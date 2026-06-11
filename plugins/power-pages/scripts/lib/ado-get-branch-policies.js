#!/usr/bin/env node

// Fetches branch protection policies for a specific ref in Azure DevOps.
// Used by commit-to-git Phase 1 to surface an informational note when the
// bound branch has a "PR-required" policy attached — Dataverse's CommitToGit
// bypasses branch policies (it commits directly via the platform service
// account), so we want users to know they're about to push to a protected
// branch without triggering the policy gate.
//
// API reference:
//   https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/configurations/list
//
//   GET {org}/{project}/_apis/policy/configurations?
//       repositoryId=<guid>
//       & refName=refs/heads/<branch>
//       & api-version=7.0
//
// Response: { count, value: [ { id, type:{id,displayName}, isBlocking, isEnabled, settings, ... } ] }
//
// Output (JSON to stdout):
//   Success: {
//     organization, project, repositoryId, branch,
//     count: <int>,
//     policies: [
//       { id, type, displayName, isBlocking, isEnabled,
//         requiresMinReviewers?: <int>,
//         requiresLinkedWorkItems?: <bool>,
//         requiresBuild?: <bool>,
//       },
//       ...
//     ],
//     hasBlockingPullRequestPolicy: <bool>,   // true when ANY policy with
//                                              //   isBlocking && isEnabled is present
//   }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node ado-get-branch-policies.js
//       --organization  <org>
//       --project       <project>
//       --repositoryId  <repoGuid>   // ADO API only accepts GUID here, NOT name
//       --branch        <branch>
//       [--pat <PAT>] | [--token <bearer>]
//       [--apiVersion   <ver>]       // default 7.0
//
// NOTE: the policy endpoint accepts the repo *GUID* not the repo *name*.
// Resolve the GUID first via ado-get-default-branch.js → repositoryId.

'use strict';

const { createAdoClient } = require('./ado-client');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repositoryId: null, branch: null,
    pat: null, token: null, apiVersion: '7.0',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repositoryId' && args[i + 1]) out.repositoryId = args[++i];
    else if (args[i] === '--branch' && args[i + 1]) out.branch = args[++i];
    else if (args[i] === '--pat' && args[i + 1]) out.pat = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) out.apiVersion = args[++i];
  }
  return out;
}

async function getBranchPolicies({
  organization, project, repositoryId, branch,
  pat = null, token = null,
  apiVersion = '7.0',
  baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repositoryId) throw new Error('--repositoryId is required (the repo GUID, not the name)');
  if (!branch) throw new Error('--branch is required');
  if (!pat && !token) throw new Error('Either --pat or --token is required for ADO auth');

  const branchName = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;

  // The policy endpoint lives under {org}/{project}/_apis/policy/configurations
  // — NOT under the git/repositories/{repo} prefix that the rest of ado-client
  // assumes. We hand-build the URL via the raw token/pat-aware HTTP helper.
  const { getAuthHeader, host } = adoAuthAndHost({ organization, pat, token, baseUrl });
  const url = `${host}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}` +
              `/_apis/policy/configurations` +
              `?repositoryId=${encodeURIComponent(repositoryId)}` +
              `&refName=${encodeURIComponent(branchName)}` +
              `&api-version=${encodeURIComponent(apiVersion)}`;

  const { makeRequest } = require('./validation-helpers');
  const res = await makeRequest({
    url, method: 'GET',
    headers: { Authorization: getAuthHeader(), Accept: 'application/json' },
  });

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
    return { error: 'get-branch-policies returned 2xx but body was not JSON: ' + e.message };
  }

  const policies = (parsed.value || []).map((p) => {
    const settings = p.settings || {};
    return {
      id: p.id,
      type: p.type ? p.type.id : null,
      displayName: p.type ? p.type.displayName : null,
      isBlocking: !!p.isBlocking,
      isEnabled: !!p.isEnabled,
      requiresMinReviewers: settings.minimumApproverCount ?? null,
      requiresLinkedWorkItems: settings.linkedWorkItemRequirementType ? true : null,
      requiresBuild: settings.buildDefinitionId ? true : null,
    };
  });

  return {
    organization, project, repositoryId, branch: branchName,
    count: policies.length,
    policies,
    hasBlockingPullRequestPolicy: policies.some(p => p.isBlocking && p.isEnabled),
  };
}

function adoAuthAndHost({ organization, pat, token, baseUrl }) {
  const host = baseUrl || 'https://dev.azure.com';
  if (pat) {
    return {
      host,
      getAuthHeader: () => 'Basic ' + Buffer.from(`:${pat}`).toString('base64'),
    };
  }
  return { host, getAuthHeader: () => `Bearer ${token}` };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  getBranchPolicies(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('ado-get-branch-policies: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { getBranchPolicies };
