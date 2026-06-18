'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { verifyLicense, PROBE_ENTITY, buildHint } = require('../lib/verify-license');

function createTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res, server));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function serverUrl(s) { const { address, port } = s.address(); return `http://${address}:${port}`; }

// ---------- Module surface ----------

test('PROBE_ENTITY is sourcecontrolconfigurations (POC-verified probe target)', () => {
  // The probe MUST be sourcecontrolconfigurations — NOT sourcecontrolcomponent.
  // Per POC: tenants with working Git integration return 200 for
  // sourcecontrolconfigurations but 404 for sourcecontrolcomponent. Using the
  // wrong probe would produce false-negatives on every env.
  assert.equal(PROBE_ENTITY, 'sourcecontrolconfigurations');
});

// ---------- buildHint (pure-logic) ----------

test('buildHint(true, 200) → null (no advisory when Git integration is available)', () => {
  assert.equal(buildHint(true, 200), null);
});

test('buildHint(false, 404) → tenant-admin guidance mentioning the entity name', () => {
  const h = buildHint(false, 404);
  assert.ok(typeof h === 'string' && h.length > 0);
  assert.match(h, /Git integration is NOT available/i);
  assert.match(h, /sourcecontrolconfigurations/);
  assert.match(h, /tenant admin/i);
});

test('buildHint(false, 401) → degraded hint (not a 404, so we DON\'T claim "not available")', () => {
  const h = buildHint(false, 401);
  assert.match(h, /Could not verify/i);
  assert.match(h, /401/);
});

test('buildHint(false, 0) → degraded hint when transport itself failed', () => {
  const h = buildHint(false, 0);
  assert.match(h, /Could not verify/i);
});

// ---------- verifyLicense: input validation ----------

test('returns error envelope when envUrl cannot be determined and none is passed', async () => {
  // No envUrl, no PAC CLI in this test process — must surface a well-formed
  // degraded result.
  const r = await verifyLicense({});
  // If PAC CLI is signed in on the test machine the result may still be ok:false
  // with a real network call; either way the envelope must be well-formed.
  assert.ok(typeof r.ok === 'boolean');
  assert.equal(typeof r.gitIntegrationAvailable, 'boolean');
  assert.equal(typeof r.statusCode, 'number');
  if (!r.ok) {
    assert.ok(typeof r.hint === 'string' && r.hint.length > 0);
  }
});

test('returns error envelope when token cannot be acquired and none is passed', async () => {
  const r = await verifyLicense({ envUrl: 'http://127.0.0.1:9', token: null });
  assert.ok(typeof r.ok === 'boolean');
  assert.equal(typeof r.gitIntegrationAvailable, 'boolean');
  // Failure case: either "no token" or "transport failed" — both produce a hint.
  if (!r.ok) {
    assert.ok(typeof r.hint === 'string' && r.hint.length > 0);
  }
});

// ---------- verifyLicense: end-to-end probe responses ----------

test('verifyLicense: HTTP 200 → gitIntegrationAvailable:true, no hint', async (t) => {
  const server = await createTestServer((req, res, s) => {
    // Assert the helper hit the expected URL shape (defence in depth — guards
    // against a future refactor accidentally probing the wrong entity).
    assert.match(req.url, /\/api\/data\/v9\.2\/sourcecontrolconfigurations\?\$top=1/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: [{ sourcecontrolconfigurationid: 'abc' }] }));
    s.close();
  });
  t.after(() => server.close());

  const r = await verifyLicense({ envUrl: serverUrl(server), token: 'fake-tok' });
  assert.equal(r.ok, true);
  assert.equal(r.gitIntegrationAvailable, true);
  assert.equal(r.statusCode, 200);
  assert.equal(r.hint, null);
  assert.equal(r.checkMethod, 'sourcecontrolconfigurations');
});

test('verifyLicense: HTTP 404 → gitIntegrationAvailable:false + tenant-admin advisory', async (t) => {
  const server = await createTestServer((req, res, s) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Resource not found' } }));
    s.close();
  });
  t.after(() => server.close());

  const r = await verifyLicense({ envUrl: serverUrl(server), token: 'fake-tok' });
  // ok:true here is INTENTIONAL — 404 is a definitive "not licensed" answer,
  // not a probe failure. The hint surfaces the actionable advice; the SKILL
  // gate decides whether to block.
  assert.equal(r.ok, true);
  assert.equal(r.gitIntegrationAvailable, false);
  assert.equal(r.statusCode, 404);
  assert.match(r.hint, /Git integration is NOT available/i);
});

test('verifyLicense: HTTP 401 → ok:false, hint is degraded (not a "not available" claim)', async (t) => {
  // 401 means token didn't work, NOT that Git integration is absent. The
  // helper must NOT claim "Git integration is not available" — it must
  // surface the transport failure honestly.
  const server = await createTestServer((req, res, s) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
    s.close();
  });
  t.after(() => server.close());

  const r = await verifyLicense({ envUrl: serverUrl(server), token: 'fake-tok' });
  assert.equal(r.ok, false);
  assert.equal(r.gitIntegrationAvailable, false);
  assert.equal(r.statusCode, 401);
  assert.match(r.hint, /Could not verify/i);
  assert.doesNotMatch(r.hint, /NOT available/);
});

test('verifyLicense: HTTP 500 → ok:false, statusCode preserved, degraded hint', async (t) => {
  const server = await createTestServer((req, res, s) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Internal error' } }));
    s.close();
  });
  t.after(() => server.close());

  const r = await verifyLicense({ envUrl: serverUrl(server), token: 'fake-tok' });
  assert.equal(r.ok, false);
  assert.equal(r.gitIntegrationAvailable, false);
  assert.equal(r.statusCode, 500);
});

test('verifyLicense: envUrl with trailing slash is normalised (no //api/data path)', async (t) => {
  // Regression: callers commonly pass envUrl='https://orgX.crm.dynamics.com/'
  // with a trailing slash from `pac env who --json`. Helper must not produce
  // a double-slash path because some proxies are picky.
  let pathSeen = null;
  const server = await createTestServer((req, res, s) => {
    pathSeen = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: [] }));
    s.close();
  });
  t.after(() => server.close());

  await verifyLicense({ envUrl: serverUrl(server) + '/', token: 'fake-tok' });
  assert.ok(pathSeen && !pathSeen.startsWith('//'),
    `path should not start with // (got ${pathSeen})`);
});

test('verifyLicense: sends OData 4.0 headers (Dataverse compatibility)', async (t) => {
  // Dataverse OData requires both OData-Version and OData-MaxVersion = 4.0.
  // Drop either and Dataverse rejects with 400.
  let headersSeen = null;
  const server = await createTestServer((req, res, s) => {
    headersSeen = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: [] }));
    s.close();
  });
  t.after(() => server.close());

  await verifyLicense({ envUrl: serverUrl(server), token: 'tok' });
  assert.equal(headersSeen['odata-version'], '4.0');
  assert.equal(headersSeen['odata-maxversion'], '4.0');
  assert.equal(headersSeen.authorization, 'Bearer tok');
});
