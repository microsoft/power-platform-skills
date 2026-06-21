'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { listConflicts, CHANGE_TYPE_LABEL } = require('../lib/list-conflicts');

function createTestServer(statusCode, body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
      server.close();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function serverUrl(s) { const { address, port } = s.address(); return `http://${address}:${port}`; }

function createQueuedServer(responses) {
  const queue = [...responses];
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    const next = queue.shift() || { status: 500, body: JSON.stringify({ error: { message: 'Unexpected request' } }) };
    res.writeHead(next.status, next.headers || { 'Content-Type': 'application/json' });
    res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}
function queuedServerUrl(s) { return `http://127.0.0.1:${s.port}`; }
function closeQueuedServer(s) { return new Promise((resolve) => s.server.close(resolve)); }

test('CHANGE_TYPE_LABEL shared constant is frozen and has 3 entries', () => {
  assert.equal(Object.keys(CHANGE_TYPE_LABEL).length, 3);
  assert.throws(() => { CHANGE_TYPE_LABEL[3] = 'Rename'; }, /read.?only|assign|cannot/i);
});

test('returns error when server is unreachable', async () => {
  const result = await listConflicts({ envUrl: 'http://127.0.0.1:1', token: 'fake' });
  assert.ok(result.error);
});

test('returns count:0 and empty items when no conflicts exist', async () => {
  const server = await createTestServer(200, { value: [] });
  try {
    const result = await listConflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 0);
    assert.deepEqual(result.items, []);
  } finally { server.close(); }
});

test('maps a conflict row to the correct output shape', async () => {
  const server = await createTestServer(200, {
    value: [{
      gitconflictfileid: 'c1',
      componentname: 'Header',
      componenttype: 'mspp_webtemplate',
      localchangetype: 1,
      incomingchangetype: 1,
      localcommitsha: null,
      incomingcommitsha: 'def456',
      solutionuniquename: 'cre48_PowerPagesSite',
    }],
  });
  try {
    const result = await listConflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 1);
    const item = result.items[0];
    assert.equal(item.conflictId, 'c1');
    assert.equal(item.componentName, 'Header');
    assert.equal(item.componentType, 'mspp_webtemplate');
    assert.equal(item.localChangeType, 'Modify');
    assert.equal(item.incomingChangeType, 'Modify');
    assert.equal(item.localCommitSha, null);
    assert.equal(item.incomingCommitSha, 'def456');
    assert.equal(item.resolutionRequired, true);
  } finally { server.close(); }
});

test('resolutionRequired is always true (all conflict rows require resolution)', async () => {
  const server = await createTestServer(200, {
    value: [
      { gitconflictfileid: 'a', componentname: 'A', componenttype: 't', localchangetype: 0, incomingchangetype: 0 },
      { gitconflictfileid: 'b', componentname: 'B', componenttype: 't', localchangetype: 1, incomingchangetype: 2 },
    ],
  });
  try {
    const result = await listConflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 2);
    assert.ok(result.items.every((i) => i.resolutionRequired === true));
  } finally { server.close(); }
});

test('returns 404 hint when entity returns 404', async () => {
  const server = await createTestServer(404, {});
  try {
    const result = await listConflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 0);
    assert.ok(result.hint);
  } finally { server.close(); }
});

test('uses sourcecontrolcomponent as the PRIMARY source when a solution is provided (action eq 3 and useraction eq 0)', async () => {
  const server = await createQueuedServer([
    {
      status: 200,
      body: {
        value: [{
          sourcecontrolcomponentid: 'scc-conflict-1',
          componentid: 'ppc-1',
          componentdisplayname: 'Header',
          componentpath: 'web-templates/header.html',
          componenttype: 'mspp_webtemplate',
          partitionid: 'sol-1',
          githashid: 'g1', lastsynchashid: 'b1', envhashid: 'e1',
          action: 3,
          useraction: 0,
        }],
      },
    },
  ]);
  try {
    const result = await listConflicts({ envUrl: queuedServerUrl(server), token: 'tok', solutionId: 'sol-1' });
    assert.equal(result.count, 1);
    assert.equal(result.via, 'sourcecontrolcomponent');
    const item = result.items[0];
    assert.equal(item.conflictId, 'scc-conflict-1');
    assert.equal(item.componentId, 'ppc-1');
    assert.equal(item.componentName, 'Header');
    assert.equal(item.componentPath, 'web-templates/header.html');
    assert.equal(item.componentType, 'mspp_webtemplate');
    assert.equal(item.partitionId, 'sol-1');
    assert.equal(item.gitHashId, 'g1');
    assert.equal(item.lastSyncHashId, 'b1');
    assert.equal(item.envHashId, 'e1');
    assert.equal(item.resolutionRequired, true);
    // PRIMARY = sourcecontrolcomponents, with the canonical conflict filter, no gitconflictfiles call
    assert.match(server.received[0].url, /sourcecontrolcomponents/);
    assert.match(decodeURIComponent(server.received[0].url), /action eq 3 and useraction eq 0/);
    assert.doesNotMatch(decodeURIComponent(server.received[0].url), /iscommitted/);
    assert.match(server.received[0].url, /partitionId=sol-1/);
    assert.equal(server.received.length, 1, 'did not fall back to gitconflictfiles');
  } finally { await closeQueuedServer(server); }
});

test('returns error on non-200 non-404 response', async () => {
  const server = await createTestServer(500, { error: { message: 'Internal Server Error' } });
  try {
    const result = await listConflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.ok(result.error);
    assert.equal(result.statusCode, 500);
  } finally { server.close(); }
});

test('mixtures of Add/Delete conflict types are mapped correctly', async () => {
  const server = await createTestServer(200, {
    value: [{
      gitconflictfileid: 'x',
      componentname: 'DeletedComponent',
      componenttype: 'mspp_webpage',
      localchangetype: 0,  // Add (local created it)
      incomingchangetype: 2, // Delete (incoming deleted it)
    }],
  });
  try {
    const result = await listConflicts({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.items[0].localChangeType, 'Add');
    assert.equal(result.items[0].incomingChangeType, 'Delete');
  } finally { server.close(); }
});
