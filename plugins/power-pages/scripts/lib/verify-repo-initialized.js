#!/usr/bin/env node

// Verifies that an ADO repository is initialized (has at least one commit on
// a default branch). ConnectToGit fails with a cryptic error if the repo is
// empty, so git-configure runs this in Phase 2.
//
// Detection algorithm:
//   1. GET repository metadata → if `defaultBranch` is null, the repo is
//      empty (no commits, no default branch set).
//   2. GET refs?filter=heads&top=1 → if value array is empty, no branches
//      exist on the server.
//
// Output (JSON to stdout):
//   {
//     initialized: true | false,
//     organization, project, repository,
//     defaultBranch: "<name>" | null,
//     branchCount: <number>,
//     hint: "<message>" | null,
//   }
//   Error: { error: "<message>", statusCode? }
//
// Usage:
//   node verify-repo-initialized.js
//       --organization <adoOrg>
//       --project      <adoProject>
//       --repository   <adoRepo>
//       [--token       <PAT or OAuth>]

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');
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
 * @param {object} options
 * @returns {Promise<object>}
 */
async function verifyRepoInitialized({ organization, project, repository, token, tokenFile } = {}) {
  if (!organization) return { error: '--organization is required' };
  if (!project) return { error: '--project is required' };
  if (!repository) return { error: '--repository is required' };

  const tokenResult = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
  if (!tokenResult.ok) return { error: tokenResult.error };

  const { header: authHeader } = buildAuthHeader(tokenResult.token);
  const adoBase = `https://dev.azure.com/${encodeURIComponent(organization)}`;
  const apiVersion = '7.1-preview.1';

  // Step 1 — GET repository metadata.
  const repoUrl =
    `${adoBase}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}` +
    `?api-version=${apiVersion}`;
  const repoRes = await makeRequest({
    url: repoUrl,
    method: 'GET',
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });

  if (repoRes.error) return { error: repoRes.error };
  if (repoRes.statusCode === 404) {
    return {
      initialized: false,
      organization, project, repository,
      defaultBranch: null,
      branchCount: 0,
      hint: `Repository "${repository}" not found in ${organization}/${project}.`,
    };
  }
  if (repoRes.statusCode !== 200) {
    let msg = `HTTP ${repoRes.statusCode}`;
    try { msg = JSON.parse(repoRes.body).message || msg; } catch {}
    return { error: msg, statusCode: repoRes.statusCode };
  }

  let body;
  try { body = JSON.parse(repoRes.body); } catch (e) {
    return { error: 'Failed to parse repository metadata: ' + e.message };
  }

  const defaultBranch = body.defaultBranch ? body.defaultBranch.replace('refs/heads/', '') : null;
  const repoId = body.id;

  // Step 2 — GET refs/heads to count branches.
  let branchCount = 0;
  if (repoId) {
    const refsUrl =
      `${adoBase}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/refs` +
      `?filter=heads&api-version=${apiVersion}`;
    const refsRes = await makeRequest({
      url: refsUrl,
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (refsRes.statusCode === 200) {
      try {
        const refsBody = JSON.parse(refsRes.body);
        branchCount = Array.isArray(refsBody.value) ? refsBody.value.length : 0;
      } catch { /* leave 0 */ }
    }
  }

  const initialized = !!defaultBranch && branchCount > 0;

  return {
    initialized,
    organization, project, repository,
    defaultBranch,
    branchCount,
    hint: initialized
      ? null
      : `Repository "${repository}" appears to be empty (no default branch / no commits). ` +
        `Push an initial commit (e.g. README) before running /power-pages:git-configure. ` +
        `In the ADO UI: "Initialize main branch with a README".`,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  verifyRepoInitialized(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('verify-repo-initialized: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { verifyRepoInitialized };
