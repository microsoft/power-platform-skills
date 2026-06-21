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

// A server that routes each request to a response by inspecting the URL — needed
// because the Updates fallback fires its action=2 and action=3/useraction=2 queries
// in parallel (order is non-deterministic), so a FIFO queue would be racy.
function createRoutingServer(routeFn) {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    const next = routeFn(req.url) || { status: 500, body: { error: { message: 'Unexpected request' } } };
    res.writeHead(next.status, next.headers || { 'Content-Type': 'application/json' });
    res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}

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

test('falls back to sourcecontrolcomponents when gitupdatefiles returns 404', async () => {
  const decoded = (u) => decodeURIComponent(u);
  const server = await createRoutingServer((u) => {
    if (u.includes('gitupdatefiles')) return { status: 404, body: {} };
    if (u.includes('sourcecontrolcomponents')) {
      // action=2 (pure update) returns the row; action=3/useraction=2 returns empty.
      if (/action eq 3/.test(decoded(u))) return { status: 200, body: { value: [] } };
      return { status: 200, body: { value: [{
        sourcecontrolcomponentid: 'scc-update-1', componentid: 'ppc-2',
        componentdisplayname: 'Pricing', componentpath: 'web-pages/pricing',
        componenttype: 'mspp_webpage', action: 2, useraction: 0,
      }] } };
    }
    return { status: 500, body: {} };
  });
  try {
    const result = await listIncomingUpdates({ envUrl: queuedServerUrl(server), token: 'tok', solutionId: 'sol-1' });
    assert.equal(result.count, 1);
    assert.equal(result.via, 'sourcecontrolcomponent');
    assert.equal(result.items[0].componentId, 'ppc-2');
    assert.equal(result.items[0].updateId, 'scc-update-1');
    assert.equal(result.items[0].componentName, 'Pricing');
    assert.equal(result.items[0].componentPath, 'web-pages/pricing');
    assert.equal(result.items[0].componentType, 'mspp_webpage');
    assert.ok(server.received.some((r) => /gitupdatefiles/.test(r.url)));
    assert.ok(server.received.some((r) => /sourcecontrolcomponents/.test(r.url) && /action eq 2/.test(decoded(r.url))));
    assert.ok(server.received.some((r) => /action eq 3 and useraction eq 2/.test(decoded(r.url))), 'also queries accepted-incoming-pending-pull');
    assert.ok(!server.received.some((r) => /iscommitted/.test(decoded(r.url))));
  } finally { await closeQueuedServer(server); }
});

test('Updates includes conflicts accepted as incoming and pending pull (action=3, useraction=2) — portal parity', async () => {
  // Live regression (2026-06-19, sri-alm-dev-1): a site setting resolved via
  // accept-incoming stays as action=3/useraction=2 until pulled; the portal lists it
  // under Updates(1) but the old helper (action eq 2 only) returned 0.
  const decoded = (u) => decodeURIComponent(u);
  const server = await createRoutingServer((u) => {
    if (u.includes('gitupdatefiles')) return { status: 404, body: {} };
    if (/action eq 3/.test(decoded(u))) {
      return { status: 200, body: { value: [{
        sourcecontrolcomponentid: 'scc-ss', componentid: 'ppc-ss',
        componentdisplayname: 'Authentication/LoginTrackingEnabled.sitesetting',
        componentpath: '/powerpagesites/RetailOS/site-settings/Authentication-LoginTrackingEnabled.sitesetting.yml',
        componenttype: 10429, action: 3, useraction: 2, iscommitted: true,
      }] } };
    }
    return { status: 200, body: { value: [] } }; // no pure action=2 rows
  });
  try {
    const result = await listIncomingUpdates({ envUrl: queuedServerUrl(server), token: 'tok', solutionId: 'sol-1' });
    assert.equal(result.count, 1);
    assert.equal(result.items[0].componentName, 'Authentication/LoginTrackingEnabled.sitesetting');
    assert.equal(result.items[0].updateType, 'AcceptedPendingPull');
  } finally { await closeQueuedServer(server); }
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
