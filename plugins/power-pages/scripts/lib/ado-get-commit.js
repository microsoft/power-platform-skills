#!/usr/bin/env node

// Fetches a single commit by SHA from Azure DevOps. Used by commit-to-git
// Phase 8 to do a *direct* SHA lookup instead of the `--top 5` list scan that
// the legacy flow used — relevant when more than 5 commits land on the bound
// branch between Phase 6 (CommitToGit POST) and Phase 8 (verification).
//
// API reference:
//   https://learn.microsoft.com/en-us/rest/api/azure/devops/git/commits/get-commit
//
//   GET {org}/{project}/_apis/git/repositories/{repo}/commits/{commitId}?
//       api-version=7.0
//       [& changeCount=<int>]   // optional — by default ADO omits the changes
//                                  array; pass changeCount=0 to get the bare
//                                  commit metadata only.
//
// Response: { commitId, comment, author:{...}, committer:{...}, parents:[...], remoteUrl, url, ... }
//
// Output (JSON to stdout):
//   Success: {
//     commitId: "<sha>",
//     comment: "<message>",
//     author:   { name, email, date },
//     committer:{ name, email, date },
//     parents:  ["<sha>", ...],
//     url:      "<commit web url>",
//     organization, project, repository,
//   }
//   Not found (404): { error: "Commit not found", statusCode: 404, found: false, commitId, ... }
//   Other failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node ado-get-commit.js
//       --organization <org>
//       --project      <project>
//       --repository   <repo>
//       --commitId     <sha>      // accepts full or short SHAs (≥ 7 chars)
//       [--pat <PAT>] | [--token <bearer>]
//       [--apiVersion  <ver>]     // default 7.0

'use strict';

const { createAdoClient } = require('./ado-client');
const { resolveAdoToken } = require('./resolve-ado-token');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null,
    commitId: null, pat: null, token: null, tokenFile: null, apiVersion: '7.0',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--commitId' && args[i + 1]) out.commitId = args[++i];
    else if (args[i] === '--pat' && args[i + 1]) out.pat = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) out.apiVersion = args[++i];
  }
  return out;
}

async function getCommit({
  organization, project, repository, commitId,
  pat = null, token = null, tokenFile = null,
  apiVersion = '7.0',
  baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repository) throw new Error('--repository is required');
  if (!commitId) throw new Error('--commitId is required');
  let resolvedToken = token;
  if (!pat) {
    const tokenResult = resolveAdoToken({ token, tokenFile, env: process.env });
    if (!tokenResult.ok) throw new Error(`Either --pat or --token/--tokenFile/ADO_TOKEN is required for ADO auth: ${tokenResult.error}`);
    resolvedToken = tokenResult.token;
  }
  if (!/^[0-9a-fA-F]{7,40}$/.test(commitId)) {
    throw new Error(`--commitId must be a hex SHA (7-40 chars); got: ${commitId}`);
  }

  const client = createAdoClient({ organization, project, repository, pat, token: resolvedToken, baseUrl, apiVersion });
  const res = await client.get(`/commits/${commitId}`, { query: { changeCount: 0 } });

  if (res.error) return { error: res.error };
  if (res.statusCode === 404) {
    return {
      error: 'Commit not found',
      statusCode: 404,
      found: false,
      commitId,
      organization, project, repository,
    };
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

  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) {
    return { error: 'get-commit returned 2xx but body was not JSON: ' + e.message };
  }

  return {
    found: true,
    commitId: parsed.commitId,
    comment: parsed.comment || '',
    author: parsed.author ? {
      name:  parsed.author.name  || null,
      email: parsed.author.email || null,
      date:  parsed.author.date  || null,
    } : null,
    committer: parsed.committer ? {
      name:  parsed.committer.name  || null,
      email: parsed.committer.email || null,
      date:  parsed.committer.date  || null,
    } : null,
    parents: parsed.parents || [],
    url: parsed.remoteUrl || parsed.url || null,
    organization, project, repository,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  getCommit(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('ado-get-commit: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { getCommit };
