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
const { readOnlyHttpClient, READ_ONLY_WRITE_REFUSED, findingOf, publicError } = require('../lib/readonly-operations.js');
const bar = require('./helpers/command-bar-org.js');

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

test('findingOf projects a caught error to its code, its HTTP status and fixed words: none of the error\'s own text', () => {
  const leak = 'SENTINEL-value-from-the-service https://contoso.crm.dynamics.com/api/data/v9.2/x?$filter=a eyJabcdefghij.klmnopqrstu.vwx';
  const wrapped = Object.assign(new Error(`the read failed: ${leak}`), { code: 'CONNECTION_ERROR', cause: Object.assign(new Error(leak), { statusCode: 403 }) });
  const f = findingOf(wrapped, 'FALLBACK');
  assert.deepEqual(Object.keys(f).sort(), ['code', 'message', 'statusCode']);
  assert.equal(f.code, 'CONNECTION_ERROR');
  assert.equal(f.statusCode, 403, 'the status is found on the cause the SDK wrapped');
  assert.match(f.message, /HTTP 403/);
  assert.doesNotMatch(JSON.stringify(f), /SENTINEL|contoso|eyJ|the read failed/);
  // A code that is not a code (free text) is not passed on; a plain error has no status.
  assert.equal(findingOf(Object.assign(new Error(leak), { code: `no such row ${leak}` }), 'FALLBACK').code, 'FALLBACK');
  assert.equal(findingOf(new Error(leak)).statusCode, undefined);
  assert.doesNotMatch(findingOf(new Error(leak)).message, /SENTINEL/);
  // The plugin's own refusals keep their words: they are written here, from the maker's input, never from a service.
  assert.equal(findingOf(publicError('PREVIEW_ITEMS_INVALID', 'items[0].key must be a non-empty string')).message, 'items[0].key must be a non-empty string');
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
  assert.equal(res.allEvaluated, true);
  assert.deepEqual(res.notEvaluated, []);
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
  assert.equal(res.notPrepared[0].statusCode, 404);
  assert.match(res.notPrepared[0].message, /HTTP 404/);
  assert.doesNotMatch(res.notPrepared[0].message, /contoso\.crm\.dynamics\.com/, 'no URL in a finding');
  assert.deepEqual(res.requiresSchema.map((r) => r.key), ['column:contoso_ticket:contoso_extra']);
  assert.deepEqual(res.summary, { ready: 1, refused: 0, unknown: 0, requiresSchema: 1, notPrepared: 1, notEvaluated: 0 });
  assert.equal(res.allEvaluated, false, 'an item that could not be prepared was not evaluated');
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
  assert.deepEqual(res.notEvaluated, [], 'every prepared artifact was dirty, so the batch answered each one');
  assert.ok(res.sharedRequests >= 0);
  assert.deepEqual(snapshot(e.root), before, 'the build\u2019s app folder and workspace are byte-for-byte as they were');
});

test('previewItemsFromPlan: schema creates become requiresSchema; an item with no typed target or an unknown live state is kept as not evaluated, never dropped', () => {
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
    { key: 'view:contoso_ticket:Lost', notEvaluated: 'livePlanUnknown' },
    { key: 'form:contoso_ticket:Main', notEvaluated: 'noTypedTarget' },
  ]);
  assert.deepEqual(pp.validatePreviewItems(items).errors, []);
  assert.match(pp.validatePreviewItems([{ key: 'x', notEvaluated: 'noTypedTarget', type: 'view' }]).errors.join(), /items\[0\]\.type cannot be combined with notEvaluated/);
  assert.match(pp.validatePreviewItems([{ key: 'x', notEvaluated: 'because' }]).errors.join(), /items\[0\]\.notEvaluated must be one of/);
});

test('a preview reports the items it did not evaluate, with why, and is never all-evaluated while one remains', async () => {
  const items = pp.previewItemsFromPlan([{ key: { kind: 'form', entity: 'contoso_ticket', name: 'Main' }, state: 'reuse' }], () => null);
  const deps = { makerSdk: { createNodeWorkspaceStorage: () => ({}), createMakerSdk: () => ({ initWorkspace: async () => {} }) } };
  const res = await pp.runPushPreview({ env: 'https://contoso.crm.dynamics.com', httpClient: { get: async () => ({ status: 200, body: {} }) }, items, deps });
  assert.deepEqual(res.notEvaluated, [{ key: 'form:contoso_ticket:Main', reason: 'noTypedTarget' }]);
  assert.equal(res.summary.notEvaluated, 1);
  assert.equal(res.allEvaluated, false);
  assert.equal(res.ok, true, 'ok still means only that nothing was written');
});

test('a schema item whose live state the dry run could not read (or did not read) is not evaluated; only a known schema reuse is left out', async () => {
  // The real dry-run annotation: a schema read that fails leaves the item `unknown`, never create or reuse.
  const { annotateLivePlan } = require('../lib/sdk-build.js');
  const plan = [{ key: { kind: 'relationship', entity: 'contoso_ticket', name: 'contoso_parent_ticket', relType: 'OneToMany' } }];
  await annotateLivePlan(plan, { spec: {}, provision: { dataverse: { get: async () => { throw Object.assign(new Error('unreadable'), { statusCode: 403 }); } } } });
  assert.equal(plan[0].state, 'unknown');
  plan.push(
    { key: { kind: 'column', entity: 'contoso_ticket', name: 'contoso_note' } },
    { key: { kind: 'column', entity: 'contoso_ticket', name: 'contoso_kept' }, state: 'reuse' },
    { key: { kind: 'table', entity: 'contoso_new' }, state: 'create' },
  );
  const items = pp.previewItemsFromPlan(plan, () => { throw new Error('a schema item is never resolved'); });
  assert.deepEqual(items, [
    { key: 'relationship:contoso_ticket:contoso_parent_ticket', notEvaluated: 'livePlanUnknown' },
    { key: 'column:contoso_ticket:contoso_note', notEvaluated: 'livePlanUnknown' },
    { key: 'table:contoso_new:0', requiresSchema: true },
  ]);
  const deps = { makerSdk: { createNodeWorkspaceStorage: () => ({}), createMakerSdk: () => ({ initWorkspace: async () => {} }) } };
  const res = await pp.runPushPreview({ env: 'https://contoso.crm.dynamics.com', httpClient: { get: async () => { throw new Error('unexpected GET'); } }, items, deps });
  assert.equal(res.summary.notEvaluated, 2, 'the unreadable relationship and the unread column must not disappear');
  assert.equal(res.allEvaluated, false);
});

test('real bundle: batch mode reports a prepared artifact the batch did not preview (no local edit) as not evaluated, never as covered', async () => {
  const e = await env();
  const mark = e.org.requests.length;
  const clean = await pp.runPushPreview({ ...e.options, mode: 'batch', items: [{ key: 'unchanged', type: 'view', id: e.view.savedqueryid }] });
  assert.deepEqual(clean.previews, [], 'the batch previews only dirty artifacts');
  assert.deepEqual(clean.notEvaluated, [{ key: 'unchanged', reason: 'notInBatch' }]);
  assert.equal(clean.summary.notEvaluated, 1);
  assert.equal(clean.allEvaluated, false, 'no preview evaluated this prepared view');
  const mixed = await pp.runPushPreview({ ...e.options, mode: 'batch', items: [
    { key: 'unchanged', type: 'view', id: e.view.savedqueryid },
    { key: 'new', type: 'view', create: { name: 'Mixed batch view', entityLogicalName: 'contoso_ticket', columns: [{ name: 'contoso_name', width: 100 }] } },
  ] });
  assert.deepEqual(mixed.previews.map((p) => p.key), ['new']);
  assert.deepEqual(mixed.notEvaluated, [{ key: 'unchanged', reason: 'notInBatch' }]);
  assert.equal(mixed.allEvaluated, false);
  assert.deepEqual(nonGets(e.org, mark), [], 'GETs only');
});

// --- the command bar: named by its table ---------------------------------------------------------------------

test('real bundle: an existing command bar is named by its table logical name, as the SDK names it, and previews with GETs only', async () => {
  const client = bar.barClient(bar.BAR);
  const item = { key: 'command:contoso_ticket', type: 'command', id: 'contoso_ticket' };
  assert.deepEqual(pp.validatePreviewItems([item]).errors, []);
  const res = await pp.runPushPreview({ env: bar.ORIGIN, httpClient: client, items: [item] });
  assert.equal(res.writeAttempts, 0);
  assert.deepEqual(res.notPrepared, []);
  assert.deepEqual(res.previews.map((p) => [p.key, p.type, p.id]), [['command:contoso_ticket', 'command', 'contoso_ticket']]);
  assert.deepEqual(client.requests.filter((r) => !r.startsWith('GET ')), []);
  // Every other kind is still a row GUID, and a command bar is never a row GUID or a display name.
  const bad = pp.validatePreviewItems([
    { key: 'a', type: 'command', id: '11111111-2222-3333-4444-555555555555' },
    { key: 'b', type: 'command', id: 'Contoso Ticket' },
    { key: 'c', type: 'form', id: 'contoso_ticket' },
  ]).errors.join('\n');
  assert.match(bad, /items\[0\]\.id must be the table logical name of a command bar/);
  assert.match(bad, /items\[1\]\.id must be the table logical name of a command bar/);
  assert.match(bad, /items\[2\]\.id must be a canonical GUID/);
});

// --- privacy of failures ------------------------------------------------------------------------------------

test('real transport: a failed fetch and an SDK finding reach the result as codes and statuses only — no service-supplied words', async () => {
  const leak = 'SENTINEL-business-value SECRET_VALUE_6ce33d';
  const refusing = createAzHttpClient('https://contoso.crm.dynamics.com', {
    getToken: () => TOKEN,
    sleep: async () => {},
    request: async () => ({ statusCode: 403, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80040220', message: `Access denied for ${leak}` } }) }),
  });
  const res = await pp.runPushPreview({ env: 'https://contoso.crm.dynamics.com', httpClient: refusing, items: [{ key: 'v', type: 'view', id: '11111111-2222-3333-4444-555555555555' }] });
  assert.equal(res.notPrepared.length, 1);
  assert.equal(res.notPrepared[0].statusCode, 403);
  assert.doesNotMatch(JSON.stringify(res), /SENTINEL|SECRET_VALUE/);
  // An SDK refusal or warning is projected to its code: its message is not assumed to be free of values.
  const deps = {
    makerSdk: {
      createNodeWorkspaceStorage: () => ({}),
      createMakerSdk: () => ({
        initWorkspace: async () => {},
        fetchArtifact: async () => ({}),
        previewPush: async (type, id) => ({ type, id, action: 'update', outcome: 'refused', refusals: [{ code: 'VALIDATION_FAILED', message: `bad value ${leak}`, issues: [{}] }], warnings: [{ code: 'NOTE', message: leak }], notEvaluated: [], localChanges: [], concurrency: { verdict: 'current', observations: [] }, components: [], publish: { byPush: false }, requests: 1 }),
      }),
    },
  };
  const stub = await pp.runPushPreview({ env: 'https://contoso.crm.dynamics.com', httpClient: { get: async () => ({ status: 200, body: {} }) }, items: [{ key: 'v', type: 'view', id: '11111111-2222-3333-4444-555555555555' }], deps });
  assert.deepEqual(stub.previews[0].refusals, [{ code: 'VALIDATION_FAILED', issues: 1 }]);
  assert.deepEqual(stub.previews[0].warnings, [{ code: 'NOTE' }]);
  assert.doesNotMatch(JSON.stringify(stub), /SENTINEL|SECRET_VALUE/);
});

// --- the dry run's own preview (lib/sdk-build.js previewTargetOf): what the BUILD would push, not the live row as it stands ---

async function dryRunPreview(e, s) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
  const { runSdkBuild } = require('../lib/sdk-build.js');
  const dir = makeTempDir('push-preview-build-');
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(path.join(dir, 'sdk')), instanceUrl: e.org.origin, httpClient: e.client, solutionUniqueName: s.solution.uniqueName, languageCode: 1033 });
  await sdk.initWorkspace();
  const mark = e.org.requests.length;
  const r = await runSdkBuild(s, { sdk, provisionSdk: sdk, apply: false, emit: () => {}, previewPush: true, env: e.org.origin, httpClient: e.client, preResolvedLanguageCode: 1033, appDir: path.join(dir, 'app') });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { r, writes: nonGets(e.org, mark) };
}

test('real bundle: a dry run previews an existing view the spec leaves as it is as noChange/ready, GETs only', async () => {
  const e = await env();
  const { r, writes } = await dryRunPreview(e, spec);
  assert.deepEqual(writes, [], 'no request other than GET reached the environment');
  const p = r.pushPreview.previews.find((x) => x.key === 'view:contoso_ticket:Open tickets');
  assert.ok(p, JSON.stringify(r.pushPreview));
  assert.equal(p.action, 'noChange');
  assert.equal(p.outcome, 'ready');
  assert.deepEqual(p.localChanges, []);
  assert.equal(r.pushPreview.writeAttempts, 0);
});

test('real bundle: a dry run previews an existing view WITH the column the spec adds (an update), and lists what it cannot prepare as not evaluated', async () => {
  const e = await env();
  const changed = structuredClone(spec);
  changed.views[0].columns.push('contoso_note');
  const before = JSON.stringify(e.org.find('savedqueries', (v) => v.savedqueryid === e.view.savedqueryid)[0]);
  const { r, writes } = await dryRunPreview(e, changed);
  assert.deepEqual(writes, [], 'no request other than GET reached the environment');
  assert.equal(JSON.stringify(e.org.find('savedqueries', (v) => v.savedqueryid === e.view.savedqueryid)[0]), before, 'the server row is unchanged');
  const p = r.pushPreview.previews.find((x) => x.key === 'view:contoso_ticket:Open tickets');
  assert.ok(p, JSON.stringify(r.pushPreview));
  assert.equal(p.action, 'update', 'the column the build would add is part of the preview, not left out as an unedited live view');
  assert.ok(p.localChanges.length > 0 && p.localChanges.every((c) => c.pointer.startsWith('/columns')), JSON.stringify(p.localChanges));
  // The existing app is reconciled by the build only while it runs (header, sitemap, components), so it has no
  // typed change here: it is listed as not evaluated, never previewed as the unedited live app.
  assert.ok(!r.pushPreview.previews.some((x) => x.type === 'app'), JSON.stringify(r.pushPreview.previews.map((x) => x.key)));
  assert.ok(r.pushPreview.notEvaluated.some((n) => /^app:/.test(n.key) && n.reason === 'noTypedTarget'), JSON.stringify(r.pushPreview.notEvaluated));
  assert.equal(r.pushPreview.allEvaluated, false);
});