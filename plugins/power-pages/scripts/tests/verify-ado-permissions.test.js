'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyAdoPermissions, buildAuthHeader } = require('../lib/verify-ado-permissions');

function adoArgs(overrides = {}) {
  return {
    organization: 'contoso',
    project: 'pp-site',
    repository: 'pp-site-repo',
    token: 'test-pat-token',
    adoBaseUrl: 'https://unit.test/contoso',
    ...overrides,
  };
}

// ===== buildAuthHeader =====

test('buildAuthHeader: PAT (no periods) → Basic base64 header', () => {
  const pat = 'myPersonalAccessToken1234';
  const { header, tokenType } = buildAuthHeader(pat);
  assert.equal(tokenType, 'PAT');
  assert.ok(header.startsWith('Basic '), 'PAT must produce Basic auth');
  // Verify the base64 encodes ":token" correctly.
  const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8');
  assert.equal(decoded, `:${pat}`);
});

test('buildAuthHeader: JWT (two periods) → Bearer header', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature';
  const { header, tokenType } = buildAuthHeader(jwt);
  assert.equal(tokenType, 'OAuth');
  assert.equal(header, `Bearer ${jwt}`);
});

test('buildAuthHeader: one-period token is treated as PAT (edge case)', () => {
  const edgeToken = 'prefix.suffix'; // one period → < 2 → PAT
  const { tokenType } = buildAuthHeader(edgeToken);
  assert.equal(tokenType, 'PAT');
});

// ===== verifyAdoPermissions — missing args =====

test('returns error when --organization is missing', async () => {
  const result = await verifyAdoPermissions({ project: 'p', repository: 'r', token: 't' });
  assert.match(result.error, /organization/i);
});

test('returns error when --project is missing', async () => {
  const result = await verifyAdoPermissions({ organization: 'o', repository: 'r', token: 't' });
  assert.match(result.error, /project/i);
});

test('returns error when --repository is missing', async () => {
  const result = await verifyAdoPermissions({ organization: 'o', project: 'p', token: 't' });
  assert.match(result.error, /repository/i);
});

test('returns error with PAT instructions when no token is available', async () => {
  // Remove ADO_TOKEN env var and disable self-acquire for the duration of this test.
  const saved = process.env.ADO_TOKEN;
  const savedNoAcquire = process.env.POWERPAGES_NO_ADO_ACQUIRE;
  delete process.env.ADO_TOKEN;
  process.env.POWERPAGES_NO_ADO_ACQUIRE = '1';
  try {
    const result = await verifyAdoPermissions({ organization: 'o', project: 'p', repository: 'r' });
    assert.ok(result.error, 'should surface a token-missing error');
    assert.match(result.error, /token|PAT/i);
  } finally {
    if (saved !== undefined) process.env.ADO_TOKEN = saved;
    else delete process.env.ADO_TOKEN;
    if (savedNoAcquire !== undefined) process.env.POWERPAGES_NO_ADO_ACQUIRE = savedNoAcquire;
    else delete process.env.POWERPAGES_NO_ADO_ACQUIRE;
  }
});

// ===== verifyAdoPermissions — deterministic ADO request paths =====

test('returns successful access shape from injected ADO responses', async () => {
  const calls = [];
  const result = await verifyAdoPermissions(adoArgs({
    requestImpl: async (req) => {
      calls.push(req);
      if (req.url.includes('/refs?')) return { statusCode: 200, body: '{"value":[]}' };
      return { statusCode: 200, body: JSON.stringify({ id: 'repo-guid', defaultBranch: 'refs/heads/main' }) };
    },
  }));

  assert.equal(result.error, undefined);
  assert.equal(result.hasAccess, true);
  assert.equal(result.canRead, true);
  assert.equal(result.canReadRefs, true);
  assert.equal(result.tokenType, 'PAT');
  assert.equal(result.repoId, 'repo-guid');
  assert.equal(result.defaultBranch, 'main');
  assert.equal(calls.length, 2);
});

test('returns an error envelope when the repository request fails', async () => {
  const result = await verifyAdoPermissions(adoArgs({
    requestImpl: async () => ({ error: 'network unavailable' }),
  }));

  assert.match(result.error, /network unavailable/);
});

test('ADO_TOKEN env var is used when no --token flag is passed', async () => {
  const saved = process.env.ADO_TOKEN;
  process.env.ADO_TOKEN = 'env-var-pat-token';
  try {
    // Should not return the "token is required" error.
    const result = await verifyAdoPermissions({
      organization: 'contoso',
      project: 'pp-site',
      repository: 'pp-site-repo',
      adoBaseUrl: 'https://unit.test/contoso',
      requestImpl: async () => ({ statusCode: 401, body: '{}' }),
      // no token
    });
    // Whatever the result, it must not be the missing-token error.
    if (result.error) {
      assert.ok(!result.error.includes('token is required'),
        'should not return missing-token error when ADO_TOKEN is set');
    }
  } finally {
    if (saved !== undefined) process.env.ADO_TOKEN = saved;
    else delete process.env.ADO_TOKEN;
  }
});

// ===== verifyAdoPermissions — hint messages =====

test('returns a not-found hint when the repository request returns 404', async () => {
  const result = await verifyAdoPermissions(adoArgs({
    organization: 'nonexistent-org-xyz',
    project: 'nonexistent-project',
    repository: 'nonexistent-repo',
    token: 'invalid-token-12345',
    requestImpl: async () => ({ statusCode: 404, body: '{}' }),
  }));

  assert.equal(result.hasAccess, false);
  assert.match(result.hint, /not found|404/i);
});

test('verify-ado-permissions: --tokenFile JSON envelope is accepted as token input', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-verify-ado-permissions.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  try {
    const result = await verifyAdoPermissions({
      organization: 'nonexistent-org-tokenfile-test',
      project: 'p',
      repository: 'r',
      tokenFile,
      adoBaseUrl: 'https://unit.test/nonexistent-org-tokenfile-test',
      requestImpl: async () => ({ statusCode: 401, body: '{}' }),
    });
    assert.ok(!String(result.error || '').includes('No ADO token provided'));
    assert.ok(!String(result.error || '').includes('token is required'));
  } finally { fs.rmSync(tokenFile, { force: true }); }
});
