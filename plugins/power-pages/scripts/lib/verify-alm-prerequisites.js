#!/usr/bin/env node

// Verifies all prerequisites for ALM skills:
//   1. PAC CLI is installed and authenticated (pac env who)
//   2. Azure CLI is installed and logged in (az account get-access-token)
//   3. Dataverse API is reachable (WhoAmI)
//
// Usage: node verify-alm-prerequisites.js [--envUrl <url>] [--require-manifest]
//
// Options:
//   --envUrl <url>        Override environment URL (default: read from pac env who)
//   --require-manifest    Fail if .solution-manifest.json is not found in project root
//
// Output (JSON to stdout):
//   { "envUrl": "...", "token": "...", "userId": "...", "organizationId": "...", "tenantId": "..." }
//
// Exit 0 on success, exit 1 on any failure (error on stderr).

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const helpers = require('./validation-helpers');
const { findProjectRoot } = helpers;

function parseArgs(argv) {
  const args = argv.slice(2);
  let envUrl = null;
  let requireManifest = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) envUrl = args[++i];
    else if (args[i] === '--require-manifest') requireManifest = true;
  }

  return { envUrl, requireManifest };
}

async function verifyAlmPrerequisites({ envUrl, requireManifest } = {}) {
  // Step 1: PAC CLI check
  let resolvedEnvUrl = envUrl;
  if (!resolvedEnvUrl) {
    resolvedEnvUrl = helpers.getEnvironmentUrl();
    if (!resolvedEnvUrl) {
      throw new Error(
        'PAC CLI is not authenticated. Run `pac auth create` to authenticate to a Dataverse environment.'
      );
    }
  }
  resolvedEnvUrl = resolvedEnvUrl.replace(/\/+$/, '');

  // Step 2: Azure CLI token
  const token = helpers.getAuthToken(resolvedEnvUrl);
  if (!token) {
    throw new Error(
      'Azure CLI is not logged in or token acquisition failed. Run `az login` and retry.'
    );
  }

  // Step 3: Dataverse API access via WhoAmI
  const res = await helpers.makeRequest({
    url: `${resolvedEnvUrl}/api/data/v9.2/WhoAmI`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 15000,
  });

  if (res.error) {
    throw new Error(`Dataverse API unreachable: ${res.error}`);
  }
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new Error(
      `Authentication failed (${res.statusCode}). Token may be expired — run \`az login\` again.`
    );
  }
  if (res.statusCode !== 200) {
    throw new Error(`WhoAmI returned unexpected status ${res.statusCode}: ${res.body}`);
  }

  const data = JSON.parse(res.body);

  // Extract tenantId from JWT payload
  let tenantId = null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    tenantId = payload.tid || null;
  } catch {}

  // Step 4 (optional): solution manifest check
  if (requireManifest) {
    const cwd = process.cwd();
    const projectRoot = findProjectRoot(cwd);
    const manifestPath = projectRoot ? path.join(projectRoot, '.solution-manifest.json') : null;
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      throw new Error(
        '.solution-manifest.json not found. Run `/power-pages:setup-solution` first to create a Dataverse solution.'
      );
    }
  }

  return {
    envUrl: resolvedEnvUrl,
    token,
    userId: data.UserId,
    organizationId: data.OrganizationId,
    tenantId,
  };
}

// CLI entry point
if (require.main === module) {
  const { envUrl, requireManifest } = parseArgs(process.argv);

  verifyAlmPrerequisites({ envUrl, requireManifest })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { verifyAlmPrerequisites };
