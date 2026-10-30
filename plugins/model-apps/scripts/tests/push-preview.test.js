'use strict';
// The read-only push preview (lib/push-preview.js, `--preview-push`): an isolated throwaway workspace, fresh fetches, typed
// local edits, then the bundled SDK's previewPush — over the REAL vendored SDK, the plugin's own HTTP client and the
// stateful fake Dataverse the lifecycle tests share. Pinned here: nothing but GETs reaches the environment, a write
// attempt is refused before it is sent and makes the result untrustworthy, a stale token is reported as stale (not
// ready), a failed read is a per-item finding (never "absent" and never a reason to call the others ready), a row
// artifact whose write plan the SDK cannot evaluate is never ready, a schema step is not dressed up as an artifact
// preview, and the build's own workspace is not touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness } = require('./helpers/lifecycle-harness.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const pp = require('../lib/push-preview.js');
const { readOnlyHttpClient, READ_ONLY_WRITE_REFUSED, safeMessage } = require('../lib/readonly-operations.js');

const TOKEN = 'x'.repeat(48);
const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoTickets', displayName: 'Contoso Tickets', publisherPrefix: 'contoso' },
  app: { name: 'Tickets' },
  entities: [{ schemaName: 'contoso_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [{ schemaName: 'contoso_note', displayName: 'Note', type: 'Text' }] }],
  views: [{ entity: 'contoso_ticket', name: 'Open tickets', columns: ['contoso_name'] }],
  appShell: { areas: [{ label: 'Work', groups: [{ label: 'Tickets', subAreas: [{ entity: 'contoso_ticket', title: 'Tickets' }] }] }] },
};

let envP;
function env() {
  if (!envP) {
    envP = (async () => {
      const org = createLifecycleOrg();
      const root = makeTempDir('push-preview-');
      const harness = createLifecycleHarness(org, root);
      const built = await harness.measure(() => harness.build(spec));
      if (built.error) throw built.error;
      assert.equal(built.value.result.ok, true, JSON.stringify(built.value.result.errors));
      const view = org.find('savedqueries', (v) => v.name === 'Open tickets')[0];
      const client = createAzHttpClient(org.origin, { getToken: () => TOKEN, request: org.request, sleep: async () => {} });
      return { org, root, view, client, options: { env: org.origin, httpClient: client, solutionUniqueName: 'ContosoTickets', languageCode: 1033 } };
    })();
  }
  return envP;
}
const nonGets = (org, mark) => org.requests.slice(mark).filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);

// --- validation -------------------------------------------------------------------------------------

test('preview items are validated before anything is read: closed keys, unique keys, canonical GUIDs, id xor create, pointer edits only', () => {
  const ok = pp.validatePreviewItems([
    { key: 'a', type: 'view', id: '11111111-2222-3333-4444-555555555555', edits: [{ op: 'update', pointer: '/name', value: 'x' }] },
    { key: 'b', type: 'view', create: { name: 'n' } },
    { key: 'c', requiresSchema: true },
  ]);
  assert.deepEqual(ok.errors, []);
  const bad = pp.validatePreviewItems([
    { key: 'a', type: 'view', id: 'not-a-guid', colour: 'red' },
    { key: 'a', type: 'view', create: { name: 'n' } },
    { key: 'c', type: 'genPage', id: '11111111-2222-3333-4444-555555555555' },
    { key: 'd', type: 'view', id: '11111111-2222-3333-4444-555555555555', create: {} },
    { key: 'e', type: 'view', id: '11111111-2222-3333-4444-555555555555', edits: [{ op: 'update', pointer: '', value: {} }, { op: 'replace', pointer: '/x' }, { op: 'add', pointer: '/x' }] },
    { key: 'f', requiresSchema: true, id: '11111111-2222-3333-4444-555555555555' },
  ]);
  const text = bad.errors.join('\n');
  assert.match(text, /items\[0\]\.colour is not a recognised field/);
  assert.match(text, /items\[0\]\.id must be a canonical GUID/);
  assert.match(text, /items\[1\]\.key "a" is used twice/);
  assert.match(text, /items\[2\]\.type must be one of/, 'a generative page is previewed by the page backend, not by pointer edits');
  assert.match(text, /items\[3\] needs exactly one of id .* or create/);
  assert.match(text, /items\[4\]\.edits\[0\]\.pointer must be a JSON Pointer starting with '\/'/, 'a whole-document replace would discard the server bags');
  assert.match(text, /items\[4\]\.edits\[1\]\.op must be one of: update, add, remove, move/);
  assert.match(text, /items\[4\]\.edits\[2\]\.element is required/);
  assert.match(text, /items\[5\]\.id cannot be combined with requiresSchema/);
  assert.deepEqual(pp.validatePreviewItems('x').errors, ['preview items must be an array']);
});

test('preparePushPreview refuses invalid items with PREVIEW_ITEMS_INVALID before making a workspace or a request', async () => {
  let made = 0;
  const deps = { makerSdk: { createMakerSdk() { made += 1; return {}; }, createNodeWorkspaceStorage() { return {}; } } };
  const httpClient = { get: async () => { throw new Error('no request expected'); } };
  await assert.rejects(pp.preparePushPreview({ env: 'https://contoso.crm.dynamics.com', httpClient, items: [{ key: '', type: 'view' }], deps }), (e) => e.code === 'PREVIEW_ITEMS_INVALID' && e.errors.length >= 2);
  assert.equal(made, 0);
});

// --- the read-only transport ------------------------------------------------------------------------

test('the read-only client forwards GETs and refuses every write method before it reaches the transport', async () => {
  const sent = [];
  const inner = {
    get: async (url) => { sent.push(`GET ${url}`); return { status: 200, headers: {}, body: {} }; },
    post: async (url) => { sent.push(`POST ${url}`); },
    patch: async (url) => { sent.push(`PATCH ${url}`); },
    delete: async (url) => { sent.push(`DELETE ${url}`); },
    postRaw: async (url) => { sent.push(`POSTRAW ${url}`); },
  };
  const { client, stats } = readOnlyHttpClient(inner);
  await client.get('https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries?$filter=name eq \'secret\'');
  for (const m of ['post', 'patch', 'delete', 'postRaw']) {
    await assert.rejects(client[m]('https://contoso.crm.dynamics.com/api/data/v9.2/$batch?x=1', {}), (e) => e.code === READ_ONLY_WRITE_REFUSED);
  }
  assert.equal(typeof client.put, 'undefined', 'a method the wrapped client lacks is not offered: the SDK decides capability by presence');
  assert.equal(typeof client.patchRaw, 'undefined');
  assert.deepEqual(sent, ["GET https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries?$filter=name eq 'secret'"]);
  assert.equal(stats.gets, 1);
  assert.equal(stats.refusedWrites, 4);
  assert.deepEqual(stats.refused.map((r) => r.path), Array(4).fill('/api/data/v9.2/$batch'), 'the query string (which can hold a value) is never recorded');
  assert.deepEqual(stats.refused.map((r) => r.method), ['POST', 'PATCH', 'DELETE', 'POST']);
});

test('safeMessage takes URLs and bearer material out of a caught error', () => {
  const m = safeMessage(new Error('HTTP 401 from https://contoso.crm.dynamics.com/api/data/v9.2/x?$filter=a: Bearer abc.def-ghi rejected eyJabcdefghij.klmnopqrstu.vwx'));
  assert.doesNotMatch(m, /contoso\.crm|abc\.def|eyJabc/);
  assert.match(m, /<url>/);
});

test('a write the SDK attempts during a preview is refused before sending and the result is not ok', async () => {
  const sent = [];
  const transport = { get: async () => ({ status: 200, headers: {}, body: {} }), post: async (u) => { sent.push(u); }, patch: async (u) => { sent.push(u); }, delete: async (u) => { sent.push(u); } };
  // A stand-in SDK that misbehaves: its preview tries a POST through the client it was given.
  const deps = {
    makerSdk: {
      createNodeWorkspaceStorage: () => ({}),
      createMakerSdk: ({ httpClient }) => ({
        initWorkspace: async () => {},
        fetchArtifact: async () => httpClient.get('https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(1)'),
        previewPush: async (type, id) => {
          await httpClient.post('https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries', {}).catch(() => {});
          return { type, id, action: 'noChange', outcome: 'ready', refusals: [], warnings: [], notEvaluated: [], localChanges: [], concurrency: { verdict: 'current', observations: [] }, components: [], publish: { byPush: false }, requests: 1 };
        },
      }),
    },
  };
  const res = await pp.runPushPreview({ env: 'https://contoso.crm.dynamics.com', httpClient: transport, items: [{ key: 'v', type: 'view', id: '11111111-2222-3333-4444-555555555555' }], deps });
  assert.equal(res.ok, false);
  assert.equal(res.writeAttempts, 1);
  assert.equal(res.error.code, READ_ONLY_WRITE_REFUSED);
  assert.deepEqual(sent, [], 'the write never reached the transport');
});

// --- real bundle ------------------------------------------------------------------------------------

test('real bundle: an unedited existing view previews as noChange/ready with a note that a push still writes it, using GETs only', async () => {
  const e = await env();
  const mark = e.org.requests.length;
  const res = await pp.runPushPreview({ ...e.options, items: [{ key: 'view:open', type: 'view', id: e.view.savedqueryid }] });
  assert.deepEqual(nonGets(e.org, mark), [], 'no request other than GET reached the environment');
  assert.equal(res.ok, true);
  assert.equal(res.writeAttempts, 0);
  const [p] = res.previews;
  assert.equal(p.key, 'view:open');
  assert.equal(p.action, 'noChange');
  assert.equal(p.outcome, 'ready');
  assert.match(p.note, /still writes/);
  assert.equal(p.concurrency.verdict, 'current');
  assert.equal(p.publication.byPush, false);
  assert.equal(p.publication.scope.envelope, 'entity');
  assert.match(res.disclaimer, /does not approve, lock or guarantee/);
  assert.ok(res.gets > 0 && res.gets === e.org.requests.length - mark, 'every request is counted');
});

test('real bundle: a prepared edit previews as update and reports the changed pointer without its value', async () => {
  const e = await env();
  const mark = e.org.requests.length;
  const res = await pp.runPushPreview({ ...e.options, items: [{ key: 'v', type: 'view', id: e.view.savedqueryid, edits: [{ op: 'update', pointer: '/description', value: 'SENTINEL-VALUE-7731' }] }] });
  assert.deepEqual(nonGets(e.org, mark), []);
  const [p] = res.previews;
  assert.equal(p.action, 'update');
  assert.equal(p.outcome, 'ready');
  assert.deepEqual(p.localChanges, [{ pointer: '/description', type: 'modified' }]);
  assert.doesNotMatch(JSON.stringify(res), /SENTINEL-VALUE-7731/, 'the preview carries no local-change values');
  assert.equal(e.org.find('savedqueries', (v) => v.savedqueryid === e.view.savedqueryid)[0].description || '', '', 'and the server row is unchanged');
});

test('real bundle: another writer changing the row after preparation makes the preview stale and refused (VERSION_CONFLICT), never ready', async () => {
  const e = await env();
  const handle = await pp.preparePushPreview({ ...e.options, items: [{ key: 'v', type: 'view', id: e.view.savedqueryid, edits: [{ op: 'update', pointer: '/description', value: 'mine' }] }] });
  try {
    const res = await e.org.request({ url: `${e.org.API}/savedqueries(${e.view.savedqueryid})`, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'theirs' }) });
    assert.ok(res.statusCode < 300);
    const mark = e.org.requests.length;
    const { previews } = await pp.previewPreparedArtifacts(handle);
    assert.deepEqual(nonGets(e.org, mark), []);
    assert.equal(previews[0].outcome, 'refused');
    assert.equal(previews[0].concurrency.verdict, 'stale');
    assert.deepEqual(previews[0].refusals.map((r) => r.code), ['VERSION_CONFLICT']);
    assert.deepEqual(previews[0].concurrency.remoteChanges, [{ pointer: '/description', type: 'modified' }]);
    assert.equal(handle.stats.refusedWrites, 0);
  } finally {
    handle.dispose();
  }
  await assert.rejects(pp.previewPreparedArtifacts(handle), (err) => err.code === 'PREVIEW_NOT_PREPARED', 'a disposed handle cannot be previewed');
});

test('real bundle: a create previews as create/absent; a failed fetch is that item\u2019s finding; a schema step is reported, not previewed', async () => {
  const e = await env();
  const mark = e.org.requests.length;
  const res = await pp.runPushPreview({
    ...e.options,
    items: [
      { key: 'view:new', type: 'view', create: { name: 'New view', entityLogicalName: 'contoso_ticket', columns: [{ name: 'contoso_name', width: 100 }] } },
      { key: 'view:gone', type: 'view', id: '00000000-0000-0000-0000-0000000000ab' },
      { key: 'column:contoso_ticket:contoso_extra', requiresSchema: true },
    ],
  });
  assert.deepEqual(nonGets(e.org, mark), []);
  assert.equal(res.ok, true);
  assert.deepEqual(res.previews.map((p) => [p.key, p.action, p.outcome, p.concurrency.verdict]), [['view:new', 'create', 'ready', 'absent']]);
  assert.equal(res.notPrepared.length, 1);
  assert.equal(res.notPrepared[0].key, 'view:gone');
  assert.match(res.notPrepared[0].message, /404/);
  assert.doesNotMatch(res.notPrepared[0].message, /contoso\.crm\.dynamics\.com/, 'no URL in a finding');
  assert.deepEqual(res.requiresSchema.map((r) => r.key), ['column:contoso_ticket:contoso_extra']);
  assert.deepEqual(res.summary, { ready: 1, refused: 0, unknown: 0, requiresSchema: 1, notPrepared: 1 });
  assert.equal(e.org.find('savedqueries', (v) => v.name === 'New view').length, 0, 'nothing was created');
});

test('real bundle: a row artifact whose write plan the SDK cannot evaluate is never ready (unknown, writePlan not evaluated)', async () => {
  const e = await env();
  const mark = e.org.requests.length;
  const res = await pp.runPushPreview({ ...e.options, items: [{ key: 'ev', type: 'environmentVariable', create: { schemaName: 'contoso_Setting', displayName: 'Setting', type: 'string' } }] });
  assert.deepEqual(nonGets(e.org, mark), []);
  const [p] = res.previews;
  assert.notEqual(p.outcome, 'ready');
  assert.ok(p.notEvaluated.includes('writePlan'), JSON.stringify(p));
});

test('real bundle: batch mode previews exactly the prepared dirty set, and the build\u2019s own workspace is untouched', async () => {
  const e = await env();
  const snapshot = (dir) => {
    const out = [];
    const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, n.name); if (n.isDirectory()) walk(f); else out.push(`${path.relative(dir, f)} ${fs.statSync(f).size} ${fs.statSync(f).mtimeMs}`); } };
    if (fs.existsSync(dir)) walk(dir);
    return out.sort();
  };
  const before = snapshot(e.root);
  const res = await pp.runPushPreview({ ...e.options, mode: 'batch', items: [
    { key: 'edited', type: 'view', id: e.view.savedqueryid, edits: [{ op: 'update', pointer: '/description', value: 'b' }] },
    { key: 'new', type: 'view', create: { name: 'Batch view', entityLogicalName: 'contoso_ticket', columns: [{ name: 'contoso_name', width: 100 }] } },
  ] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.previews.map((p) => p.key).sort(), ['edited', 'new']);
  assert.ok(res.sharedRequests >= 0);
  assert.deepEqual(snapshot(e.root), before, 'the build\u2019s app folder and workspace are byte-for-byte as they were');
});

test('previewItemsFromPlan: schema creates become requiresSchema, unknown states are skipped, the caller resolves artifacts', () => {
  const plan = [
    { key: { kind: 'table', entity: 'contoso_ticket' }, state: 'create' },
    { key: { kind: 'column', entity: 'contoso_ticket', name: 'contoso_note' }, state: 'reuse' },
    { key: { kind: 'view', entity: 'contoso_ticket', name: 'Open' }, state: 'reuse' },
    { key: { kind: 'view', entity: 'contoso_ticket', name: 'Lost' }, state: 'unknown' },
    { key: { kind: 'form', entity: 'contoso_ticket', name: 'Main' }, state: 'create' },
  ];
  const items = pp.previewItemsFromPlan(plan, (item) => (item.key.kind === 'view' ? { type: 'view', id: '11111111-2222-3333-4444-555555555555' } : null));
  assert.deepEqual(items, [
    { key: 'table:contoso_ticket:0', requiresSchema: true },
    { key: 'view:contoso_ticket:Open', type: 'view', id: '11111111-2222-3333-4444-555555555555' },
  ]);
  assert.deepEqual(pp.validatePreviewItems(items).errors, []);
});
