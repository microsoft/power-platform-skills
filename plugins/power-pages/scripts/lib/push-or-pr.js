#!/usr/bin/env node

// Pushes a locally-committed real merge from a cloned worktree back to the ADO
// branch bound to Power Pages. This helper performs mutations when invoked; the
// caller/orchestrator owns all user consent gates. It never force-pushes:
// direct updates use a normal non-force git push and protected/non-fast-forward
// failures fall back to pushing a run branch and opening a PR.
//
// Export:
//   pushOrPr({ repoDir, binding, user, token, autoComplete, title, description,
//              timestamp, deps, gitImpl })
//
// Results:
//   Direct fast-forward push:
//     { mode: 'direct-push', pushed: true, branch }
//   PR fallback/path:
//     { mode: 'pr', prId, prUrl, runBranch, autoCompleteEnabled }

'use strict';

const gitExec = require('./git-exec');
const { getBranchPolicies } = require('./ado-get-branch-policies');
const { createPullRequest } = require('./ado-create-pr');
const { createAdoClient } = require('./ado-client');

function stripHeads(branch) {
  const value = String(branch || '').trim();
  return value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
}

function compactUtcTimestamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

function sanitizeBranchSuffix(branch) {
  return stripHeads(branch)
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'branch';
}

function sanitizeUserSegment(user) {
  return String(user || 'user')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'user';
}

function buildRunBranch({ user, branch, timestamp }) {
  return `pp-merge/${sanitizeUserSegment(user)}/${sanitizeBranchSuffix(branch)}-${timestamp || compactUtcTimestamp()}`;
}

function defaultDeps() {
  return {
    getBranchPolicies,
    createPr: createPullRequest,
    createAdoClient,
  };
}

function requireBinding(binding) {
  if (!binding) throw new Error('pushOrPr: binding is required');
  const required = ['organization', 'project', 'repository', 'branch']; // repositoryId is optional (only used for the branch-policy pre-check)
  for (const key of required) {
    if (!binding[key]) throw new Error(`pushOrPr: binding.${key} is required`);
  }
}

function prIdFrom(result) {
  return result && (result.pullRequestId || result.prId || result.id);
}

function prUrlFrom(result) {
  return result && (result.url || result.prUrl || result.webUrl);
}

function descriptorFrom(prResult, user) {
  if (prResult && prResult.autoCompleteSetByDescriptor) return prResult.autoCompleteSetByDescriptor;
  if (prResult && prResult.createdByDescriptor) return prResult.createdByDescriptor;
  if (prResult && prResult.createdBy && prResult.createdBy.descriptor) return prResult.createdBy.descriptor;
  if (user && typeof user === 'object') return user.descriptor || user.autoCompleteSetByDescriptor || null;
  return null;
}

async function enableAutoCompleteBestEffort({ deps, binding, token, prResult, user }) {
  const prId = prIdFrom(prResult);
  if (!prId) return false;

  if (typeof deps.enableAutoComplete === 'function') {
    const r = await deps.enableAutoComplete({ ...binding, pullRequestId: prId, token, user });
    return r === true || !!(r && (r.ok || r.enabled || r.autoCompleteEnabled));
  }

  if (prResult && prResult.autoCompleteEnabled) return true;
  if (typeof deps.createAdoClient !== 'function') return false;

  const descriptor = descriptorFrom(prResult, user);
  if (!descriptor) return false;

  const client = deps.createAdoClient({
    organization: binding.organization,
    project: binding.project,
    repository: binding.repository,
    token,
    apiVersion: '7.0',
  });

  const res = await client.patch(`/pullrequests/${prId}`, {
    body: {
      autoCompleteSetBy: { descriptor },
      completionOptions: {
        deleteSourceBranch: false,
        mergeCommitMessage: 'Complete Power Pages selective merge',
        squashMerge: false,
      },
    },
  });

  return !!(res && res.statusCode >= 200 && res.statusCode < 300 && !res.error);
}

async function shouldUsePrPath({ deps, binding, token }) {
  // Without the repo GUID we can't query branch policies — skip the pre-check and
  // attempt a direct push; a protected branch will reject it and we fall back to PR.
  if (!binding.repositoryId) return false;
  try {
    const policy = await deps.getBranchPolicies({
      organization: binding.organization,
      project: binding.project,
      repositoryId: binding.repositoryId,
      branch: binding.branch,
      token,
    });
    return !!(policy && policy.hasBlockingPullRequestPolicy);
  } catch {
    return false;
  }
}

async function pushRunBranch({ gitImpl, repoDir, token, runBranch }) {
  const result = await gitImpl.push({
    cwd: repoDir,
    remote: 'origin',
    refspec: `HEAD:refs/heads/${runBranch}`,
    token,
  });
  if (!result || !result.ok) {
    const detail = result && (result.stderr || result.stdout) ? `: ${result.stderr || result.stdout}` : '';
    throw new Error(`pushOrPr: failed to push run branch "${runBranch}"${detail}`);
  }
}

async function createPrPath({ repoDir, binding, user, token, autoComplete, title, description, timestamp, deps, gitImpl }) {
  const runBranch = buildRunBranch({ user, branch: binding.branch, timestamp });
  await pushRunBranch({ gitImpl, repoDir, token, runBranch });

  const pr = await deps.createPr({
    organization: binding.organization,
    project: binding.project,
    repository: binding.repository,
    sourceBranch: runBranch,
    targetBranch: binding.branch,
    title: title || `Power Pages merge into ${stripHeads(binding.branch)}`,
    description: description || 'Power Pages merge resolved in a cloned worktree.',
    token,
  });
  if (!pr || pr.error || pr.created === false) {
    throw new Error(`pushOrPr: failed to create PR${pr && pr.error ? `: ${pr.error}` : ''}`);
  }

  let autoCompleteEnabled = false;
  if (autoComplete) {
    try {
      autoCompleteEnabled = await enableAutoCompleteBestEffort({ deps, binding, token, prResult: pr, user });
    } catch {
      autoCompleteEnabled = false;
    }
  }

  return {
    mode: 'pr',
    prId: prIdFrom(pr),
    prUrl: prUrlFrom(pr),
    runBranch,
    autoCompleteEnabled,
  };
}

async function pushOrPr({
  repoDir,
  binding,
  user,
  token,
  autoComplete = true,
  title,
  description,
  timestamp,
  deps = defaultDeps(),
  gitImpl = gitExec,
} = {}) {
  if (!repoDir) throw new Error('pushOrPr: repoDir is required');
  requireBinding(binding);
  if (!deps || typeof deps.getBranchPolicies !== 'function') throw new Error('pushOrPr: deps.getBranchPolicies is required');
  if (typeof deps.createPr !== 'function') throw new Error('pushOrPr: deps.createPr is required');
  if (!gitImpl || typeof gitImpl.push !== 'function') throw new Error('pushOrPr: gitImpl.push is required');

  const usePrPath = await shouldUsePrPath({ deps, binding, token });
  if (!usePrPath) {
    const pushResult = await gitImpl.push({
      cwd: repoDir,
      remote: 'origin',
      refspec: `HEAD:refs/heads/${binding.branch}`,
      token,
    });
    if (pushResult && pushResult.ok) {
      return { mode: 'direct-push', pushed: true, branch: binding.branch };
    }
  }

  return await createPrPath({
    repoDir, binding, user, token, autoComplete, title, description, timestamp, deps, gitImpl,
  });
}

module.exports = {
  pushOrPr,
  buildRunBranch,
  compactUtcTimestamp,
};

