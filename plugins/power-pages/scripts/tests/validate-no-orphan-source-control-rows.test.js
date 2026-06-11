'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { validateNoOrphanSourceControlRows, ACTION_LABEL } = require('../lib/validate-no-orphan-source-control-rows');

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

// ===== ACTION_LABEL =====

test('ACTION_LABEL maps 0→None, 1→Push, 2→Pull, 3→Conflict', () => {
  assert.equal(ACTION_LABEL[0], 'None');
  assert.equal(ACTION_LABEL[1], 'Push');
  assert.equal(ACTION_LABEL[2], 'Pull');
  assert.equal(ACTION_LABEL[3], 'Conflict');
});

test('ACTION_LABEL is frozen', () => {
  assert.throws(() => { ACTION_LABEL[9] = 'x'; }, /read.?only|assign|cannot/i);
});

// ===== validateNoOrphanSourceControlRows =====

test('approves when server returns zero orphan rows', async () => {
  const server = await createTestServer({ status: 200, body: { '@odata.count': 0, value: [] } });
  try {
    const r = await validateNoOrphanSourceControlRows({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.ok, true);
    assert.equal(r.totalChecked, 0);
    assert.deepEqual(r.blocking, []);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.info, []);
    assert.deepEqual(r.scope, { all: true });
  } finally { server.close(); }
});

test('flags every orphan row as a BLOCKER finding with IL-019 ref', async () => {
  const server = await createTestServer({
    status: 200,
    body: {
      '@odata.count': 2,
      value: [
        {
          sourcecontrolcomponentid: 'aaa1',
          componentid: 'cid-1',
          componenttype: 1,
          componenttypename: 'Entity',
          componentpath: '/tables/sri_intern.entity.yml',
          action: 1,
        },
        {
          sourcecontrolcomponentid: 'aaa2',
          componentid: null,
          componenttype: 10,
          componenttypename: 'Web Template',
          componentpath: null,
          action: 0,
        },
      ],
    },
  });
  try {
    const r = await validateNoOrphanSourceControlRows({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.ok, false);
    assert.equal(r.totalChecked, 2);
    assert.equal(r.blocking.length, 2);
    assert.equal(r.blocking[0].severity, 'blocker');
    assert.equal(r.blocking[0].key, 'orphan-source-control-row');
    assert.equal(r.blocking[0].ref, 'IL-019');
    assert.equal(r.blocking[0].details.sourcecontrolcomponentid, 'aaa1');
    assert.equal(r.blocking[0].details.componentId, 'cid-1');
    assert.equal(r.blocking[0].details.componentType, 'Entity');
    assert.equal(r.blocking[0].details.componentPath, '/tables/sri_intern.entity.yml');
    assert.equal(r.blocking[0].details.actionLabel, 'Push');
    assert.match(r.blocking[0].message, /orphan.*no payload/i);
    assert.match(r.blocking[0].remediation, /Maker Portal|Discard/i);
    // null path → message still well-formed
    assert.equal(r.blocking[1].details.componentPath, null);
    assert.equal(r.blocking[1].details.actionLabel, 'None');
  } finally { server.close(); }
});

test('emits info finding (not error) on tenant where entity 404s', async () => {
  const server = await createTestServer({ status: 404, body: { error: { message: 'not found' } } });
  try {
    const r = await validateNoOrphanSourceControlRows({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.ok, true);
    assert.equal(r.totalChecked, 0);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.info.length, 1);
    assert.equal(r.info[0].severity, 'info');
    assert.equal(r.info[0].key, 'orphan-detection-unavailable');
    assert.equal(r.info[0].ref, 'IL-016');
  } finally { server.close(); }
});

test('returns {error} for non-200/non-404 HTTP failures', async () => {
  const server = await createTestServer({ status: 500, body: { error: { message: 'kaboom' } } });
  try {
    const r = await validateNoOrphanSourceControlRows({ envUrl: serverUrl(server), token: 'tok' });
    assert.ok(r.error);
    assert.equal(r.statusCode, 500);
  } finally { server.close(); }
});

test('emits truncation info when @odata.count exceeds returned rows', async () => {
  const server = await createTestServer({
    status: 200,
    body: {
      '@odata.count': 250,
      value: [{
        sourcecontrolcomponentid: 'a',
        componentid: 'cid-a',
        componenttype: 1,
        componenttypename: 'Entity',
        componentpath: '/x',
        action: 1,
      }],
    },
  });
  try {
    const r = await validateNoOrphanSourceControlRows({ envUrl: serverUrl(server), token: 'tok', top: 1 });
    assert.equal(r.totalChecked, 250);
    assert.equal(r.blocking.length, 1);
    assert.ok(r.info.find((f) => f.key === 'orphan-row-truncation'));
  } finally { server.close(); }
});

test('resolves solutionUniqueName before main query (2-request sequence)', async () => {
  const server = await createTestServer([
    { status: 200, body: { value: [{ solutionid: 'sol-123' }] } },
    { status: 200, body: { '@odata.count': 0, value: [] } },
  ]);
  try {
    const r = await validateNoOrphanSourceControlRows({
      envUrl: serverUrl(server), token: 'tok',
      solutionUniqueName: 'InternLearning',
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.scope, { solutionUniqueName: 'InternLearning', solutionId: 'sol-123' });
  } finally { server.close(); }
});

test('returns {error} when solution lookup fails', async () => {
  const server = await createTestServer([
    { status: 200, body: { value: [] } },
  ]);
  try {
    const r = await validateNoOrphanSourceControlRows({
      envUrl: serverUrl(server), token: 'tok',
      solutionUniqueName: 'DoesNotExist',
    });
    assert.ok(r.error);
    assert.match(r.error, /not found/i);
  } finally { server.close(); }
});
