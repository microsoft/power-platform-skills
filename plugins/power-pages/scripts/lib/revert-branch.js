#!/usr/bin/env node

// Resets an ADO branch HEAD to a previous commit. This is the "undo the
// commit I just pushed" lever — used by skill 9b (revert-branch) for cases
// where a CommitToGit produced a regression in Git.
//
// Strategy: ADO Git REST API does NOT expose a native "reset" verb. Instead
// we use the Refs API to update the ref to point at the older commit:
//   PATCH https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/refs?api-version=7.0
//   Body: [{
//     "name": "refs/heads/<branch>",
//     "oldObjectId": "<currentSha>",   // platform's concurrency check
//     "newObjectId": "<targetSha>",
//   }]
//
// Two consent gates the SKILL layer must enforce (this helper does NOT):
//   1. This is a force-update (history rewrite). Other devs' clones diverge.
//   2. The Dataverse environment is now AHEAD of the branch — caller must
//      decide whether to follow up with revert-workspace or commit-to-git
//      to bring environment back in sync.
//
// API reference: references/git-integration-api-patterns.md §11 (ADO REST)
// Microsoft Learn ADO Git Refs PATCH:
//   https://learn.microsoft.com/en-us/rest/api/azure/devops/git/refs/update-refs
//
// Output (JSON to stdout):
//   Success: {
//     reset: true,
//     branch, organization, project, repository,
//     oldSha, newSha,
//     calledAt: "<ISO>",
//   }
//   Failure: { error, statusCode?, errorCode?, adoMessage? }
//
// Usage:
//   node revert-branch.js
//       --organization        <orgName>
//       --project             <projectName>
//       --repository          <repoName>
//       --branch              <branchName>          # without refs/heads/ prefix
//       --currentSha          <40-char sha>         # required by ADO concurrency check
//       --targetSha           <40-char sha>         # commit to reset to
//       [--pat                <PAT>]                # ADO PAT, or
//       [--token              <bearer>]             # AAD bearer
//       [--apiVersion         <ver>]                # default 7.0

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');

const DEFAULT_API_VERSION = '7.0';
const SHA_REGEX = /^[0-9a-f]{40}$/i;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null, branch: null,
    currentSha: null, targetSha: null,
    pat: null, token: null,
    apiVersion: DEFAULT_API_VERSION,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--branch' && args[i + 1]) out.branch = args[++i];
    else if (args[i] === '--currentSha' && args[i + 1]) out.currentSha = args[++i];
    else if (args[i] === '--targetSha' && args[i + 1]) out.targetSha = args[++i];
    else if (args[i] === '--pat' && args[i + 1]) out.pat = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) out.apiVersion = args[++i];
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} [options.baseUrl]  Override the ADO base URL (used by tests).
 *                                    Defaults to https://dev.azure.com/{org}.
 * @returns {Promise<object>}
 */
async function revertBranch({
  organization, project, repository, branch,
  currentSha, targetSha,
  pat = null, token = null,
  apiVersion = DEFAULT_API_VERSION,
  baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repository) throw new Error('--repository is required');
  if (!branch) throw new Error('--branch is required');
  if (!currentSha) throw new Error('--currentSha is required');
  if (!targetSha) throw new Error('--targetSha is required');
  if (!SHA_REGEX.test(currentSha)) throw new Error('--currentSha must be a 40-character SHA');
  if (!SHA_REGEX.test(targetSha)) throw new Error('--targetSha must be a 40-character SHA');
  if (!pat && !token) throw new Error('Either --pat or --token is required for ADO auth');

  // buildAuthHeader takes a single token string and auto-detects PAT vs OAuth
  // based on dot-count (JWTs have 2 dots; PATs typically don't).
  const { header: authHeader } = buildAuthHeader(pat || token);
  const base = baseUrl || `https://dev.azure.com/${encodeURIComponent(organization)}`;
  const refName = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  const apiUrl = `${base}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}/refs?api-version=${apiVersion}`;

  const bodyArr = [{
    name: refName,
    oldObjectId: currentSha,
    newObjectId: targetSha,
  }];

  const res = await makeRequest({
    url: apiUrl,
    method: 'POST', // ADO Refs uses POST with an array body to update refs
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(bodyArr),
  });

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

  // ADO returns { value: [{ success: true, ... }] }. Surface per-ref result.
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  const result = parsed?.value?.[0];
  if (result && result.success === false) {
    return {
      error: result.customMessage || result.repositoryId || 'ADO ref update failed',
      statusCode: res.statusCode,
      adoMessage: result.customMessage || null,
      adoResult: result,
    };
  }

  return {
    reset: true,
    branch: refName,
    organization, project, repository,
    oldSha: currentSha,
    newSha: targetSha,
    adoResult: result || null,
    calledAt: new Date().toISOString(),
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  revertBranch(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('revert-branch: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { revertBranch, SHA_REGEX, DEFAULT_API_VERSION };
