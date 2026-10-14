'use strict';
// An UNCHANGED rebuild must write (almost) nothing.
//
// Measured on a mid-sized app: `build --apply --publish --verify` straight after a successful build of the same spec
// still sent ~59 writes — an AddSolutionComponent per reused component, a PATCH and a PublishXml per existing view and
// form, and more. These tests drive the REAL vendored SDK against a stateful fake Dataverse (helpers/fake-dataverse.js)
// and count what actually reaches the wire, so each skipped write is proven against what the SDK really sends, and
// each one that must NOT be skipped is proven to still go out.
//
// Every test name starts "rebuild writes:". Four write-skipping behaviours are covered, in this order:
//   views        an existing view is pushed only when the reconcile changed it (columns / description), or an
//                interrupted run left an edit in the workspace
//   publishes    with --publish, a reconcile's own publish is left to the one phase-8 publish, and a failure of that
//                publish names the views, forms and charts it carried (a first build's included); without --publish,
//                each still publishes its own
//   forms        an existing form is pushed only when the reconcile changed it
//   membership   solution membership is read once; only components the solution does not already hold are added
// An edit a maker made in Dataverse since the last build must be converged, never skipped as "unchanged".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild, settleOwedPublishes } = require('../lib/sdk-build.js');
const { createFakeDataverse } = require('./helpers/fake-dataverse.js');

const COMPONENT = { view: 26, chart: 59, form: 60 };
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ENTITIES = {
  new_ticket: { attributes: { new_name: 'String', new_code: 'String', new_area: 'String', new_extra: 'String', new_taskid: 'Lookup' } },
  new_task: { attributes: { new_name: 'String', new_due: 'String' } },
};

// Two tables the build did not create (`existing: true`: no default-form promotion, no default-view enrichment — both
// are the SDK's or another path's writes, accounted for separately below): a view and a form on each, a Quick View
// form hosted on the ticket form, and a chart. This is the shape of the measured app, scaled down.
function specFor({ viewColumns = ['new_name', 'new_code'], viewDescription, ticketColumns = ['new_code', 'new_area'], authoredFilter = false } = {}) {
  return {
    $schemaVersion: '1.0',
    solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
    app: { name: 'Support Desk', uniqueName: 'new_supportdesk' },
    entities: [
      { schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', existing: true,
        primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        columns: ticketColumns.map((c) => ({ schemaName: c, displayName: c, type: 'Text' })) },
      { schemaName: 'new_task', displayName: 'Task', pluralName: 'Tasks', existing: true,
        primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        columns: [{ schemaName: 'new_due', displayName: 'Due', type: 'Text' }] },
    ],
    views: [
      { entity: 'new_ticket', name: 'Open Tickets', columns: viewColumns, ...(viewDescription ? { description: viewDescription } : {}),
        ...(authoredFilter ? { filters: [{ attr: 'new_code', op: 'eq', value: 'A' }] } : {}) },
      { entity: 'new_task', name: 'My Tasks', columns: ['new_name', 'new_due'] },
    ],
    charts: [{ entity: 'new_ticket', name: 'By Area', chartType: 'Pie', groupBy: 'new_area', measure: 'count' }],
    forms: [
      { entity: 'new_ticket', name: 'Ticket', layout: 'auto', quickViews: [{ lookup: 'new_taskid', targetEntity: 'new_task', form: 'Task Card' }] },
      { entity: 'new_task', name: 'Task', layout: 'auto' },
      { entity: 'new_task', name: 'Task Card', formType: 'QuickView', layout: 'auto' },
    ],
  };
}

// The same two tables with NO form in the spec: the view's table is carried by a view and the chart's by a chart, so each
// publish's vehicle is not a form. A column-only view change and a chart description are the two edits it can carry.
function formlessSpec(viewColumns, chartDescription) {
  return {
    $schemaVersion: '1.0',
    solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
    app: { name: 'Support Desk', uniqueName: 'new_supportdesk' },
    entities: [
      { schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [{ schemaName: 'new_code', displayName: 'Code', type: 'Text' }, { schemaName: 'new_area', displayName: 'Area', type: 'Text' }] },
      { schemaName: 'new_task', displayName: 'Task', pluralName: 'Tasks', existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [{ schemaName: 'new_due', displayName: 'Due', type: 'Text' }] },
    ],
    views: [{ entity: 'new_task', name: 'My Tasks', columns: viewColumns }],
    charts: [{ entity: 'new_ticket', name: 'By Area', chartType: 'Pie', groupBy: 'new_area', measure: 'count', ...(chartDescription ? { description: chartDescription } : {}) }],
  };
}

// One durable workspace and one fake environment per scenario; each build gets a FRESH SDK instance over the same
// workspace directory, as every CLI run does.
function scenario(fakeOptions = {}) {
  const fake = createFakeDataverse({ entities: ENTITIES, ...fakeOptions });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-writes-'));
  dirs.push(dir);
  const sdkOver = async (workspace = dir, { withoutDiff = false } = {}) => {
    const real = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(workspace), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient: fake.httpClient });
    await real.initWorkspace();
    if (!withoutDiff) return real;
    // An SDK without the dirty-tracking method: a method the engine finds missing must make it write as before.
    return new Proxy(real, { get: (target, key) => (key === 'diffArtifact' ? undefined : (typeof target[key] === 'function' ? target[key].bind(target) : target[key])) });
  };
  async function build(spec, { publish = true, phases, sdk, warnings = [] } = {}) {
    const mark = fake.mark();
    const useSdk = sdk || await sdkOver();
    const result = await runSdkBuild(spec, { sdk: useSdk, apply: true, publish, phases: phases || PHASES, warn: (w) => warnings.push(String(w)) });
    return { result, mark, writes: fake.writeCounts(mark), warnings, sdk: useSdk };
  }
  return { fake, dir, sdkOver, build };
}

const PHASES = ['views', 'charts', 'forms', 'publish'];

// --------------------------------------------------------------------------------------------- the baseline

test('rebuild writes: an unchanged rebuild sends nothing but the one phase-8 publish', async () => {
  const s = scenario();
  const first = await s.build(specFor());
  assert.deepEqual(first.writes, {
    'POST savedqueries': 2, 'POST savedqueryvisualizations': 1, 'POST systemforms': 3, 'PATCH systemforms': 1, 'POST AddSolutionComponent': 6, 'POST PublishXml': 1,
  }, 'the first build creates every component (the PATCH places the quick view on its host form), adds each to the solution, and publishes once');
  assert.deepEqual(s.fake.unpublished(), []);

  const again = await s.build(specFor());
  assert.deepEqual(again.writes, { 'POST PublishXml': 1 }, 'the only write left is phase 8\'s single envelope for the tables the spec touches');
  assert.equal(again.result.ok, true);
  assert.deepEqual(s.fake.unpublished(), [], 'nothing is left saved but unpublished');
  assert.equal(s.fake.requests.slice(again.mark).filter((e) => e.method === 'POST' && e.path === '/PublishXml').length, 1);
});

// ------------------------------------------------------------------------------------ views: pushed only when changed

test('rebuild writes: an existing view the reconcile changes is still pushed once, with its new column', async () => {
  const s = scenario();
  await s.build(specFor());
  const changed = await s.build(specFor({ viewColumns: ['new_name', 'new_code', 'new_area'] }));
  assert.equal(changed.writes['PATCH savedqueries'], 1, JSON.stringify(changed.writes));
  const [save] = s.fake.saves(changed.mark);
  assert.match(save.body.layoutxml, /<cell name="new_area"/, 'the added column reaches the layout');
  assert.match(save.body.layoutxml, /<cell name="new_code"/, 'the columns already there are kept');
  assert.equal(changed.writes['POST AddSolutionComponent'], undefined, 'it is already a member');
  assert.deepEqual(s.fake.unpublished(), [], 'and the change is published (by phase 8)');
});

test('rebuild writes: a changed view description is pushed; the same description a second time is not', async () => {
  const s = scenario();
  await s.build(specFor());
  const first = await s.build(specFor({ viewDescription: 'Open work, newest first.' }));
  const [save] = s.fake.saves(first.mark);
  assert.ok(save, JSON.stringify(first.writes));
  assert.equal(save.body.description, 'Open work, newest first.');
  const second = await s.build(specFor({ viewDescription: 'Open work, newest first.' }));
  assert.equal(second.writes['PATCH savedqueries'], undefined, 'an ordinary rebuild issues no extra write');
});

test('rebuild writes: a view edit an interrupted run left in the workspace is still pushed', async () => {
  const s = scenario();
  await s.build(specFor());
  // The run that wants a new column dies at the push: the workspace copy keeps the edit, the server never sees it.
  s.fake.failWritesWhen((req) => (req.method === 'PATCH' && /^\/savedqueries\(/.test(req.path) ? 500 : undefined));
  await assert.rejects(s.build(specFor({ viewColumns: ['new_name', 'new_code', 'new_area'] })), /push|500|simulated/i);
  s.fake.failWritesWhen(null);
  const savedBefore = s.fake.rows('savedqueries').filter((r) => r.data.name === 'Open Tickets')[0].data.layoutxml;
  assert.doesNotMatch(savedBefore, /new_area/, 'the server still lacks the column');

  // The next run reconciles the SAME spec. Against the server copy the view already "has" the column only because the
  // workspace kept the unpushed edit — comparing what this run computed with what was fetched would call it unchanged.
  const retry = await s.build(specFor({ viewColumns: ['new_name', 'new_code', 'new_area'] }));
  assert.equal(retry.writes['PATCH savedqueries'], 1, JSON.stringify(retry.writes));
  assert.match(s.fake.rows('savedqueries').filter((r) => r.data.name === 'Open Tickets')[0].data.layoutxml, /new_area/);
  assert.deepEqual(s.fake.unpublished(), []);
});

test('rebuild writes: the "authored filters are NOT reapplied" warning still fires on an unchanged rebuild', async () => {
  const s = scenario();
  const spec = specFor({ authoredFilter: true });
  await s.build(spec);
  const again = await s.build(spec);
  assert.equal(again.writes['PATCH savedqueries'], undefined);
  assert.ok(again.warnings.some((w) => /view 'Open Tickets' already exists/.test(w) && /NOT reapplied/.test(w)), again.warnings.join('\n'));
});

test('rebuild writes: an SDK without dirty tracking pushes an existing view exactly as before', async () => {
  const s = scenario();
  await s.build(specFor());
  const again = await s.build(specFor(), { sdk: await s.sdkOver(s.dir, { withoutDiff: true }) });
  assert.equal(again.writes['PATCH savedqueries'], 2, 'both views pushed, as before');
  assert.equal(again.writes['PATCH systemforms'], 3, 'and all three forms');
});

// -------------------------------------------------- publishes: left to phase 8 with --publish, per artifact without it

test('rebuild writes: with --publish a reconcile\'s own publish is left to phase 8, which publishes every table it touched', async () => {
  const s = scenario();
  await s.build(specFor());
  // Both tables change: a view column on the ticket, a form field on the task.
  const spec = specFor({ viewColumns: ['new_name', 'new_code', 'new_area'] });
  spec.entities[1].columns.push({ schemaName: 'new_extra', displayName: 'Extra', type: 'Text' });
  const changed = await s.build(spec);
  assert.equal(changed.writes['POST PublishXml'], 1, `one envelope, not one publish per reconciled artifact: ${JSON.stringify(changed.writes)}`);
  const publishXml = s.fake.since(changed.mark).filter((e) => e.path === '/PublishXml')[0];
  assert.match(publishXml.body.ParameterXml, /<entity>new_ticket<\/entity>/);
  assert.match(publishXml.body.ParameterXml, /<entity>new_task<\/entity>/);
  assert.deepEqual(s.fake.unpublished(), []);
});

test('rebuild writes: a table whose only reconciled artifact is a view, and one whose only artifact is a chart, are still published', async () => {
  const s = scenario();
  const spec = formlessSpec;
  await s.build(spec(['new_name']));
  const changed = await s.build(spec(['new_name', 'new_due'], 'Tickets by area.'));
  assert.equal(changed.writes['PATCH savedqueries'], 1, 'the task view gains its column');
  assert.equal(changed.writes['PATCH savedqueryvisualizations'], 1, 'the chart description is written');
  assert.equal(changed.writes['POST PublishXml'], 1, JSON.stringify(changed.writes));
  const xml = s.fake.since(changed.mark).find((e) => e.path === '/PublishXml').body.ParameterXml;
  assert.match(xml, /<entity>new_task<\/entity>/, 'the view\'s table (no form in the spec names it) is in the envelope');
  assert.match(xml, /<entity>new_ticket<\/entity>/, 'the chart\'s table is in the envelope');
  assert.deepEqual(s.fake.unpublished(), []);
});

test('rebuild writes: without --publish every reconciled view and form still publishes its own table, as before', async () => {
  const s = scenario();
  await s.build(specFor(), { publish: false });
  const again = await s.build(specFor(), { publish: false });
  // Nothing was pushed (unchanged), but a clean workspace copy is the UNPUBLISHED layer: it cannot show that an earlier
  // run which pushed and then stopped ever published, so the per-artifact publish stays — 2 views + 3 forms.
  assert.equal(again.writes['POST PublishXml'], 5, JSON.stringify(again.writes));
  assert.equal(again.writes['PATCH savedqueries'], undefined);
  assert.equal(again.writes['PATCH systemforms'], undefined);
  assert.equal(again.writes['POST AddSolutionComponent'], undefined);
});

test('rebuild writes: without --publish a view the earlier run pushed but never published is published by the rebuild', async () => {
  const s = scenario();
  await s.build(specFor(), { publish: false });
  // An earlier run saved a new column and stopped before any publish: simulated by a push that no publish follows.
  const sdk = await s.sdkOver();
  const view = s.fake.rows('savedqueries').find((r) => r.data.name === 'Open Tickets');
  await sdk.fetchArtifact('view', view.data.savedqueryid);
  await sdk.updateElement('view', view.data.savedqueryid, '/columns', [...(await sdk.getArtifact('view', view.data.savedqueryid)).columns, { name: 'new_area', width: 100, order: 2 }]);
  await sdk.pushArtifact('view', view.data.savedqueryid);
  assert.ok(s.fake.unpublished().some((r) => r.name === 'Open Tickets'), 'saved but unpublished');
  const again = await s.build(specFor({ viewColumns: ['new_name', 'new_code', 'new_area'] }), { publish: false });
  assert.equal(again.writes['PATCH savedqueries'], undefined, 'the server already has the column: nothing to push');
  assert.deepEqual(s.fake.unpublished().filter((r) => r.name === 'Open Tickets'), [], 'the rebuild still publishes it');
});

test('rebuild writes: a build that halts after a reconcile hands its caller the publish it owes, and settling it makes the change live', async () => {
  const s = scenario();
  await s.build(specFor());
  // The view is pushed (its publish deferred), then a form push fails and halts the forms phase before phase 8.
  s.fake.failWritesWhen((req) => (req.method === 'PATCH' && /^\/systemforms\(/.test(req.path) && req.body && req.body.formxml ? 500 : undefined));
  const spec = specFor({ viewColumns: ['new_name', 'new_code', 'new_area'] });
  spec.entities[0].columns.push({ schemaName: 'new_extra', displayName: 'Extra', type: 'Text' });
  const sdk = await s.sdkOver();
  const halted = await runSdkBuild(spec, { sdk, apply: true, publish: true, phases: PHASES }).then(() => null, (e) => e);
  assert.ok(halted, 'the build halts');
  s.fake.failWritesWhen(null);
  assert.ok(Array.isArray(halted.owedPublishes) && halted.owedPublishes.length >= 1, 'the halt carries what it owes');
  assert.ok(halted.owedPublishes.every(([type, id]) => type && id));
  assert.ok(s.fake.unpublished().some((r) => r.name === 'Open Tickets'), 'the saved view waits for its publish');
  assert.equal(Object.keys(halted).includes('owedPublishes'), false, 'it rides along, never into a serialized error');

  const warnings = [];
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w));
  assert.deepEqual(s.fake.unpublished().filter((r) => r.name === 'Open Tickets'), [], 'a halted build leaves the saved view live, as it did before publishes were deferred');
  assert.deepEqual(warnings, []);
});

// Settling happens only for a halt the build THROWS: a process killed outright (Ctrl-C, a crash) settles nothing, and
// no marker outlives it. That is a documented limit, so what it leaves must be exactly what a re-run repairs.
test('rebuild writes: a build killed between its reconcile and its publish leaves the edit saved, and the next build publishes it without writing it again', async () => {
  const s = scenario();
  await s.build(specFor());
  const grown = () => specFor({ viewColumns: ['new_name', 'new_code', 'new_area'] });
  // The process dies as phase 8 starts. Nothing here calls settleOwedPublishes, which is the point.
  const killed = (e) => { if (e.phase === 'publish' && e.status === 'start') throw new Error('process killed'); };
  const sdk = await s.sdkOver();
  await assert.rejects(runSdkBuild(grown(), { sdk, apply: true, publish: true, phases: PHASES, emit: killed }), /process killed/);
  assert.ok(s.fake.unpublished().some((r) => r.name === 'Open Tickets'), 'the saved view waits for a publish nothing will send');

  const again = await s.build(grown());
  assert.equal(again.writes['PATCH savedqueries'], undefined, 'the column is already on the server: nothing to write again');
  assert.deepEqual(s.fake.unpublished(), [], 'the next build publishes it');
});

// A deferred publish is ONE for a whole table, so the lines it prints when it fails or cannot be confirmed name the
// saved views and forms it was to publish, as the per-artifact publish it replaced did. Naming whichever artifact stands
// for the table (its Main form, usually untouched) would send a maker looking for the wrong thing.
const changedTicketSpec = () => {
  const spec = specFor({ viewColumns: ['new_name', 'new_code', 'new_area'] });
  spec.entities[0].columns.push({ schemaName: 'new_extra', displayName: 'Extra', type: 'Text' });
  return spec;
};
const PUBLISH_XML_DOWN = (req) => (req.method === 'POST' && req.path === '/PublishXml' ? 500 : undefined);

test('rebuild writes: a phase-8 publish that fails names the views and forms that were saved but are not live', async () => {
  const s = scenario();
  await s.build(specFor());
  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  const changed = await s.build(changedTicketSpec(), { warnings });
  s.fake.failWritesWhen(null);
  assert.equal(changed.result.ok, true, 'a refused publish is reported and left to the next build');
  assert.ok(s.fake.unpublished().some((r) => r.name === 'Open Tickets'), 'the saved view really is not live');

  const failed = warnings.filter((w) => /FAILED/.test(w));
  assert.equal(failed.length, 2, `one line per table: ${warnings.join('\n')}`);
  const ticket = failed.find((w) => /Open Tickets/.test(w));
  assert.match(ticket, /^publish view Open Tickets, form Ticket FAILED: /, 'the view that changed, and the form that rode with it');
  assert.match(ticket, /the change is SAVED but the runtime still serves the previously published copy/);
  const task = failed.find((w) => /My Tasks/.test(w));
  assert.ok(task && /form Task\b/.test(task) && /form Task Card/.test(task), `every reconciled artifact of the table is named: ${task}`);
  assert.ok(failed.every((w) => !/\b[0-9a-f]{8}-[0-9a-f]{4}-/.test(w)), `no bare artifact id stands in for a name: ${failed.join('\n')}`);
});

test('rebuild writes: a phase-8 publish that cannot be confirmed names the views and forms it covers', async () => {
  const s = scenario();
  await s.build(specFor());
  // The SDK says `unverifiable` when the published projection cannot be read back; the build reports what it is told.
  const real = await s.sdkOver();
  const sdk = new Proxy(real, {
    get: (target, key) => {
      if (key === 'publishArtifacts') {
        return async (items, options) => (await target.publishArtifacts(items, options)).map((r) => ({ ...r, shipped: false, publish: { kind: 'unverifiable', reason: 'the published projection could not be read' } }));
      }
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    },
  });
  const warnings = [];
  await s.build(specFor(), { sdk, warnings });
  const unconfirmed = warnings.filter((w) => /could not be CONFIRMED/.test(w));
  assert.equal(unconfirmed.length, 2, warnings.join('\n'));
  assert.match(unconfirmed.find((w) => /Open Tickets/.test(w)), /^publish view Open Tickets, form Ticket could not be CONFIRMED \(the published projection could not be read\) — /);
  assert.ok(unconfirmed.some((w) => /My Tasks/.test(w) && /form Task Card/.test(w)));
});

test('rebuild writes: when settling the publish a halted build owes fails, the warning names the saved views', async () => {
  const s = scenario();
  await s.build(specFor());
  s.fake.failWritesWhen((req) => (req.method === 'PATCH' && /^\/systemforms\(/.test(req.path) && req.body && req.body.formxml ? 500 : undefined));
  const sdk = await s.sdkOver();
  const halted = await runSdkBuild(changedTicketSpec(), { sdk, apply: true, publish: true, phases: PHASES }).then(() => null, (e) => e);
  assert.ok(halted, 'the build halts in the forms phase');
  const ticket = halted.owedPublishes.find(([, , names]) => (names || []).includes('view Open Tickets'));
  assert.ok(ticket, `the owed target carries the names of what it covers: ${JSON.stringify(halted.owedPublishes)}`);

  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w));
  s.fake.failWritesWhen(null);
  assert.ok(warnings.some((w) => /^the build stopped before its publish phase; publish view Open Tickets FAILED: /.test(w)), warnings.join('\n'));
});

// The default views the enrichment saved are owed the same publish. A table whose authored view changed AND whose generated
// Active/Inactive pair was enriched has three views saved but not live, and a line that named only the authored one would
// leave the pair looking published.
const enriched = (spec) => {
  for (const e of spec.entities) { delete e.existing; e.enrichDefaultViews = true; }
  return spec;
};
function enrichedScenario() {
  const s = scenario();
  s.fake.seedDefaultViews('new_ticket', 'Tickets');
  s.fake.seedDefaultViews('new_task', 'Tasks');
  return s;
}

test('rebuild writes: a failed phase-8 publish also names the default views the enrichment saved, whether it made the table\'s record or found it', async () => {
  const s = enrichedScenario();
  // The task table has no authored view, so its enrichment is what makes its record; the ticket table's authored view does.
  const spec = (viewColumns) => { const sp = enriched(specFor({ viewColumns })); sp.views = sp.views.filter((v) => v.entity === 'new_ticket'); return sp; };
  await s.build(spec(['new_name', 'new_code']));
  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  await s.build(spec(['new_name', 'new_code', 'new_area']), { warnings });
  s.fake.failWritesWhen(null);
  const notLive = s.fake.unpublished().map((r) => r.name);
  for (const name of ['Open Tickets', 'Active Tickets', 'Inactive Tickets', 'Active Tasks', 'Inactive Tasks']) assert.ok(notLive.includes(name), `${name} is saved but not live: ${notLive}`);

  const failed = warnings.filter((w) => /FAILED/.test(w));
  assert.equal(failed.length, 2, `one line per table: ${warnings.join('\n')}`);
  assert.match(failed.find((w) => /Open Tickets/.test(w)), /^publish view Open Tickets, default views of new_ticket, form Ticket FAILED: /, 'the authored view made the record; the enrichment joined it');
  const task = failed.find((w) => /new_task/.test(w));
  assert.match(task, /^publish default views of new_task, form Task/, `the enrichment made the record, and the forms joined it: ${failed.join('\n')}`);
  assert.match(task, /form Task Card/);
});

test('rebuild writes: when settling the publish a halted build owes fails, the warning also names the default views the enrichment saved', async () => {
  const s = enrichedScenario();
  await s.build(enriched(specFor()));
  s.fake.failWritesWhen((req) => (req.method === 'PATCH' && /^\/systemforms\(/.test(req.path) && req.body && req.body.formxml ? 500 : undefined));
  const sdk = await s.sdkOver();
  const halted = await runSdkBuild(enriched(changedTicketSpec()), { sdk, apply: true, publish: true, phases: PHASES }).then(() => null, (e) => e);
  assert.ok(halted, 'the build halts in the forms phase');
  const ticket = halted.owedPublishes.find(([, , names]) => (names || []).includes('view Open Tickets'));
  assert.deepEqual(ticket && ticket[2], ['view Open Tickets', 'default views of new_ticket'], `the owed target names both: ${JSON.stringify(halted.owedPublishes)}`);

  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w));
  s.fake.failWritesWhen(null);
  assert.ok(warnings.some((w) => /^the build stopped before its publish phase; publish view Open Tickets, default views of new_ticket FAILED: /.test(w)), warnings.join('\n'));
});

// The names one failed-publish line carries: `publish form Ticket, view Open Tickets FAILED: …` -> ['form Ticket', 'view Open Tickets'].
const carried = (line) => line.replace(/^publish /, '').replace(/ FAILED: .*$/, '').split(', ');

// What the build REQUESTS from the SDK, to prove the names only label the lines: a request is still a type and an id.
function recordPublishRequests(real) {
  const calls = [];
  const sdk = new Proxy(real, {
    get: (target, key) => {
      if (key === 'publishArtifacts' || key === 'publishArtifact') return (...args) => { calls.push({ via: key, args }); return target[key](...args); };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    },
  });
  return { sdk, calls };
}

// A FIRST build creates its views, forms and charts, so no reconcile deferred a publish for any of them and the only name a
// table's record held was its generated default views'. When that table's publish fails, everything the build saved on it is
// not live, and a line that named only the generated Active/Inactive pair read as if only those had failed.
test('rebuild writes: a failed phase-8 publish on a first build names the view, form and chart it created, not only the default views', async () => {
  const s = enrichedScenario();
  const { sdk, calls } = recordPublishRequests(await s.sdkOver());
  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  const first = await s.build(enriched(specFor()), { sdk, warnings });
  s.fake.failWritesWhen(null);
  assert.equal(first.result.ok, true, 'a refused publish is reported and left to the next build');
  const notLive = s.fake.unpublished().map((r) => r.name);
  for (const name of ['Open Tickets', 'By Area', 'Ticket', 'Active Tickets', 'Inactive Tickets', 'My Tasks', 'Task', 'Task Card', 'Active Tasks', 'Inactive Tasks']) assert.ok(notLive.includes(name), `${name} is saved but not live: ${notLive}`);

  const failed = warnings.filter((w) => /FAILED/.test(w));
  assert.equal(failed.length, 2, `one line per table: ${warnings.join('\n')}`);
  // One line per table, in spec order. What was deferred onto the table comes first (the enrichment, then the quick-view
  // placement), then what the build created, in name order because the artifacts are created concurrently — each name once.
  assert.deepEqual(failed.map((w) => carried(w)), [
    ['default views of new_ticket', 'form Ticket quick-views', 'chart By Area', 'form Ticket', 'view Open Tickets'],
    ['default views of new_task', 'form Task', 'form Task Card', 'view My Tasks'],
  ], failed.join('\n'));
  assert.ok(failed.every((w) => !/\b[0-9a-f]{8}-[0-9a-f]{4}-/.test(w)), `no bare artifact id stands in for a name: ${failed.join('\n')}`);

  // Only the label changed: the publish is asked for exactly as before — one envelope with one artifact per table, each a
  // type and an id, then each table that failed on its own — and nothing more is sent for it.
  const envelope = calls.filter((c) => c.via === 'publishArtifacts');
  const single = calls.filter((c) => c.via === 'publishArtifact');
  assert.equal(envelope.length, 1, 'one envelope');
  assert.deepEqual(envelope[0].args[0].map((item) => [Object.keys(item).sort().join(), item.type]), [['id,type', 'form'], ['id,type', 'form']], 'the Main form of each table carries its publish, named by type and id only');
  assert.equal(single.length, 2, 'then each failed table on its own');
  for (const { args } of single) assert.equal(args.length, 2, 'a single publish is a type and an id');
  assert.equal(first.writes['POST PublishXml'], 3, `one envelope and one publish per failed table, nothing more: ${JSON.stringify(first.writes)}`);
});

test('rebuild writes: a failed phase-8 publish on a first build of tables it does not enrich names what it created, not a bare form id', async () => {
  const s = scenario();
  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  await s.build(specFor(), { warnings });
  s.fake.failWritesWhen(null);
  const failed = warnings.filter((w) => /FAILED/.test(w));
  assert.equal(failed.length, 2, `one line per table: ${warnings.join('\n')}`);
  // One line per table, in spec order. The ticket table's only deferred publish is its quick-view placement; the task
  // table has none, so its Main form used to stand for it as a bare id.
  assert.deepEqual(failed.map((w) => carried(w)), [
    ['form Ticket quick-views', 'chart By Area', 'form Ticket', 'view Open Tickets'],
    ['form Task', 'form Task Card', 'view My Tasks'],
  ], failed.join('\n'));
  assert.ok(failed.every((w) => !/\b[0-9a-f]{8}-[0-9a-f]{4}-/.test(w)), `no bare artifact id stands in for a name: ${failed.join('\n')}`);
});

test('rebuild writes: a failed phase-8 publish on a first build names the view or chart that stands for a table with no form', async () => {
  const s = scenario();
  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  await s.build(formlessSpec(['new_name']), { warnings });
  s.fake.failWritesWhen(null);
  const failed = warnings.filter((w) => /FAILED/.test(w));
  assert.equal(failed.length, 2, `one line per table: ${warnings.join('\n')}`);
  assert.deepEqual(failed.map((w) => carried(w)).sort(), [['chart By Area'], ['view My Tasks']], `the artifact that carries each table is named: ${failed.join('\n')}`);
});

test('rebuild writes: a failed phase-8 publish names a view a rebuild added and a chart description it wrote, beside what it reconciled', async () => {
  const s = scenario();
  await s.build(specFor());
  const grown = specFor();
  grown.views.push({ entity: 'new_ticket', name: 'Closed Tickets', columns: ['new_name'] });
  grown.charts[0].description = 'Tickets by area.';
  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  const again = await s.build(grown, { warnings });
  s.fake.failWritesWhen(null);
  assert.equal(again.writes['POST savedqueries'], 1, 'the new view is created');
  assert.equal(again.writes['PATCH savedqueryvisualizations'], 1, 'the chart description is written');
  // The two reconciled artifacts first (deferred in phase order), then what the rebuild created or wrote, in name order.
  const failed = warnings.filter((w) => /FAILED/.test(w));
  const ticketLine = failed.find((w) => /Open Tickets/.test(w));
  assert.ok(ticketLine, `the ticket table's line names its reconciled view: ${failed.join('\n')}`);
  assert.deepEqual(carried(ticketLine), ['view Open Tickets', 'form Ticket', 'chart By Area', 'view Closed Tickets']);
});

// A name is said once, and only for something the build saved: a chart whose description the spec sets but that was already there was not written, so it is not named; and a form the
// reconcile deferred and a form of the same name the build created are one `form Ticket`, not two.
test('rebuild writes: an unchanged chart whose description the spec sets is not named', async () => {
  const s = scenario();
  const spec = () => { const sp = specFor(); sp.charts[0].description = 'Tickets by area.'; return sp; };
  await s.build(spec());
  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  await s.build(spec(), { warnings });
  s.fake.failWritesWhen(null);
  const ticket = warnings.filter((w) => /FAILED/.test(w)).find((w) => /Open Tickets/.test(w));
  assert.ok(ticket, warnings.join('\n'));
  assert.ok(!carried(ticket).includes('chart By Area'), ticket);
});

test('rebuild writes: a reconciled form and a created form of the same name are named once', async () => {
  const s = scenario();
  await s.build(specFor());
  const grown = specFor();
  grown.forms.push({ entity: 'new_ticket', name: 'Ticket', formType: 'QuickCreate', layout: 'auto' });
  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  await s.build(grown, { warnings });
  s.fake.failWritesWhen(null);
  const ticket = warnings.filter((w) => /FAILED/.test(w)).find((w) => /Open Tickets/.test(w));
  assert.equal(carried(ticket).filter((n) => n === 'form Ticket').length, 1, ticket);
});

// The SDK saves both generated views of every table it enriches on EVERY build, so the enrichment's name is in the record on an
// unchanged rebuild too, not only when something changed. (Should the SDK ever skip an identical save, this and the comment at
// the enrichment step go stale together.)
test('rebuild writes: an unchanged rebuild still names the default views when its publish fails, because the SDK saves them on every build', async () => {
  const s = enrichedScenario();
  const first = await s.build(enriched(specFor()));
  // `since(mark)` runs to the end of the log, so the first build's saves are read before the second build starts.
  const savesSince = (mark) => Object.fromEntries(s.fake.since(mark).filter((e) => e.method === 'PATCH' && /^\/savedqueries\(/.test(e.path)).map((e) => [e.path, JSON.stringify(e.body)]));
  const savedFirst = savesSince(first.mark);
  assert.equal(Object.keys(savedFirst).length, 4, 'the first build enriches both generated views of each table');
  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  const again = await s.build(enriched(specFor()), { warnings });
  s.fake.failWritesWhen(null);
  assert.equal(again.writes['PATCH savedqueries'], 4, `both generated views of each table are saved again: ${JSON.stringify(again.writes)}`);
  assert.deepEqual(savesSince(again.mark), savedFirst, 'with the content they already had');
  const failed = warnings.filter((w) => /FAILED/.test(w));
  assert.equal(failed.length, 2, `one line per table: ${warnings.join('\n')}`);
  assert.ok(carried(failed.find((w) => /new_ticket/.test(w))).includes('default views of new_ticket'), failed.join('\n'));
  assert.ok(carried(failed.find((w) => /new_task/.test(w))).includes('default views of new_task'), failed.join('\n'));
});

// The names of what a build CREATED only label a failed publish; they are not a debt. What a halted build settles is what
// it DEFERRED, so a table whose artifacts it merely created is left exactly as it always was — nothing published for it.
test('rebuild writes: a first build that halts owes no publish for the views, forms and charts it merely created', async () => {
  const s = scenario();
  s.fake.failWritesWhen((req) => (req.method === 'PATCH' && /^\/systemforms\(/.test(req.path) && req.body && req.body.formxml ? 500 : undefined));
  const sdk = await s.sdkOver();
  const mark = s.fake.mark();
  const halted = await runSdkBuild(specFor(), { sdk, apply: true, publish: true, phases: PHASES }).then(() => null, (e) => e);
  s.fake.failWritesWhen(null);
  assert.ok(halted, 'the build halts in the forms phase, when the quick view is placed');
  assert.ok(s.fake.unpublished().some((r) => r.name === 'Open Tickets') && s.fake.unpublished().some((r) => r.name === 'By Area'), 'the created view and chart are saved and not live');
  assert.equal(halted.owedPublishes, undefined, 'nothing was deferred, so nothing is owed');
  assert.equal(s.fake.since(mark).filter((e) => e.path === '/PublishXml').length, 0, 'and no publish was sent');
});

test('rebuild writes: wiring a form event handler defers its publish too, and a rebuild that adds nothing wires and publishes nothing', async () => {
  const s = scenario();
  const spec = specFor();
  spec.forms[1].events = [{ event: 'onload', library: 'new_tasklib.js', function: 'taskLoad' }];
  const first = await s.build(spec);
  // 3 creates + the quick view's host push + the handler's push; the quick-view and handler publishes are phase 8's.
  assert.equal(first.writes['PATCH systemforms'], 2, JSON.stringify(first.writes));
  assert.equal(first.writes['POST PublishXml'], 1, `one publish for the whole build: ${JSON.stringify(first.writes)}`);
  assert.deepEqual(s.fake.unpublished(), []);

  const again = await s.build(spec);
  assert.deepEqual(again.writes, { 'POST PublishXml': 1 });

  spec.forms[1].events.push({ event: 'onsave', library: 'new_tasklib.js', function: 'taskSave' });
  const added = await s.build(spec);
  assert.equal(added.writes['PATCH systemforms'], 1, 'only the form that gained a handler is pushed');
  assert.equal(added.writes['POST PublishXml'], 1);
  assert.deepEqual(s.fake.unpublished(), []);
});

// ------------------------------------------------------------------------------------ forms: pushed only when changed

test('rebuild writes: an existing form the reconcile changes is still pushed once, with its new field', async () => {
  const s = scenario();
  await s.build(specFor());
  const spec = specFor();
  spec.entities[1].columns.push({ schemaName: 'new_extra', displayName: 'Extra', type: 'Text' });
  const changed = await s.build(spec);
  assert.equal(changed.writes['PATCH systemforms'], 2, `the task Main form and its quick view both gain the field: ${JSON.stringify(changed.writes)}`);
  assert.ok(s.fake.saves(changed.mark).every((e) => /new_extra/.test(e.body.formxml)));
  assert.equal(changed.writes['POST AddSolutionComponent'], undefined);
  assert.deepEqual(s.fake.unpublished(), []);
});

test('rebuild writes: an unchanged rebuild reads no form version token and writes no form', async () => {
  const s = scenario();
  await s.build(specFor());
  const again = await s.build(specFor());
  assert.deepEqual(s.fake.saves(again.mark), []);
  // A form push reads the row's version token first (`GET /systemforms(<id>)`), then the content token and the record
  // back — three reads a form on top of the fetch. None of them happen when there is nothing to send.
  assert.equal(s.fake.reads(/^\/systemforms\([^)]*\)$/, again.mark).length, 0, 'no row-token read: nothing was pushed');
});

test('rebuild writes: a form edit an interrupted run left in the workspace is still pushed', async () => {
  const s = scenario();
  await s.build(specFor());
  const spec = specFor();
  spec.entities[1].columns.push({ schemaName: 'new_extra', displayName: 'Extra', type: 'Text' });
  s.fake.failWritesWhen((req) => (req.method === 'PATCH' && /^\/systemforms\(/.test(req.path) && req.body && req.body.formxml ? 500 : undefined));
  await assert.rejects(s.build(spec), /push|500|simulated/i);
  s.fake.failWritesWhen(null);
  assert.ok(s.fake.rows('systemforms').every((r) => !/new_extra/.test(r.data.formxml)), 'the server never saw the field');
  const retry = await s.build(spec);
  assert.ok(retry.writes['PATCH systemforms'] >= 1, JSON.stringify(retry.writes));
  assert.ok(s.fake.rows('systemforms').filter((r) => r.data.objecttypecode === 'new_task' && r.data.type === 2).every((r) => /new_extra/.test(r.data.formxml)), 'the field lands');
});

// --------------------------------------------------------------- an edit made in Dataverse since the last build
//
// The workspace copy of a view or form is the SDK's last-synced snapshot, so a CLEAN copy says the workspace holds
// no edit the server has not seen — nothing about the server having MOVED since. The reconcile fetches first: a clean
// copy is refreshed from the server (the maker's edit becomes the new snapshot), the reconcile applies what the spec
// asks for on top of it, and THAT difference is what gets pushed. A dirty check that read "clean" regardless would
// leave the maker's edit standing and report a green build, so each of these moves the server before the rebuild.

test('rebuild writes: a spec column a maker removed from a view in Dataverse is pushed back', async () => {
  const s = scenario();
  await s.build(specFor());
  const view = () => s.fake.rows('savedqueries').find((r) => r.data.name === 'Open Tickets');
  assert.match(view().data.layoutxml, /new_code/);
  // The maker drops the column in the designer: the layout loses its cell, the query its attribute, the row moves on.
  view().data.layoutxml = view().data.layoutxml.replace(/<cell name="new_code"[^>]*\/>/, '');
  view().data.fetchxml = view().data.fetchxml.replace(/<attribute name="new_code"\s*\/>/, '');
  view().version += 1;
  assert.doesNotMatch(view().data.layoutxml, /new_code/, 'the edit was made');

  const again = await s.build(specFor());
  assert.equal(again.writes['PATCH savedqueries'], 1, JSON.stringify(again.writes));
  assert.match(view().data.layoutxml, /<cell name="new_code"/, 'the spec\'s column is back');
  assert.deepEqual(s.fake.unpublished(), [], 'and it is published');
});

test('rebuild writes: a description the spec sets, changed by a maker in Dataverse, is pushed back', async () => {
  const s = scenario();
  const spec = () => specFor({ viewDescription: 'Spec text.' });
  await s.build(spec());
  const view = () => s.fake.rows('savedqueries').find((r) => r.data.name === 'Open Tickets');
  assert.equal(view().data.description, 'Spec text.');
  view().data.description = 'Maker text.';
  view().version += 1;

  const again = await s.build(spec());
  assert.equal(again.writes['PATCH savedqueries'], 1, JSON.stringify(again.writes));
  assert.equal(view().data.description, 'Spec text.', 'the spec\'s description is back');
  assert.deepEqual(s.fake.unpublished(), []);
});

test('rebuild writes: a spec field a maker removed from a form in Dataverse is pushed back', async () => {
  const s = scenario();
  await s.build(specFor());
  const form = () => s.fake.rows('systemforms').find((r) => r.data.objecttypecode === 'new_ticket' && r.data.type === 2);
  const before = form().data.formxml;
  assert.match(before, /datafieldname="new_area"/);
  // Drop the whole <cell> that holds the field, as removing it in the designer does.
  form().data.formxml = before.replace(/<cell\b(?:(?!<cell\b)[\s\S])*?datafieldname="new_area"[\s\S]*?<\/cell>/, '');
  form().version += 1;
  assert.doesNotMatch(form().data.formxml, /datafieldname="new_area"/, 'the edit was made');

  const again = await s.build(specFor());
  assert.equal(again.writes['PATCH systemforms'], 1, `only the form that moved is pushed: ${JSON.stringify(again.writes)}`);
  assert.match(form().data.formxml, /datafieldname="new_area"/, 'the spec\'s field is back');
  assert.deepEqual(s.fake.unpublished(), []);
});

// Both at once is the one combination the SDK refuses to reconcile on its own: the workspace holds an edit the server
// has not seen AND the server has moved, so a refresh would lose one of them. The reconcile's fetch throws before any
// dirty check is asked, and the build must stop there — not skip the push as "unchanged", and not overwrite either side.
test('rebuild writes: an edit left in the workspace by an interrupted run, with the server moved since, halts without writing', async () => {
  const s = scenario();
  await s.build(specFor());
  const grown = () => specFor({ viewColumns: ['new_name', 'new_code', 'new_area'] });
  s.fake.failWritesWhen((req) => (req.method === 'PATCH' && /^\/savedqueries\(/.test(req.path) ? 500 : undefined));
  await assert.rejects(s.build(grown()), /push|500|simulated/i);
  s.fake.failWritesWhen(null);
  const view = () => s.fake.rows('savedqueries').find((r) => r.data.name === 'Open Tickets');
  view().data.description = 'Maker text.';
  view().version += 1;

  const mark = s.fake.mark();
  await assert.rejects(s.build(grown()), (e) => e && e.code === 'LOCAL_EDITS_WOULD_BE_LOST' && e.phase === 'views');
  assert.equal(s.fake.writeCounts(mark)['PATCH savedqueries'], undefined, 'nothing is written over the maker\'s edit');
  assert.equal(view().data.description, 'Maker text.', 'and the maker\'s edit is still there');
  assert.doesNotMatch(view().data.layoutxml, /new_area/, 'the interrupted run\'s column never reached the server');
});

// ----------------------------------------------------------- solution membership: one read, only what is missing added

test('rebuild writes: the membership read is made once and every component it proves present is not added', async () => {
  const s = scenario();
  await s.build(specFor());
  const again = await s.build(specFor());
  assert.equal(again.writes['POST AddSolutionComponent'], undefined);
  assert.equal(s.fake.reads(/^\/solutioncomponents$/, again.mark).length, 1, 'one query, not one per component');
  assert.equal(s.fake.reads(/^\/solutions$/, again.mark).length, 1);
  const query = s.fake.reads(/^\/solutioncomponents$/, again.mark)[0].query;
  assert.match(query.$filter, new RegExp(`_solutionid_value eq ${s.fake.solutionId}`));
  assert.match(query.$filter, /componenttype eq 26/);
  assert.equal(query.$top, undefined, 'a paginated read carries no $top');
});

test('rebuild writes: a component the solution lacks is added again, and only that one', async () => {
  const s = scenario();
  await s.build(specFor());
  const chart = s.fake.rows('savedqueryvisualizations')[0];
  const view = s.fake.rows('savedqueries').find((r) => r.data.name === 'My Tasks');
  s.fake.removeMember(COMPONENT.chart, chart.data.savedqueryvisualizationid);
  s.fake.removeMember(COMPONENT.view, view.data.savedqueryid);
  const again = await s.build(specFor());
  assert.equal(again.writes['POST AddSolutionComponent'], 2, JSON.stringify(again.writes));
  const adds = s.fake.since(again.mark).filter((e) => e.path === '/AddSolutionComponent').map((e) => `${e.body.ComponentType}:${e.body.ComponentId}`).sort();
  assert.deepEqual(adds, [`${COMPONENT.chart}:${chart.data.savedqueryvisualizationid}`, `${COMPONENT.view}:${view.data.savedqueryid}`].sort());
  assert.equal(s.fake.members.size, 6, 'membership is whole again');
});

test('rebuild writes: a membership read that pages is read in full, and still adds nothing', async () => {
  const s = scenario({ pageSize: 2 });
  await s.build(specFor());
  const again = await s.build(specFor());
  assert.equal(again.writes['POST AddSolutionComponent'], undefined, 'a short first page must not look like a short list');
  assert.equal(s.fake.reads(/^\/solutioncomponents$/, again.mark).length, 3, 'six members in pages of two');
});

test('rebuild writes: when the membership cannot be read, every component is added as before', async () => {
  const s = scenario({ failSolutionComponentReads: true });
  await s.build(specFor());
  const again = await s.build(specFor());
  assert.equal(again.result.ok, true, 'an unreadable membership never fails the build');
  assert.equal(again.writes['POST AddSolutionComponent'], 6, `2 views + 1 chart + 3 forms: ${JSON.stringify(again.writes)}`);
});

test('rebuild writes: a built-in solution proves nothing, is never read, and still gets its adds', async () => {
  const s = scenario({ solution: { uniqueName: 'Default' } });
  const spec = (name) => { const sp = specFor(); sp.solution.uniqueName = name; return sp; };
  await s.build(spec('Default'));
  const again = await s.build(spec('Default'));
  assert.equal(s.fake.reads(/^\/solutioncomponents$/, again.mark).length, 0);
  assert.equal(again.writes['POST AddSolutionComponent'], 6);
});

// A first build that deploys pages is the exception: the page manifest is persisted through the membership check even
// when it was just created, so that build makes the read (pinned in sdk-build.test.js, where pages can be staged).
test('rebuild writes: a first build with no pages, where every component is new, never reads the membership', async () => {
  const s = scenario();
  const first = await s.build(specFor());
  assert.equal(s.fake.reads(/^\/solutioncomponents$/, first.mark).length, 0);
  assert.equal(first.writes['POST AddSolutionComponent'], 6);
});

// A table created inside a solution is held by it with ALL its subcomponents ("Include all objects"), and the platform
// does not list that table's views, forms and charts one by one: an explicit AddSolutionComponent for one succeeds and
// leaves no row. Measured live — a rebuild of an app whose tables the build had created sent the adds for every view,
// form and chart again, 10 of the 19 a rebuild used to send, because a membership that looked only for rows never found
// them; the SDK's own solution reader documents the same ("members the solution does not list one by one").
// The fake answers the way the platform does (helpers/fake-dataverse.js). A table held in part is the control: it lists
// what was added on its own, so only that can be skipped, and a missing one is added.
const tableIdReads = (s, mark) => s.fake.reads(/^\/EntityDefinitions\(LogicalName='[^']+'\)$/, mark).filter((e) => /MetadataId/.test(e.query.$select || ''));

test('rebuild writes: a table held with all its subcomponents has no rows for its views, forms and charts, and a rebuild adds none of them', async () => {
  const s = scenario({ heldTables: { new_ticket: 0, new_task: 0 } });
  const first = await s.build(specFor());
  assert.equal(first.writes['POST AddSolutionComponent'], 6, 'the first build adds each component it creates');
  assert.equal(s.fake.members.size, 0, 'and the platform lists none of them: their tables carry them');

  const again = await s.build(specFor());
  assert.deepEqual(again.writes, { 'POST PublishXml': 1 }, JSON.stringify(again.writes));
  const read = s.fake.reads(/^\/solutioncomponents$/, again.mark);
  assert.equal(read.length, 1, 'one membership read');
  assert.match(read[0].query.$filter, /componenttype eq 1\b/, 'it asks for the tables');
  assert.match(read[0].query.$select, /rootcomponentbehavior/, 'and for how much of each the solution holds');
  assert.deepEqual(tableIdReads(s, again.mark).map((e) => e.path).sort(), ["/EntityDefinitions(LogicalName='new_task')", "/EntityDefinitions(LogicalName='new_ticket')"], 'one lookup per table, not one per component');
});

test('rebuild writes: a table held in part lists what was added on its own, and a rebuild adds only what is missing', async () => {
  for (const behavior of [1, 2]) {
    const s = scenario({ heldTables: { new_ticket: behavior, new_task: behavior } });
    const first = await s.build(specFor());
    assert.equal(first.writes['POST AddSolutionComponent'], 6);
    assert.equal(s.fake.members.size, 6, `held at ${behavior}, each component is listed on its own`);

    const again = await s.build(specFor());
    assert.equal(again.writes['POST AddSolutionComponent'], undefined, `held at ${behavior}: ${JSON.stringify(again.writes)}`);
    assert.deepEqual(tableIdReads(s, again.mark), [], 'no table carries its subcomponents, so none is looked up');

    // A view the solution lost is added again: the table does not carry it.
    const view = s.fake.rows('savedqueries').find((r) => r.data.name === 'My Tasks');
    s.fake.removeMember(COMPONENT.view, view.data.savedqueryid);
    const repaired = await s.build(specFor());
    assert.equal(repaired.writes['POST AddSolutionComponent'], 1, `held at ${behavior}: ${JSON.stringify(repaired.writes)}`);
  }
});

test('rebuild writes: a table held with all its subcomponents vouches for its own components only, not for another table\'s', async () => {
  const s = scenario({ heldTables: { new_ticket: 0, new_task: 2 } });
  const first = await s.build(specFor());
  assert.equal(first.writes['POST AddSolutionComponent'], 6);
  assert.equal(s.fake.members.size, 3, 'the task\'s view and two forms are listed; the ticket\'s view, chart and form are carried by their table');

  const again = await s.build(specFor());
  assert.equal(again.writes['POST AddSolutionComponent'], undefined, JSON.stringify(again.writes));
  assert.deepEqual(tableIdReads(s, again.mark).map((e) => e.path), ["/EntityDefinitions(LogicalName='new_ticket')"], 'only the table that has to vouch for something is looked up');

  const view = s.fake.rows('savedqueries').find((r) => r.data.name === 'My Tasks');
  s.fake.removeMember(COMPONENT.view, view.data.savedqueryid);
  const repaired = await s.build(specFor());
  assert.equal(repaired.writes['POST AddSolutionComponent'], 1, 'the ticket table does not carry the task view: it is added again');
});

test('rebuild writes: a table a maker switched from "all subcomponents" to "shell only" stops vouching, and its components are added once', async () => {
  const s = scenario({ heldTables: { new_ticket: 0, new_task: 0 } });
  await s.build(specFor());
  s.fake.holdTable('new_ticket', 2);
  const switched = await s.build(specFor());
  assert.equal(switched.writes['POST AddSolutionComponent'], 3, `the ticket's view, chart and form no longer ride on the table: ${JSON.stringify(switched.writes)}`);
  const settled = await s.build(specFor());
  assert.equal(settled.writes['POST AddSolutionComponent'], undefined, 'and now they are listed on their own');
});

test('rebuild writes: when a table\'s MetadataId cannot be read, nothing is vouched for and every component is added as before', async () => {
  const s = scenario({ heldTables: { new_ticket: 0, new_task: 0 } });
  await s.build(specFor());
  s.fake.failTableIdReads(true);
  const again = await s.build(specFor());
  s.fake.failTableIdReads(false);
  assert.equal(again.result.ok, true, 'a failed lookup never fails the build');
  assert.equal(again.writes['POST AddSolutionComponent'], 6, JSON.stringify(again.writes));
});

// --------------------------------------------------------------------------------- what is deliberately left

test('rebuild writes: the default-view enrichment is the SDK\'s own write and is still sent for each table\'s generated pair', async () => {
  const s = scenario();
  s.fake.seedDefaultViews('new_ticket', 'Tickets');
  s.fake.seedDefaultViews('new_task', 'Tasks');
  const spec = specFor();
  for (const e of spec.entities) { delete e.existing; e.enrichDefaultViews = true; }
  await s.build(spec);
  const again = await s.build(spec);
  // The engine's own reconcile writes are gone; what remains is the SDK's enrichDefaultViews, which pushes both views
  // of each pair, and the default-form promotion of the two owned tables (isdefault) — neither is a reconcile push.
  assert.equal(again.writes['PATCH savedqueries'], 4, JSON.stringify(again.writes));
  assert.equal(again.writes['POST AddSolutionComponent'], undefined);
  assert.equal(again.writes['POST PublishXml'], 1);
  assert.deepEqual(s.fake.saves(again.mark).filter((e) => e.body.formxml), [], 'no form document is written');
});
