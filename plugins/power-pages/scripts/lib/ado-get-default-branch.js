#!/usr/bin/env node

// Fetches the *default branch* configured on an Azure DevOps repository.
// Used by commit-to-git Phase 9 to detect the "PR-to-self" case (when the
// bound branch IS the repo default) — there is no point offering an open-pr
// gate in that case.
//
// API reference:
//   https://learn.microsoft.com/en-us/rest/api/azure/devops/git/repositories/get-repository
//
//   GET {org}/{project}/_apis/git/repositories/{repo}?api-version=7.0
//
// Response: { id, name, defaultBranch: "refs/heads/main", ... }
//
// Output (JSON to stdout):
//   Success: { defaultBranch: "main", defaultBranchRef: "refs/heads/main",
//              organization, project, repository, repositoryId }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node ado-get-default-branch.js
//       --organization <org>
//       --project      <project>
//       --repository   <repo>      // accepts name OR GUID
//       [--pat <PAT>] | [--token <bearer>]
//       [--apiVersion  <ver>]      // default 7.0

'use strict';

const { createAdoClient } = require('./ado-client');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null,
    pat: null, token: null, tokenFile: null, apiVersion: '7.0',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--pat' && args[i + 1]) out.pat = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) out.apiVersion = args[++i];
  }
  return out;
}

async function getDefaultBranch({
  organization, project, repository,
  pat = null, token = null, tokenFile = null,
  apiVersion = '7.0',
  baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repository) throw new Error('--repository is required');
  let resolvedToken = token;
  if (!pat) {
    const tokenResult = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
    if (!tokenResult.ok) throw new Error(`Either --pat or --token/--tokenFile/ADO_TOKEN is required for ADO auth: ${tokenResult.error}`);
    resolvedToken = tokenResult.token;
  }

  const client = createAdoClient({ organization, project, repository, pat, token: resolvedToken, baseUrl, apiVersion });
  // The repo-get endpoint is at the *repository root*. ado-client expects
  // path to start with '/' — passing '/' produces a URL with a trailing
  // slash that ADO accepts for the repo GET. Tested live against
  // dev.azure.com/GitIntegration22/srijan-pp-alm/srijan-pp-alm.
  const res = await client.get('/');

  if (res.error) return { error: res.error };
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try {
      const parsed = JSON.parse(res.body);
      msg = parsed.message || msg;
      code = parsed.typeKey || parsed.errorCode || null;
    } catch {}
    return { error: msg, statusCode: res.statusCode, errorCode: code };
  }

  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) {
    return { error: 'get-default-branch returned 2xx but body was not JSON: ' + e.message };
  }

  const ref = parsed.defaultBranch || null;
  const name = ref ? ref.replace(/^refs\/heads\//, '') : null;

  return {
    defaultBranch: name,
    defaultBranchRef: ref,
    repositoryId: parsed.id || null,
    organization, project, repository,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  getDefaultBranch(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('ado-get-default-branch: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { getDefaultBranch };
