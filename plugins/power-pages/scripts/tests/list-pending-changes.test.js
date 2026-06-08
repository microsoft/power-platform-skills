'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { listPendingChanges, CHANGE_TYPE_LABEL } = require('../lib/list-pending-changes');

// Multi-request test server: takes an array of {status, body} responses and
// serves them in order. Required because the new helper may issue up to
// 2 requests (solution-id lookup, then components query).
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

// ===== CHANGE_TYPE_LABEL =====

test('CHANGE_TYPE_LABEL maps solutioncomponentstate 0→Add, 1→Modify, 2→Delete', () => {
  assert.equal(CHANGE_TYPE_LABEL[0], 'Add');
  assert.equal(CHANGE_TYPE_LABEL[1], 'Modify');
  assert.equal(CHANGE_TYPE_LABEL[2], 'Delete');
});

test('CHANGE_TYPE_LABEL is frozen', () => {
  assert.throws(() => { CHANGE_TYPE_LABEL[3] = 'Rename'; }, /read.?only|assign|cannot/i);
});

// ===== listPendingChanges =====

test('returns count:0 + empty items when sourcecontrolcomponents returns no rows', async () => {
  const server = await createTestServer({ status: 200, body: { '@odata.count': 0, value: [] } });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 0);
    assert.deepEqual(result.items, []);
  } finally { server.close(); }
});

test('maps a sourcecontrolcomponent row to the canonical output shape', async () => {
  const server = await createTestServer({
    status: 200,
    body: {
      '@odata.count': 1,
      value: [{
        sourcecontrolcomponentid: 'scc1',
        componentid:              '7441cfaa-c249-4c69-9f72-b4bb287a9c85',
        componentdisplayname:     'Header',
        name:                     'Header',
        componenttype:            10,
        componenttypename:        'Web Template',
        componentpath:            '/powerpagesites/RetailOS/web-templates/Header.webtemplate.yml',
        solutioncomponentstate:   1,
        action:                   1,
        'action@OData.Community.Display.V1.FormattedValue': 'Push',
        partitionid:              '52cdfb68-415e-f111-a826-6045bd08be8b',
        modifiedon:               '2026-05-30T10:00:00Z',
      }],
    },
  });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 1);
    const item = result.items[0];
    assert.equal(item.componentId,    '7441cfaa-c249-4c69-9f72-b4bb287a9c85');
    assert.equal(item.componentName,  'Header');
    assert.equal(item.componentType,  'Web Template');
    assert.equal(item.changeType,     'Modify');
    assert.equal(item.action,         'Push');
    assert.equal(item.filePath,       '/powerpagesites/RetailOS/web-templates/Header.webtemplate.yml');
    assert.equal(item.partitionId,    '52cdfb68-415e-f111-a826-6045bd08be8b');
    assert.equal(item.lastModifiedOn, '2026-05-30T10:00:00Z');
  } finally { server.close(); }
});

test('unknown solutioncomponentstate falls back to the raw string', async () => {
  const server = await createTestServer({
    status: 200,
    body: { '@odata.count': 1, value: [{
      componentid: 'x', componentdisplayname: 'A', componenttypename: 't',
      solutioncomponentstate: 99, action: 0,
    }] },
  });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.items[0].changeType, '99');
  } finally { server.close(); }
});

test('count reflects @odata.count even when value is paginated', async () => {
  const server = await createTestServer({
    status: 200,
    body: {
      '@odata.count': 385,
      value: [
        { componentid: 'a', componentdisplayname: 'A', componenttypename: 'Solution',     solutioncomponentstate: 0, action: 1 },
        { componentid: 'b', componentdisplayname: 'B', componenttypename: 'Web Page',     solutioncomponentstate: 0, action: 1 },
        { componentid: 'c', componentdisplayname: 'C', componenttypename: 'Web Template', solutioncomponentstate: 1, action: 1 },
      ],
    },
  });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 385);
    assert.equal(result.items.length, 3);
    assert.equal(result.items[2].changeType, 'Modify');
  } finally { server.close(); }
});

test('surfaces 404 with hint pointing at Git-integration provisioning', async () => {
  const server = await createTestServer({ status: 404, body: {} });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 0);
    assert.deepEqual(result.items, []);
    assert.match(result.hint, /sourcecontrolcomponent|Git integration/i);
  } finally { server.close(); }
});

test('returns error on non-200 non-404 response', async () => {
  const server = await createTestServer({ status: 403, body: { error: { message: 'Forbidden' } } });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok' });
    assert.ok(result.error);
    assert.equal(result.statusCode, 403);
  } finally { server.close(); }
});

test('resolves solutionUniqueName → solutionId via solutions query, then filters components', async () => {
  // 1st request: solution lookup. 2nd request: sourcecontrolcomponent query.
  const server = await createTestServer([
    { status: 200, body: { value: [{ solutionid: '52cdfb68-415e-f111-a826-6045bd08be8b' }] } },
    { status: 200, body: { '@odata.count': 5, value: [] } },
  ]);
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok', solutionUniqueName: 'RetailOS' });
    assert.equal(result.count, 5);
    assert.equal(result.scope.solutionUniqueName, 'RetailOS');
    assert.equal(result.scope.solutionId, '52cdfb68-415e-f111-a826-6045bd08be8b');
  } finally { server.close(); }
});

test('returns clear error when solutionUniqueName cannot be resolved', async () => {
  const server = await createTestServer({ status: 200, body: { value: [] } });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok', solutionUniqueName: 'DoesNotExist' });
    assert.match(result.error, /not found/i);
  } finally { server.close(); }
});

test('null lastModifiedOn when modifiedon is absent from row', async () => {
  const server = await createTestServer({
    status: 200,
    body: { '@odata.count': 1, value: [{
      componentid: 'z', componentdisplayname: 'Nav', componenttypename: 'Web Template',
      solutioncomponentstate: 0, action: 1,
    }] },
  });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.items[0].lastModifiedOn, null);
  } finally { server.close(); }
});
