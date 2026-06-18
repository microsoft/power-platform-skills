'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { listIncomingUpdates, UPDATE_TYPE_LABEL } = require('../lib/list-incoming-updates');

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

test('UPDATE_TYPE_LABEL maps 0→Add, 1→Modify, 2→Delete', () => {
  assert.equal(UPDATE_TYPE_LABEL[0], 'Add');
  assert.equal(UPDATE_TYPE_LABEL[1], 'Modify');
  assert.equal(UPDATE_TYPE_LABEL[2], 'Delete');
});

test('UPDATE_TYPE_LABEL is frozen', () => {
  assert.throws(() => { UPDATE_TYPE_LABEL[3] = 'Rename'; }, /read.?only|assign|cannot/i);
});

test('returns error when server is unreachable', async () => {
  const result = await listIncomingUpdates({ envUrl: 'http://127.0.0.1:1', token: 'fake' });
  assert.ok(result.error);
});

test('returns count:0 and empty items when no updates exist', async () => {
  const server = await createTestServer(200, { value: [] });
  try {
    const result = await listIncomingUpdates({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 0);
    assert.deepEqual(result.items, []);
  } finally { server.close(); }
});

test('maps an update row to the correct output shape', async () => {
  const server = await createTestServer(200, {
    value: [{
      gitupdatefileid: 'u1',
      componentname: 'PricingPage',
      componenttype: 'mspp_webpage',
      updatetype: 0,
      commitsha: 'abc123def456',
      commitmessage: 'feat: add pricing page',
      solutionuniquename: 'cre48_PowerPagesSite',
    }],
  });
  try {
    const result = await listIncomingUpdates({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 1);
    const item = result.items[0];
    assert.equal(item.componentId, 'u1');
    assert.equal(item.componentName, 'PricingPage');
    assert.equal(item.componentType, 'mspp_webpage');
    assert.equal(item.updateType, 'Add');
    assert.equal(item.commitSha, 'abc123def456');
    assert.equal(item.commitMessage, 'feat: add pricing page');
  } finally { server.close(); }
});

test('returns count matching the full value array length', async () => {
  const rows = [
    { gitupdatefileid: 'a', componentname: 'A', componenttype: 't', updatetype: 1, commitsha: null, commitmessage: null },
    { gitupdatefileid: 'b', componentname: 'B', componenttype: 't', updatetype: 2, commitsha: null, commitmessage: null },
  ];
  const server = await createTestServer(200, { value: rows });
  try {
    const result = await listIncomingUpdates({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 2);
    assert.equal(result.items[1].updateType, 'Delete');
  } finally { server.close(); }
});

test('returns 404 hint on 404 response', async () => {
  const server = await createTestServer(404, {});
  try {
    const result = await listIncomingUpdates({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 0);
    assert.ok(result.hint);
  } finally { server.close(); }
});

test('returns error with statusCode on non-200 non-404', async () => {
  const server = await createTestServer(401, { error: { message: 'Unauthorized' } });
  try {
    const result = await listIncomingUpdates({ envUrl: serverUrl(server), token: 'tok' });
    assert.ok(result.error);
    assert.equal(result.statusCode, 401);
  } finally { server.close(); }
});

test('null commitSha and commitMessage when absent from row', async () => {
  const server = await createTestServer(200, {
    value: [{ gitupdatefileid: 'x', componentname: 'X', componenttype: 't', updatetype: 0 }],
  });
  try {
    const result = await listIncomingUpdates({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.items[0].commitSha, null);
    assert.equal(result.items[0].commitMessage, null);
  } finally { server.close(); }
});
