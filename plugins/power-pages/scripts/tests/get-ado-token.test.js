'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getAdoToken,
  extractTenantIdFromConnectionData,
  ADO_ENTRA_RESOURCE_GUID,
  sha256Hex,
  writeTokenFile,
  redactResult,
} = require('../lib/get-ado-token');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// All tests use DI hooks (_execImpl for `az`, _makeRequestImpl for ADO REST)
// so the suite runs entirely offline. The contract is documented in
// get-ado-token.js's header comment.

// ===== ADO_ENTRA_RESOURCE_GUID is the canonical, tenant-invariant ID =====

test('ADO_ENTRA_RESOURCE_GUID is the documented ADO Entra app id', () => {
  assert.equal(ADO_ENTRA_RESOURCE_GUID, '499b84ac-1321-427f-aa17-267ca6975798');
});

// ===== argument validation =====

test('--verifyTenant without --organization → ok:false', async () => {
  const r = await getAdoToken({ verifyTenant: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /organization/i);
});

// ===== az happy path =====

test('valid az JSON → ok:true with 2-dot token, OAuth tokenType, tenantId, expiresOn', async () => {
  const fakeAz = (cmd) => {
    assert.match(cmd, new RegExp(`az account get-access-token --resource ${ADO_ENTRA_RESOURCE_GUID}`));
    return JSON.stringify({
      token: 'eyJhbGc.eyJzdWIi.signature',
      expiresOn: '2026-06-10T18:33:00+0000',
      tenantId: '11111111-2222-3333-4444-555555555555',
    });
  };
  const r = await getAdoToken({ _execImpl: fakeAz });
  assert.equal(r.ok, true);
  assert.equal(r.tokenType, 'OAuth');
  assert.equal((r.token.match(/\./g) || []).length, 2, 'JWT must have exactly 2 dots');
  assert.equal(r.tenantId, '11111111-2222-3333-4444-555555555555');
  assert.equal(r.expiresOn, '2026-06-10T18:33:00+0000');
  assert.equal(r.adoOrgTenantId, null);
  assert.equal(r.tenantMismatch, false);
  assert.equal(r.hint, null);
});

// ===== az failure paths =====

test('az exits non-zero → ok:false with az login hint and stderr in error', async () => {
  const fakeAz = () => {
    const err = new Error('Command failed');
    err.stderr = Buffer.from('ERROR: Please run "az login" to setup account.\n');
    throw err;
  };
  const r = await getAdoToken({ _execImpl: fakeAz });
  assert.equal(r.ok, false);
  assert.match(r.error, /az login/);
  assert.match(r.error, /Please run "az login"/);
});

test('az returns non-JSON → ok:false', async () => {
  const fakeAz = () => 'not actually json';
  const r = await getAdoToken({ _execImpl: fakeAz });
  assert.equal(r.ok, false);
  assert.match(r.error, /non-JSON/);
});

test('az returns JSON without accessToken → ok:false', async () => {
  const fakeAz = () => JSON.stringify({ tenantId: 'x' });
  const r = await getAdoToken({ _execImpl: fakeAz });
  assert.equal(r.ok, false);
  assert.match(r.error, /accessToken/);
});

// ===== --verifyTenant + connectionData =====

const VALID_AZ_PAYLOAD = () => JSON.stringify({
  token: 'eyJhbGc.eyJzdWIi.signature',
  expiresOn: '2026-06-10T18:33:00+0000',
  tenantId: '11111111-2222-3333-4444-555555555555',
});

test('verifyTenant: connectionData returns matching tenant → tenantMismatch:false', async () => {
  const fakeMake = async ({ url, headers }) => {
    assert.match(url, /dev\.azure\.com\/contoso\/_apis\/connectionData/);
    assert.equal(headers.Authorization, 'Bearer eyJhbGc.eyJzdWIi.signature');
    return {
      statusCode: 200,
      body: JSON.stringify({
        authenticatedUser: {
          properties: {
            'Microsoft.IdentityModel.Claims.TenantId': {
              $value: '11111111-2222-3333-4444-555555555555',
            },
          },
        },
      }),
    };
  };
  const r = await getAdoToken({
    organization: 'contoso',
    verifyTenant: true,
    _execImpl: VALID_AZ_PAYLOAD,
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, true);
  assert.equal(r.adoOrgTenantId, '11111111-2222-3333-4444-555555555555');
  assert.equal(r.tenantMismatch, false);
  assert.equal(r.hint, null);
});

test('verifyTenant: connectionData returns different tenant → tenantMismatch:true with hint', async () => {
  const fakeMake = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      authorizedUser: {
        properties: {
          'Microsoft.IdentityModel.Claims.TenantId': {
            $value: '99999999-aaaa-bbbb-cccc-dddddddddddd',
          },
        },
      },
    }),
  });
  const r = await getAdoToken({
    organization: 'contoso',
    verifyTenant: true,
    _execImpl: VALID_AZ_PAYLOAD,
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, true);
  assert.equal(r.adoOrgTenantId, '99999999-aaaa-bbbb-cccc-dddddddddddd');
  assert.equal(r.tenantMismatch, true);
  assert.match(r.hint, /az login --tenant 99999999-aaaa-bbbb-cccc-dddddddddddd/);
});

test('verifyTenant: connectionData lacks tenant claim → tenantMismatch:false with skipped hint', async () => {
  const fakeMake = async () => ({
    statusCode: 200,
    body: JSON.stringify({ authenticatedUser: { id: 'user-without-tenant-claim' } }),
  });
  const r = await getAdoToken({
    organization: 'contoso',
    verifyTenant: true,
    _execImpl: VALID_AZ_PAYLOAD,
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, true);
  assert.equal(r.adoOrgTenantId, null);
  assert.equal(r.tenantMismatch, false);
  assert.match(r.hint, /verification skipped/i);
});

test('verifyTenant: connectionData returns 401 → tenantMismatch:false with skipped hint', async () => {
  const fakeMake = async () => ({ statusCode: 401, body: '{"message":"Unauthorized"}' });
  const r = await getAdoToken({
    organization: 'contoso',
    verifyTenant: true,
    _execImpl: VALID_AZ_PAYLOAD,
    _makeRequestImpl: fakeMake,
  });
  // Don't hard-block — we have a token; the org just isn't probable. Soft skip.
  assert.equal(r.ok, true);
  assert.equal(r.tenantMismatch, false);
  assert.match(r.hint, /HTTP 401/);
});

test('verifyTenant: connectionData network error → tenantMismatch:false with reachability hint', async () => {
  const fakeMake = async () => ({ error: 'ECONNREFUSED' });
  const r = await getAdoToken({
    organization: 'contoso',
    verifyTenant: true,
    _execImpl: VALID_AZ_PAYLOAD,
    _makeRequestImpl: fakeMake,
  });
  assert.equal(r.ok, true);
  assert.equal(r.tenantMismatch, false);
  assert.match(r.hint, /could not reach/);
  assert.match(r.hint, /ECONNREFUSED/);
});

// ===== extractTenantIdFromConnectionData unit cases =====

test('extractTenantIdFromConnectionData: authenticatedUser path', () => {
  const t = extractTenantIdFromConnectionData({
    authenticatedUser: {
      properties: {
        'Microsoft.IdentityModel.Claims.TenantId': {
          $value: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
      },
    },
  });
  assert.equal(t, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('extractTenantIdFromConnectionData: authorizedUser fallback path', () => {
  const t = extractTenantIdFromConnectionData({
    authorizedUser: {
      properties: {
        TenantId: { $value: '12345678-1234-1234-1234-123456789012' },
      },
    },
  });
  assert.equal(t, '12345678-1234-1234-1234-123456789012');
});

test('extractTenantIdFromConnectionData: rejects non-GUID values', () => {
  const t = extractTenantIdFromConnectionData({
    authenticatedUser: {
      properties: {
        'Microsoft.IdentityModel.Claims.TenantId': { $value: 'not-a-guid' },
      },
    },
  });
  assert.equal(t, null);
});

test('extractTenantIdFromConnectionData: missing properties → null', () => {
  assert.equal(extractTenantIdFromConnectionData({}), null);
  assert.equal(extractTenantIdFromConnectionData(null), null);
  assert.equal(extractTenantIdFromConnectionData({ authenticatedUser: {} }), null);
});

test('extractTenantIdFromConnectionData: properties as raw string (not {$value})', () => {
  const t = extractTenantIdFromConnectionData({
    authenticatedUser: {
      properties: {
        'Microsoft.IdentityModel.Claims.TenantId': '12345678-1234-1234-1234-123456789012',
      },
    },
  });
  assert.equal(t, '12345678-1234-1234-1234-123456789012');
});

// ===== --writeToFile + --mask redaction (E3 security fix) =====

test('default mode (no --writeToFile, no --mask) returns token in result for back-compat', async () => {
  const r = await getAdoToken({ _execImpl: VALID_AZ_PAYLOAD });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'eyJhbGc.eyJzdWIi.signature', 'default mode MUST include token (back-compat)');
  assert.equal(r.tokenFile, undefined);
  assert.equal(r.tokenSha256, undefined);
});

test('--mask omits token and includes tokenSha256 (no file written)', async () => {
  const r = await getAdoToken({ mask: true, _execImpl: VALID_AZ_PAYLOAD });
  assert.equal(r.ok, true);
  assert.equal(r.token, undefined, 'masked result MUST NOT contain token');
  assert.equal(r.tokenFile, undefined);
  assert.equal(typeof r.tokenSha256, 'string');
  assert.equal(r.tokenSha256.length, 64);
  assert.equal(r.tokenSha256, sha256Hex('eyJhbGc.eyJzdWIi.signature'));
  // Non-token fields preserved
  assert.equal(r.tokenType, 'OAuth');
  assert.equal(r.tenantId, '11111111-2222-3333-4444-555555555555');
});

test('--writeToFile writes payload to disk, omits token from result, includes tokenFile + tokenSha256', async () => {
  let captured = null;
  const fakeWriter = (filePath, payload) => {
    captured = { filePath, payload };
    return path.resolve(filePath);
  };
  const targetPath = '/tmp/test-ado-token.json';
  const r = await getAdoToken({
    writeToFile: targetPath,
    _execImpl: VALID_AZ_PAYLOAD,
    _writeToFileImpl: fakeWriter,
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, undefined, 'writeToFile result MUST NOT contain token in stdout');
  assert.equal(r.tokenFile, path.resolve(targetPath));
  assert.equal(r.tokenSha256, sha256Hex('eyJhbGc.eyJzdWIi.signature'));
  // The file payload MUST contain the raw token + canonical fields.
  assert.ok(captured, 'writer must be called');
  assert.equal(captured.filePath, targetPath);
  assert.equal(captured.payload.token, 'eyJhbGc.eyJzdWIi.signature');
  assert.equal(captured.payload.tokenType, 'OAuth');
  assert.equal(captured.payload.tenantId, '11111111-2222-3333-4444-555555555555');
  assert.equal(captured.payload.expiresOn, '2026-06-10T18:33:00+0000');
  assert.equal(captured.payload.adoOrgTenantId, null);
  assert.equal(captured.payload.tenantMismatch, false);
  // hint is transient stdout-only — MUST NOT appear in the file payload
  assert.equal(captured.payload.hint, undefined);
});

test('--writeToFile + --mask combined: file written, stdout still redacted with sha256', async () => {
  let captured = null;
  const fakeWriter = (filePath, payload) => {
    captured = { filePath, payload };
    return path.resolve(filePath);
  };
  const r = await getAdoToken({
    writeToFile: '/tmp/test-combo.json',
    mask: true,
    _execImpl: VALID_AZ_PAYLOAD,
    _writeToFileImpl: fakeWriter,
  });
  assert.equal(r.token, undefined);
  assert.equal(r.tokenFile, path.resolve('/tmp/test-combo.json'));
  assert.equal(r.tokenSha256, sha256Hex('eyJhbGc.eyJzdWIi.signature'));
  assert.ok(captured);
  assert.equal(captured.payload.token, 'eyJhbGc.eyJzdWIi.signature');
});

test('--writeToFile with --verifyTenant: file payload includes tenant-cross-check fields', async () => {
  let captured = null;
  const fakeWriter = (filePath, payload) => {
    captured = { filePath, payload };
    return path.resolve(filePath);
  };
  const fakeMake = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      authenticatedUser: {
        properties: {
          'Microsoft.IdentityModel.Claims.TenantId': {
            $value: '99999999-aaaa-bbbb-cccc-dddddddddddd',
          },
        },
      },
    }),
  });
  const r = await getAdoToken({
    organization: 'contoso',
    verifyTenant: true,
    writeToFile: '/tmp/test-verify.json',
    _execImpl: VALID_AZ_PAYLOAD,
    _makeRequestImpl: fakeMake,
    _writeToFileImpl: fakeWriter,
  });
  assert.equal(r.token, undefined);
  assert.equal(r.adoOrgTenantId, '99999999-aaaa-bbbb-cccc-dddddddddddd');
  assert.equal(r.tenantMismatch, true);
  assert.match(r.hint, /az login --tenant/);
  // The file MUST capture the tenant cross-check result too — it's the
  // canonical bundle a downstream caller might verify against.
  assert.equal(captured.payload.adoOrgTenantId, '99999999-aaaa-bbbb-cccc-dddddddddddd');
  assert.equal(captured.payload.tenantMismatch, true);
});

test('--writeToFile on az failure: NO file is written, error surfaces in stdout', async () => {
  let called = false;
  const fakeWriter = () => { called = true; return '/x'; };
  const fakeAz = () => {
    const err = new Error('Command failed');
    err.stderr = Buffer.from('ERROR: az login required\n');
    throw err;
  };
  const r = await getAdoToken({
    writeToFile: '/tmp/should-not-exist.json',
    _execImpl: fakeAz,
    _writeToFileImpl: fakeWriter,
  });
  assert.equal(r.ok, false);
  assert.equal(called, false, 'token file MUST NOT be written when token acquisition fails');
});

// ===== writeTokenFile real-disk integration test =====

test('writeTokenFile creates the file, JSON-encodes the payload, chmods 0o600 on POSIX', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-token-test-'));
  const filePath = path.join(tmpDir, 'sub', '.ado-token');
  const payload = { token: 'eyJ.x.y', tokenType: 'OAuth', tenantId: 'a-b-c' };
  try {
    const abs = writeTokenFile(filePath, payload);
    assert.equal(abs, path.resolve(filePath));
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    assert.deepEqual(parsed, payload);
    if (process.platform !== 'win32') {
      const stat = fs.statSync(abs);
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600, `expected mode 0o600, got 0o${mode.toString(8)}`);
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ===== sha256Hex unit =====

test('sha256Hex produces 64-char hex digest matching node:crypto', () => {
  const expected = require('node:crypto').createHash('sha256').update('hello', 'utf8').digest('hex');
  assert.equal(sha256Hex('hello'), expected);
  assert.equal(sha256Hex('').length, 64);
});

// ===== redactResult unit =====

test('redactResult strips token field, optionally adds tokenSha256 and tokenFile', () => {
  const full = { ok: true, token: 'abc.def.ghi', tokenType: 'OAuth', tenantId: 't1' };
  const plain = redactResult(full);
  assert.equal(plain.token, undefined);
  assert.equal(plain.tokenType, 'OAuth');
  assert.equal(plain.tenantId, 't1');
  assert.equal(plain.tokenSha256, undefined);
  assert.equal(plain.tokenFile, undefined);

  const withSha = redactResult(full, { includeSha256: true });
  assert.equal(withSha.tokenSha256, sha256Hex('abc.def.ghi'));

  const withFile = redactResult(full, { tokenFile: '/a/b/c' });
  assert.equal(withFile.tokenFile, '/a/b/c');
});
