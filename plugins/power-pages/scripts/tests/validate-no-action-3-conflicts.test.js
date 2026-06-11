'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { validateNoAction3Conflicts, USERACTION_LABEL } = require('../lib/validate-no-action-3-conflicts');

function createTestServer(responses) {
  const list = Array.isArray(responses) ? responses : [responses];
  let i = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const r = list[Math.min(i, list.length - 1)];
      i++;
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function serverUrl(s) { const { address, port } = s.address(); return `http://${address}:${port}`; }

// ===== USERACTION_LABEL =====

test('USERACTION_LABEL maps 0→None, 1→AcceptLocal, 2→AcceptIncoming', () => {
  assert.equal(USERACTION_LABEL[0], 'None');
  assert.equal(USERACTION_LABEL[1], 'AcceptLocal');
  assert.equal(USERACTION_LABEL[2], 'AcceptIncoming');
});

// ===== validateNoAction3Conflicts =====

test('approves when server returns zero conflict rows', async () => {
  const server = await createTestServer({ status: 200, body: { '@odata.count': 0, value: [] } });
  try {
    const r = await validateNoAction3Conflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.ok, true);
    assert.equal(r.totalChecked, 0);
    assert.deepEqual(r.blocking, []);
  } finally { server.close(); }
});

test('flags action=3 row as BLOCKER even when useraction=0 (None)', async () => {
  const server = await createTestServer({
    status: 200,
    body: {
      '@odata.count': 1,
      value: [{
        sourcecontrolcomponentid: 'c1',
        componenttype: 8,
        componenttypename: 'Solution',
        componentpath: '/solutions/InternLearning',
        useraction: 0,
        solutioncomponentstate: 1,
      }],
    },
  });
  try {
    const r = await validateNoAction3Conflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.ok, false);
    assert.equal(r.blocking.length, 1);
    assert.equal(r.blocking[0].severity, 'blocker');
    assert.equal(r.blocking[0].key, 'action-3-conflict');
    assert.equal(r.blocking[0].ref, 'IL-010');
    assert.equal(r.blocking[0].details.useractionLabel, 'None');
    assert.match(r.blocking[0].message, /useraction=None/);
  } finally { server.close(); }
});

test('flags action=3 row as BLOCKER even when useraction=2 (AcceptIncoming) — post-Accept stuck state', async () => {
  const server = await createTestServer({
    status: 200,
    body: {
      '@odata.count': 1,
      value: [{
        sourcecontrolcomponentid: 'c2',
        componenttype: 1,
        componenttypename: 'Entity',
        componentpath: '/tables/sri_intern.entity.yml',
        useraction: 2,
        solutioncomponentstate: 1,
      }],
    },
  });
  try {
    const r = await validateNoAction3Conflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.ok, false);
    assert.equal(r.blocking.length, 1);
    assert.equal(r.blocking[0].details.useractionLabel, 'AcceptIncoming');
  } finally { server.close(); }
});

test('emits info finding (not error) on tenant where entity 404s', async () => {
  const server = await createTestServer({ status: 404, body: { error: { message: 'not found' } } });
  try {
    const r = await validateNoAction3Conflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.ok, true);
    assert.equal(r.info.length, 1);
    assert.equal(r.info[0].key, 'conflict-detection-unavailable');
    assert.equal(r.info[0].ref, 'IL-016');
  } finally { server.close(); }
});

test('returns {error} for non-200/non-404 HTTP failures', async () => {
  const server = await createTestServer({ status: 401, body: { error: { message: 'unauth' } } });
  try {
    const r = await validateNoAction3Conflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.ok(r.error);
    assert.equal(r.statusCode, 401);
  } finally { server.close(); }
});

test('emits truncation info when total > returned', async () => {
  const server = await createTestServer({
    status: 200,
    body: {
      '@odata.count': 300,
      value: [{
        sourcecontrolcomponentid: 'c',
        componenttype: 1,
        componenttypename: 'Entity',
        componentpath: '/x',
        useraction: 0,
        solutioncomponentstate: 1,
      }],
    },
  });
  try {
    const r = await validateNoAction3Conflicts({ envUrl: serverUrl(server), token: 'tok', top: 1 });
    assert.equal(r.totalChecked, 300);
    assert.ok(r.info.find((f) => f.key === 'action-3-truncation'));
  } finally { server.close(); }
});

test('resolves solutionUniqueName before main query (2-request sequence)', async () => {
  const server = await createTestServer([
    { status: 200, body: { value: [{ solutionid: 'sol-x' }] } },
    { status: 200, body: { '@odata.count': 0, value: [] } },
  ]);
  try {
    const r = await validateNoAction3Conflicts({
      envUrl: serverUrl(server), token: 'tok',
      solutionUniqueName: 'InternLearning',
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.scope, { solutionUniqueName: 'InternLearning', solutionId: 'sol-x' });
  } finally { server.close(); }
});
