'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { verifyByokCmk, BAP_RESOURCE, BAP_API_VERSION, buildHint } = require('../lib/verify-byok-cmk');

function createTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res, server));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function serverUrl(s) { const { address, port } = s.address(); return `http://${address}:${port}`; }

// ---------- Module surface ----------

test('BAP_RESOURCE is the correct service.powerapps.com audience', () => {
  assert.equal(BAP_RESOURCE, 'https://service.powerapps.com/');
});

test('BAP_API_VERSION matches verify-managed-env.js (2023-06-01) for cross-helper parity', () => {
  // Drift here is a smell — both helpers hit the same BAP env GET endpoint;
  // future work may share a single request between them.
  assert.equal(BAP_API_VERSION, '2023-06-01');
});

// ---------- buildHint (pure-logic) ----------

test('buildHint("Microsoft") returns null (no advisory needed for default state)', () => {
  assert.equal(buildHint('Microsoft'), null);
});

test('buildHint("Customer") returns a security-team advisory mentioning BYOK / CMK', () => {
  const h = buildHint('Customer');
  assert.ok(typeof h === 'string' && h.length > 0);
  assert.match(h, /BYOK|CMK|Customer-managed/i);
  assert.match(h, /security|compliance/i);
});

test('buildHint("Unknown") returns a degradation advisory', () => {
  const h = buildHint('Unknown');
  assert.match(h, /Could not determine/i);
  assert.match(h, /properties\.protectionStatus\.keyManagedBy/);
});

// ---------- verifyByokCmk: input validation ----------

test('returns error envelope when environmentId cannot be determined', async () => {
  // No --environmentId, no PAC CLI auth in this test process → must surface
  // a degraded but well-formed result.
  const r = await verifyByokCmk({ envUrl: 'http://127.0.0.1:9', bapToken: 'tok' });
  // In the test environment we may or may not have PAC CLI auth available;
  // if we do, the helper continues to the BAP probe (and fails on network).
  // Either outcome must be a well-formed envelope.
  assert.ok(typeof r.ok === 'boolean');
  assert.ok(['Microsoft', 'Customer', 'Unknown'].includes(r.keyManagedBy));
  assert.equal(typeof r.byokEnabled, 'boolean');
  assert.ok(['bap', 'unknown'].includes(r.checkMethod));
});

test('returns error envelope when bapToken cannot be acquired and none is passed', async () => {
  // Force the "no token" path by passing an explicit environmentId so PAC CLI
  // discovery isn't attempted.
  const r = await verifyByokCmk({
    envUrl: 'http://127.0.0.1:9',
    environmentId: '00000000-0000-0000-0000-000000000000',
    bapToken: null,
  });
  // Either: no az login → checkMethod 'unknown' with an explanatory error;
  // or: az login cached → BAP call fails with non-200 / network → still ok:false.
  // Both must be well-formed envelopes.
  assert.ok(typeof r.ok === 'boolean');
  assert.ok(typeof r.keyManagedBy === 'string');
  assert.equal(typeof r.byokEnabled, 'boolean');
  if (!r.ok) {
    assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
      'failed result must include a human-readable hint');
  }
});

// ---------- verifyByokCmk via test seam (bapBase) ----------

test('verifyByokCmk: keyManagedBy="Customer" → byokEnabled=true + advisory hint', async (t) => {
  const server = await createTestServer((req, res, s) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      properties: {
        displayName: 'My Dev Env',
        protectionStatus: { keyManagedBy: 'Customer' },
      },
    }));
    s.close();
  });
  t.after(() => server.close());

  const r = await verifyByokCmk({
    environmentId: '12345678-1234-1234-1234-123456789012',
    bapToken: 'fake-tok',
    bapBase: serverUrl(server),
  });
  assert.equal(r.ok, true);
  assert.equal(r.keyManagedBy, 'Customer');
  assert.equal(r.byokEnabled, true);
  assert.equal(r.displayName, 'My Dev Env');
  assert.match(r.hint, /BYOK|Customer-managed/i);
  assert.equal(r.checkMethod, 'bap');
});

test('verifyByokCmk: keyManagedBy="Microsoft" → byokEnabled=false + no hint', async (t) => {
  const server = await createTestServer((req, res, s) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      properties: {
        displayName: 'My Prod Env',
        protectionStatus: { keyManagedBy: 'Microsoft' },
      },
    }));
    s.close();
  });
  t.after(() => server.close());

  const r = await verifyByokCmk({
    environmentId: '12345678-1234-1234-1234-123456789012',
    bapToken: 'fake-tok',
    bapBase: serverUrl(server),
  });
  assert.equal(r.ok, true);
  assert.equal(r.keyManagedBy, 'Microsoft');
  assert.equal(r.byokEnabled, false);
  assert.equal(r.hint, null);
});

test('verifyByokCmk: response missing protectionStatus → keyManagedBy="Unknown", ok:true, degraded hint', async (t) => {
  // POC found protectionStatus IS returned unconditionally on every tested
  // tenant — but defend in depth: if some future tenant omits the field,
  // surface a degraded-but-non-blocking result.
  const server = await createTestServer((req, res, s) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ properties: { displayName: 'Quirky Env' } }));
    s.close();
  });
  t.after(() => server.close());

  const r = await verifyByokCmk({
    environmentId: '12345678-1234-1234-1234-123456789012',
    bapToken: 'fake-tok',
    bapBase: serverUrl(server),
  });
  assert.equal(r.ok, true);
  assert.equal(r.keyManagedBy, 'Unknown');
  assert.equal(r.byokEnabled, false);
  assert.match(r.hint, /Could not determine/);
});

test('verifyByokCmk: response with an unexpected keyManagedBy value normalises to "Unknown"', async (t) => {
  // Defend against future BAP value drift (e.g. a new "ThirdParty" enum).
  const server = await createTestServer((req, res, s) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      properties: { protectionStatus: { keyManagedBy: 'NewVendor' } },
    }));
    s.close();
  });
  t.after(() => server.close());

  const r = await verifyByokCmk({
    environmentId: '12345678-1234-1234-1234-123456789012',
    bapToken: 'fake-tok',
    bapBase: serverUrl(server),
  });
  assert.equal(r.keyManagedBy, 'Unknown');
  assert.equal(r.byokEnabled, false);
});

test('verifyByokCmk: 500 from BAP → ok:false, checkMethod:"bap", hint includes guidance', async (t) => {
  const server = await createTestServer((req, res, s) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'oops' } }));
    s.close();
  });
  t.after(() => server.close());

  const r = await verifyByokCmk({
    environmentId: '12345678-1234-1234-1234-123456789012',
    bapToken: 'fake-tok',
    bapBase: serverUrl(server),
  });
  assert.equal(r.ok, false);
  assert.equal(r.checkMethod, 'bap');
  assert.equal(r.keyManagedBy, 'Unknown');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0);
});

test('verifyByokCmk: unparseable body → ok:false, checkMethod:"bap"', async (t) => {
  const server = await createTestServer((req, res, s) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('not json');
    s.close();
  });
  t.after(() => server.close());

  const r = await verifyByokCmk({
    environmentId: '12345678-1234-1234-1234-123456789012',
    bapToken: 'fake-tok',
    bapBase: serverUrl(server),
  });
  assert.equal(r.ok, false);
  assert.equal(r.checkMethod, 'bap');
});
