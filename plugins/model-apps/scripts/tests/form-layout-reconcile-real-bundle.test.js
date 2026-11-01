'use strict';
// Declared form layout (`forms[].reconcile: "declared"`) through the REAL vendored SDK over a stored systemform.
// Existing forms: declared fields are packed in order around a maker's controls, which keep their exact slots; existing
// cells keep their ids; a free slot a later cell must skip is a spacer, and only a spacer the build recorded is its own;
// an unchanged layout sends nothing; every refusal writes nothing. New forms: the whole composite is sent in one push with
// every id supplied through the creation port (the stable-id double, and the pass-through), proven by a fresh read before
// it is bound, and published only through the coordinator's settlement.
const test = require('node:test');
const assert = require('node:assert/strict');
const { guid, createHarness, seedForm, NOTES_CLASS_ID } = require('./helpers/form-store-harness.js');
const { fakeManaged, fakePublication, passThroughCreates } = require('./helpers/feature-ports.js');
const { stableCreates, stableId } = require('./helpers/stable-creates.js');
const { compileFormIntent } = require('../lib/artifact-intent.js');
const { slotGrid, rowOccupancy } = require('../lib/form-occupancy.js');
const { commitPublication } = require('../lib/reconcile-common.js');
const flr = require('../lib/form-layout-reconcile.js');

const harnesses = [];
test.after(() => { for (const h of harnesses) h.cleanup(); });

const cell = (n, field, extra = {}) => ({ id: guid(n), control: { id: `ctl_${field}`, fieldName: field, ...(extra.control || {}) }, ...(extra.cell || {}) });
const spacer = (n) => ({ id: guid(n), control: null });
const section = (name, columns, rows, n) => ({ ...(n ? { id: guid(n) } : {}), name, label: name, columns, visible: true, showLabel: true, rows });
const tab = (sections, n = 900) => ({ id: guid(n), name: 'tab_main', label: 'Overview', visible: true, expanded: true, columns: [{ width: '100%', sections }] });
const QUICK_VIEW_CLASS_ID = '5C5600E0-1D6E-4205-A272-BE80DA87FD42';
// The build compiles with the platform's timeline class id (sdk-build.js); so do these tests.
const INTENT = { notesClassId: NOTES_CLASS_ID };

function specWith(forms) {
  return {
    solution: { uniqueName: 'FormProbe', displayName: 'Form Probe', publisherPrefix: 'new' },
    app: { name: 'Form Probe', uniqueName: 'new_formprobe' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [
      { schemaName: 'new_code', displayName: 'Code', type: 'Text' }, { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' },
      { schemaName: 'new_area', displayName: 'Area', type: 'Text' }, { schemaName: 'new_extra', displayName: 'Extra', type: 'Text' },
    ] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
    forms,
  };
}

// One explicit tab of sections: `sections` is [{ name, columns?, fields }] (fields: names or entries).
function formSpec(sections, { reconcile = 'declared', notes = false, extra = {} } = {}) {
  const form = { entity: 'new_ticket', name: 'Main', formType: 'Main', layout: 'explicit', prune: false, notes,
    tabs: [{ name: 'tab_main', label: 'Overview', sections: sections.map((s) => ({ label: s.name, ...s })) }], ...extra };
  if (reconcile) form.reconcile = reconcile;
  return specWith([form]);
}

async function deployed(sections) {
  const h = createHarness();
  harnesses.push(h);
  await seedForm(h, [tab(sections)]);
  return h;
}

// What the server stores, read through a fresh SDK.
async function storedForm(h) {
  const { sdk } = await h.freshSdk();
  await sdk.fetchArtifact('form', h.formId, { overwrite: true });
  return await sdk.getArtifact('form', h.formId);
}

// The stored layout of a section: each row as the fields it holds in order ('.' a spacer, '#' another control), and each
// field's slot, spans, ids and flags.
async function layoutOf(h, name) {
  const form = await storedForm(h);
  const s = form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections)).find((x) => x.name === name);
  assert.ok(s, `section ${name} is on the stored form`);
  const g = slotGrid(s.rows, s.columns);
  const at = {};
  const isQv = (c) => !!c.control && String(c.control.classId || '').replace(/[{}]/g, '').toUpperCase() === QUICK_VIEW_CLASS_ID;
  for (const p of g.placed) {
    const c = s.rows[p.row].cells[p.cell];
    const k = c.control && c.control.fieldName && !isQv(c) ? c.control.fieldName : `cell:${c.id}`;
    at[k] = { r: p.r, c: p.c, colspan: p.colspan, rowspan: p.rowspan, id: c.id, controlId: c.control && c.control.id, readOnly: !!(c.control && c.control.isReadOnly === true), hidden: c.visible === false };
  }
  const label = (c) => (!c.control ? '.' : (c.control.fieldName && !isQv(c) ? c.control.fieldName : '#'));
  return { section: s, columns: s.columns, rows: s.rows.map((row) => (row.cells || []).map(label)), at, overflow: g.overflow };
}

function ports(extra = {}) {
  return { creates: stableCreates(), managed: fakeManaged(), publication: fakePublication(), ...extra };
}

// Plan and apply against an existing form, through a fresh SDK. Bindings are persisted into ctx.managed afterwards, as the
// coordinator does once a result settles, so a second call sees them.
async function reconcile(h, spec, ctx, extra = {}) {
  const { sdk, mutations } = await h.freshSdk();
  const writesBefore = h.writes.length;
  const form = extra.form || spec.forms[0];
  const plan = await flr.planDeclaredFormLayout({ form, spec, formId: h.formId, intentTabs: compileFormIntent(spec, spec.forms[0], INTENT).tabs, sdk, hosts: extra.hosts, events: extra.events }, ctx);
  const result = await flr.applyDeclaredFormLayout(plan, { sdk }, ctx);
  if (ctx.managed && !result.refused.length && !result.unknown.length) ctx.managed.persist(result.managedBindings);
  return { plan, result, mutations, writes: h.writes.slice(writesBefore) };
}

const codes = (result) => [...result.refused, ...result.unknown].map((r) => r.code);

test('slot model: a cell beside a row-spanning cell sits in the column the span leaves free; the width-only model is unchanged', () => {
  const g = slotGrid([{ cells: [{ rowspan: 2 }, {}] }, { cells: [{}] }], 2);
  assert.deepEqual(g.placed.map((p) => [p.r, p.c]), [[0, 0], [0, 1], [1, 1]]);
  assert.deepEqual(g.overflow, []);
  assert.deepEqual(rowOccupancy([{ cells: [{ rowspan: 2 }, {}] }, { cells: [{}] }]).map((o) => o.used), [2, 2]);
  assert.deepEqual(slotGrid([{ cells: [{ colspan: 2 }] }], 1).overflow, [{ row: 0, cell: 0 }]);
});

test('declared fields pack in order around a maker field that keeps its slot and id; publication waits for settlement; a re-run sends nothing', async () => {
  const h = await deployed([section('sec_main', 2, [
    { cells: [cell(1, 'new_name'), cell(2, 'new_extra')] },
    { cells: [cell(3, 'new_code')] },
  ], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', 'new_name', 'new_area'] }]);
  const ctx = ports({ authorizedAdoption: true });
  const { result, writes } = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  assert.deepEqual(result.saved.map((s) => s.kind), ['form-layout']);
  assert.equal(writes.filter((w) => w.method === 'patch').length, 1, 'one push');
  assert.equal(ctx.publication.queued.length, 0, 'the helper never publishes');
  assert.deepEqual(result.pendingPublish.map((p) => p.scope), [{ type: 'form', id: h.formId, table: 'new_ticket' }]);
  commitPublication(ctx, result);
  assert.deepEqual(ctx.publication.queued, [{ type: 'form', id: h.formId, table: 'new_ticket' }], 'settled: queued once');
  const after = await layoutOf(h, 'sec_main');
  assert.deepEqual(after.rows, [['new_code', 'new_extra'], ['new_name', 'new_area']]);
  assert.deepEqual([after.at.new_extra.r, after.at.new_extra.c, after.at.new_extra.id], [0, 1, guid(2)], 'the maker field did not move');
  assert.equal(after.at.new_name.id, guid(1));
  assert.equal(after.at.new_code.id, guid(3));
  // The new cell's ids came from the creation port, and every object the build relies on is recorded.
  const port = ctx.creates.calls[0];
  assert.equal(port.op.kind, flr.KIND, 'one creation family for the form and every child, now and later');
  assert.equal(port.op.identity.parentId, h.formId);
  assert.equal(after.at.new_area.id, port.ids.childIds['cell:new_area']);
  const childKeys = result.managedBindings.filter((b) => b.kind === flr.CHILD_KIND).map((b) => b.key.split('#')[1]);
  for (const k of ['cell:new_area', 'control:new_area', 'cell:new_code', 'cell:new_name', 'section:tab_main/sec_main', 'tab:tab_main']) assert.ok(childKeys.includes(k), k);
  const again = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(again.result), []);
  assert.equal(again.plan.action, 'noChange');
  assert.deepEqual(again.writes, [], 'an unchanged layout sends nothing');
  assert.deepEqual(again.mutations, []);
});

test('a row this pack empties is kept while a maker cell sits below it, so the maker cell does not move up', async () => {
  const h = await deployed([section('sec_main', 1, [
    { cells: [cell(1, 'new_name')] },
    { cells: [cell(2, 'new_extra')] },
  ], 50)]);
  const spec = formSpec([{ name: 'sec_side', columns: 1, fields: ['new_name'] }]);
  const ctx = ports({ authorizedAdoption: true });
  const { result } = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const main = await layoutOf(h, 'sec_main');
  assert.deepEqual(main.rows, [[], ['new_extra']]);
  assert.deepEqual([main.at.new_extra.r, main.at.new_extra.c], [1, 0], 'the maker row stayed where it was');
  const side = await layoutOf(h, 'sec_side');
  assert.deepEqual(side.rows, [['new_name']]);
  assert.equal(side.at.new_name.id, guid(1), 'the moved cell keeps its id');
  assert.equal(side.section.id, ctx.creates.calls[0].ids.childIds['section:tab_main/sec_side'], 'the new section has the port id');
});

test('a stated section width is stored with the rows packed for it', async () => {
  const h = await deployed([section('sec_main', 1, [
    { cells: [cell(1, 'new_name')] },
    { cells: [cell(2, 'new_code')] },
  ], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_name', 'new_code'] }]);
  const { result } = await reconcile(h, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const after = await layoutOf(h, 'sec_main');
  assert.equal(after.columns, 2);
  assert.deepEqual(after.rows, [['new_name', 'new_code']]);
  assert.deepEqual(after.overflow, []);
});

test('readOnly:false and hidden:false written in the columns tab shape clear the flags', async () => {
  const h = await deployed([section('sec_main', 1, [
    { cells: [cell(1, 'new_name', { control: { isReadOnly: true } })] },
    { cells: [cell(2, 'new_code', { cell: { visible: false } })] },
  ], 50)]);
  const spec = specWith([{ entity: 'new_ticket', name: 'Main', formType: 'Main', layout: 'explicit', prune: false, notes: false, reconcile: 'declared',
    tabs: [{ name: 'tab_main', label: 'Overview', columns: [{ sections: [{ name: 'sec_main', label: 'Main', columns: 1,
      fields: [{ name: 'new_name', readOnly: false }, { name: 'new_code', hidden: false }] }] }] }] }]);
  const before = await layoutOf(h, 'sec_main');
  assert.equal(before.at.new_name.readOnly, true);
  assert.equal(before.at.new_code.hidden, true);
  const { result } = await reconcile(h, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const after = await layoutOf(h, 'sec_main');
  assert.equal(after.at.new_name.readOnly, false, 'readOnly:false cleared the flag');
  assert.equal(after.at.new_code.hidden, false, 'hidden:false shows the field again');
});

test('a field declared in two sections refuses before anything is read or written', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', fields: ['new_name'] }, { name: 'sec_side', fields: ['new_name'] }]);
  const ctx = ports({ authorizedAdoption: true });
  const readsBefore = h.reads.length;
  const { result, writes, mutations } = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(result), ['form-layout-duplicate-field']);
  assert.deepEqual(writes, []);
  assert.deepEqual(mutations, []);
  assert.equal(h.reads.length, readsBefore, 'nothing was read');
  assert.deepEqual(result.managedBindings, []);
  assert.deepEqual(ctx.creates.calls, []);
});

test('a spacer the build wrote is recorded at its slot and recycled; a spacer it did not write is a fixed obstacle', async () => {
  const live = () => [section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_extra')] }, { cells: [cell(3, 'new_code')] }], 50)];
  const h = await deployed(live());
  const ctx = ports({ authorizedAdoption: true });
  const wide = formSpec([{ name: 'sec_main', columns: 2, fields: [{ name: 'new_name', colspan: 2 }, 'new_code'] }]);
  const first = await reconcile(h, wide, ctx);
  assert.deepEqual(codes(first.result), [], JSON.stringify(first.result));
  let after = await layoutOf(h, 'sec_main');
  assert.deepEqual(after.rows, [['.', 'new_extra'], ['new_name'], ['new_code']], 'the free slot before the maker field is held by a spacer');
  const spacerId = after.section.rows[0].cells[0].id;
  const record = ctx.managed.lookup(flr.CHILD_KIND, `${flr.formLayoutKey(wide.forms[0])}#spacer:tab_main/sec_main:0:0`);
  assert.ok(record && record.id === spacerId, 'the spacer is recorded at its slot');
  assert.deepEqual((await reconcile(h, wide, ctx)).writes, [], 'its own spacer standing where it was is no change');
  const narrow = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', { name: 'new_name', colspan: 2 }] }]);
  const second = await reconcile(h, narrow, ctx);
  assert.deepEqual(codes(second.result), [], JSON.stringify(second.result));
  after = await layoutOf(h, 'sec_main');
  assert.deepEqual(after.rows, [['new_code', 'new_extra'], ['new_name']], 'its own spacer was dropped for a declared field');
  assert.deepEqual([after.at.new_extra.r, after.at.new_extra.c, after.at.new_extra.id], [0, 1, guid(2)]);

  const h2 = await deployed([section('sec_main', 2, [{ cells: [spacer(9), cell(2, 'new_extra')] }, { cells: [cell(1, 'new_name')] }, { cells: [cell(3, 'new_code')] }], 50)]);
  const third = await reconcile(h2, narrow, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(third.result), [], JSON.stringify(third.result));
  after = await layoutOf(h2, 'sec_main');
  assert.equal(after.section.rows[0].cells[0].id, guid(9), 'a spacer the build did not record stays where it is');
  assert.deepEqual(after.rows, [['.', 'new_extra'], ['new_code'], ['new_name']]);
});

test('a declared width that would cut through a maker control refuses and writes nothing', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_extra')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const ctx = ports({ authorizedAdoption: true });
  const { result, writes, mutations } = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(result), ['form-layout-narrowing-refused']);
  assert.deepEqual(writes, []);
  assert.deepEqual(mutations, []);
  assert.deepEqual(result.pendingPublish, []);
  assert.deepEqual(ctx.creates.calls, []);
});

test('adoption, drift and the bound identity gate every write', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_code')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', 'new_name'] }]);
  const ctx = ports();
  const unadopted = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(unadopted.result), ['form-layout-adoption-not-authorized']);
  assert.deepEqual(unadopted.writes, []);
  ctx.authorizedAdoption = true;
  const adopted = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(adopted.result), [], JSON.stringify(adopted.result));
  delete ctx.authorizedAdoption;
  // A maker swaps the two fields back in the designer: the next build refuses rather than undo their edit.
  const maker = await h.freshSdk();
  await maker.sdk.fetchArtifact('form', h.formId, { overwrite: true });
  const form = await maker.sdk.getArtifact('form', h.formId);
  const rows = form.tabs[0].columns[0].sections[0].rows;
  rows[0].cells.reverse();
  await maker.sdk.updateElement('form', h.formId, '/tabs/0/columns/0/sections/0/rows', rows);
  await maker.sdk.pushArtifact('form', h.formId);
  const drifted = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(drifted.result), ['form-layout-drift']);
  assert.deepEqual(drifted.writes, []);
  // The key is bound to this form: a resolution that names another refuses.
  const { sdk } = await h.freshSdk();
  const plan = await flr.planDeclaredFormLayout({ form: spec.forms[0], spec, formId: guid(4242), intentTabs: compileFormIntent(spec, spec.forms[0], INTENT).tabs, sdk }, ctx);
  assert.deepEqual(plan.refused.map((r) => r.code), ['form-layout-binding-mismatch']);
});

test('only the raw spec form opts in: a compiled def (which carries no `reconcile`) plans and creates nothing', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', 'new_name'] }]);
  const def = compileFormIntent(spec, spec.forms[0], INTENT);
  assert.equal(def.reconcile, undefined);
  const ctx = ports({ authorizedAdoption: true });
  const readsBefore = h.reads.length;
  const { plan, result, writes } = await reconcile(h, spec, ctx, { form: def });
  assert.equal(plan.action, null);
  assert.deepEqual([result.saved, result.refused, result.unknown, writes], [[], [], [], []]);
  assert.equal(h.reads.length, readsBefore);
  const { sdk } = await h.freshSdk();
  const created = await flr.applyDeclaredFormCreate({ form: def, spec, def, sdk }, ctx);
  assert.deepEqual([created.saved, created.refused, ctx.creates.calls], [[], [], []]);
  const raw = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(raw.result), [], JSON.stringify(raw.result));
  assert.deepEqual((await layoutOf(h, 'sec_main')).rows, [['new_code', 'new_name']]);
});

test('a quick view bound to a declared lookup is not taken for the field; an existing form needs no create when nothing is new', async () => {
  const qv = { id: guid(30), control: { id: 'qv_area', classId: QUICK_VIEW_CLASS_ID, fieldName: 'new_area', parameters: { ControlMode: 'Edit' } } };
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_area'), qv] }, { cells: [cell(2, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_name', 'new_area'] }]);
  const ctx = ports({ authorizedAdoption: true });
  const { result } = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const after = await layoutOf(h, 'sec_main');
  assert.deepEqual(after.rows, [['new_name', '#'], ['new_area']]);
  assert.deepEqual([after.at[`cell:${guid(30)}`].r, after.at[`cell:${guid(30)}`].c], [0, 1], 'the quick view kept its slot');
  assert.deepEqual(ctx.creates.calls, [], 'no new child: the creation port is not asked');
});

// Create a NEW declared form on an empty harness whose stored row takes `formId` (the id the port answers for the root).
async function create(spec, ctx, { hosts, formId, events } = {}) {
  const form = spec.forms[0];
  const h = createHarness({ formId: formId || stableId('stable-test', flr.KIND, flr.formLayoutKey(form)) });
  harnesses.push(h);
  const { sdk, mutations } = await h.freshSdk();
  const result = await flr.applyDeclaredFormCreate({ form, spec, def: compileFormIntent(spec, form, INTENT), sdk, hosts, events }, ctx);
  return { h, result, mutations };
}

const ROWSPAN_SPEC = () => formSpec([{ name: 'sec_main', columns: 2, fields: [{ name: 'new_name', rowspan: 2 }, 'new_code', 'new_extra', 'new_area'] }]);

test('a new form packs a cell after a middle row-spanning cell into the free column, where the compiled rows overflow', async () => {
  const spec = ROWSPAN_SPEC();
  const compiled = compileFormIntent(spec, spec.forms[0], INTENT).tabs[0].columns[0].sections.find((s) => s.name === 'sec_main');
  assert.ok(slotGrid(compiled.rows, 2).overflow.length > 0, 'the width-only compiled rows run past the grid');
  const ctx = ports();
  const { h, result } = await create(spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const after = await layoutOf(h, 'sec_main');
  assert.deepEqual(after.overflow, []);
  assert.deepEqual(['new_name', 'new_code', 'new_extra', 'new_area'].map((f) => [after.at[f].r, after.at[f].c]), [[0, 0], [0, 1], [1, 1], [2, 0]]);
  assert.equal(after.at.new_name.rowspan, 2);
  const rows = flr.declaredSlotRows(compiled.rows.flatMap((r) => r.cells), 2);
  assert.deepEqual(slotGrid(rows, 2).overflow, [], 'the export the compile path uses packs the same way');
});

test('a new form is created whole through the creation port: every supplied id survives the push and is bound only after a fresh read', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_name', 'new_code'] }]);
  const ctx = ports();
  const { h, result, mutations } = await create(spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const call = ctx.creates.calls[0];
  assert.equal(call.op.kind, flr.KIND);
  assert.deepEqual(call.op.identity, { table: 'new_ticket', formType: 'Main', name: 'main' });
  assert.equal(h.writes.filter((w) => w.method === 'post' && /systemforms/.test(w.url)).length, 1, 'one create push');
  assert.equal(mutations.filter((m) => m.method === 'createArtifact').length, 1);
  const form = await storedForm(h);
  assert.equal(form.id, call.ids.id);
  const tabStored = form.tabs.find((t) => t.name === 'tab_main');
  assert.equal(tabStored.id, call.ids.childIds['tab:tab_main'], 'the tab keeps its supplied id');
  const sec = tabStored.columns[0].sections.find((s) => s.name === 'sec_main');
  assert.equal(sec.id, call.ids.childIds['section:tab_main/sec_main'], 'the section keeps its supplied id');
  assert.equal(sec.rows[0].cells[0].id, call.ids.childIds['cell:new_name']);
  assert.equal(form.tabs.length, 1, 'the seed tab is gone');
  assert.deepEqual(result.saved.map((s) => [s.kind, s.id, s.created]), [[flr.KIND, call.ids.id, true]]);
  const root = result.managedBindings.find((b) => b.kind === flr.KIND);
  assert.equal(root.origin, 'created');
  assert.ok(result.managedBindings.some((b) => b.key.endsWith('#section:tab_main/sec_main') && b.id === sec.id));
  assert.equal(ctx.publication.queued.length, 0);
  commitPublication(ctx, result);
  assert.deepEqual(ctx.publication.queued, [{ type: 'form', id: call.ids.id, table: 'new_ticket' }]);
  // Bound now: a second create of the same key refuses rather than make a twin.
  ctx.managed.persist(result.managedBindings);
  const { sdk } = await h.freshSdk();
  const twin = await flr.applyDeclaredFormCreate({ form: spec.forms[0], spec, def: compileFormIntent(spec, spec.forms[0], INTENT), sdk }, ctx);
  assert.deepEqual(codes(twin), ['form-layout-bound-row-missing']);
});

test('the pass-through creation port creates the same form', async () => {
  const spec = ROWSPAN_SPEC();
  const ctx = ports({ creates: passThroughCreates() });
  const { h, result } = await create(spec, ctx, { formId: 'd0d0d0d0-0000-4000-8000-000000000001' });
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const after = await layoutOf(h, 'sec_main');
  assert.deepEqual([after.at.new_extra.r, after.at.new_extra.c], [1, 1]);
  assert.equal(result.saved[0].id, 'd0d0d0d0-0000-4000-8000-000000000001');
});

test('a new form that asks for the timeline stores it in the shape that renders', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }], { notes: true });
  const ctx = ports();
  const { h, result } = await create(spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const form = await storedForm(h);
  const notes = form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections)).find((s) => s.rows.some((r) => (r.cells || []).some((c) => c.control && c.control.id === 'notescontrol')));
  assert.ok(notes, 'a timeline is stored');
  const cellStored = notes.rows[0].cells[0];
  assert.equal(String(cellStored.control.classId).replace(/[{}]/g, '').toUpperCase(), NOTES_CLASS_ID);
  assert.equal(cellStored.rowspan, 23);
  assert.equal(notes.rows.length, 23, 'the span is backed by 22 rows');
  assert.equal(notes.id, ctx.creates.calls[0].ids.childIds['section:timeline']);
  assert.ok(ctx.creates.calls[0].ids.childIds['cell:timeline'], 'the timeline cell has a child id');
  assert.equal(cellStored.id, ctx.creates.calls[0].ids.childIds['cell:timeline'], 'the timeline cell is created under its own child id');
  const timelines = form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections.flatMap((s) => s.rows.flatMap((r) => (r.cells || []).filter((c2) => c2.control && String(c2.control.classId).replace(/[{}]/g, '').toUpperCase() === NOTES_CLASS_ID)))));
  assert.equal(timelines.length, 1, 'exactly one timeline is stored');
});

test('a create whose port answer is lost is unknown: nothing is bound and its publication is withheld', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const ctx = ports({ creates: stableCreates({ failAfterExecute: true }) });
  const { result } = await create(spec, ctx);
  assert.deepEqual(codes(result), ['form-layout-write-unknown']);
  assert.deepEqual(result.saved, []);
  assert.deepEqual(result.managedBindings, []);
  assert.equal(result.pendingPublish.length, 1, 'the push may have reached the service');
  commitPublication(ctx, result);
  assert.deepEqual(ctx.publication.queued, [], 'an unsettled create is never published');
  assert.equal(result.pendingPublish[0].withheld, true);
});

test('an existing form that asks for the timeline gets one added after its sections; then nothing changes', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }], { notes: true });
  const ctx = ports({ authorizedAdoption: true });
  const { result } = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const form = await storedForm(h);
  const sections = form.tabs[0].columns[0].sections;
  assert.deepEqual(sections.map((s) => s.name), ['sec_main', 'section_notes']);
  assert.equal(sections[1].rows[0].cells[0].control.id, 'notescontrol');
  assert.equal(sections[1].rows.length, 23);
  const again = await reconcile(h, spec, ctx);
  assert.equal(again.plan.action, 'noChange');
  assert.deepEqual(again.writes, []);
});

test('a broken timeline alone in its section is rewritten in the rendering shape; one beside a maker control refuses', async () => {
  const broken = (n) => ({ id: guid(n), control: { id: 'notescontrol', classId: NOTES_CLASS_ID, fieldName: null, label: 'Notes', parameters: {} } });
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50), section('sec_old_notes', 1, [{ cells: [broken(40)] }], 51)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }], { notes: true });
  const { result } = await reconcile(h, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const after = await layoutOf(h, 'sec_old_notes');
  assert.equal(after.section.rows.length, 23);
  assert.equal(after.section.rows[0].cells[0].id, guid(40), 'the timeline cell keeps its id');
  assert.equal(after.section.rows[0].cells[0].rowspan, 23);

  const h2 = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50), section('sec_old_notes', 1, [{ cells: [broken(40)] }, { cells: [cell(2, 'new_extra')] }], 51)]);
  const refused = await reconcile(h2, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(refused.result), ['form-timeline-unsupported-host']);
  assert.deepEqual(refused.writes, []);
});

test('a requested sub-grid the form lacks is added in its own section; a placed one it cannot honour refuses', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const grid = { targetEntity: 'new_child', relationshipName: 'new_ticket_child', viewId: guid(7777), label: 'Children' };
  const ctx = ports({ authorizedAdoption: true });
  const placed = await reconcile(h, spec, ctx, { hosts: { subgrids: [{ ...grid, placement: { after: 'sec_main' } }] } });
  assert.deepEqual(codes(placed.result), ['form-host-unsupported']);
  assert.deepEqual(placed.writes, []);
  const { result } = await reconcile(h, spec, ctx, { hosts: { subgrids: [grid] } });
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const form = await storedForm(h);
  const grids = form.tabs[0].columns[0].sections.filter((s) => s.rows.some((r) => (r.cells || []).some((c) => c.control && c.control.parameters && c.control.parameters.RelationshipName === 'new_ticket_child')));
  assert.equal(grids.length, 1);
  const again = await reconcile(h, spec, ctx, { hosts: { subgrids: [grid] } });
  assert.equal(again.plan.action, 'noChange');
});

test('a declared field the form holds twice refuses; a write the store does not keep is unknown and withheld', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }, { cells: [{ ...cell(2, 'new_name'), control: { id: 'ctl_new_name_2', fieldName: 'new_name' } }] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const twice = await reconcile(h, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(twice.result), ['form-layout-field-ambiguous']);
  assert.deepEqual(twice.writes, []);

  const h2 = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_code')] }], 50)]);
  const swap = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', 'new_name'] }]);
  const ctx = ports({ authorizedAdoption: true });
  const { sdk } = await h2.freshSdk();
  const plan = await flr.planDeclaredFormLayout({ form: swap.forms[0], spec: swap, formId: h2.formId, intentTabs: compileFormIntent(swap, swap.forms[0], INTENT).tabs, sdk }, ctx);
  // The service answers the push as saved but keeps the old layout.
  const kept = h2.store.row.formxml;
  const push = sdk.pushArtifact.bind(sdk);
  sdk.pushArtifact = async (...args) => { const out = await push(...args); h2.store.row.formxml = kept; return out; };
  const result = await flr.applyDeclaredFormLayout(plan, { sdk }, ctx);
  assert.deepEqual(codes(result), ['form-layout-not-stored']);
  assert.deepEqual(result.managedBindings, []);
  commitPublication(ctx, result);
  assert.deepEqual(ctx.publication.queued, []);
  assert.equal(result.pendingPublish[0].withheld, true);
});

test('a new form carries its event handlers in the same push', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const ctx = ports();
  const { h, result } = await create(spec, ctx, { events: [{ event: 'onload', library: 'new_/ticket.js', function: 'Ticket.onLoad' }] });
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  assert.equal(h.writes.filter((w) => w.method === 'post' && /systemforms/.test(w.url)).length, 1);
  assert.match(String(h.store.row.formxml), /<event name="onload"[^>]*>[\s\S]*Ticket\.onLoad/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Authority of recorded identities, foreign content, one creation family, refusals instead of substitutions.

const allSections = (f) => f.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections));
const allCells = (f) => allSections(f).flatMap((s) => s.rows.flatMap((r) => r.cells || []));

// A maker replaces the stored form's tabs (a designer edit), through a fresh SDK.
async function makerEdit(h, fn) {
  const maker = await h.freshSdk();
  await maker.sdk.fetchArtifact('form', h.formId, { overwrite: true });
  const live = await maker.sdk.getArtifact('form', h.formId);
  fn(live.tabs);
  await maker.sdk.updateElement('form', h.formId, '/tabs', live.tabs);
  await maker.sdk.pushArtifact('form', h.formId);
}

test('the stored row must be the form the key names: a Main row under a Quick View key refuses and writes nothing', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: [{ name: 'new_name', readOnly: true }] }]);
  spec.forms[0].formType = 'QuickView';
  const out = await reconcile(h, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(out.result), ['form-layout-identity-mismatch']);
  assert.deepEqual(out.writes, []);
  // Neighbour: the same row under its own (Main) key is written.
  spec.forms[0].formType = 'Main';
  const main = await reconcile(h, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(main.result), [], JSON.stringify(main.result));
});

test('a recorded field cell that was replaced is not re-found by its field name: refuses, writes nothing, keeps the record', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const original = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const ctx = ports({ authorizedAdoption: true });
  assert.deepEqual(codes((await reconcile(h, original, ctx)).result), []);
  const key = `${flr.formLayoutKey(original.forms[0])}#cell:new_name`;
  const before = ctx.managed.lookup(flr.CHILD_KIND, key).id;
  delete ctx.authorizedAdoption;
  const wanted = formSpec([{ name: 'sec_main', columns: 1, fields: [{ name: 'new_name', readOnly: true }] }]);
  // Neighbour first: the recorded cell, still there, is written.
  const kept = await reconcile(h, wanted, ctx);
  assert.deepEqual(codes(kept.result), [], JSON.stringify(kept.result));
  await makerEdit(h, (tabs) => {
    const c = tabs[0].columns[0].sections[0].rows[0].cells[0];
    c.id = guid(720);
    c.control.id = 'foreign_replacement';
    c.control.isReadOnly = false;
  });
  const out = await reconcile(h, wanted, ctx);
  assert.deepEqual(codes(out.result), ['create-completion-required']);
  assert.deepEqual(out.writes, []);
  assert.equal(ctx.managed.lookup(flr.CHILD_KIND, key).id, before, 'the record still names the original cell');
});

test('moving a declared field out of a row keeps that row and its own payload; a plain emptied row still goes', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')], bag: { a: [['data-maker-marker', 'retain-me']], c: [] } }], 50)]);
  assert.match(h.store.row.formxml, /retain-me/);
  const wanted = formSpec([{ name: 'sec_side', columns: 1, fields: ['new_name'] }]);
  const out = await reconcile(h, wanted, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(out.result), [], JSON.stringify(out.result));
  assert.match(h.store.row.formxml, /retain-me/, 'the row payload is stored');
  assert.deepEqual((await layoutOf(h, 'sec_main')).rows, [[]], 'the emptied row that carries a payload stays');
  assert.deepEqual((await layoutOf(h, 'sec_side')).rows, [['new_name']]);
  // Neighbour: the same move from a row that carries nothing of its own drops that row.
  const plain = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  assert.deepEqual(codes((await reconcile(plain, wanted, ports({ authorizedAdoption: true }))).result), []);
  assert.deepEqual((await layoutOf(plain, 'sec_main')).rows, []);
});

test('an existing sub-grid or quick view must already be what is requested: another target or a stated placement refuses', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const ctx = ports({ authorizedAdoption: true });
  const grid = { targetEntity: 'new_child', relationshipName: 'new_ticket_child', viewId: guid(7777), label: 'Children' };
  assert.deepEqual(codes((await reconcile(h, spec, ctx, { hosts: { subgrids: [grid] } })).result), []);
  const otherView = await reconcile(h, spec, ctx, { hosts: { subgrids: [{ ...grid, viewId: guid(7778) }] } });
  assert.deepEqual(codes(otherView.result), ['form-host-target-mismatch']);
  assert.deepEqual(otherView.writes, []);
  const placed = await reconcile(h, spec, ctx, { hosts: { subgrids: [{ ...grid, placement: { after: 'sec_main' } }] } });
  assert.deepEqual(codes(placed.result), ['form-host-unsupported']);
  assert.deepEqual(placed.writes, []);
  const unresolved = await reconcile(h, spec, ctx, { hosts: { subgrids: [{ targetEntity: 'new_other', relationshipName: '', viewId: '', unresolved: true }] } });
  assert.deepEqual(codes(unresolved.result), ['form-prerequisite-missing']);
  // The recorded host replaced by a maker's own grid with the same relationship refuses as well.
  await makerEdit(h, (tabs) => {
    const host = allSections({ tabs }).flatMap((s) => s.rows.flatMap((r) => r.cells || [])).find((c) => c.control && c.control.parameters && c.control.parameters.RelationshipName === 'new_ticket_child');
    host.id = guid(721);
    host.control.id = 'maker_grid';
  });
  const replaced = await reconcile(h, spec, ctx, { hosts: { subgrids: [grid] } });
  assert.deepEqual(codes(replaced.result), ['create-completion-required']);
  // Neighbour: a quick view already showing the requested form is left as it is.
  const qvForm = guid(7800);
  const h2 = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), { id: guid(30), control: { id: 'qv_area', classId: QUICK_VIEW_CLASS_ID, fieldName: 'new_area', parameters: { QuickForms: `<QuickFormIds><QuickFormId entityname="contact">${qvForm}</QuickFormId></QuickFormIds>`, ControlMode: 'Edit' } } }] }], 50)]);
  const same = await reconcile(h2, formSpec([{ name: 'sec_main', columns: 2, fields: ['new_name'] }]), ports({ authorizedAdoption: true }), { hosts: { quickViews: [{ lookupFieldName: 'new_area', targetEntity: 'contact', quickViewFormId: qvForm }] } });
  assert.deepEqual(codes(same.result), [], JSON.stringify(same.result));
  assert.equal(same.plan.action, 'noChange');
  const other = await reconcile(h2, formSpec([{ name: 'sec_main', columns: 2, fields: ['new_name'] }]), ports({ authorizedAdoption: true }), { hosts: { quickViews: [{ lookupFieldName: 'new_area', targetEntity: 'contact', quickViewFormId: guid(7801) }] } });
  assert.deepEqual(codes(other.result), ['form-host-target-mismatch']);
});

test('children added on a later run take the id of the same creation family, and a re-run after an unsettled add finds that id', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const ctx = ports();
  const first = await create(spec, ctx);
  assert.deepEqual(codes(first.result), []);
  ctx.managed.persist(first.result.managedBindings);
  const key = flr.formLayoutKey(spec.forms[0]);
  const sameFamily = stableId('stable-test', flr.KIND, key, 'cell:new_code');
  const more = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name', 'new_code'] }]);
  // The add is sent, but the port cannot settle its answer: unknown, nothing bound.
  const lost = { ...ctx, creates: stableCreates({ failAfterExecute: true }) };
  const unsettled = await reconcile(first.h, more, lost);
  assert.deepEqual(codes(unsettled.result), ['form-layout-write-unknown']);
  assert.equal(lost.creates.calls[0].op.kind, ctx.creates.calls[0].op.kind, 'the same family as the form\'s create');
  assert.equal(lost.creates.calls[0].op.identity.parentId, first.h.formId);
  assert.equal(lost.creates.calls[0].ids.childIds['cell:new_code'], sameFamily);
  // The re-run finds the cell under that very id and records it.
  const rerun = await reconcile(first.h, more, ctx);
  assert.deepEqual(codes(rerun.result), [], JSON.stringify(rerun.result));
  assert.equal(ctx.managed.lookup(flr.CHILD_KIND, `${key}#cell:new_code`).id, sameFamily);
});

test('a requested section in the second form column goes there; a column the tab lacks or a section standing elsewhere refuses', async () => {
  const twoColumns = (h, sideColumn) => seedForm(h, [{ id: guid(900), name: 'tab_main', label: 'Overview', visible: true, expanded: true, columns: [
    { width: '50%', sections: [section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50), ...(sideColumn === 0 ? [section('sec_side', 1, [], 52)] : [])] },
    { width: '50%', sections: sideColumn === 1 ? [section('sec_side', 1, [], 52)] : [] },
  ] }]);
  const spec = () => {
    const s = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
    s.forms[0].tabs[0].columns = [{ width: '50%', sections: s.forms[0].tabs[0].sections }, { width: '50%', sections: [{ name: 'sec_side', label: 'Side', columns: 1, fields: ['new_code'] }] }];
    delete s.forms[0].tabs[0].sections;
    return s;
  };
  // The tab has one column: refuse rather than put sec_side in the first.
  const one = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const refused = await reconcile(one, spec(), ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(refused.result), ['form-layout-column-unsupported']);
  assert.deepEqual(refused.writes, []);
  // Two columns: the new section goes in the second.
  const two = createHarness();
  harnesses.push(two);
  await twoColumns(two, null);
  const placed = await reconcile(two, spec(), ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(placed.result), [], JSON.stringify(placed.result));
  const stored = (await storedForm(two)).tabs[0];
  assert.equal(stored.columns.findIndex((c) => c.sections.some((s) => s.name === 'sec_side')), 1);
  // sec_side already stands in the first column: never moved.
  const moved = createHarness();
  harnesses.push(moved);
  await twoColumns(moved, 0);
  const elsewhere = await reconcile(moved, spec(), ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(elsewhere.result), ['form-layout-container-moved']);
  assert.deepEqual(elsewhere.writes, []);
  // Neighbour: where it is in the second column, it is used in place.
  const inPlace = createHarness();
  harnesses.push(inPlace);
  await twoColumns(inPlace, 1);
  const used = await reconcile(inPlace, spec(), ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(used.result), [], JSON.stringify(used.result));
  assert.equal(allSections(await storedForm(inPlace)).filter((s) => s.name === 'sec_side').length, 1);
});

test('the stored proof compares what the build does not own: a lost maker control is unknown, unbound and withheld', async () => {
  const qv = { id: guid(73), control: { id: 'foreign_qv', classId: QUICK_VIEW_CLASS_ID, fieldName: 'new_area', parameters: { ControlMode: 'Edit' } } };
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: [{ name: 'new_name', readOnly: true }] }]);
  const run = async (loss) => {
    const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), qv] }, { cells: [cell(2, 'new_extra')], bag: { a: [['data-keep', 'row-payload']], c: [] } }], 50)]);
    assert.match(h.store.row.formxml, /data-keep="row-payload"/);
    const ctx = ports({ authorizedAdoption: true });
    const { sdk } = await h.freshSdk();
    const plan = await flr.planDeclaredFormLayout({ form: spec.forms[0], spec, formId: h.formId, intentTabs: compileFormIntent(spec, spec.forms[0], INTENT).tabs, sdk }, ctx);
    const push = sdk.pushArtifact.bind(sdk);
    sdk.pushArtifact = async (...args) => { const r = await push(...args); h.store.row.formxml = loss(h.store.row.formxml); return r; };
    const result = await flr.applyDeclaredFormLayout(plan, { sdk }, ctx);
    commitPublication(ctx, result);
    return { result, ctx };
  };
  const lostCell = await run((xml) => xml.replace(/<cell\b[^>]*>[\s\S]*?<\/cell>/g, (c) => (c.includes('foreign_qv') ? '' : c)));
  assert.deepEqual(codes(lostCell.result), ['form-layout-not-stored']);
  assert.deepEqual(lostCell.result.saved, []);
  assert.deepEqual(lostCell.result.managedBindings, []);
  assert.deepEqual(lostCell.ctx.publication.queued, []);
  assert.equal(lostCell.result.pendingPublish[0].withheld, true);
  const lostPayload = await run((xml) => xml.replace(/ data-keep="row-payload"/, ''));
  assert.deepEqual(codes(lostPayload.result), ['form-layout-not-stored']);
  // Neighbour: nothing lost, the same write saves.
  const kept = await run((xml) => xml);
  assert.deepEqual(codes(kept.result), [], JSON.stringify(kept.result));
});

// Plan and apply against an existing form whose store rewrites the saved XML after the push (`mutate`), so the fresh
// read sees what the store kept. Answers the result and the stored form.
async function faulted(h, spec, mutate, ctx = ports({ authorizedAdoption: true })) {
  const { sdk } = await h.freshSdk();
  const plan = await flr.planDeclaredFormLayout({ form: spec.forms[0], spec, formId: h.formId, intentTabs: compileFormIntent(spec, spec.forms[0], INTENT).tabs, sdk }, ctx);
  const push = sdk.pushArtifact.bind(sdk);
  sdk.pushArtifact = async (...args) => { const r = await push(...args); h.store.row.formxml = mutate(h.store.row.formxml); return r; };
  const result = await flr.applyDeclaredFormLayout(plan, { sdk }, ctx);
  return { result, live: await storedForm(h) };
}

test('a section is known by its tab: a field the store keeps in a same-named section of another tab is not the declared one', async () => {
  const seed = async () => {
    const h = createHarness();
    harnesses.push(h);
    await seedForm(h, [tab([section('sec_shared', 1, [{ cells: [cell(1, 'new_name')] }], 50)]), { ...tab([section('sec_shared', 1, [{ cells: [] }], 51)], 901), name: 'tab_other' }]);
    return h;
  };
  const spec = formSpec([{ name: 'sec_shared', columns: 1, fields: [{ name: 'new_name', readOnly: true }] }]);
  // The store moves the field's cell into tab_other's sec_shared.
  let moved = '';
  const intoOtherTab = (xml) => xml.replace(/<section\b[^>]*>[\s\S]*?<\/section>/g, (s) => {
    if (s.includes('ctl_new_name')) return s.replace(/<cell\b[^>]*>[\s\S]*?<\/cell>/g, (c) => { moved = c; return ''; });
    return s.replace(/<rows\b[^>]*>[\s\S]*?<\/rows>/, `<rows><row>${moved}</row></rows>`);
  });
  const h = await seed();
  const r = await faulted(h, spec, intoOtherTab);
  assert.ok(r.live.tabs[1].columns[0].sections[0].rows.some((row) => row.cells.some((c) => c.control && c.control.fieldName === 'new_name')), 'the store moved it');
  assert.deepEqual(codes(r.result), ['form-layout-not-stored']);
  assert.deepEqual(r.result.saved, []);
  assert.deepEqual(r.result.managedBindings, []);
  // The projection names each section by its tab and form column.
  const parts = flr.formProjection(r.live.tabs);
  assert.deepEqual(Object.keys(parts).filter((k) => k.startsWith('columns:')).sort(), ['columns:tab_main/0/sec_shared', 'columns:tab_other/0/sec_shared']);
  assert.equal(parts['field:new_name'][0].section, 'tab_other/0/sec_shared');
  // Neighbour: the store keeps what was sent, the same write saves.
  const kept = await faulted(await seed(), spec, (xml) => xml);
  assert.deepEqual(codes(kept.result), [], JSON.stringify(kept.result));
  assert.equal(kept.result.saved.length, 1);
});

test('the stored proof checks what each written id is: swapped field controls and a row payload on another row are unknown and unbound', async () => {
  const twoFields = () => deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }, { cells: [cell(2, 'new_code')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: [{ name: 'new_name', readOnly: true }, 'new_code'] }]);
  // The store swaps the two controls' ids: the same id set, each bound to the other field.
  const swap = (xml) => xml.replaceAll('ctl_new_name', 'swap_marker').replaceAll('ctl_new_code', 'ctl_new_name').replaceAll('swap_marker', 'ctl_new_code');
  const swapped = await faulted(await twoFields(), spec, swap);
  const held = swapped.live.tabs[0].columns[0].sections[0].rows.flatMap((row) => row.cells).map((c) => [c.control.fieldName, c.control.id]);
  assert.deepEqual(held, [['new_name', 'ctl_new_code'], ['new_code', 'ctl_new_name']], 'the store swapped them');
  assert.deepEqual(codes(swapped.result), ['form-layout-not-stored']);
  assert.deepEqual(swapped.result.saved, []);
  assert.deepEqual(swapped.result.managedBindings, []);
  assert.equal(swapped.result.pendingPublish.length, 1, 'the possibly-saved scope is left for settlement to withhold');
  // A maker's row payload the store keeps on another row of the same section.
  const withPayload = () => deployed([section('sec_main', 1, [{ cells: [], bag: { a: [['data-maker-marker', 'retain-me']], c: [] } }, { cells: [] }, { cells: [cell(1, 'new_name')] }], 50)]);
  const one = formSpec([{ name: 'sec_main', columns: 1, fields: [{ name: 'new_name', readOnly: true }] }]);
  const moveRow = (xml) => { let i = 0; return xml.replace(/<row\b[^>]*\/?>/g, (row) => { const plain = row.replace(/\sdata-maker-marker="retain-me"/g, ''); i += 1; return i === 2 ? plain.replace(/\/?>$/, (m) => ` data-maker-marker="retain-me"${m}`) : plain; }); };
  const moved = await faulted(await withPayload(), one, moveRow);
  assert.deepEqual(moved.live.tabs[0].columns[0].sections[0].rows.flatMap((row, i) => (JSON.stringify(row.bag).includes('retain-me') ? [i] : [])), [1], 'the store moved it');
  assert.deepEqual(codes(moved.result), ['form-layout-not-stored']);
  assert.deepEqual(moved.result.managedBindings, []);
  // Neighbours: kept as sent, both writes save and bind the ids the stored form holds where they were sent.
  const keptSwap = await faulted(await twoFields(), spec, (xml) => xml);
  assert.deepEqual(codes(keptSwap.result), [], JSON.stringify(keptSwap.result));
  const childIds = keptSwap.result.managedBindings.filter((b) => b.kind === flr.CHILD_KIND).map((b) => b.id);
  assert.ok(childIds.includes('ctl_new_name') && childIds.includes('ctl_new_code'), JSON.stringify(childIds));
  const keptRow = await faulted(await withPayload(), one, (xml) => xml);
  assert.deepEqual(codes(keptRow.result), [], JSON.stringify(keptRow.result));
});

test('an authoritative native match is not a creation: approved adoption with a full proof saves it as matched; without approval it refuses and is withheld', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const first = await create(spec, ports());
  assert.deepEqual(codes(first.result), []);
  const matching = (extra) => {
    const ctx = ports(extra);
    const run = ctx.creates.run.bind(ctx.creates);
    ctx.creates.run = async (request, execute) => ({ ...(await run(request, execute)), outcome: 'matched', evidence: 'sdk-adopted-exact' });
    return ctx;
  };
  const def = compileFormIntent(spec, spec.forms[0], INTENT);
  const approved = matching({ authorizedAdoption: true });
  const { sdk } = await first.h.freshSdk();
  const result = await flr.applyDeclaredFormCreate({ form: spec.forms[0], spec, def, sdk }, approved);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  assert.equal(result.saved.length, 1);
  assert.equal(result.saved[0].matched, true);
  assert.equal(result.saved.some((s) => s.created), false, 'never counted as created');
  assert.equal(result.managedBindings.find((b) => b.kind === flr.KIND).origin, 'adopted');
  const unapproved = matching({});
  const again = await flr.applyDeclaredFormCreate({ form: spec.forms[0], spec, def, sdk: (await first.h.freshSdk()).sdk }, unapproved);
  assert.deepEqual(codes(again), ['form-layout-adoption-not-authorized']);
  assert.deepEqual(again.managedBindings, []);
  commitPublication(unapproved, again);
  assert.deepEqual(unapproved.publication.queued, []);
});

test('requested event handlers an existing form lacks are added in the layout push; then nothing changes', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const events = [{ event: 'onload', library: 'new_/ticket.js', function: 'Ticket.onLoad' }];
  const ctx = ports();
  const unbound = await reconcile(h, spec, ctx, { events });
  assert.deepEqual(codes(unbound.result), ['form-layout-adoption-not-authorized'], 'an unbound form is not edited without approval');
  ctx.authorizedAdoption = true;
  const out = await reconcile(h, spec, ctx, { events });
  assert.deepEqual(codes(out.result), [], JSON.stringify(out.result));
  assert.equal(out.writes.filter((w) => w.method === 'patch').length, 1, 'one push');
  assert.match(String(h.store.row.formxml), /<event name="onload"[^>]*>[\s\S]*Ticket\.onLoad/);
  const again = await reconcile(h, spec, ctx, { events });
  assert.equal(again.plan.action, 'noChange');
  assert.deepEqual(again.writes, []);
});

test('an onchange handler is known by its field: the same function on two fields is two handlers, each added and verified', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }, { cells: [cell(2, 'new_code')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name', 'new_code'] }]);
  const onName = { event: 'onchange', attribute: 'new_name', library: 'new_/ticket.js', function: 'Ticket.onChange' };
  const onCode = { ...onName, attribute: 'new_code' };
  const onLoad = { event: 'onload', library: 'new_/ticket.js', function: 'Ticket.onLoad' };
  const intentTabs = compileFormIntent(spec, spec.forms[0], INTENT).tabs;
  const verify = async (events) => flr.verifyDeclaredForm({ form: spec.forms[0], spec, intentTabs, liveForm: await storedForm(h), events }).map((i) => i.code);
  const stored = () => [...String(h.store.row.formxml).matchAll(/<event name="onchange"[^>]*attribute="([^"]+)"/g)].map((m) => m[1]).sort();
  const ctx = ports({ authorizedAdoption: true });
  // Neighbour: the handler on one field first, with an onload handler beside it.
  const first = await reconcile(h, spec, ctx, { events: [onName, onLoad] });
  assert.deepEqual(codes(first.result), [], JSON.stringify(first.result));
  assert.deepEqual(stored(), ['new_name']);
  assert.deepEqual(await verify([onName, onCode, onLoad]), ['form-event'], 'the sibling on new_code is missing');
  // The sibling on the other field is added on its own; nothing else is sent again.
  const both = await reconcile(h, spec, ctx, { events: [onName, onCode, onLoad] });
  assert.deepEqual(codes(both.result), [], JSON.stringify(both.result));
  assert.deepEqual(both.plan.addHandlers.map((ev) => ev.attribute || ev.event), ['new_code']);
  assert.deepEqual(stored(), ['new_code', 'new_name']);
  assert.equal((String(h.store.row.formxml).match(/<event name="onload"/g) || []).length, 1, 'the onload handler is not added twice');
  assert.deepEqual(await verify([onName, onCode, onLoad]), []);
  const again = await reconcile(h, spec, ctx, { events: [onName, onCode, onLoad] });
  assert.equal(again.plan.action, 'noChange');
  assert.deepEqual(again.writes, []);
});

// The ids the stable creation port derives for a new declared form of `spec`, so a test can read the row it made.
const createdForm = async (spec) => {
  const form = spec.forms[0];
  const h = createHarness({ formId: stableId('stable-test', flr.KIND, flr.formLayoutKey(form)) });
  harnesses.push(h);
  return h;
};
const declared = async (h, spec, ctx, extra = {}) => flr.reconcileDeclaredForm({
  form: spec.forms[0], spec, def: compileFormIntent(spec, spec.forms[0], INTENT), sdk: (await h.freshSdk()).sdk, ...extra,
}, ctx);

test('a form\'s bindings are recorded root last, and child records with no root binding steer nothing', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const key = flr.formLayoutKey(spec.forms[0]);
  const first = await reconcile(h, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(first.result), [], JSON.stringify(first.result));
  const kinds = first.result.managedBindings.map((b) => b.kind);
  assert.equal(kinds[kinds.length - 1], flr.KIND, 'the root binding is the last one recorded');
  assert.ok(kinds.slice(0, -1).length && kinds.slice(0, -1).every((k) => k === flr.CHILD_KIND));
  // What a recording that stopped part way leaves: child records, one of them (the section's) naming a section
  // the form does not hold, and no root.
  const children = first.result.managedBindings.filter((b) => b.kind === flr.CHILD_KIND);
  const stale = { ...children[0], key: `${key}#section:tab_main/sec_main`, id: guid(4242) };
  const root = first.result.managedBindings.find((b) => b.kind === flr.KIND);
  const partial = await reconcile(h, spec, ports({ authorizedAdoption: true, managed: fakeManaged([...children, stale]) }));
  assert.deepEqual(codes(partial.result), [], JSON.stringify(partial.result));
  assert.equal(partial.plan.action, 'noChange');
  // Neighbour: under the root binding the same record is the build's, and the section it names is gone.
  const whole = await reconcile(h, spec, ports({ managed: fakeManaged([...children, stale, root]) }));
  assert.deepEqual(codes(whole.result), ['create-completion-required']);
  assert.deepEqual(whole.writes, []);
});

test('a continuation of this key\'s own create is the build\'s without an adoption; the same row found by name needs the approval', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name', 'new_code'] }]);
  const h = await createdForm(spec);
  // The create saves, but its settlement does not finish (its solution membership failed): nothing is recorded.
  const made = await declared(h, spec, ports(), { resolveExisting: async () => undefined });
  assert.deepEqual(codes(made), [], JSON.stringify(made));
  assert.equal(made.action, 'create');
  assert.ok(made.managedBindings.length);
  const edited = formSpec([{ name: 'sec_main', columns: 1, fields: [{ name: 'new_name', readOnly: true }, 'new_code'] }]);
  // By name the row is an existing form the spec has not managed: it is not edited without the approval.
  const byName = await declared(h, edited, ports(), { resolveExisting: async () => h.formId });
  assert.deepEqual(codes(byName), ['form-layout-adoption-not-authorized']);
  assert.deepEqual(byName.managedBindings, []);
  // As the creation port's continuation it is this key's own create: written, proven and bound as created.
  const ctx = ports();
  const continued = await declared(h, edited, ctx, { resolveExisting: async () => ({ id: h.formId, continuation: true }) });
  assert.deepEqual(codes(continued), [], JSON.stringify(continued));
  assert.deepEqual(continued.saved.map((s) => [s.id, !!s.continued]), [[h.formId, true]]);
  const root = continued.managedBindings[continued.managedBindings.length - 1];
  assert.deepEqual([root.kind, root.id, root.origin], [flr.KIND, h.formId, 'created']);
  // Unchanged, a continuation is still bound; once bound, the binding wins and the resolver is not asked.
  const unchanged = await declared(h, edited, ports(), { resolveExisting: async () => ({ id: h.formId, continuation: true }) });
  assert.deepEqual(unchanged.unchanged.map((s) => [s.id, s.managed, !!s.continued]), [[h.formId, true, true]]);
  assert.equal(unchanged.managedBindings[unchanged.managedBindings.length - 1].kind, flr.KIND);
  ctx.managed.persist(continued.managedBindings);
  const bound = await declared(h, edited, ctx, { resolveExisting: async () => { throw new Error('must not be asked'); } });
  assert.deepEqual(codes(bound), []);
  assert.equal(bound.action, 'noChange');
  // A resolver that refuses (two forms of the name) is a refusal of this form; nothing is written.
  const ambiguous = await declared(h, edited, ports(), { resolveExisting: async () => { throw new Error('two forms are named Main'); } });
  assert.deepEqual(codes(ambiguous), ['form-layout-resolve-refused']);
});
test('declaredHostsOf keeps what the legacy pass drops: an unresolved sub-grid or quick view and a stated placement', () => {
  const form = { entity: 'new_ticket', name: 'Main', reconcile: 'declared',
    subgrids: [{ childEntity: 'new_child', tab: 'tab_main' }, { childEntity: 'new_orphan' }],
    quickViews: [{ lookup: 'new_area', targetEntity: 'contact', form: 'Card' }, { lookup: 'new_owner', targetEntity: 'account', form: 'Missing' }] };
  const def = { __subgrids: [
    { targetEntity: 'new_child', relationshipName: 'new_ticket_child', viewId: guid(7777), label: 'Children' },
    { targetEntity: 'new_auto', relationshipName: 'new_ticket_auto', viewId: guid(7779), label: 'Auto' },
  ] };
  const hosts = flr.declaredHostsOf(form, def, { quickViewFormIdOf: (t, name) => (t === 'contact' && name === 'Card' ? guid(7800) : '') });
  assert.deepEqual(hosts.subgrids.map((s) => [s.targetEntity, !!s.unresolved, s.placement || null]), [
    ['new_child', false, { tab: 'tab_main' }], ['new_orphan', true, null], ['new_auto', false, null],
  ]);
  assert.deepEqual(hosts.quickViews.map((q) => [q.lookupFieldName, q.quickViewFormId, !!q.unresolved]), [['new_area', guid(7800), false], ['new_owner', '', true]]);
  assert.deepEqual(hosts.quickViews.map((q) => q.placement || null), [null, null], 'a quick view that states no placement carries none');
});

test('a quick view placement in the raw spec reaches the plan and refuses; without one the same quick view is added', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_name'] }]);
  const qvForm = guid(7800);
  const hostsFor = (qv) => flr.declaredHostsOf({ ...spec.forms[0], quickViews: [qv] }, {}, { quickViewFormIdOf: (t, name) => (t === 'contact' && name === 'Card' ? qvForm : '') });
  const raw = { lookup: 'new_area', targetEntity: 'contact', form: 'Card' };
  const placedHosts = hostsFor({ ...raw, tab: 'Tab_Main' });
  assert.deepEqual(placedHosts.quickViews[0].placement, { tab: 'tab_main' });
  const placed = await reconcile(h, spec, ports({ authorizedAdoption: true }), { hosts: placedHosts });
  assert.deepEqual(codes(placed.result), ['form-host-unsupported']);
  assert.deepEqual(placed.writes, []);
  const plain = await reconcile(h, spec, ports({ authorizedAdoption: true }), { hosts: hostsFor(raw) });
  assert.deepEqual(codes(plain.result), [], JSON.stringify(plain.result));
  assert.match(String(h.store.row.formxml), new RegExp(qvForm.replace(/[-]/g, '\\-'), 'i'));
});

test('verifyDeclaredForm checks only what the spec states, on the stored form', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_extra')] }, { cells: [cell(3, 'new_code')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', { name: 'new_name', readOnly: true }] }]);
  const intentTabs = compileFormIntent(spec, spec.forms[0], INTENT).tabs;
  const verify = async (extra = {}) => flr.verifyDeclaredForm({ form: spec.forms[0], spec, intentTabs, liveForm: await storedForm(h), ...extra }).map((i) => i.code);
  assert.deepEqual(await verify(), ['form-field-flag', 'form-field-order'], 'before the build: out of order and not read-only');
  const { result } = await reconcile(h, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  assert.deepEqual(await verify(), [], 'the maker field it does not declare is unconstrained');
  const grid = { targetEntity: 'new_child', relationshipName: 'new_ticket_child', viewId: guid(7777) };
  assert.deepEqual(await verify({ hosts: { subgrids: [grid] }, events: [{ event: 'onload', library: 'new_/t.js', function: 'T.onLoad' }] }), ['form-host', 'form-event']);
  const quick = { ...spec.forms[0], formType: 'QuickView' };
  assert.deepEqual(flr.verifyDeclaredForm({ form: quick, spec, intentTabs, liveForm: await storedForm(h) }).map((i) => i.code), ['form-identity']);
});

test('the manifest keeps a settled declared form; hydrate restores it only while the stored form is still what the build bound', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_extra')] }, { cells: [cell(3, 'new_code')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', { name: 'new_name', readOnly: true }] }]);
  const { result } = await reconcile(h, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const entry = JSON.parse(JSON.stringify(flr.formManifestEntry({ form: spec.forms[0], result })));
  assert.equal(entry.id.toLowerCase(), h.formId.toLowerCase());
  assert.ok(['tab:tab_main', 'section:tab_main/sec_main', 'cell:new_code', 'control:new_name'].every((k) => entry.children[k]), JSON.stringify(entry.children));
  assert.equal(flr.formManifestEntry({ form: spec.forms[0], result: { ...result, unknown: [{ code: 'form-layout-not-stored' }] } }), null, 'unsettled work is no declaration');
  assert.equal(flr.formManifestEntry({ form: { ...spec.forms[0], reconcile: undefined }, result }), null);
  assert.deepEqual(flr.hydrateDeclaredForm(entry, { formId: h.formId, liveForm: await storedForm(h) }), { form: spec.forms[0] });
  assert.match(flr.hydrateDeclaredForm(entry, { formId: guid(9191), liveForm: await storedForm(h) }).stale, /not/);
  assert.match(flr.hydrateDeclaredForm({ ...entry, kind: 'other' }, { formId: h.formId, liveForm: await storedForm(h) }).stale, /not a declared form entry/);
  // A maker turns the declared read-only field editable: the declaration is no longer what the form holds.
  await makerEdit(h, (tabs) => { for (const c of tabs[0].columns[0].sections[0].rows.flatMap((r) => r.cells)) if (c.control && c.control.fieldName === 'new_name') c.control.isReadOnly = false; });
  assert.match(flr.hydrateDeclaredForm(entry, { formId: h.formId, liveForm: await storedForm(h) }).stale || '', /layout changed/);
});

test('with the manifest, verify checks what the build bound: a swapped managed control, a lost stored host or handler; without it nothing new is asked', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_code')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_name', 'new_code'] }]);
  const intentTabs = compileFormIntent(spec, spec.forms[0], INTENT).tabs;
  const grid = { targetEntity: 'new_child', relationshipName: 'new_ticket_child', viewId: guid(7777), label: 'Children' };
  const handler = { event: 'onload', library: 'new_/t.js', function: 'T.onLoad' };
  const { result } = await reconcile(h, spec, ports({ authorizedAdoption: true }), { hosts: { subgrids: [grid] }, events: [handler] });
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const manifest = flr.formManifestEntry({ form: spec.forms[0], result, hosts: { subgrids: [grid] }, events: [handler] });
  assert.equal(manifest.hosts.length, 1);
  assert.equal(manifest.handlers.length, 1);
  const verify = async (extra = {}) => flr.verifyDeclaredForm({ form: spec.forms[0], spec, intentTabs, liveForm: await storedForm(h), ...extra }).map((i) => i.code);
  assert.deepEqual(await verify({ manifest }), []);
  // A reader that cannot resolve the sub-grid's view matches it by relationship and table.
  assert.deepEqual(await verify({ hosts: { subgrids: [{ ...grid, viewId: '' }] } }), []);
  assert.deepEqual(await verify({ hosts: { subgrids: [{ ...grid, relationshipName: 'new_ticket_other', viewId: '' }] } }), ['form-host']);
  // Another form of the same table and type is not the form the build bound.
  const other = { ...(await storedForm(h)), id: guid(9191) };
  assert.deepEqual(flr.verifyDeclaredForm({ form: spec.forms[0], spec, intentTabs, liveForm: other, manifest }).map((i) => i.code), ['form-identity']);
  // A maker swaps the two field controls' fields, drops the sub-grid and the handler.
  await makerEdit(h, (tabs) => {
    const cells = tabs[0].columns[0].sections[0].rows[0].cells;
    const [a, b] = [cells[0].control, cells[1].control];
    [a.fieldName, b.fieldName] = [b.fieldName, a.fieldName];
    for (const t of tabs) for (const col of t.columns) for (const s of col.sections) s.rows = s.rows.map((r) => ({ ...r, cells: (r.cells || []).filter((c) => !(c.control && c.control.parameters && c.control.parameters.RelationshipName)) }));
  });
  const live = await storedForm(h);
  live.bag = { ...live.bag, c: (live.bag.c || []).filter((e) => !(e && e.node && e.node.n === 'events')) };
  const withManifest = flr.verifyDeclaredForm({ form: spec.forms[0], spec, intentTabs, liveForm: live, manifest }).map((i) => i.code);
  assert.ok(withManifest.includes('form-managed-child') && withManifest.includes('form-host') && withManifest.includes('form-event'), JSON.stringify(withManifest));
  // Neighbour: without the manifest (and with no hosts or events asked) the same form only meets the spec's own checks.
  const without = flr.verifyDeclaredForm({ form: spec.forms[0], spec, intentTabs, liveForm: live }).map((i) => i.code);
  assert.ok(!without.includes('form-managed-child') && !without.includes('form-host') && !without.includes('form-event'), JSON.stringify(without));
});