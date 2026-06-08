#!/usr/bin/env node

// Gets the status of an existing Azure DevOps Pull Request. Used by the
// `open-pr` skill after creating a PR (verify-after-create) and by
// `diagnose-git-integration` to check whether a known PR is still open.
//
// API reference:
//   https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request
//
//   GET {org}/{project}/_apis/git/repositories/{repo}/pullrequests/{prId}?api-version=7.0
//
// Response (200): full PR object — we surface a flattened summary.
//
// Output (JSON to stdout):
//   Success: {
//     found: true,
//     pullRequestId, status, mergeStatus,
//     sourceBranch, targetBranch, title, description,
//     createdBy: { displayName, uniqueName },
//     creationDate, url,
//   }
//   Not found: { found: false, pullRequestId }   (404 from ADO)
//   Failure:   { error, statusCode?, errorCode? }
//
// Usage:
//   node ado-get-pr.js
//       --organization     <org>
//       --project          <project>
//       --repository       <repo>
//       --pullRequestId    <int>
//       [--pat <PAT>] | [--token <bearer>]
//       [--apiVersion      <ver>]   # default 7.0

'use strict';

const { createAdoClient } = require('./ado-client');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null,
    pullRequestId: null,
    pat: null, token: null,
    apiVersion: '7.0',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--pullRequestId' && args[i + 1]) out.pullRequestId = args[++i];
    else if (args[i] === '--pat' && args[i + 1]) out.pat = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) out.apiVersion = args[++i];
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} [options.baseUrl]   Override dev.azure.com host (for tests)
 */
async function getPullRequest({
  organization, project, repository, pullRequestId,
  pat = null, token = null,
  apiVersion = '7.0',
  baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repository) throw new Error('--repository is required');
  if (!pullRequestId) throw new Error('--pullRequestId is required');
  if (!pat && !token) throw new Error('Either --pat or --token is required for ADO auth');

  const client = createAdoClient({ organization, project, repository, pat, token, baseUrl, apiVersion });

  const res = await client.get(`/pullrequests/${encodeURIComponent(pullRequestId)}`);

  if (res.error) return { error: res.error };
  if (res.statusCode === 404) {
    return { found: false, pullRequestId };
  }
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

  let p = {};
  try { p = JSON.parse(res.body); } catch (e) {
    return { error: 'GET PR returned 2xx but body was not JSON: ' + e.message };
  }

  const url =
    p?._links?.web?.href ||
    `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${pullRequestId}`;

  return {
    found: true,
    pullRequestId: p.pullRequestId ?? pullRequestId,
    status: p.status || null,
    mergeStatus: p.mergeStatus || null,
    sourceBranch: p.sourceRefName || null,
    targetBranch: p.targetRefName || null,
    title: p.title || null,
    description: p.description || null,
    createdBy: p.createdBy ? {
      displayName: p.createdBy.displayName || null,
      uniqueName:  p.createdBy.uniqueName  || null,
    } : null,
    creationDate: p.creationDate || null,
    url,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  getPullRequest(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('ado-get-pr: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { getPullRequest };
