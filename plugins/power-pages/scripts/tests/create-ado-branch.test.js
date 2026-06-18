'use strict';

// Offline DI-driven tests for create-ado-branch.js — the helper git-configure
// Phase 4 calls (gate git-configure:4.create-branch) to create a feature branch
// in a populated ADO repo (the gap that previously forced manual ADO branch
// creation before switch-branch). No network: every HTTP call is the injected
// _makeRequestImpl.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withNoAdoAcquire } = require('./ado-test-helpers');
const {
  createAdoBranch,
  API_VERSION,
  ZERO_OBJECT_ID,
  normalizeRefName,
  validateBranchName,
} = require('../lib/create-ado-branch');

// ===== constants + small helpers =====

test('API_VERSION is the stable 7.1 (matches list-ado-branches, check-ado-folder-exists)', () => {
  assert.equal(API_VERSION, '7.1');
});

test('ZERO_OBJECT_ID is 40 zeros (the git "create ref" sentinel)', () => {
  assert.equal(ZERO_OBJECT_ID, '0'.repeat(40));
});

test('normalizeRefName strips refs/heads/ and trims; preserves internal slashes', () => {
  assert.equal(normalizeRefName('main'), 'main');
  assert.equal(normalizeRefName('refs/heads/feature/dev-a'), 'feature/dev-a');
  assert.equal(normalizeRefName('  feature/dev-a  '), 'feature/dev-a');
  assert.equal(normalizeRefName(''), null);
  assert.equal(normalizeRefName(null), null);
});

test('validateBranchName accepts valid names (incl. forward slashes)', () => {
  assert.equal(validateBranchName('main').ok, true);
  assert.equal(validateBranchName('feature/dev-a').ok, true);
  assert.equal(validateBranchName('release/1.2/hotfix').ok, true);
});

test('validateBranchName rejects git-invalid names before any network call', () => {
  assert.equal(validateBranchName('').ok, false);
  assert.equal(validateBranchName('feature\\dev').ok, false);
  assert.equal(validateBranchName('feature dev').ok, false);
  assert.equal(validateBranchName('feature/..//dev').ok, false);
  assert.equal(validateBranchName('/feature').ok, false);
  assert.equal(validateBranchName('feature/').ok, false);
  assert.equal(validateBranchName('feature/dev~1').ok, false);
  assert.equal(validateBranchName('feature/dev.lock').ok, false);
  assert.equal(validateBranchName('.hidden').ok, false);
});

// ===== argument validation =====

test('required-arg validation: --organization missing', async () => {
  const r = await createAdoBranch({ project: 'p', repository: 'r', newBranch: 'feature/x', baseBranch: 'main', token: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /organization/);
});

test('required-arg validation: --newBranch missing', async () => {
  const r = await createAdoBranch({ organization: 'o', project: 'p', repository: 'r', baseBranch: 'main', token: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /newBranch/);
});

test('required-arg validation: --baseBranch (and no --baseSha) missing', async () => {
  const r = await createAdoBranch({ organization: 'o', project: 'p', repository: 'r', newBranch: 'feature/x', token: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /baseBranch|baseSha/);
});

test('required-arg validation: --token missing', async () => {
  const r = await withNoAdoAcquire(() => createAdoBranch({ organization: 'o', project: 'p', repository: 'r', newBranch: 'feature/x', baseBranch: 'main' }));
  assert.equal(r.ok, false); assert.match(r.error, /token/);
});

test('invalid new-branch name is rejected before any network call', async () => {
  let called = false;
  const r = await createAdoBranch({
    organization: 'o', project: 'p', repository: 'r',
    newBranch: 'bad branch name', baseBranch: 'main', token: 't',
    _makeRequestImpl: async () => { called = true; return { statusCode: 200, body: '{}' }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /whitespace/);
  assert.equal(called, false, 'helper must not make any HTTP call when the branch name is invalid');
});

// ===== idempotency =====

test('branch already exists → ok:true, alreadyExists:true, created:false, no POST made', async () => {
  let postCount = 0;
  const r = await createAdoBranch({
    organization: 'o', project: 'p', repository: 'r',
    newBranch: 'feature/dev-a', baseBranch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      if (opts.method === 'POST') postCount++;
      // first GET (existing newBranch) returns a hit
      return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'existingsha' }] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyExists, true);
  assert.equal(r.created, false);
  assert.equal(r.baseSha, 'existingsha');
  assert.equal(postCount, 0, 'must not POST when the branch already exists');
});

// ===== happy path =====

test('creates branch from base HEAD → created:true with correct POST URL + body', async () => {
  const calls = [];
  let postBody;
  const r = await createAdoBranch({
    organization: 'myorg', project: 'myproj', repository: 'myrepo',
    newBranch: 'feature/dev-a', baseBranch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      calls.push(opts);
      if (opts.method === 'GET' && /filter=heads%2Ffeature%2Fdev-a/.test(opts.url)) {
        return { statusCode: 200, body: JSON.stringify({ value: [] }) }; // newBranch not found
      }
      if (opts.method === 'GET' && /filter=heads%2Fmain/.test(opts.url)) {
        return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'basesha123' }] }) };
      }
      // POST create
      postBody = JSON.parse(opts.body);
      return { statusCode: 200, body: JSON.stringify({ value: [{ success: true, updateStatus: 'succeeded' }] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.alreadyExists, false);
  assert.equal(r.baseSha, 'basesha123');
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'a POST must be made');
  assert.match(post.url, /\/refs\?api-version=7\.1$/);
  assert.equal(postBody[0].name, 'refs/heads/feature/dev-a');
  assert.equal(postBody[0].oldObjectId, '0'.repeat(40));
  assert.equal(postBody[0].newObjectId, 'basesha123');
});

test('--baseSha bypasses the base-branch lookup GET', async () => {
  let baseLookup = false;
  const r = await createAdoBranch({
    organization: 'o', project: 'p', repository: 'r',
    newBranch: 'feature/x', baseBranch: 'main', baseSha: 'pinnedsha', token: 't',
    _makeRequestImpl: async (opts) => {
      if (opts.method === 'GET' && /filter=heads%2Fmain/.test(opts.url)) baseLookup = true;
      if (opts.method === 'GET') return { statusCode: 200, body: JSON.stringify({ value: [] }) };
      return { statusCode: 200, body: JSON.stringify({ value: [{ success: true }] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.baseSha, 'pinnedsha');
  assert.equal(baseLookup, false, 'must not look up the base branch when --baseSha is supplied');
});

// ===== error paths =====

test('base branch not found → ok:false, statusCode 404', async () => {
  const r = await createAdoBranch({
    organization: 'o', project: 'p', repository: 'r',
    newBranch: 'feature/x', baseBranch: 'nope', token: 't',
    _makeRequestImpl: async (opts) => {
      if (/filter=heads%2Ffeature%2Fx/.test(opts.url)) return { statusCode: 200, body: JSON.stringify({ value: [] }) };
      return { statusCode: 200, body: JSON.stringify({ value: [] }) }; // base lookup empty
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 404);
  assert.match(r.error, /Base branch "nope" not found/);
});

test('ADO refuses the ref update (success:false) → ok:false with updateStatus', async () => {
  const r = await createAdoBranch({
    organization: 'o', project: 'p', repository: 'r',
    newBranch: 'feature/x', baseBranch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      if (opts.method === 'GET' && /filter=heads%2Ffeature%2Fx/.test(opts.url)) return { statusCode: 200, body: JSON.stringify({ value: [] }) };
      if (opts.method === 'GET') return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) };
      return { statusCode: 200, body: JSON.stringify({ value: [{ success: false, updateStatus: 'rejectedByPolicy' }] }) };
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /rejectedByPolicy/);
});

test('403 on create → ok:false, statusCode 403, hint about Create Branch', async () => {
  const r = await createAdoBranch({
    organization: 'o', project: 'p', repository: 'r',
    newBranch: 'feature/x', baseBranch: 'main', token: 't',
    _makeRequestImpl: async (opts) => {
      if (opts.method === 'GET' && /filter=heads%2Ffeature%2Fx/.test(opts.url)) return { statusCode: 200, body: JSON.stringify({ value: [] }) };
      if (opts.method === 'GET') return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) };
      return { statusCode: 403, body: '{}' };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 403);
  assert.match(r.hint, /Create Branch|Contribute/);
});

test('network error on the existence probe → ok:false, error surfaced verbatim', async () => {
  const r = await createAdoBranch({
    organization: 'o', project: 'p', repository: 'r',
    newBranch: 'feature/x', baseBranch: 'main', token: 't',
    _makeRequestImpl: async () => ({ error: 'ECONNREFUSED', body: '' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('--branch and --fromBranch aliases + --tokenFile envelope work', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-create-ado-branch.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  try {
    const headers = [];
    const r = await createAdoBranch({
      organization: 'o', project: 'p', repository: 'r',
      branch: 'feature/aliased', fromBranch: 'main', tokenFile,
      _makeRequestImpl: async (opts) => {
        headers.push(opts.headers.Authorization);
        if (opts.method === 'GET' && /filter=heads%2Ffeature%2Faliased/.test(opts.url)) return { statusCode: 200, body: JSON.stringify({ value: [] }) };
        if (opts.method === 'GET') return { statusCode: 200, body: JSON.stringify({ value: [{ objectId: 'sha' }] }) };
        return { statusCode: 200, body: JSON.stringify({ value: [{ success: true }] }) };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.newBranch, 'feature/aliased');
    assert.equal(r.baseBranch, 'main');
    assert.ok(headers.every((h) => h === 'Bearer header.payload.sig'));
  } finally { fs.rmSync(tokenFile, { force: true }); }
});
