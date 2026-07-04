#!/usr/bin/env node

// Verifies that the ADO PAT or OAuth token has sufficient permissions
// (at minimum: "Code - Read & Write" / Contribute) on the target repository.
//
// Used by git-configure (Phase 2 ado-perms-fail gate, git-configure:2.ado-perms-fail)
// and git-sync's inline PR offer to surface the
// "ADO auth insufficient" root cause (IL-002) before attempting any writes.
//
// The check makes a lightweight ADO REST API call (GET repository metadata)
// that succeeds with Read-only access, then a refs probe to verify Write
// access. Because Write-scope cannot be confirmed without attempting a write,
// this helper conservatively checks:
//   1. Can we GET the repository? (Read = token is valid for this repo)
//   2. Can we GET refs (branches)? (needed for ConnectToGit)
//
// Output (JSON to stdout):
//   {
//     hasAccess:    true | false,
//     organization: "<ADO org>",
//     project:      "<ADO project>",
//     repository:   "<ADO repo>",
//     canRead:      true | false,
//     canReadRefs:  true | false,
//     tokenType:    "PAT" | "OAuth" | "unknown",
//     repoId:       "<guid>" | null,
//     defaultBranch: "<branch>" | null,
//     hint:         "<message>" | null,
//   }
//   On error: { error: "<message>" }
//
// Usage:
//   node verify-ado-permissions.js
//       --organization <adoOrg>
//       --project      <adoProject>
//       --repository   <adoRepo>
//       [--token       <PAT or OAuth token>]
//
// Token precedence:
//   1. --token CLI arg (PAT or OAuth Bearer)
//   2. ADO_TOKEN env var
//   3. Fails with an actionable error

'use strict';

const { makeRequest } = require('./validation-helpers');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { organization: null, project: null, repository: null, token: null, tokenFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
  }
  return out;
}

/**
 * Builds the Authorization header value from a token.
 * ADO accepts both:
 *   - PAT: base64(":token") → "Basic <b64>"
 *   - OAuth/AAD: "Bearer <token>"
 * We detect PAT heuristically (PATs don't have periods; JWTs have 2 periods).
 */
function buildAuthHeader(token) {
  const isPat = (token.split('.').length - 1) < 2;
  if (isPat) {
    const b64 = Buffer.from(`:${token}`).toString('base64');
    return { header: `Basic ${b64}`, tokenType: 'PAT' };
  }
  return { header: `Bearer ${token}`, tokenType: 'OAuth' };
}

/**
 * @param {object} options
 * @param {string} options.organization
 * @param {string} options.project
 * @param {string} options.repository
 * @param {string} [options.token]
 * @returns {Promise<object>}
 */
async function verifyAdoPermissions({ organization, project, repository, token, tokenFile, adoBaseUrl, requestImpl } = {}) {
  if (!organization) return { error: '--organization is required' };
  if (!project) return { error: '--project is required' };
  if (!repository) return { error: '--repository is required' };

  const tokenResult = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
  if (!tokenResult.ok) {
    return {
      error: tokenResult.error + ' The PAT must have "Code - Read & Write" scope on the target repository.',
    };
  }

  const { header: authHeader, tokenType } = buildAuthHeader(tokenResult.token);
  const adoBase = adoBaseUrl || `https://dev.azure.com/${encodeURIComponent(organization)}`;
  const apiVersion = '7.1-preview.1';
  const request = requestImpl || makeRequest;

  // Step 1 — GET repository metadata (Read scope check)
  const repoUrl =
    `${adoBase}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}` +
    `?api-version=${apiVersion}`;

  const repoRes = await request({
    url: repoUrl,
    method: 'GET',
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  if (repoRes.error) {
    return { error: `ADO repository check failed: ${repoRes.error}` };
  }

  const canRead = repoRes.statusCode === 200;
  let repoId = null;
  let defaultBranch = null;
  let hint = null;

  if (canRead) {
    try {
      const body = JSON.parse(repoRes.body);
      repoId = body.id || null;
      defaultBranch = body.defaultBranch
        ? body.defaultBranch.replace('refs/heads/', '')
        : null;
    } catch { /* leave null */ }
  } else if (repoRes.statusCode === 401 || repoRes.statusCode === 403) {
    hint = `ADO returned ${repoRes.statusCode}. Check that your PAT has "Code - Read & Write" ` +
      `scope and has not expired. If using OAuth, ensure the token includes the ` +
      `"vso.code_write" scope.`;
  } else if (repoRes.statusCode === 404) {
    hint = `Repository "${repository}" not found in project "${project}" / org "${organization}". ` +
      `Verify the names are spelled exactly as they appear in ADO.`;
  }

  // Step 2 — GET refs (branches) — confirms the token can enumerate refs,
  // which ConnectToGit requires to validate the branch exists.
  let canReadRefs = false;
  if (canRead && repoId) {
    const refsUrl =
      `${adoBase}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/refs` +
      `?filter=heads&api-version=${apiVersion}&$top=1`;
    const refsRes = await request({
      url: refsUrl,
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (refsRes.error) {
      hint = `ADO refs check failed: ${refsRes.error}`;
    } else {
      canReadRefs = refsRes.statusCode === 200;
    }
  }

  return {
    hasAccess: canRead && canReadRefs,
    organization,
    project,
    repository,
    canRead,
    canReadRefs,
    tokenType,
    repoId,
    defaultBranch,
    hint: hint || null,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  verifyAdoPermissions(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('verify-ado-permissions: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { verifyAdoPermissions, buildAuthHeader };
