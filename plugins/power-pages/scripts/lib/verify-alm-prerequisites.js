#!/usr/bin/env node

// Verifies all prerequisites for ALM skills:
//   1. PAC CLI is installed and authenticated (pac env who)
//   2. Azure CLI is installed and logged in (az account get-access-token)
//   3. Dataverse API is reachable (WhoAmI)
//
// Usage: node verify-alm-prerequisites.js [--envUrl <url>] [--require-manifest] [--expectedEnvUrl <url>]
//
// Options:
//   --envUrl <url>        Override environment URL (default: read from pac env who)
//   --require-manifest    Fail if .solution-manifest.json is not found in project root
//   --expectedEnvUrl <url>  Assert the resolved env matches this origin; HARD-STOP on
//                           mismatch (guards against an ambient PAC context drifting to
//                           the wrong environment). Compared origin-only. No-op if unset.
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
  let expectedEnvUrl = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) envUrl = args[++i];
    else if (args[i] === '--require-manifest') requireManifest = true;
    else if (args[i] === '--expectedEnvUrl' && args[i + 1]) expectedEnvUrl = args[++i];
  }

  return { envUrl, requireManifest, expectedEnvUrl };
}

// Normalize a Dataverse env reference to its origin (scheme+host), lowercased.
// Tolerates a missing scheme (`org.crm.dynamics.com` → `https://org.crm.dynamics.com`)
// since a hand-authored manifest may omit it. Returns null when the value is empty
// or not a parseable host — so the caller can treat "can't compare" distinctly from
// "definitely different" and avoid a false mismatch on garbage input.
function envOrigin(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  // Try as-is, then with an https:// prefix (covers a bare host like
  // `org.crm.dynamics.com`). The WHATWG URL parser is lenient and will happily
  // accept `https://{CONFIGURED_ENV_URL}` as a "host", so after parsing we ALSO
  // require a plausible DNS hostname (dot-separated alnum/hyphen labels). That
  // rejects an unsubstituted `{PLACEHOLDER}`, `null`, or other junk (→ null) so it
  // can never be compared as if it were a real environment.
  for (const candidate of [s, 'https://' + s.replace(/^\/+/, '')]) {
    let parsed;
    try { parsed = new URL(candidate); } catch { continue; }
    const host = parsed.hostname.toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) continue;
    return parsed.origin.toLowerCase();
  }
  return null;
}

// Compare two env references by origin only — path/query/trailing-slash/case ignored.
// Returns true (same), false (definitely different), or null (indeterminate: one side
// isn't a parseable env URL). Callers must hard-stop ONLY on an explicit `false`, never
// on null, so a missing/placeholder/garbage value disables the assertion instead of
// blocking a legitimate run.
function sameEnvOrigin(a, b) {
  const oa = envOrigin(a);
  const ob = envOrigin(b);
  if (oa === null || ob === null) return null;
  return oa === ob;
}

async function verifyAlmPrerequisites({ envUrl, requireManifest, expectedEnvUrl } = {}) {
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

  // Step 1b: Environment-match assertion (opt-in via --expectedEnvUrl). When the
  // env is resolved from the ambient PAC context (no explicit --envUrl), it is NOT
  // guaranteed to be the project's environment — and since getEnvironmentUrl() now
  // parses PAC 2.8.x's "Org URL:" successfully, a DRIFTED PAC context resolves and
  // proceeds SILENTLY instead of failing loudly the way the old parse-miss did
  // (which had been an accidental safety net). A caller that knows the project's
  // env (from .solution-manifest.json / powerpages.config.json / the approved plan)
  // passes it here; a mismatch HARD-STOPS before any token acquisition or write, so
  // an ALM operation can never silently target the wrong environment (e.g. PROD).
  // HARD-STOP only on a DEFINITE mismatch (sameEnvOrigin === false). A null result
  // means expectedEnvUrl wasn't a parseable env URL (empty, an unsubstituted
  // `{PLACEHOLDER}`, junk) — in that case skip the assertion rather than block a
  // legitimate run on bad input; the SKILL.md guidance is to omit the flag entirely
  // when no env URL is recorded.
  if (expectedEnvUrl && sameEnvOrigin(resolvedEnvUrl, expectedEnvUrl) === false) {
    throw new Error(
      `Environment mismatch: PAC CLI is connected to ${resolvedEnvUrl} but this project targets ` +
      `${expectedEnvUrl.replace(/\/+$/, '')}. Run \`pac env select --environment ${expectedEnvUrl.replace(/\/+$/, '')}\` ` +
      '(or `pac auth select` to the right profile) and retry. If `pac env who` keeps reverting to a ' +
      'different environment, an external process is changing the active env — resolve that before ' +
      'running ALM skills, or pass --envUrl to pin this run explicitly.'
    );
  }

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
  const { envUrl, requireManifest, expectedEnvUrl } = parseArgs(process.argv);

  verifyAlmPrerequisites({ envUrl, requireManifest, expectedEnvUrl })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { verifyAlmPrerequisites, parseArgs, sameEnvOrigin, envOrigin };
