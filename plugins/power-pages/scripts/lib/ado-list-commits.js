#!/usr/bin/env node

// Lists recent commits on a branch in Azure DevOps. Used by:
//   - revert-branch skill UI (to let the user pick a target commit to reset to)
//   - diagnose-git-integration (to show recent CommitToGit / merge history)
//
// API reference:
//   https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-commits
//
//   GET {org}/{project}/_apis/git/repositories/{repo}/commits?
//       searchCriteria.itemVersion.version=<branch>
//       & searchCriteria.itemVersion.versionType=branch
//       & $top=<n>
//       & api-version=7.0
//
// Response: { count, value: [ { commitId, comment, author: { name, email, date }, ... } ] }
//
// Output (JSON to stdout):
//   {
//     count: <int>,
//     commits: [
//       {
//         commitId: "<sha>",
//         comment: "<truncated message>",
//         author:   { name, email, date },
//         committer:{ name, email, date },
//         url: "<commit web url>",
//       }, ...
//     ],
//     branch, organization, project, repository,
//   }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node ado-list-commits.js
//       --organization   <org>
//       --project        <project>
//       --repository     <repo>
//       --branch         <branchName>      # without refs/heads/
//       [--top           <int>]            # default 20, max 100 (ADO cap is higher
//                                            but UI rarely shows more)
//       [--pat <PAT>] | [--token <bearer>]
//       [--apiVersion    <ver>]            # default 7.0
//       [--author        <name|email>]     # optional searchCriteria.author filter

'use strict';

const { createAdoClient } = require('./ado-client');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');

const DEFAULT_TOP = 20;
const MAX_TOP = 100;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null,
    branch: null, top: DEFAULT_TOP, author: null,
    pat: null, token: null, tokenFile: null,
    apiVersion: '7.0',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--branch' && args[i + 1]) out.branch = args[++i];
    else if (args[i] === '--top' && args[i + 1]) out.top = parseInt(args[++i], 10);
    else if (args[i] === '--author' && args[i + 1]) out.author = args[++i];
    else if (args[i] === '--pat' && args[i + 1]) out.pat = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) out.apiVersion = args[++i];
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} [options.baseUrl]   Override the dev.azure.com host (for tests)
 */
async function listCommits({
  organization, project, repository, branch,
  top = DEFAULT_TOP, author = null,
  pat = null, token = null, tokenFile = null,
  apiVersion = '7.0',
  baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repository) throw new Error('--repository is required');
  if (!branch) throw new Error('--branch is required');
  let resolvedToken = token;
  if (!pat) {
    const tokenResult = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
    if (!tokenResult.ok) throw new Error(`Either --pat or --token/--tokenFile/ADO_TOKEN is required for ADO auth: ${tokenResult.error}`);
    resolvedToken = tokenResult.token;
  }

  const cappedTop = Math.max(1, Math.min(top, MAX_TOP));
  const branchName = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;

  const client = createAdoClient({ organization, project, repository, pat, token: resolvedToken, baseUrl, apiVersion });

  const query = {
    'searchCriteria.itemVersion.version': branchName,
    'searchCriteria.itemVersion.versionType': 'branch',
    '$top': cappedTop,
  };
  if (author) query['searchCriteria.author'] = author;

  const res = await client.get('/commits', { query });

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

  let parsed = { value: [] };
  try { parsed = JSON.parse(res.body); } catch (e) {
    return { error: 'list-commits returned 2xx but body was not JSON: ' + e.message };
  }

  const commits = (parsed.value || []).map((c) => ({
    commitId: c.commitId,
    comment: c.comment || '',
    author: c.author ? {
      name:  c.author.name  || null,
      email: c.author.email || null,
      date:  c.author.date  || null,
    } : null,
    committer: c.committer ? {
      name:  c.committer.name  || null,
      email: c.committer.email || null,
      date:  c.committer.date  || null,
    } : null,
    url: c.remoteUrl || c.url || null,
  }));

  return {
    count: commits.length,
    commits,
    branch: branchName,
    organization, project, repository,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  listCommits(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('ado-list-commits: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { listCommits, DEFAULT_TOP, MAX_TOP };
