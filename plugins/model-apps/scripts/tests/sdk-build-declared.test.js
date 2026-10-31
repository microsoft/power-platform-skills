'use strict';
// Declared reconciliation through the whole build: runSdkBuild over the REAL vendored SDK and the stateful fake environment
// (helpers/fake-app-build-org.js), so what is asserted is what reached the wire. Covers the declared view and chart branches
// (views[].reconcile / charts[].reconcile "declared"), Quick Find (entities[].quickFind), keyed commands, the creation port,
// the approvals a refusal names, settlement (a result that is not clean is reported and never published) and the run-wide table
// publication barrier (a table with a failed declared write is not published by any later publish in the run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild, previewTargetOf } = require('../lib/sdk-build.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { createPassthroughCreates } = require('../lib/creates-passthrough.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ENTITIES = {
  contoso_item: { attributes: { contoso_name: 'String', contoso_code: 'String', contoso_kind: 'Picklist' } },
  contoso_other: { attributes: { contoso_name: 'String', contoso_code: 'String' } },
};

const table = (schemaName, extra = {}) => ({
  schemaName, displayName: schemaName, existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
  columns: [{ schemaName: 'contoso_code', displayName: 'Code', type: 'Text' }], ...extra,
});

function makeSpec(extra = {}) {
  return {
    solution: { uniqueName: 'ContosoDeclared', displayName: 'Contoso Declared', publisherPrefix: 'contoso' },
    app: { name: 'Declared Views', uniqueName: 'contoso_declaredviews' },
    entities: [table('contoso_item'), table('contoso_other')],
    views: [],
    charts: [],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
    ...extra,
  };
}

const declaredView = (over = {}) => ({ entity: 'contoso_item', name: 'Declared Items', reconcile: 'declared', columns: ['contoso_name', 'contoso_code'], ...over });
const declaredChart = (over = {}) => ({ entity: 'contoso_item', name: 'By Kind', chartType: 'Pie', groupBy: 'contoso_kind', reconcile: 'declared', ...over });

function newOrg() {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-build-declared-'));
  dirs.push(dir);
  return { org, dir };
}

// One build over a fresh SDK on the same workspace folder, as the CLI's durable workspace is reused by a re-run.
async function build({ org, dir }, spec, opts = {}) {
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
  await sdk.initWorkspace();
  const mark = org.calls.length;
  const warns = [];
  let out;
  let err;
  try {
    out = await runSdkBuild(spec, { sdk, apply: true, publish: false, workspaceDir: dir, appDir: dir, env: org.origin, warn: (w) => warns.push(w), ...opts });
  } catch (e) {
    err = e;
  }
  const calls = org.calls.slice(mark);
  return {
    out, err, warns, calls,
    writes: calls.filter((c) => c.method !== 'GET'),
    tablePublishes: org.tablePublishes(mark),
    named: (t) => org.tablePublishes(mark).filter((names) => names.includes(t)).length,
  };
}

// A port that records each call and each execute, over the build's own allocation.
function spyCreates() {
  const runs = [];
  const base = createPassthroughCreates();
  return {
    runs,
    run: async (request, execute) => {
      const entry = { kind: request.kind, key: request.key, executes: 0, id: null };
      runs.push(entry);
      const out = await base.run(request, async (ids) => { entry.executes += 1; entry.id = ids.id; return execute(ids); });
      return out;
    },
  };
}

const viewRows = (org) => org.fake.rows('savedqueries').map((r) => r.data);

test('a new declared view goes through the creation port once, keeps the id the port allocated, and is published once without the publish phase', async () => {
  const env = newOrg();
  const creates = spyCreates();
  const r = await build(env, makeSpec({ views: [declaredView()] }), { phases: ['views'], creates });
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.deepEqual(creates.runs.map((x) => [x.kind, x.key, x.executes]), [['view', 'contoso_item/Declared Items', 1]]);
  assert.equal(r.out.created.views['contoso_item|Declared Items'], creates.runs[0].id);
  assert.ok(viewRows(env.org).some((v) => v.savedqueryid === creates.runs[0].id && v.name === 'Declared Items'));
  assert.equal(r.writes.filter((c) => c.method === 'POST' && c.path.startsWith('/savedqueries')).length, 1);
  assert.equal(r.writes.filter((c) => c.path === '/AddSolutionComponent').length, 1);
  assert.equal(r.named('contoso_item'), 1);
});

test('a new declared view with the publish phase is published once, in the phase-8 envelope', async () => {
  const env = newOrg();
  const r = await build(env, makeSpec({ views: [declaredView()] }), { phases: ['views', 'publish'], publish: true });
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.equal(r.named('contoso_item'), 1);
});

test('a declared view rebuilt unchanged writes nothing; a changed one over an unbound view needs the adopt approval the halt names', async () => {
  const env = newOrg();
  const first = await build(env, makeSpec({ views: [declaredView({ columns: ['contoso_name'] })] }), { phases: ['views'] });
  assert.equal(first.err, undefined, first.err && first.err.message);

  const again = await build(env, makeSpec({ views: [declaredView({ columns: ['contoso_name'] })] }), { phases: ['views'] });
  assert.equal(again.err, undefined, again.err && again.err.message);
  assert.deepEqual(again.writes, []);

  // No managed-binding store is wired, so the view the first run created is unbound: a change to it is an adoption.
  const changed = makeSpec({ views: [declaredView()] });
  const refused = await build(env, changed, { phases: ['views'] });
  assert.ok(refused.err, 'the refused view halts the run');
  assert.equal(refused.err.code, 'view-adoption-not-authorized');
  assert.match(refused.err.message, /--authorize adopt:contoso_item\/Declared Items/);
  assert.deepEqual(refused.err.incomplete.map((x) => x.code), ['view-adoption-not-authorized']);
  assert.deepEqual(refused.writes, []);

  const adopted = await build(env, changed, { phases: ['views'], authorizedAdoption: new Set(['contoso_item/Declared Items']) });
  assert.equal(adopted.err, undefined, adopted.err && adopted.err.message);
  assert.equal(adopted.writes.filter((c) => c.method === 'PATCH' && /^\/savedqueries\(/.test(c.path)).length, 1);
  assert.equal(adopted.named('contoso_item'), 1);

  // Removing a column the view shows is destructive: the halt names the flag that approves it, and nothing is written.
  const narrowed = await build(env, makeSpec({ views: [declaredView({ columns: ['contoso_name'] })] }), { phases: ['views'], authorizedAdoption: new Set(['contoso_item/Declared Items']) });
  assert.equal(narrowed.err && narrowed.err.code, 'view-columns-removal-not-authorized');
  assert.match(narrowed.err.message, /--allow-destructive/);
  assert.deepEqual(narrowed.writes, []);
});

test('a declared view whose name an existing view already holds is refused before any write, with no create and no solution add', async () => {
  const env = newOrg();
  await build(env, makeSpec({ views: [{ entity: 'contoso_item', name: 'Declared Items', columns: ['contoso_name'] }] }), { phases: ['views'] });
  const creates = spyCreates();
  const r = await build(env, makeSpec({ views: [declaredView()] }), { phases: ['views'], creates });
  assert.equal(r.err && r.err.code, 'view-adoption-not-authorized');
  assert.deepEqual(creates.runs, []);
  assert.deepEqual(r.writes, []);
});

test('chart parity: a declared chart without a title is published exactly as a legacy chart in the same phase set', async () => {
  for (const [phases, publish, expected] of [[['charts', 'publish'], true, 1], [['charts', 'publish'], false, 0], [['charts'], false, 0]]) {
    const counts = [];
    for (const chart of [{ entity: 'contoso_item', name: 'By Kind', chartType: 'Pie', groupBy: 'contoso_kind' }, declaredChart()]) {
      const env = newOrg();
      const r = await build(env, makeSpec({ charts: [chart] }), { phases, publish });
      assert.equal(r.err, undefined, r.err && r.err.message);
      counts.push(r.named('contoso_item'));
    }
    assert.deepEqual(counts, [expected, expected], `${phases.join('+')} publish=${publish}`);
  }
});

test('a new declared chart goes through the creation port and keeps the id the port allocated', async () => {
  const env = newOrg();
  const creates = spyCreates();
  const r = await build(env, makeSpec({ charts: [declaredChart()] }), { phases: ['charts'], creates });
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.deepEqual(creates.runs.map((x) => [x.kind, x.key, x.executes]), [['chart', 'contoso_item/By Kind', 1]]);
  assert.equal(r.out.created.charts['contoso_item|By Kind'], creates.runs[0].id);
});

test('barrier: a declared chart that ends refused withholds its table from every later publish; another table is still published once', async () => {
  for (const publish of [true, false]) {
    const env = newOrg();
    const spec = makeSpec({
      views: [{ entity: 'contoso_other', name: 'Other Items', columns: ['contoso_name', 'contoso_code'], reconcile: 'declared' }],
      // A new chart cannot store a title, so the titled chart is created but never settles; its sibling on the same table is clean.
      charts: [declaredChart({ title: 'Kinds' }), { entity: 'contoso_item', name: 'Plain', chartType: 'Pie', groupBy: 'contoso_kind' }],
    });
    const r = await build(env, spec, { phases: ['views', 'charts', 'publish'], publish });
    assert.ok(r.err, `publish=${publish}: the run halts`);
    assert.ok(r.err.incomplete.some((x) => x.code === 'chart-title-not-stored'), JSON.stringify(r.err.incomplete));
    assert.equal(r.named('contoso_item'), 0, `publish=${publish}: ${JSON.stringify(r.tablePublishes)}`);
    assert.equal(r.named('contoso_other'), 1, `publish=${publish}: ${JSON.stringify(r.tablePublishes)}`);
    assert.equal(r.writes.filter((c) => c.path === '/AddSolutionComponent').length >= 2, true, 'the created charts still join the solution');
  }
});

// The fake answers no per-table attribute list; the SDK reads one to choose each find column's search template.
function answerAttributes(org, names) {
  return org.intercept((c) => c.method === 'GET' && /^\/EntityDefinitions\(LogicalName='contoso_item'\)\/Attributes/.test(c.path),
    () => ({ status: 200, headers: {}, body: { value: names.map((LogicalName) => ({ LogicalName, AttributeType: 'String' })) } }));
}

async function seedQuickFind(org, columns) {
  const base = `${org.origin}/api/data/v9.0`;
  const conds = columns.map((c) => `<condition attribute="${c}" operator="like" value="{0}"/>`).join('');
  const fetchxml = `<fetch version="1.0" mapping="logical"><entity name="contoso_item"><attribute name="contoso_name"/><filter type="and"><condition attribute="statecode" operator="eq" value="0"/></filter><filter type="or" isquickfindfields="1">${conds}</filter></entity></fetch>`;
  await org.fake.httpClient.post(`${base}/savedqueries`, { savedqueryid: randomUUID(), name: 'Quick Find Active Items', returnedtypecode: 'contoso_item', querytype: 4, isdefault: true, fetchxml,
    layoutxml: '<grid name="resultset" object="10001" jump="contoso_name" select="1" icon="1" preview="1"><row name="result" id="contoso_itemid"><cell name="contoso_name" width="300"/></row></grid>' });
  await org.fake.httpClient.post(`${base}/PublishXml`, { ParameterXml: '<importexportxml><entities><entity>contoso_item</entity></entities></importexportxml>' });
}

const quickFindSpec = (findColumns) => makeSpec({ entities: [table('contoso_item', { quickFind: { findColumns }, enrichDefaultViews: false }), table('contoso_other')] });

test('Quick Find alone publishes its table exactly once, with and without the publish phase, and nothing when the list already matches', async () => {
  for (const [phases, publish] of [[['views'], false], [['views', 'publish'], true]]) {
    const env = newOrg();
    await seedQuickFind(env.org, ['contoso_name']);
    answerAttributes(env.org, ['contoso_name', 'contoso_code']);
    const r = await build(env, quickFindSpec(['contoso_name', 'contoso_code']), { phases, publish });
    assert.equal(r.err, undefined, r.err && r.err.message);
    assert.equal(r.named('contoso_item'), 1, `${phases.join('+')}: ${JSON.stringify(r.tablePublishes)}`);
    const again = await build(env, quickFindSpec(['contoso_name', 'contoso_code']), { phases, publish });
    assert.equal(again.err, undefined, again.err && again.err.message);
    assert.deepEqual(again.writes.filter((c) => c.path !== '/PublishXml'), []);
    assert.equal(again.named('contoso_item'), 0);
  }
});

test('a Quick Find list the SDK refuses is reported, publishes nothing, and is refused again on a re-run over the same workspace', async () => {
  const env = newOrg();
  await seedQuickFind(env.org, ['contoso_name']);
  answerAttributes(env.org, ['contoso_name']);
  for (let run = 0; run < 2; run += 1) {
    const r = await build(env, quickFindSpec(['contoso_name', 'contoso_code']), { phases: ['views'] });
    assert.equal(r.err && r.err.code, 'quick-find-rejected', `run ${run + 1}`);
    assert.deepEqual(r.writes, [], `run ${run + 1}`);
  }
});

// An SDK over the build's workspace whose reset reads (fetchArtifact with overwrite) can be made to fail, counting each.
async function resetSdk({ org, dir }, failResets) {
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
  await sdk.initWorkspace();
  const resets = { count: 0 };
  const fetch = sdk.fetchArtifact;
  sdk.fetchArtifact = async (kind, id, options) => {
    if (options && options.overwrite) {
      resets.count += 1;
      if (failResets) throw Object.assign(new Error('reset read temporarily unavailable'), { code: 'ECONNRESET' });
    }
    return fetch.call(sdk, kind, id, options);
  };
  return { sdk, resets };
}

test('a refused Quick Find list whose copy reset failed is refused again on the next run, never read as already stored', async () => {
  const env = newOrg();
  await seedQuickFind(env.org, ['contoso_name']);
  answerAttributes(env.org, ['contoso_name']);
  const spec = quickFindSpec(['contoso_name', 'contoso_code']);
  const failing = await resetSdk(env, true);
  const first = await build(env, spec, { phases: ['views'], sdk: failing.sdk });
  assert.equal(first.err && first.err.code, 'quick-find-rejected');
  assert.equal(failing.resets.count, 1, 'the apply tried to reset the copy');

  // The next run finds the earlier run's unsent edit in the copy, resets it once and is refused for the list again.
  const working = await resetSdk(env, false);
  const again = await build(env, spec, { phases: ['views'], sdk: working.sdk });
  assert.equal(again.err && again.err.code, 'quick-find-rejected', 'a reset that failed cannot certify a list the server never stored');
  assert.deepEqual(again.writes, []);
  assert.equal(working.resets.count, 2, 'one reset before planning, one after the refused apply');

  // Where that reset fails as well, the item is not applied and the run says why.
  await build(env, spec, { phases: ['views'], sdk: (await resetSdk(env, true)).sdk });
  const blocked = await build(env, spec, { phases: ['views'], sdk: (await resetSdk(env, true)).sdk });
  assert.equal(blocked.err && blocked.err.code, 'workspace-copy-unsent-edits');
  assert.deepEqual(blocked.writes, []);
  assert.equal(blocked.named('contoso_item'), 0);
});

test('a declared view whose copy holds an earlier run\'s unsent edit is planned over the server\'s copy and written', async () => {
  const env = newOrg();
  const first = await build(env, makeSpec({ views: [declaredView({ columns: ['contoso_name'] })] }), { phases: ['views'] });
  assert.equal(first.err, undefined, first.err && first.err.message);
  const id = first.out.created.views['contoso_item|Declared Items'];

  // An interrupted run: the column is added to the workspace copy and never pushed.
  const { sdk } = await resetSdk(env, false);
  await sdk.fetchArtifact('view', id);
  const copy = await sdk.getArtifact('view', id);
  await sdk.updateElement('view', id, '/columns', [...copy.columns, { ...copy.columns[0], name: 'contoso_code' }]);
  const stored = () => viewRows(env.org).find((v) => v.savedqueryid === id).layoutxml;
  assert.doesNotMatch(stored(), /contoso_code/);

  const adopt = new Set(['contoso_item/Declared Items']);
  const working = await resetSdk(env, false);
  const r = await build(env, makeSpec({ views: [declaredView()] }), { phases: ['views'], authorizedAdoption: adopt, sdk: working.sdk });
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.equal(working.resets.count, 1);
  assert.equal(r.writes.filter((c) => c.method === 'PATCH' && /^\/savedqueries\(/.test(c.path)).length, 1, 'the column is sent, not taken as already there');
  assert.match(stored(), /contoso_code/);

  // A clean copy is planned as before: no reset read, and nothing written.
  const clean = await resetSdk(env, false);
  const again = await build(env, makeSpec({ views: [declaredView()] }), { phases: ['views'], authorizedAdoption: adopt, sdk: clean.sdk });
  assert.equal(again.err, undefined, again.err && again.err.message);
  assert.equal(clean.resets.count, 0);
  assert.deepEqual(again.writes, []);
});

test('push preview: a declared view edit is not evaluated rather than previewed as unchanged; the apply writes it', async () => {
  const env = newOrg();
  const view = declaredView({ activeOnly: false });
  const first = await build(env, makeSpec({ views: [view] }), { phases: ['views'] });
  assert.equal(first.err, undefined, first.err && first.err.message);
  const spec = makeSpec({ views: [{ ...view, filters: [{ attr: 'contoso_code', op: 'eq', value: 'TARGET' }] }] });
  const authorizedAdoption = new Set(['contoso_item/Declared Items']);
  const preview = await build(env, spec, { phases: ['views'], apply: false, previewPush: true, authorizedAdoption, httpClient: env.org.httpClient });
  assert.equal(preview.err, undefined, preview.err && preview.err.message);
  assert.deepEqual(preview.writes, []);
  const p = preview.out.pushPreview;
  assert.ok(!(p.previews || []).some((x) => x.type === 'view'), JSON.stringify(p.previews));
  assert.ok((p.notEvaluated || []).some((x) => /^view:contoso_item:Declared Items/.test(x.key) && x.reason === 'noTypedTarget'), JSON.stringify(p.notEvaluated));
  const applied = await build(env, spec, { phases: ['views'], authorizedAdoption });
  assert.equal(applied.err, undefined, applied.err && applied.err.message);
  assert.equal(applied.writes.filter((c) => c.method === 'PATCH' && c.path.startsWith('/savedqueries(')).length, 1);
});

test('push preview targets: declared views and charts have none; a legacy reused view and a legacy new chart keep theirs', () => {
  const legacyView = { entity: 'contoso_item', name: 'Legacy Items', columns: ['contoso_name'] };
  const legacyChart = { entity: 'contoso_item', name: 'Plain', chartType: 'Pie', groupBy: 'contoso_kind' };
  const spec = makeSpec({ views: [declaredView(), legacyView], charts: [declaredChart(), legacyChart] });
  const liveId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const reused = (v) => ({ state: 'reuse', liveId, key: { kind: 'view', entity: v.entity, name: v.name, declared: v } });
  const created = (c) => ({ state: 'create', key: { kind: 'chart', entity: c.entity, name: c.name } });
  assert.equal(previewTargetOf(reused(spec.views[0]), spec), null);
  assert.equal(previewTargetOf(created(spec.charts[0]), spec), null);
  const view = previewTargetOf(reused(legacyView), spec);
  assert.deepEqual([view.type, view.id, typeof view.liveEdits], ['view', liveId, 'function']);
  const chart = previewTargetOf(created(legacyChart), spec);
  assert.equal(chart.type, 'chart');
  assert.equal(chart.create.name, 'Plain');
});

test('verify: a declared view with object and joined-table columns passes on the layout the build stores; a missing one is named', async () => {
  const env = newOrg();
  const view = declaredView({ activeOnly: false, columns: [{ name: 'contoso_name', width: 180 }, { name: 'contoso_code', width: 150 }] });
  const built = await build(env, makeSpec({ views: [view] }), { phases: ['views'] });
  assert.equal(built.err, undefined, built.err && built.err.message);
  const rows = viewRows(env.org).filter((r) => r.name === view.name);
  assert.equal(rows.length, 1);
  const read = { sitemapXml: async () => '<SiteMap/>', queryRecords: async (set) => (set === 'savedquery' ? rows : []) };
  const verified = await verifySpec({ views: [view], entities: [] }, read);
  assert.equal(verified.ok, true, JSON.stringify(verified.missing));
  assert.ok(verified.checks.some((c) => c.kind === 'view-columns' && c.present));
  const legacy = await verifySpec({ views: [{ ...view, reconcile: undefined, columns: ['contoso_name', 'contoso_code'] }], entities: [] }, read);
  assert.equal(legacy.ok, true, 'a legacy string-column view verifies against the same row as before');

  const joined = declaredView({
    linkEntities: [{ name: 'contoso_other', from: 'contoso_otherid', to: 'contoso_otherid', alias: 'o' }],
    columns: [{ name: 'contoso_name', width: 180 }, { name: 'contoso_code', relatedEntity: 'o' }],
  });
  const layout = (cells) => [{ savedqueryid: rows[0].savedqueryid, layoutxml: `<grid name="resultset"><row name="result">${cells.map((c) => `<cell name="${c}" width="100"/>`).join('')}</row></grid>` }];
  const joinedRead = (cells) => ({ sitemapXml: async () => '<SiteMap/>', queryRecords: async (set) => (set === 'savedquery' ? layout(cells) : []) });
  assert.equal((await verifySpec({ views: [joined], entities: [] }, joinedRead(['contoso_name', 'o.contoso_code']))).ok, true);
  const missing = await verifySpec({ views: [joined], entities: [] }, joinedRead(['contoso_name']));
  assert.equal(missing.ok, false);
  assert.match(missing.missing.find((c) => c.kind === 'view-columns').detail, /missing column\(s\): o\.contoso_code$/);
});

// A reader over the fake org's saved queries that, like a hand-made reader, answers the whole set whatever the filter.
const quickFindReader = (rows, counter = { reads: 0 }) => ({
  sitemapXml: async () => '<SiteMap/>', findTable: async () => ({ logicalName: 'contoso_item' }), findColumns: async () => [],
  queryRecords: async (set) => { if (set === 'savedquery') counter.reads += 1; return typeof rows === 'function' ? rows() : rows; },
});
const qfSpec = (findColumns) => ({ entities: [{ schemaName: 'contoso_item', columns: [], quickFind: { findColumns } }] });
const qfCheck = (r) => r.checks.find((c) => c.kind === 'quick-find');

test('verify: a declared Quick Find list is read from the table\'s Quick Find view; the stored list passes, another fails', async () => {
  const env = newOrg();
  await seedQuickFind(env.org, ['contoso_name']);
  answerAttributes(env.org, ['contoso_name', 'contoso_code']);
  const built = await build(env, quickFindSpec(['contoso_code', 'contoso_name']), { phases: ['views'] });
  assert.equal(built.err, undefined, built.err && built.err.message);
  const counter = { reads: 0 };
  const read = quickFindReader(() => viewRows(env.org), counter);
  const ok = await verifySpec(qfSpec(['contoso_code', 'contoso_name']), read);
  assert.equal(ok.ok, true, JSON.stringify(ok.missing));
  assert.deepEqual([qfCheck(ok).name, qfCheck(ok).present], ['contoso_item', true]);
  assert.equal(counter.reads, 1);

  for (const declared of [['contoso_name', 'contoso_code'], ['contoso_name'], ['contoso_code', 'contoso_name', 'contoso_kind']]) {
    const r = await verifySpec(qfSpec(declared), read);
    assert.equal(r.ok, false, declared.join(','));
    assert.match(qfCheck(r).detail, /^expected find columns \[.*\], stored \[contoso_code, contoso_name\]$/);
  }

  // A spec that declares no Quick Find reads no view for it.
  const plain = { reads: 0 };
  const none = await verifySpec({ entities: [{ schemaName: 'contoso_item', columns: [] }] }, quickFindReader(() => viewRows(env.org), plain));
  assert.equal(none.ok, true);
  assert.equal(plain.reads, 0);
  assert.equal(qfCheck(none), undefined);
});

test('verify: a Quick Find view that is missing, ambiguous, unreadable or not a plain list never passes', async () => {
  const qf = (conds, over = {}) => ({ savedqueryid: randomUUID(), returnedtypecode: 'contoso_item', querytype: 4, isdefault: true, fetchxml: `<fetch><entity name="contoso_item"><filter type="and"><condition attribute="statecode" operator="eq" value="0"/></filter>${conds}</entity></fetch>`, ...over });
  const list = '<filter type="or" isquickfindfields="1"><condition attribute="contoso_name" operator="like" value="{0}"/></filter>';
  const cases = [
    ['no view', [], /no default Quick Find view/],
    ['only a non-default one', [qf(list, { isdefault: false })], /no default Quick Find view/],
    ['another table\'s', [qf(list, { returnedtypecode: 'contoso_other' })], /no default Quick Find view/],
    ['two defaults', [qf(list), qf(list)], /2 default Quick Find views/],
    ['no find filter', [qf('')], /no find filter/],
    ['a nested filter', [qf('<filter type="or" isquickfindfields="1"><condition attribute="contoso_name" operator="like" value="{0}"/><filter type="and"><condition attribute="contoso_code" operator="like" value="{0}"/></filter></filter>')], /more than conditions/],
    ['a literal condition', [qf('<filter type="or" isquickfindfields="1"><condition attribute="contoso_name" operator="eq" value="x"/></filter>')], /not a find column/],
    ['a joined-table condition', [qf('<filter type="or" isquickfindfields="1"><condition entityname="o" attribute="contoso_name" operator="like" value="{0}"/></filter>')], /not a find column/],
    ['only inside a join', [qf(`<link-entity name="contoso_other" from="a" to="b">${list}</link-entity>`)], /no find filter/],
  ];
  for (const [name, rows, detail] of cases) {
    const r = await verifySpec(qfSpec(['contoso_name']), quickFindReader(rows));
    assert.equal(r.ok, false, name);
    assert.match(qfCheck(r).detail, detail, name);
  }
  const unreadable = await verifySpec(qfSpec(['contoso_name']), { ...quickFindReader([]), queryRecords: async () => { throw new Error('HTTP 503'); } });
  assert.equal(unreadable.ok, false);
  assert.match(qfCheck(unreadable).detail, /could not be read: HTTP 503/);
  // A reader that answers without the view's content (an existence-only stub) neither passes nor fails the list: it is
  // reported as not verified. A row carrying any of the fields is still judged.
  const stub = await verifySpec(qfSpec(['contoso_name']), quickFindReader([{ savedqueryid: 'x' }]));
  assert.equal(qfCheck(stub), undefined);
  assert.ok(stub.unverified.some((u) => /^quick-find:contoso_item \(the reader returned the view without its content\)$/.test(u)), JSON.stringify(stub.unverified));
  assert.equal((await verifySpec(qfSpec(['contoso_name']), quickFindReader([{ savedqueryid: 'x', querytype: 4, isdefault: true, returnedtypecode: 'contoso_item' }]))).ok, false);
  // The control: the same view with the declared list passes, its find filter self-closed or not.
  assert.equal((await verifySpec(qfSpec(['contoso_name']), quickFindReader([qf(list)]))).ok, true);
  assert.equal((await verifySpec(qfSpec([]), quickFindReader([qf('<filter type="or" isquickfindfields="1"/>')]))).ok, true);
});

test('a keyed command bar is refused without the managed-binding store, and nothing is written', async () => {
  const env = newOrg();
  const spec = makeSpec({
    webResources: [{ name: 'contoso_/a.js', type: 'js', content: 'function go(){}' }],
    commands: [{ entity: 'contoso_item', key: 'go', label: 'Go', library: 'contoso_/a.js', function: 'go' }],
  });
  const r = await build(env, spec, { phases: ['commands'] });
  assert.equal(r.err && r.err.code, 'managed-binding-port-unavailable');
  assert.deepEqual(r.writes, []);
});

test('reconcile on a kind 2.21.0 does not reconcile is a validation error', () => {
  const spec = makeSpec({ forms: [{ entity: 'contoso_item', name: 'Item', layout: 'auto', reconcile: 'declared' }] });
  const v = validateAppSpec(spec);
  assert.ok(v.errors.some((e) => /reconcile/.test(e) && /form/i.test(e)), JSON.stringify(v.errors));
  const legacy = validateAppSpec(makeSpec({ forms: [{ entity: 'contoso_item', name: 'Item', layout: 'auto' }] }));
  assert.ok(!legacy.errors.some((e) => /reconcile/.test(e)), JSON.stringify(legacy.errors));
});
