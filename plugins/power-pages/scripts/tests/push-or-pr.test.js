'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pushOrPr, buildRunBranch } = require('../lib/push-or-pr');

const binding = {
  organization: 'org',
  project: 'proj',
  repository: 'repo',
  repositoryId: '00000000-0000-0000-0000-000000000001',
  branch: 'feature/site',
};

function makeGit(pushResults) {
  const pushes = [];
  return {
    pushes,
    async push(args) {
      pushes.push(args);
      return pushResults.shift() || { ok: true, code: 0, stdout: '', stderr: '' };
    },
  };
}

function makeDeps({ blocking = false, prResult = null, createAdoClient = null } = {}) {
  const calls = { policies: [], prs: [], patches: [] };
  return {
    calls,
    async getBranchPolicies(args) {
      calls.policies.push(args);
      return { hasBlockingPullRequestPolicy: blocking };
    },
    async createPr(args) {
      calls.prs.push(args);
      return prResult || {
        created: true,
        pullRequestId: 42,
        url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/42',
        createdByDescriptor: 'aad.user-descriptor',
      };
    },
    createAdoClient: createAdoClient || (() => ({
      async patch(path, opts) {
        calls.patches.push({ path, opts });
        return { statusCode: 200, body: '{}' };
      },
    })),
  };
}

test('pushOrPr: no blocking policy and push ok returns direct-push', async () => {
  const gitImpl = makeGit([{ ok: true, code: 0, stdout: 'pushed', stderr: '' }]);
  const deps = makeDeps({ blocking: false });

  const result = await pushOrPr({
    repoDir: 'C:\\repo',
    binding,
    user: 'alice',
    token: 'token',
    deps,
    gitImpl,
  });

  assert.deepEqual(result, { mode: 'direct-push', pushed: true, branch: 'feature/site' });
  assert.equal(gitImpl.pushes.length, 1);
  assert.equal(gitImpl.pushes[0].refspec, 'HEAD:refs/heads/feature/site');
  assert.equal(deps.calls.prs.length, 0);
});

test('pushOrPr: rejected direct push falls back to run branch and PR', async () => {
  const gitImpl = makeGit([
    { ok: false, code: 1, stdout: '', stderr: 'non-fast-forward' },
    { ok: true, code: 0, stdout: 'pushed run branch', stderr: '' },
  ]);
  const deps = makeDeps({ blocking: false });

  const result = await pushOrPr({
    repoDir: 'C:\\repo',
    binding,
    user: 'alice',
    token: 'token',
    timestamp: '20260623-0249',
    deps,
    gitImpl,
  });

  assert.equal(result.mode, 'pr');
  assert.equal(result.prId, 42);
  assert.equal(result.runBranch, 'pp-merge/alice/feature-site-20260623-0249');
  assert.equal(gitImpl.pushes.length, 2);
  assert.equal(gitImpl.pushes[1].refspec, 'HEAD:refs/heads/pp-merge/alice/feature-site-20260623-0249');
  assert.equal(deps.calls.prs.length, 1);
  assert.equal(deps.calls.prs[0].sourceBranch, 'pp-merge/alice/feature-site-20260623-0249');
  assert.equal(deps.calls.prs[0].targetBranch, 'feature/site');
});

test('pushOrPr: blocking policy skips direct push and uses PR path', async () => {
  const gitImpl = makeGit([{ ok: true, code: 0, stdout: 'pushed run branch', stderr: '' }]);
  const deps = makeDeps({ blocking: true });

  const result = await pushOrPr({
    repoDir: 'C:\\repo',
    binding,
    user: 'alice',
    token: 'token',
    timestamp: '20260623-0249',
    deps,
    gitImpl,
  });

  assert.equal(result.mode, 'pr');
  assert.equal(gitImpl.pushes.length, 1);
  assert.equal(gitImpl.pushes[0].refspec, 'HEAD:refs/heads/pp-merge/alice/feature-site-20260623-0249');
  assert.equal(deps.calls.prs[0].sourceBranch, 'pp-merge/alice/feature-site-20260623-0249');
});

test('pushOrPr: run-branch name format uses user, branch suffix, and timestamp', () => {
  assert.equal(
    buildRunBranch({ user: 'alice', branch: 'feature/site', timestamp: '20260623-0249' }),
    'pp-merge/alice/feature-site-20260623-0249',
  );
});

test('pushOrPr: autoComplete=true requests auto-complete with PATCH', async () => {
  const gitImpl = makeGit([{ ok: true, code: 0, stdout: 'pushed run branch', stderr: '' }]);
  const deps = makeDeps({ blocking: true });

  const result = await pushOrPr({
    repoDir: 'C:\\repo',
    binding,
    user: 'alice',
    token: 'token',
    autoComplete: true,
    timestamp: '20260623-0249',
    deps,
    gitImpl,
  });

  assert.equal(result.autoCompleteEnabled, true);
  assert.equal(deps.calls.patches.length, 1);
  assert.equal(deps.calls.patches[0].path, '/pullrequests/42');
  assert.deepEqual(deps.calls.patches[0].opts.body.autoCompleteSetBy, { descriptor: 'aad.user-descriptor' });
  assert.equal(deps.calls.patches[0].opts.body.completionOptions.deleteSourceBranch, false);
});

