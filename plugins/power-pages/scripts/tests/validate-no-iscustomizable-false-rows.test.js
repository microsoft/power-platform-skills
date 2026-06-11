'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  validateNoIscustomizableFalseRows,
  buildInFilter,
  chunk,
} = require('../lib/validate-no-iscustomizable-false-rows');

function createTestServer(responses) {
  const list = Array.isArray(responses) ? responses : [responses];
  let i = 0;
  let received = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      received.push(req.url);
      const r = list[Math.min(i, list.length - 1)];
      i++;
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
    server.received = received;
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function serverUrl(s) { const { address, port } = s.address(); return `http://${address}:${port}`; }

function mkTmp(content) {
  const p = path.join(os.tmpdir(), `vncrf-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}

// ===== buildInFilter =====

test('buildInFilter wraps each id in quotes and joins with commas', () => {
  const f = buildInFilter(['a', 'b', 'c']);
  assert.equal(f, "Microsoft.Dynamics.CRM.In(PropertyName='MetadataId',PropertyValues=['a','b','c'])");
});

// ===== chunk =====

test('chunk splits array into batches of N', () => {
  assert.deepEqual(chunk([1,2,3,4,5], 2), [[1,2], [3,4], [5]]);
  assert.deepEqual(chunk([], 25), []);
});

// ===== validateNoIscustomizableFalseRows =====

test('errors if --pending-file missing', async () => {
  const r = await validateNoIscustomizableFalseRows({ envUrl: 'http://x', token: 't' });
  assert.ok(r.error);
});

test('returns ok=true when snapshot has no Entity/Attribute components (all skipped → info)', async () => {
  const pf = mkTmp({ items: [{ componentId: 'g1', componentType: 'Web Page' }] });
  try {
    const r = await validateNoIscustomizableFalseRows({
      envUrl: 'http://localhost:1', token: 'tok', pendingFile: pf,
    });
    assert.equal(r.ok, true);
    assert.equal(r.totalChecked, 0);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.info.length, 1);
    assert.equal(r.info[0].key, 'iscustomizable-check-skipped-type');
    assert.equal(r.info[0].details.componentType, 'Web Page');
  } finally { fs.unlinkSync(pf); }
});

test('emits WARN per non-customizable Entity', async () => {
  const server = await createTestServer({
    status: 200,
    body: {
      value: [
        { MetadataId: 'gA', LogicalName: 'sri_intern',     IsCustomizable: { Value: true  } },
        { MetadataId: 'gB', LogicalName: 'sri_blocked',    IsCustomizable: { Value: false } },
      ],
    },
  });
  const pf = mkTmp({ items: [
    { componentId: 'gA', componentType: 'Entity', componentName: 'sri_intern'  },
    { componentId: 'gB', componentType: 'Entity', componentName: 'sri_blocked' },
  ] });
  try {
    const r = await validateNoIscustomizableFalseRows({
      envUrl: serverUrl(server), token: 'tok', pendingFile: pf,
    });
    assert.equal(r.ok, true);
    assert.equal(r.totalChecked, 2);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].severity, 'warn');
    assert.equal(r.warnings[0].key, 'not-customizable-metadata');
    assert.equal(r.warnings[0].ref, 'IL-007');
    assert.equal(r.warnings[0].details.componentId, 'gB');
    assert.equal(r.warnings[0].details.logicalName, 'sri_blocked');
    assert.match(r.warnings[0].message, /sri_blocked/);
  } finally { server.close(); fs.unlinkSync(pf); }
});

test('batches large id lists by batchSize', async () => {
  // 50 ids → with batchSize=25, expect 2 HTTP requests.
  const ids = Array.from({ length: 50 }, (_, i) => `g${i}`);
  const server = await createTestServer([
    { status: 200, body: { value: [] } },
    { status: 200, body: { value: [] } },
  ]);
  const pf = mkTmp({ items: ids.map((id) => ({ componentId: id, componentType: 'Entity' })) });
  try {
    const r = await validateNoIscustomizableFalseRows({
      envUrl: serverUrl(server), token: 'tok', pendingFile: pf, batchSize: 25,
    });
    assert.equal(r.ok, true);
    assert.equal(r.totalChecked, 50);
    assert.equal(server.received.length, 2);
  } finally { server.close(); fs.unlinkSync(pf); }
});

test('combines warnings across multiple batches', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `g${i}`);
  const server = await createTestServer([
    { status: 200, body: { value: [
      { MetadataId: 'g0',  LogicalName: 'a', IsCustomizable: { Value: false } },
    ] } },
    { status: 200, body: { value: [
      { MetadataId: 'g25', LogicalName: 'b', IsCustomizable: { Value: false } },
    ] } },
  ]);
  const pf = mkTmp({ items: ids.map((id) => ({ componentId: id, componentType: 'Entity' })) });
  try {
    const r = await validateNoIscustomizableFalseRows({
      envUrl: serverUrl(server), token: 'tok', pendingFile: pf, batchSize: 25,
    });
    assert.equal(r.warnings.length, 2);
    const named = r.warnings.map((w) => w.details.logicalName).sort();
    assert.deepEqual(named, ['a', 'b']);
  } finally { server.close(); fs.unlinkSync(pf); }
});

test('returns {error} on HTTP failure', async () => {
  const server = await createTestServer({ status: 401, body: { error: { message: 'unauth' } } });
  const pf = mkTmp({ items: [{ componentId: 'g0', componentType: 'Entity' }] });
  try {
    const r = await validateNoIscustomizableFalseRows({
      envUrl: serverUrl(server), token: 'tok', pendingFile: pf,
    });
    assert.ok(r.error);
  } finally { server.close(); fs.unlinkSync(pf); }
});

test('handles snapshot in items-only array form', async () => {
  const server = await createTestServer({ status: 200, body: { value: [] } });
  const pf = mkTmp([{ componentId: 'g0', componentType: 'Entity' }]);
  try {
    const r = await validateNoIscustomizableFalseRows({
      envUrl: serverUrl(server), token: 'tok', pendingFile: pf,
    });
    assert.equal(r.ok, true);
    assert.equal(r.totalChecked, 1);
  } finally { server.close(); fs.unlinkSync(pf); }
});
