#!/usr/bin/env node

// Creates a Pull Request in Azure DevOps from a source branch into a target
// branch. Used by the `open-pr` skill (architecture doc §5 Skill 10).
//
// API reference: ADO Git Pull Requests REST API
//   https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create
//
//   POST {org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.0
//   Body: {
//     sourceRefName: "refs/heads/<src>",
//     targetRefName: "refs/heads/<tgt>",
//     title:        "<title>",
//     description:  "<markdown>",
//     reviewers:    [{ id: "<aad-or-team-guid>" }, ...]   // optional
//     workItemRefs: [{ id: "<ado-work-item-id>" }, ...]   // optional
//   }
//
// Response (201 Created):
//   {
//     pullRequestId: <int>,
//     status: "active",
//     sourceRefName, targetRefName, title, description,
//     repository: { webUrl: "..." },                    // for building PR URL
//     _links: { web: { href: "<pr web url>" } },
//   }
//
// Output (JSON to stdout):
//   Success: {
//     created: true,
//     pullRequestId, status, url,
//     sourceBranch, targetBranch, title,
//     calledAt: "<ISO>",
//   }
//   Failure: { error, statusCode?, errorCode?, adoMessage? }
//
// Usage:
//   node ado-create-pr.js
//       --organization   <org>
//       --project        <project>
//       --repository     <repo>
//       --sourceBranch   <branchName>           # without refs/heads/
//       --targetBranch   <branchName>
//       --title          "<title>"
//       --description    "<markdown body>"
//       [--pat           <PAT>] | [--token <bearer>]
//       [--reviewers     <id1>,<id2>,...]       # comma-separated reviewer AAD/team IDs
//       [--workItems     <id1>,<id2>,...]       # comma-separated work item IDs
//       [--apiVersion    <ver>]                 # default 7.0

'use strict';

const { createAdoClient } = require('./ado-client');
const { resolveAdoToken } = require('./resolve-ado-token');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null,
    sourceBranch: null, targetBranch: null,
    title: null, description: null,
    pat: null, token: null, tokenFile: null,
    reviewers: null, workItems: null,
    apiVersion: '7.0',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--sourceBranch' && args[i + 1]) out.sourceBranch = args[++i];
    else if (args[i] === '--targetBranch' && args[i + 1]) out.targetBranch = args[++i];
    else if (args[i] === '--title' && args[i + 1]) out.title = args[++i];
    else if (args[i] === '--description' && args[i + 1]) out.description = args[++i];
    else if (args[i] === '--pat' && args[i + 1]) out.pat = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
    else if (args[i] === '--reviewers' && args[i + 1]) out.reviewers = args[++i];
    else if (args[i] === '--workItems' && args[i + 1]) out.workItems = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) out.apiVersion = args[++i];
  }
  return out;
}

function normalizeRef(ref) {
  if (!ref) return ref;
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

function splitCsv(s) {
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * @param {object} options
 * @param {string} [options.baseUrl]   Override the dev.azure.com host (for tests)
 * @returns {Promise<object>}
 */
async function createPullRequest({
  organization, project, repository,
  sourceBranch, targetBranch, title, description,
  pat = null, token = null, tokenFile = null,
  reviewers = null, workItems = null,
  apiVersion = '7.0',
  baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repository) throw new Error('--repository is required');
  if (!sourceBranch) throw new Error('--sourceBranch is required');
  if (!targetBranch) throw new Error('--targetBranch is required');
  if (!title) throw new Error('--title is required');
  let resolvedToken = token;
  if (!pat) {
    const tokenResult = resolveAdoToken({ token, tokenFile, env: process.env });
    if (!tokenResult.ok) throw new Error(`Either --pat or --token/--tokenFile/ADO_TOKEN is required for ADO auth: ${tokenResult.error}`);
    resolvedToken = tokenResult.token;
  }

  const client = createAdoClient({ organization, project, repository, pat, token: resolvedToken, baseUrl, apiVersion });

  const body = {
    sourceRefName: normalizeRef(sourceBranch),
    targetRefName: normalizeRef(targetBranch),
    title,
    description: description || '',
  };

  const reviewerList = Array.isArray(reviewers) ? reviewers : splitCsv(reviewers);
  if (reviewerList.length > 0) body.reviewers = reviewerList.map((id) => ({ id }));

  const workItemList = Array.isArray(workItems) ? workItems : splitCsv(workItems);
  if (workItemList.length > 0) body.workItemRefs = workItemList.map((id) => ({ id: String(id) }));

  const res = await client.post('/pullrequests', { body });

  if (res.error) return { error: res.error };
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    let adoMessage = null;
    try {
      const parsed = JSON.parse(res.body);
      msg = parsed.message || msg;
      code = parsed.typeKey || parsed.errorCode || null;
      adoMessage = parsed.message || null;
    } catch {}
    return { error: msg, statusCode: res.statusCode, errorCode: code, adoMessage };
  }

  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch (e) {
    return { error: 'PR create returned 2xx but body was not JSON: ' + e.message };
  }

  const prId = parsed.pullRequestId;
  const url =
    parsed?._links?.web?.href ||
    (prId && project && repository
      ? `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${prId}`
      : null);

  return {
    created: true,
    pullRequestId: prId,
    status: parsed.status || null,
    url,
    sourceBranch: parsed.sourceRefName || body.sourceRefName,
    targetBranch: parsed.targetRefName || body.targetRefName,
    title: parsed.title || title,
    organization, project, repository,
    calledAt: new Date().toISOString(),
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  createPullRequest(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('ado-create-pr: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { createPullRequest, normalizeRef };
