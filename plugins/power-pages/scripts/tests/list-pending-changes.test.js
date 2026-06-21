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
        componentpath:            '/powerpagesites/SolutionA/web-templates/Header.webtemplate.yml',
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
    assert.equal(item.filePath,       '/powerpagesites/SolutionA/web-templates/Header.webtemplate.yml');
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

test('count reflects @odata.count; truncated:true when server returns fewer rows than count without a nextLink', async () => {
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
    assert.equal(result.truncated, true, 'items (3) < count (385) and no nextLink → truncated');
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
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok', solutionUniqueName: 'SolutionA' });
    assert.equal(result.count, 5);
    assert.equal(result.scope.solutionUniqueName, 'SolutionA');
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

// ===== probe mode =====

test('probe=true returns count + probe:true and NO items[] (count-only fast path)', async () => {
  // Server still echoes @odata.count even with $top=0; value should be empty.
  const server = await createTestServer({ status: 200, body: { '@odata.count': 44, value: [] } });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok', probe: true });
    assert.equal(result.count, 44);
    assert.equal(result.probe, true);
    assert.equal(result.items, undefined);
    assert.ok(result.scope);
  } finally { server.close(); }
});

test('probe=true with solutionUniqueName still resolves solutionId before the count query', async () => {
  const server = await createTestServer([
    { status: 200, body: { value: [{ solutionid: 'sol-guid-001' }] } },
    { status: 200, body: { '@odata.count': 12, value: [] } },
  ]);
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok', solutionUniqueName: 'InternLearning', probe: true });
    assert.equal(result.count, 12);
    assert.equal(result.probe, true);
    assert.equal(result.scope.solutionUniqueName, 'InternLearning');
    assert.equal(result.scope.solutionId, 'sol-guid-001');
  } finally { server.close(); }
});

test('probe=true issues query with $top=1 and minimal $select (verified via captured URL)', async () => {
  // Capture the URL the helper hits so we can assert the probe query shape.
  // We use $top=1 instead of $top=0 because Dataverse rejects $top=0 with
  // "Invalid value for $top query option." (HTTP 400, verified 2026-06-11
  // against org5ba33a19).
  let captured = null;
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      captured = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ '@odata.count': 7, value: [] }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await listPendingChanges({ envUrl: serverUrl(server), token: 'tok', probe: true });
    assert.ok(captured);
    assert.match(captured, /\$top=1(&|$)/, 'probe should use $top=1 (NOT $top=0 — Dataverse rejects 0)');
    assert.match(captured, /\$count=true/, 'probe should still request count');
    assert.match(captured, /\$select=sourcecontrolcomponentid(&|$)/, 'probe should select only the minimal id field');
    // Confirm the heavy field set is NOT in the probe URL.
    assert.ok(!/componentdisplayname/.test(captured), 'probe must omit componentdisplayname');
    assert.ok(!/componenttypename/.test(captured), 'probe must omit componenttypename');
  } finally { server.close(); }
});

test('probe=false (default) still returns items[] with full field set', async () => {
  let captured = null;
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      captured = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        '@odata.count': 1,
        value: [{
          componentid: 'c1', componentdisplayname: 'X', componenttypename: 'Web Page',
          solutioncomponentstate: 0, action: 1,
        }],
      }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.probe, undefined);
    assert.equal(result.items.length, 1);
    assert.equal(result.truncated, false, 'complete single page → truncated:false');
    assert.match(captured, /\$select=/, 'non-probe path must include $select');
    assert.match(captured, /\$top=5000/, 'non-probe path default top is 5000');
  } finally { server.close(); }
});

// ===== pagination + truncation (B1) =====

test('auto-follows @odata.nextLink across pages and returns a complete, non-truncated snapshot', async () => {
  const mkRow = (id) => ({ componentid: id, componentdisplayname: id, componenttypename: 'Web Page', solutioncomponentstate: 0, action: 1 });
  // Page 1 carries the total count + a nextLink; page 2 completes the set.
  const server = await new Promise((resolve) => {
    const responses = [
      { '@odata.count': 4, '@odata.nextLink': null, value: [mkRow('a'), mkRow('b')] },
      { value: [mkRow('c'), mkRow('d')] },
    ];
    let i = 0;
    const s = http.createServer((req, res) => {
      const body = responses[Math.min(i, responses.length - 1)];
      // Inject a nextLink that points back at this server for the first page only.
      if (i === 0) body['@odata.nextLink'] = `http://${s.address().address}:${s.address().port}/page2`;
      i++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(result.count, 4);
    assert.equal(result.items.length, 4, 'both pages accumulated');
    assert.deepEqual(result.items.map((x) => x.componentId), ['a', 'b', 'c', 'd']);
    assert.equal(result.truncated, false, 'full pagination → complete snapshot');
  } finally { server.close(); }
});

test('caps at maxItems and reports truncated:true when count exceeds the safety cap', async () => {
  const mkRow = (id) => ({ componentid: String(id), componentdisplayname: String(id), componenttypename: 'Web Page', solutioncomponentstate: 0, action: 1 });
  const server = await createTestServer({
    status: 200,
    body: { '@odata.count': 10, value: [mkRow(1), mkRow(2), mkRow(3), mkRow(4), mkRow(5)] },
  });
  try {
    const result = await listPendingChanges({ envUrl: serverUrl(server), token: 'tok', maxItems: 3 });
    assert.equal(result.count, 10);
    assert.equal(result.items.length, 3, 'items capped at maxItems');
    assert.equal(result.truncated, true, 'cap tripped → truncated');
  } finally { server.close(); }
});

// Regression: the pending-Changes query MUST filter to action eq 1 (Push). Without
// it, the inert action=0 baseline is counted, producing false "pending changes" on
// a clean env (live 2026-06-19: 238 iscommitted=false rows were all action=0 while
// the portal showed Changes(0)).
test('query filters to "iscommitted eq false AND action eq 1" (excludes the action=0 baseline)', async () => {
  const seen = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ '@odata.count': 0, value: [] }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await listPendingChanges({ envUrl: serverUrl(server), token: 'tok' });
    const compQuery = seen.find((u) => u.includes('sourcecontrolcomponents'));
    assert.ok(compQuery, 'queried sourcecontrolcomponents');
    const decoded = decodeURIComponent(compQuery);
    assert.match(decoded, /iscommitted eq false/);
    assert.match(decoded, /action eq 1/);
  } finally { server.close(); }
});
