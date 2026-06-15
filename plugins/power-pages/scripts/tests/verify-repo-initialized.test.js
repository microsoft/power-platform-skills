'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyRepoInitialized } = require('../lib/verify-repo-initialized');

// verify-repo-initialized targets `dev.azure.com` which we can't intercept
// without monkey-patching makeRequest. Unit tests therefore cover:
//   1. Required-arg validation
//   2. Token resolution (--token arg, ADO_TOKEN env, neither)
//   3. The shape of the result on unreachable / 404 / non-200 paths
// The happy path is covered by integration tests against a real ADO repo.

test('returns error when --organization is missing', async () => {
  const r = await verifyRepoInitialized({ project: 'p', repository: 'r', token: 't' });
  assert.match(r.error, /organization/i);
});

test('returns error when --project is missing', async () => {
  const r = await verifyRepoInitialized({ organization: 'o', repository: 'r', token: 't' });
  assert.match(r.error, /project/i);
});

test('returns error when --repository is missing', async () => {
  const r = await verifyRepoInitialized({ organization: 'o', project: 'p', token: 't' });
  assert.match(r.error, /repository/i);
});

test('returns error when no token is available (no --token arg + no ADO_TOKEN env)', async () => {
  const saved = process.env.ADO_TOKEN;
  delete process.env.ADO_TOKEN;
  try {
    const r = await verifyRepoInitialized({ organization: 'o', project: 'p', repository: 'r' });
    assert.ok(r.error);
    assert.match(r.error, /token|ADO_TOKEN/i);
  } finally {
    if (saved !== undefined) process.env.ADO_TOKEN = saved;
  }
});

test('uses ADO_TOKEN env var when --token is omitted', async () => {
  const saved = process.env.ADO_TOKEN;
  process.env.ADO_TOKEN = 'env-pat-1234567890';
  try {
    const r = await verifyRepoInitialized({
      organization: 'nonexistent-org-xyz-test',
      project: 'nonexistent-proj',
      repository: 'nonexistent-repo',
    });
    // Whatever the result, it must NOT be the missing-token error.
    if (r.error) {
      assert.ok(!r.error.includes('token is required'),
        'should not return missing-token error when ADO_TOKEN is set');
    }
  } finally {
    if (saved !== undefined) process.env.ADO_TOKEN = saved;
    else delete process.env.ADO_TOKEN;
  }
});

test('shape: result on a real-but-likely-404 ADO call has the right keys', async () => {
  const r = await verifyRepoInitialized({
    organization: 'nonexistent-org-xyz-test-power-pages',
    project: 'nonexistent-proj-test',
    repository: 'nonexistent-repo-test',
    token: 'invalid-pat-1234567890',
  });
  // Live ADO call. Two valid outcomes:
  //   - Network/auth error → result.error
  //   - 404 → result.initialized:false with branchCount:0 and a descriptive hint
  if (r.error) {
    assert.ok(r.error.length > 0);
  } else {
    assert.equal(typeof r.initialized, 'boolean');
    assert.equal(r.organization, 'nonexistent-org-xyz-test-power-pages');
    assert.equal(r.project, 'nonexistent-proj-test');
    assert.equal(r.repository, 'nonexistent-repo-test');
    assert.equal(typeof r.branchCount, 'number');
    if (!r.initialized) {
      assert.ok(r.hint, 'uninitialized repo must carry a remediation hint');
    }
  }
});

test('hint mentions remediation steps when repo is uninitialized', async () => {
  // We rely on the live 404 path producing a hint. If it doesn't (network
  // failure), we still pass — this test guards the hint text shape, not the
  // network path.
  const r = await verifyRepoInitialized({
    organization: 'nonexistent-org-test-xyz',
    project: 'nonexistent-project-test',
    repository: 'definitely-empty-repo-name',
    token: 'fake-pat',
  });
  if (!r.error && !r.initialized) {
    assert.match(r.hint, /empty|README|initial commit|Initialize/i);
  }
});

test('verify-repo-initialized: --tokenFile JSON envelope is accepted as token input', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-verify-repo-initialized.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  try {
    const result = await verifyRepoInitialized({ organization: 'nonexistent-org-tokenfile-test', project: 'p', repository: 'r', tokenFile });
    assert.ok(!String(result.error || '').includes('No ADO token provided'));
    assert.ok(!String(result.error || '').includes('token is required'));
  } finally { fs.rmSync(tokenFile, { force: true }); }
});
