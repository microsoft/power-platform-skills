'use strict';
// Declared form layout (`forms[].reconcile: "declared"`) through the REAL vendored SDK over a stored systemform, settled
// through the managed binding store (managed-bindings.js) and the shared managed settlement (managed-feature-contract.js).
// Existing forms: declared fields are packed in order around a maker's controls, which keep their exact slots; existing
// cells keep their ids; a free slot a later cell must skip is a spacer, and only a spacer the build recorded is its own;
// an unchanged layout sends nothing; every refusal writes nothing. New forms: the whole composite is sent in one push with
// every id derived from the form's key by the creation catalog. Every write is proved by one composite proof of a fresh
// read (what each child id IS and where it stands, what the form shows, and what the spec does not own) before the group
// is committed; a write that is not proved is held, never bound, and recovered from its stored proof on the next run.
// Publication is paid per table through the shared managed publication, after a no-op too.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { guid, createHarness, seedForm, NOTES_CLASS_ID } = require('./helpers/form-store-harness.js');
const { createManagedWire, sdkOver, ORIGIN } = require('./helpers/managed-wire.js');
const { compileFormIntent } = require('../lib/artifact-intent.js');
const { slotGrid, rowOccupancy } = require('../lib/form-occupancy.js');
const { openManagedContext } = require('../lib/managed-bindings.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { createIntentCatalog } = require('../lib/creates-catalog.js');
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
function formSpec(sections, { reconcile = 'declared', notes = false, extra = {}, name = 'Main' } = {}) {
  const form = { entity: 'new_ticket', name, formType: 'Main', layout: 'explicit', prune: false, notes,
    tabs: [{ name: 'tab_main', label: 'Overview', sections: sections.map((s) => ({ label: s.name, ...s })) }], ...extra };
  if (reconcile) form.reconcile = reconcile;
  return specWith([form]);
}

// The form's own id is never one of its children's (the harness default, guid(1), is the first test cell's).
const FORM_ID = guid(4000);
async function deployed(sections) {
  const h = createHarness({ formId: FORM_ID });
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

// One build invocation's managed context over a workspace folder: a fresh publication barrier and the store opened
// the way the build opens it (openManagedContext installs the holds and quarantines its debt calls for).
function openRun(dir) {
  const barrier = createPublicationBarrier();
  const { store, debt } = openManagedContext({ workspaceDir: dir, environment: ORIGIN, appUniqueName: 'new_formprobe', solutionUniqueName: 'FormProbe', barrier });
  return { store, barrier, debt };
}
function ports(extra = {}) {
  const dir = makeTempDir('form-layout-');
  return { dir, ...openRun(dir), ...extra };
}
const catalogOf = (form) => createIntentCatalog([flr.formCatalogIntent(form, { solution: 'FormProbe' })]);
const derivedFormId = (form) => catalogOf(form).identityFor(flr.FAMILY, flr.formLayoutKey(form)).id;
const groupOf = (ctx, form) => ctx.store.readGroup(flr.FAMILY, flr.formLayoutKey(form));
const recordOf = (ctx, form, locator) => {
  const g = groupOf(ctx, form).committed;
  const key = locator ? `${flr.formLayoutKey(form)}#${locator}` : flr.formLayoutKey(form);
  return (g && g.records.find((r) => r.key === key)) || null;
};

// Reconcile one declared form as one build invocation does: the store is re-opened with a fresh barrier (so what an
// earlier call left pending is held), the catalog names the form's ids, and the existing form resolves to the harness
// row. A thrown error (every refusal, unknown outcome or failed proof) is answered as `result.code`.
async function reconcile(h, spec, ctx, extra = {}) {
  const { sdk, mutations } = await h.freshSdk();
  if (extra.wrap) extra.wrap(sdk);
  Object.assign(ctx, openRun(ctx.dir));
  const readsBefore = h.reads.length;
  const writesBefore = h.writes.length;
  const form = extra.form || spec.forms[0];
  let result;
  try {
    result = await flr.reconcileDeclaredForm({
      form, spec, def: compileFormIntent(spec, spec.forms[0], INTENT), sdk, hosts: extra.hosts, events: extra.events,
      resolveExisting: extra.resolveExisting || (async () => h.formId),
    }, { catalog: catalogOf(spec.forms[0]), ...ctx });
  } catch (err) {
    result = { action: null, code: err.code || 'thrown', error: err };
  }
  return { result, plan: result, mutations, writes: h.writes.slice(writesBefore), reads: h.reads.length - readsBefore };
}

const codes = (result) => (result.code ? [result.code] : []);

// Create a NEW declared form on an empty harness whose stored row takes the id the catalog derives for its key.
async function create(spec, ctx, { hosts, events, wrap } = {}) {
  const h = createHarness({ formId: derivedFormId(spec.forms[0]) });
  harnesses.push(h);
  const out = await reconcile(h, spec, ctx, { hosts, events, wrap, resolveExisting: async () => undefined });
  return { h, ...out };
}

// The store answers the push as saved but rewrites what it keeps (`mutate` of the saved XML), so the fresh read sees it.
const storeRewrites = (h, mutate) => (sdk) => {
  const push = sdk.pushArtifact.bind(sdk);
  sdk.pushArtifact = async (...args) => { const r = await push(...args); h.store.row.formxml = mutate(h.store.row.formxml); return r; };
};
// The push reaches the store, then its answer is lost.
const answerLost = (sdk) => {
  const push = sdk.pushArtifact.bind(sdk);
  sdk.pushArtifact = async (...args) => { await push(...args); throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };
};
async function faulted(h, spec, mutate, ctx = ports({ authorizedAdoption: true })) {
  const out = await reconcile(h, spec, ctx, { wrap: storeRewrites(h, mutate) });
  return { ...out, ctx, live: await storedForm(h) };
}

const allSections = (f) => f.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections));

// A maker replaces the stored form's tabs (a designer edit), through a fresh SDK.
async function makerEdit(h, fn) {
  const maker = await h.freshSdk();
  await maker.sdk.fetchArtifact('form', h.formId, { overwrite: true });
  const live = await maker.sdk.getArtifact('form', h.formId);
  fn(live.tabs);
  await maker.sdk.updateElement('form', h.formId, '/tabs', live.tabs);
  await maker.sdk.pushArtifact('form', h.formId);
}

const nothingSettled = (ctx, form) => {
  const { committed, pending } = groupOf(ctx, form);
  assert.equal(committed, null, 'nothing is bound');
  return pending;
};

test('slot model: a cell beside a row-spanning cell sits in the column the span leaves free; the width-only model is unchanged', () => {
  const g = slotGrid([{ cells: [{ rowspan: 2 }, {}] }, { cells: [{}] }], 2);
  assert.deepEqual(g.placed.map((p) => [p.r, p.c]), [[0, 0], [0, 1], [1, 1]]);
  assert.deepEqual(g.overflow, []);
  assert.deepEqual(rowOccupancy([{ cells: [{ rowspan: 2 }, {}] }, { cells: [{}] }]).map((o) => o.used), [2, 2]);
  assert.deepEqual(slotGrid([{ cells: [{ colspan: 2 }] }], 1).overflow, [{ row: 0, cell: 0 }]);
});

test('declared fields pack in order around a maker field that keeps its slot and id; the group is committed after the proof; a re-run sends nothing', async () => {
  const h = await deployed([section('sec_main', 2, [
    { cells: [cell(1, 'new_name'), cell(2, 'new_extra')] },
    { cells: [cell(3, 'new_code')] },
  ], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', 'new_name', 'new_area'] }]);
  const form = spec.forms[0];
  const ctx = ports({ authorizedAdoption: true });
  const { result, writes } = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result.error && result.error.cause && result.error.cause.message));
  assert.equal(result.action, 'update');
  assert.equal(writes.filter((w) => w.method === 'patch').length, 1, 'one push');
  assert.equal(writes.filter((w) => /PublishXml/i.test(w.url)).length, 0, 'reconcile never publishes');
  const after = await layoutOf(h, 'sec_main');
  assert.deepEqual(after.rows, [['new_code', 'new_extra'], ['new_name', 'new_area']]);
  assert.deepEqual([after.at.new_extra.r, after.at.new_extra.c, after.at.new_extra.id], [0, 1, guid(2)], 'the maker field did not move');
  assert.equal(after.at.new_name.id, guid(1));
  assert.equal(after.at.new_code.id, guid(3));
  // The new cell's id came from the creation catalog under the form's id; every object the build relies on is recorded.
  const root = recordOf(ctx, form);
  assert.deepEqual([root.id, root.origin], [h.formId, 'adopted']);
  const added = recordOf(ctx, form, 'cell:new_area');
  assert.deepEqual([added.id, added.origin], [after.at.new_area.id, 'created']);
  for (const k of ['cell:new_code', 'cell:new_name', 'control:new_area', 'section:tab_main/sec_main', 'tab:tab_main']) assert.ok(recordOf(ctx, form, k), k);
  assert.equal(recordOf(ctx, form, 'cell:new_extra'), null, 'the maker field is not the build\'s');
  const again = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(again.result), []);
  assert.equal(again.result.action, 'noop');
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
  assert.equal(side.section.id, recordOf(ctx, spec.forms[0], 'section:tab_main/sec_side').id, 'the new section has the catalog id');
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
  const { result, writes, mutations, reads } = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(result), ['form-layout-duplicate-field']);
  assert.deepEqual(writes, []);
  assert.deepEqual(mutations, []);
  assert.equal(reads, 0, 'nothing was read');
  assert.equal(nothingSettled(ctx, spec.forms[0]), null, 'and no attempt was recorded');
});

test('prune and embedded generative pages refuse before anything is read or written', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  for (const [extra, code] of [[{ prune: true }, 'form-layout-prune-unsupported'], [{ genPages: [{ name: 'p' }] }, 'form-page-embeds-incomplete']]) {
    const spec = formSpec([{ name: 'sec_main', fields: ['new_name'] }], { extra });
    const ctx = ports({ authorizedAdoption: true });
    const out = await reconcile(h, spec, ctx);
    assert.deepEqual(codes(out.result), [code]);
    assert.deepEqual([out.writes, out.reads], [[], 0]);
    assert.equal(nothingSettled(ctx, spec.forms[0]), null);
  }
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
  const record = recordOf(ctx, wide.forms[0], 'spacer:tab_main/sec_main:0:0');
  assert.ok(record && record.id === spacerId, 'the spacer is recorded at its slot');
  const same = await reconcile(h, wide, ctx);
  assert.deepEqual([same.result.action, same.writes], ['noop', []], 'its own spacer standing where it was is no change');
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
  assert.equal(nothingSettled(ctx, spec.forms[0]), null);
});

test('adoption, drift and the bound identity gate every write; the resolver is asked only for an unbound key', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_code')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', 'new_name'] }]);
  const ctx = ports();
  const unadopted = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(unadopted.result), ['form-layout-adoption-not-authorized']);
  assert.deepEqual(unadopted.writes, []);
  const refusing = await reconcile(h, spec, ctx, { resolveExisting: async () => { throw new Error('two forms are named Main'); } });
  assert.deepEqual(codes(refusing.result), ['form-layout-resolve-refused']);
  ctx.authorizedAdoption = true;
  const adopted = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(adopted.result), [], JSON.stringify(adopted.result));
  delete ctx.authorizedAdoption;
  // Once bound, the binding wins: the resolver is not asked, whatever it would name.
  const bound = await reconcile(h, spec, ctx, { resolveExisting: async () => { throw new Error('must not be asked'); } });
  assert.deepEqual([codes(bound.result), bound.result.action, bound.result.formId], [[], 'noop', h.formId]);
  // A maker swaps the two fields back in the designer: the next build refuses rather than undo their edit.
  await makerEdit(h, (tabs) => { tabs[0].columns[0].sections[0].rows[0].cells.reverse(); });
  const drifted = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(drifted.result), ['form-layout-drift']);
  assert.deepEqual(drifted.writes, []);
});

test('only the raw spec form opts in: a compiled def (which carries no `reconcile`) plans, creates and reads nothing', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', 'new_name'] }]);
  const def = compileFormIntent(spec, spec.forms[0], INTENT);
  assert.equal(def.reconcile, undefined);
  const ctx = ports({ authorizedAdoption: true });
  const compiled = await reconcile(h, spec, ctx, { form: def, resolveExisting: async () => undefined });
  assert.deepEqual([compiled.result.action, compiled.writes, compiled.reads], [null, [], 0]);
  const raw = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(raw.result), [], JSON.stringify(raw.result));
  assert.deepEqual((await layoutOf(h, 'sec_main')).rows, [['new_code', 'new_name']]);
});

test('a quick view bound to a declared lookup is not taken for the field; an existing form needs no new id when nothing is new', async () => {
  const qv = { id: guid(30), control: { id: 'qv_area', classId: QUICK_VIEW_CLASS_ID, fieldName: 'new_area', parameters: { ControlMode: 'Edit' } } };
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_area'), qv] }, { cells: [cell(2, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_name', 'new_area'] }]);
  const ctx = ports({ authorizedAdoption: true });
  const { result } = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const after = await layoutOf(h, 'sec_main');
  assert.deepEqual(after.rows, [['new_name', '#'], ['new_area']]);
  assert.deepEqual([after.at[`cell:${guid(30)}`].r, after.at[`cell:${guid(30)}`].c], [0, 1], 'the quick view kept its slot');
  assert.deepEqual(groupOf(ctx, spec.forms[0]).committed.records.filter((r) => r.origin === 'created'), [], 'no new child, no catalog id');
});

const ROWSPAN_SPEC = () => formSpec([{ name: 'sec_main', columns: 2, fields: [{ name: 'new_name', rowspan: 2 }, 'new_code', 'new_extra', 'new_area'] }]);

test('a new form packs a cell after a middle row-spanning cell into the free column, where the compiled rows overflow', async () => {
  const spec = ROWSPAN_SPEC();
  const compiled = compileFormIntent(spec, spec.forms[0], INTENT).tabs[0].columns[0].sections.find((s) => s.name === 'sec_main');
  assert.ok(slotGrid(compiled.rows, 2).overflow.length > 0, 'the width-only compiled rows run past the grid');
  const { h, result } = await create(spec, ports());
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const after = await layoutOf(h, 'sec_main');
  assert.deepEqual(after.overflow, []);
  assert.deepEqual(['new_name', 'new_code', 'new_extra', 'new_area'].map((f) => [after.at[f].r, after.at[f].c]), [[0, 0], [0, 1], [1, 1], [2, 0]]);
  assert.equal(after.at.new_name.rowspan, 2);
  const rows = flr.declaredSlotRows(compiled.rows.flatMap((r) => r.cells), 2);
  assert.deepEqual(slotGrid(rows, 2).overflow, [], 'the export the compile path uses packs the same way');
});

test('a new form is created whole under the catalog ids: every id survives the push and is bound only after a fresh read', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_name', 'new_code'] }]);
  const form = spec.forms[0];
  const ctx = ports();
  const { h, result, mutations, writes } = await create(spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  assert.deepEqual([result.action, result.formId], ['create', derivedFormId(form)]);
  assert.equal(writes.filter((w) => w.method === 'post' && /systemforms/.test(w.url)).length, 1, 'one create push');
  assert.equal(mutations.filter((m) => m.method === 'createArtifact').length, 1);
  const stored = await storedForm(h);
  assert.equal(stored.id, derivedFormId(form));
  assert.equal(stored.tabs.length, 1, 'the seed tab is gone');
  const tabStored = stored.tabs[0];
  const sec = tabStored.columns[0].sections.find((s) => s.name === 'sec_main');
  for (const [locator, id] of [['tab:tab_main', tabStored.id], ['section:tab_main/sec_main', sec.id], ['cell:new_name', sec.rows[0].cells[0].id]]) {
    const r = recordOf(ctx, form, locator);
    assert.deepEqual([r.id, r.origin], [id, 'created'], locator);
  }
  assert.equal(recordOf(ctx, form).origin, 'created');
  // Bound now: the next run proves the same form and sends nothing.
  const again = await reconcile(h, spec, ctx, { resolveExisting: async () => { throw new Error('must not be asked'); } });
  assert.deepEqual([codes(again.result), again.result.action, again.writes], [[], 'noop', []]);
});

test('a new form that asks for the timeline stores it in the shape that renders', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }], { notes: true });
  const ctx = ports();
  const { h, result } = await create(spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const stored = await storedForm(h);
  const notes = allSections(stored).find((s) => s.rows.some((r) => (r.cells || []).some((c) => c.control && c.control.id === 'notescontrol')));
  assert.ok(notes, 'a timeline is stored');
  const cellStored = notes.rows[0].cells[0];
  assert.equal(String(cellStored.control.classId).replace(/[{}]/g, '').toUpperCase(), NOTES_CLASS_ID);
  assert.equal(cellStored.rowspan, 23);
  assert.equal(notes.rows.length, 23, 'the span is backed by 22 rows');
  assert.equal(notes.id, recordOf(ctx, spec.forms[0], 'section:timeline').id);
  assert.equal(cellStored.id, recordOf(ctx, spec.forms[0], 'cell:timeline').id, 'the timeline cell is created under its own child id');
  const timelines = allSections(stored).flatMap((s) => s.rows.flatMap((r) => (r.cells || []).filter((c2) => c2.control && String(c2.control.classId).replace(/[{}]/g, '').toUpperCase() === NOTES_CLASS_ID)));
  assert.equal(timelines.length, 1, 'exactly one timeline is stored');
});

test('a create whose answer is lost binds nothing and holds its table; the next run proves it from the stored proof and never sends it again', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const form = spec.forms[0];
  const ctx = ports();
  const lost = await create(spec, ctx, { wrap: answerLost });
  assert.deepEqual(codes(lost.result), ['form-layout-write-unknown']);
  const pending = nothingSettled(ctx, form);
  assert.ok(pending && pending.expected, 'the attempt and its expected proof were stored before the send');
  // The next build opens the store: the attempt is a hold on the table, released only by its recovery.
  const next = openRun(ctx.dir);
  assert.deepEqual(next.debt.map((d) => [d.kind, d.key]), [['hold', flr.formLayoutKey(form)]]);
  const recovered = await reconcile(lost.h, spec, ctx);
  assert.deepEqual(codes(recovered.result), [], JSON.stringify(recovered.result));
  assert.equal(recovered.result.action, 'recovered');
  assert.deepEqual(recovered.writes, [], 'proved, never sent again');
  // Its answer never came back, so the store never saw the root acknowledged: the proved row is bound, but as adopted.
  assert.equal(recordOf(ctx, form).origin, 'adopted');
  assert.deepEqual(openRun(ctx.dir).debt, [], 'settled: nothing is held any more');
});

test('an existing form that asks for the timeline gets one added after its sections; then nothing changes', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }], { notes: true });
  const ctx = ports({ authorizedAdoption: true });
  const { result } = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  const sections = (await storedForm(h)).tabs[0].columns[0].sections;
  assert.deepEqual(sections.map((s) => s.name), ['sec_main', 'section_notes']);
  assert.equal(sections[1].rows[0].cells[0].control.id, 'notescontrol');
  assert.equal(sections[1].rows.length, 23);
  const again = await reconcile(h, spec, ctx);
  assert.equal(again.result.action, 'noop');
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
  const grids = (await storedForm(h)).tabs[0].columns[0].sections.filter((s) => s.rows.some((r) => (r.cells || []).some((c) => c.control && c.control.parameters && c.control.parameters.RelationshipName === 'new_ticket_child')));
  assert.equal(grids.length, 1);
  const again = await reconcile(h, spec, ctx, { hosts: { subgrids: [grid] } });
  assert.equal(again.result.action, 'noop');
});

test('a declared field the form holds twice refuses; a write the store does not keep is unproved, unbound and held', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }, { cells: [{ ...cell(2, 'new_name'), control: { id: 'ctl_new_name_2', fieldName: 'new_name' } }] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const twice = await reconcile(h, spec, ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(twice.result), ['form-layout-field-ambiguous']);
  assert.deepEqual(twice.writes, []);

  const h2 = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_code')] }], 50)]);
  const swap = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_code', 'new_name'] }]);
  // The service answers the push as saved but keeps the old layout.
  const kept = h2.store.row.formxml;
  const out = await faulted(h2, swap, () => kept);
  assert.deepEqual(codes(out.result), ['form-layout-unproved']);
  assert.ok(nothingSettled(out.ctx, swap.forms[0]).expected, 'the attempt stays pending');
  assert.deepEqual(openRun(out.ctx.dir).debt.map((d) => d.kind), ['hold'], 'its table is held on the next run');
});

test('a new form carries its event handlers in the same push', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const { h, result } = await create(spec, ports(), { events: [{ event: 'onload', library: 'new_/ticket.js', function: 'Ticket.onLoad' }] });
  assert.deepEqual(codes(result), [], JSON.stringify(result));
  assert.equal(h.writes.filter((w) => w.method === 'post' && /systemforms/.test(w.url)).length, 1);
  assert.match(String(h.store.row.formxml), /<event name="onload"[^>]*>[\s\S]*Ticket\.onLoad/);
});

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
  const before = recordOf(ctx, original.forms[0], 'cell:new_name').id;
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
  assert.equal(recordOf(ctx, wanted.forms[0], 'cell:new_name').id, before, 'the record still names the original cell');
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
  const qvSpec = formSpec([{ name: 'sec_main', columns: 2, fields: ['new_name'] }]);
  const same = await reconcile(h2, qvSpec, ports({ authorizedAdoption: true }), { hosts: { quickViews: [{ lookupFieldName: 'new_area', targetEntity: 'contact', quickViewFormId: qvForm }] } });
  assert.deepEqual(codes(same.result), [], JSON.stringify(same.result));
  assert.deepEqual(same.writes, []);
  const other = await reconcile(h2, qvSpec, ports({ authorizedAdoption: true }), { hosts: { quickViews: [{ lookupFieldName: 'new_area', targetEntity: 'contact', quickViewFormId: guid(7801) }] } });
  assert.deepEqual(codes(other.result), ['form-host-target-mismatch']);
});

test('two sub-grids whose targets a maker swapped under unchanged ids: the bound children no longer prove, though the id set is the same', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const form = spec.forms[0];
  const intentTabs = compileFormIntent(spec, form, INTENT).tabs;
  const a = { targetEntity: 'new_child', relationshipName: 'new_ticket_child', viewId: guid(7777), label: 'Children' };
  const b = { targetEntity: 'new_other', relationshipName: 'new_ticket_other', viewId: guid(7778), label: 'Others' };
  const hosts = { subgrids: [a, b] };
  const ctx = ports({ authorizedAdoption: true });
  assert.deepEqual(codes((await reconcile(h, spec, ctx, { hosts })).result), []);
  const group = () => groupOf(ctx, form).committed;
  const ids = (f) => allSections(f).flatMap((s) => s.rows.flatMap((r) => (r.cells || []).flatMap((c) => [c.id, c.control && c.control.id]))).filter(Boolean).sort();
  const before = await storedForm(h);
  assert.deepEqual(flr.verifyDeclaredForm({ form, spec, intentTabs, hosts, liveForm: before, group: group() }).map((i) => i.code), []);
  assert.ok(flr.hydrateDeclaredForm(group(), { formId: h.formId, liveForm: before }).form, 'unchanged, the declaration restores');
  await makerEdit(h, (tabs) => {
    const grids = allSections({ tabs }).flatMap((s) => s.rows.flatMap((r) => r.cells || [])).filter((c) => c.control && c.control.parameters && c.control.parameters.RelationshipName);
    const keys = ['RelationshipName', 'TargetEntityType', 'ViewId', 'DefaultViewId'];
    const [p, q] = [grids[0].control.parameters, grids[1].control.parameters];
    for (const k of keys) [p[k], q[k]] = [q[k], p[k]];
  });
  const after = await storedForm(h);
  assert.deepEqual(ids(after), ids(before), 'the same ids, each now showing the other target');
  // Both requested sub-grids are still shown, so what the spec states holds; what the build bound does not.
  const issues = flr.verifyDeclaredForm({ form, spec, intentTabs, hosts, liveForm: after, group: group() }).map((i) => i.code);
  assert.ok(issues.includes('form-managed-child') && !issues.includes('form-host'), JSON.stringify(issues));
  assert.match(flr.hydrateDeclaredForm(group(), { formId: h.formId, liveForm: after }).stale || '', /another object or stands somewhere else/);
  // The next build neither rebinds nor rewrites the swapped hosts.
  const next = await reconcile(h, spec, ctx, { hosts });
  assert.notEqual(next.result.action, 'noop');
  assert.ok(codes(next.result).length === 1, JSON.stringify(next.result.action));
  assert.deepEqual(next.writes, []);
});

test('children added on a later run take the catalog id under the form id, and a re-run after an unsettled add proves that id', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const ctx = ports();
  const first = await create(spec, ctx);
  assert.deepEqual(codes(first.result), []);
  const more = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name', 'new_code'] }]);
  const reserved = catalogOf(more.forms[0]).reserveChildren(flr.FAMILY, flr.formLayoutKey(more.forms[0]), {
    actualRootId: first.h.formId, children: [{ locator: 'cell:new_code', childKind: 'formCell', keyParts: [flr.formLayoutKey(more.forms[0]), 'new_code'] }],
  }).childIds['cell:new_code'];
  // The add is sent, but its answer is lost: unknown, nothing new bound.
  const unsettled = await reconcile(first.h, more, ctx, { wrap: answerLost });
  assert.deepEqual(codes(unsettled.result), ['form-layout-write-unknown']);
  assert.equal(recordOf(ctx, more.forms[0], 'cell:new_code'), null);
  assert.equal((await layoutOf(first.h, 'sec_main')).at.new_code.id, reserved, 'the id the catalog derives');
  // The re-run proves the cell under that very id and records it; nothing is sent again.
  const rerun = await reconcile(first.h, more, ctx);
  assert.deepEqual(codes(rerun.result), [], JSON.stringify(rerun.result));
  assert.deepEqual([rerun.result.action, rerun.writes], ['recovered', []]);
  assert.equal(recordOf(ctx, more.forms[0], 'cell:new_code').id, reserved);
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
  const harness = async (sideColumn) => { const h = createHarness({ formId: FORM_ID }); harnesses.push(h); await twoColumns(h, sideColumn); return h; };
  // The tab has one column: refuse rather than put sec_side in the first.
  const one = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const refused = await reconcile(one, spec(), ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(refused.result), ['form-layout-column-unsupported']);
  assert.deepEqual(refused.writes, []);
  // Two columns: the new section goes in the second.
  const two = await harness(null);
  const placed = await reconcile(two, spec(), ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(placed.result), [], JSON.stringify(placed.result));
  assert.equal((await storedForm(two)).tabs[0].columns.findIndex((c) => c.sections.some((s) => s.name === 'sec_side')), 1);
  // sec_side already stands in the first column: never moved.
  const elsewhere = await reconcile(await harness(0), spec(), ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(elsewhere.result), ['form-layout-container-moved']);
  assert.deepEqual(elsewhere.writes, []);
  // Neighbour: where it is in the second column, it is used in place.
  const inPlace = await harness(1);
  const used = await reconcile(inPlace, spec(), ports({ authorizedAdoption: true }));
  assert.deepEqual(codes(used.result), [], JSON.stringify(used.result));
  assert.equal(allSections(await storedForm(inPlace)).filter((s) => s.name === 'sec_side').length, 1);
});

test('the proof compares what the build does not own: a lost maker control or row payload is unproved and nothing is bound', async () => {
  const qv = { id: guid(73), control: { id: 'foreign_qv', classId: QUICK_VIEW_CLASS_ID, fieldName: 'new_area', parameters: { ControlMode: 'Edit' } } };
  const spec = formSpec([{ name: 'sec_main', columns: 2, fields: [{ name: 'new_name', readOnly: true }] }]);
  const run = async (loss) => {
    const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), qv] }, { cells: [cell(2, 'new_extra')], bag: { a: [['data-keep', 'row-payload']], c: [] } }], 50)]);
    assert.match(h.store.row.formxml, /data-keep="row-payload"/);
    return faulted(h, spec, loss);
  };
  const lostCell = await run((xml) => xml.replace(/<cell\b[^>]*>[\s\S]*?<\/cell>/g, (c) => (c.includes('foreign_qv') ? '' : c)));
  assert.deepEqual(codes(lostCell.result), ['form-layout-unproved']);
  assert.ok(nothingSettled(lostCell.ctx, spec.forms[0]).expected);
  const lostPayload = await run((xml) => xml.replace(/ data-keep="row-payload"/, ''));
  assert.deepEqual(codes(lostPayload.result), ['form-layout-unproved']);
  // Neighbour: nothing lost, the same write saves.
  const kept = await run((xml) => xml);
  assert.deepEqual(codes(kept.result), [], JSON.stringify(kept.result));
});

test('a foreign event handler the store drops with the write is unproved: the declared handler is there, the maker\'s is not', async () => {
  const seedWithHandler = async () => {
    const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
    // The maker's own onsave handler, stored in the form XML the way the designer stores one.
    h.store.row.formxml = String(h.store.row.formxml).replace(/<\/form>\s*$/, `<events><event name="onsave" application="false" active="true"><Handlers><Handler functionName="Maker.onSave" libraryName="new_/maker.js" handlerUniqueId="{${guid(8800)}}" enabled="true" parameters="" passExecutionContext="false" /></Handlers></event></events></form>`);
    assert.match(h.store.row.formxml, /Maker\.onSave/);
    return h;
  };
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: [{ name: 'new_name', readOnly: true }] }]);
  const events = [{ event: 'onload', library: 'new_/ticket.js', function: 'Ticket.onLoad' }];
  const dropMaker = (xml) => xml.replace(/<event name="onsave"[\s\S]*?<\/event>/, '');
  const h = await seedWithHandler();
  const ctx = ports({ authorizedAdoption: true });
  const out = await reconcile(h, spec, ctx, { events, wrap: storeRewrites(h, dropMaker) });
  assert.match(h.store.row.formxml, /Ticket\.onLoad/);
  assert.doesNotMatch(h.store.row.formxml, /Maker\.onSave/, 'the store dropped it');
  assert.deepEqual(codes(out.result), ['form-layout-unproved']);
  assert.equal(groupOf(ctx, spec.forms[0]).committed, null);
  // Neighbour: the store keeps both handlers; the same write settles.
  const h2 = await seedWithHandler();
  const kept = await reconcile(h2, spec, ports({ authorizedAdoption: true }), { events });
  assert.deepEqual(codes(kept.result), [], JSON.stringify(kept.result));
  assert.match(h2.store.row.formxml, /Maker\.onSave/);
  assert.match(h2.store.row.formxml, /Ticket\.onLoad/);
});

test('a section is known by its tab: a field the store keeps in a same-named section of another tab is not the declared one', async () => {
  const seed = async () => {
    const h = createHarness({ formId: FORM_ID });
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
  const r = await faulted(await seed(), spec, intoOtherTab);
  assert.ok(r.live.tabs[1].columns[0].sections[0].rows.some((row) => row.cells.some((c) => c.control && c.control.fieldName === 'new_name')), 'the store moved it');
  assert.deepEqual(codes(r.result), ['form-layout-unproved']);
  assert.equal(groupOf(r.ctx, spec.forms[0]).committed, null);
  // The projection names each section by its tab and form column.
  const parts = flr.formProjection(r.live.tabs);
  assert.deepEqual(Object.keys(parts).filter((k) => k.startsWith('columns:')).sort(), ['columns:tab_main/0/sec_shared', 'columns:tab_other/0/sec_shared']);
  assert.equal(parts['field:new_name'][0].section, 'tab_other/0/sec_shared');
  // Neighbour: the store keeps what was sent, the same write saves.
  const kept = await faulted(await seed(), spec, (xml) => xml);
  assert.deepEqual(codes(kept.result), [], JSON.stringify(kept.result));
  assert.ok(groupOf(kept.ctx, spec.forms[0]).committed);
});

test('the proof checks what each written id is: swapped field controls and a row payload on another row are unproved and unbound', async () => {
  const twoFields = () => deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }, { cells: [cell(2, 'new_code')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: [{ name: 'new_name', readOnly: true }, 'new_code'] }]);
  // The store swaps the two controls' ids: the same id set, each bound to the other field.
  const swap = (xml) => xml.replaceAll('ctl_new_name', 'swap_marker').replaceAll('ctl_new_code', 'ctl_new_name').replaceAll('swap_marker', 'ctl_new_code');
  const swapped = await faulted(await twoFields(), spec, swap);
  const held = swapped.live.tabs[0].columns[0].sections[0].rows.flatMap((row) => row.cells).map((c) => [c.control.fieldName, c.control.id]);
  assert.deepEqual(held, [['new_name', 'ctl_new_code'], ['new_code', 'ctl_new_name']], 'the store swapped them');
  assert.deepEqual(codes(swapped.result), ['form-layout-unproved']);
  assert.equal(groupOf(swapped.ctx, spec.forms[0]).committed, null);
  // A maker's row payload the store keeps on another row of the same section.
  const withPayload = () => deployed([section('sec_main', 1, [{ cells: [], bag: { a: [['data-maker-marker', 'retain-me']], c: [] } }, { cells: [] }, { cells: [cell(1, 'new_name')] }], 50)]);
  const one = formSpec([{ name: 'sec_main', columns: 1, fields: [{ name: 'new_name', readOnly: true }] }]);
  const moveRow = (xml) => { let i = 0; return xml.replace(/<row\b[^>]*\/?>/g, (row) => { const plain = row.replace(/\sdata-maker-marker="retain-me"/g, ''); i += 1; return i === 2 ? plain.replace(/\/?>$/, (m) => ` data-maker-marker="retain-me"${m}`) : plain; }); };
  const moved = await faulted(await withPayload(), one, moveRow);
  assert.deepEqual(moved.live.tabs[0].columns[0].sections[0].rows.flatMap((row, i) => (JSON.stringify(row.bag).includes('retain-me') ? [i] : [])), [1], 'the store moved it');
  assert.deepEqual(codes(moved.result), ['form-layout-unproved']);
  // Neighbours: kept as sent, both writes save and bind the ids the stored form holds where they were sent.
  const keptSwap = await faulted(await twoFields(), spec, (xml) => xml);
  assert.deepEqual(codes(keptSwap.result), [], JSON.stringify(keptSwap.result));
  assert.deepEqual(['control:new_name', 'control:new_code'].map((l) => recordOf(keptSwap.ctx, spec.forms[0], l).id), ['ctl_new_name', 'ctl_new_code']);
  const keptRow = await faulted(await withPayload(), one, (xml) => xml);
  assert.deepEqual(codes(keptRow.result), [], JSON.stringify(keptRow.result));
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
  assert.equal(again.result.action, 'noop');
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
  assert.equal(both.writes.filter((w) => w.method === 'patch').length, 1);
  assert.deepEqual(stored(), ['new_code', 'new_name']);
  assert.equal((String(h.store.row.formxml).match(/<event name="onload"/g) || []).length, 1, 'the onload handler is not added twice');
  assert.deepEqual(await verify([onName, onCode, onLoad]), []);
  const again = await reconcile(h, spec, ctx, { events: [onName, onCode, onLoad] });
  assert.equal(again.result.action, 'noop');
  assert.deepEqual(again.writes, []);
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

test('download restores the declaration only for the bound form as its last proof saw it; a dropped handler or a maker edit makes it stale', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }, { cells: [cell(2, 'new_code')] }], 50)]);
  const raw = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name', 'new_code'] }]);
  const events = [{ event: 'onload', library: 'new_/ticket.js', function: 'Ticket.onLoad' }];
  const spec = { ...raw, forms: [{ ...raw.forms[0], events, fieldOptions: { new_code: { readOnly: true } } }] };
  const form = spec.forms[0];
  const intentTabs = compileFormIntent(spec, form, INTENT).tabs;
  const ctx = ports({ authorizedAdoption: true });
  const out = await reconcile(h, spec, ctx, { events });
  assert.deepEqual(codes(out.result), [], JSON.stringify(out.result));
  const group = () => groupOf(ctx, form).committed;
  const hydrate = async (g = group(), formId = h.formId) => flr.hydrateDeclaredForm(g, { formId, liveForm: await storedForm(h) });
  const verify = async (extra = {}) => flr.verifyDeclaredForm({ form, spec, intentTabs, events, liveForm: await storedForm(h), ...extra }).map((i) => i.code);
  // The declaration as the spec wrote it (`prune`, which a declared form always leaves false, is not part of it).
  const { prune, ...declared } = form;
  assert.equal(prune, false);
  assert.deepEqual(await hydrate(), { form: declared });
  assert.deepEqual(await verify({ group: group() }), []);
  assert.match((await hydrate(group(), guid(4001))).stale, /names form/, 'another form id is not this group\'s');
  assert.match((await hydrate({ ...group(), family: 'view' })).stale, /no proved declared form/);
  assert.deepEqual(await verify({ group: group(), liveForm: { ...(await storedForm(h)), id: guid(4001) } }), ['form-identity']);
  // A maker removes the declared handler: verify names it, and download no longer restores a declaration it was not.
  const kept = h.store.row.formxml;
  h.store.row.formxml = String(kept).replace(/<events>[\s\S]*<\/events>/, '');
  assert.doesNotMatch(h.store.row.formxml, /Ticket\.onLoad/);
  assert.deepEqual(await verify({ group: group() }), ['form-event']);
  assert.match((await hydrate()).stale, /handlers/);
  h.store.row.formxml = kept;
  assert.deepEqual(await hydrate(), { form: declared });
  // A maker field added below the declared ones: what the spec states still verifies, the declaration is stale.
  await makerEdit(h, (tabs) => { allSections({ tabs })[0].rows.push({ cells: [cell(3, 'new_extra')] }); });
  assert.deepEqual(await verify({ group: group() }), []);
  assert.match((await hydrate()).stale, /changed/);
  // A maker drops a declared field: verify names the field, and with the group the child it bound.
  await makerEdit(h, (tabs) => { const s = allSections({ tabs })[0]; s.rows = s.rows.filter((r) => !r.cells.some((c) => c.control && c.control.fieldName === 'new_code')); });
  assert.deepEqual(await verify(), ['form-field-count']);
  assert.deepEqual([...new Set(await verify({ group: group() }))], ['form-field-count', 'form-managed-child']);
});

test('fieldOptions is part of what the build settles: true, false, then absent each change the recorded declaration, and download returns it as written', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }, { cells: [cell(2, 'new_code')] }], 50)]);
  const specOf = (fieldOptions) => {
    const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name', 'new_code'] }]);
    if (fieldOptions !== undefined) spec.forms[0].fieldOptions = fieldOptions;
    return spec;
  };
  const ctx = ports({ authorizedAdoption: true });
  const settled = async (spec) => (await flr.hydrateDeclaredForm(groupOf(ctx, spec.forms[0]).committed, { formId: h.formId, liveForm: await storedForm(h) })).form;
  const on = specOf({ new_code: { readOnly: true } });
  const first = await reconcile(h, on, ctx);
  assert.deepEqual([codes(first.result), first.result.action], [[], 'update'], JSON.stringify(first.result));
  assert.equal((await layoutOf(h, 'sec_main')).at.new_code.readOnly, true);
  assert.equal((await reconcile(h, on, ctx)).result.action, 'noop');
  const off = specOf({ new_code: { readOnly: false } });
  const cleared = await reconcile(h, off, ctx);
  assert.deepEqual([codes(cleared.result), cleared.result.action], [[], 'update'], 'an explicit false is a change, not a no-op');
  assert.equal((await layoutOf(h, 'sec_main')).at.new_code.readOnly, false);
  assert.deepEqual((await settled(off)).fieldOptions, { new_code: { readOnly: false } }, 'written as the spec states it');
  // Absent leaves the flag unconstrained: nothing is sent, but the recorded declaration follows the spec.
  const absent = specOf(undefined);
  const dropped = await reconcile(h, absent, ctx);
  assert.deepEqual(codes(dropped.result), [], JSON.stringify(dropped.result));
  assert.notEqual(dropped.result.action, 'noop', 'the recorded declaration still names fieldOptions');
  assert.deepEqual(dropped.writes, []);
  assert.equal('fieldOptions' in (await settled(absent)), false);
  assert.equal((await reconcile(h, absent, ctx)).result.action, 'noop');
});

// The managed wire with a row version per form: the SDK's optimistic concurrency reads an etag with every form it loads.
const etagged = (wire) => {
  let rev = 1;
  return { ...wire, request: async (req) => {
    const r = await wire.request(req);
    const m = String(req.method).toUpperCase();
    if (m === 'PATCH') rev += 1;
    if (m === 'GET' && /systemforms\(/i.test(req.url)) r.headers = { ...(r.headers || {}), etag: `W/"${rev}"` };
    return r;
  } };
};
// A published form of new_ticket on the wire: one section of one-field rows, its ids offset by `n`.
async function onWire(wire, id, name, n) {
  const h = createHarness({ formId: id, formName: name });
  harnesses.push(h);
  await seedForm(h, [tab([section('sec_main', 1, [{ cells: [cell(n + 1, 'new_name')] }], n + 50)], n + 900)], { name });
  wire.putForm({ ...h.store.row, formid: id }, { publishedToo: true });
}
const wireSpec = (name) => { const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name', 'new_code'] }], { name }); return spec; };
// One build invocation over the wire: a fresh barrier and store, the plugin's real client gated by that barrier.
async function wireRun(w, ctx, spec, id, { afterPush } = {}) {
  Object.assign(ctx, openRun(ctx.dir));
  const form = spec.forms[0];
  const { sdk } = await sdkOver(w, { barrier: ctx.barrier });
  if (afterPush) { const push = sdk.pushArtifact.bind(sdk); sdk.pushArtifact = async (...a) => { const r = await push(...a); afterPush(); return r; }; }
  let result;
  try {
    result = await flr.reconcileDeclaredForm({ form, spec, def: compileFormIntent(spec, form, INTENT), sdk, events: [], resolveExisting: async () => id }, { catalog: catalogOf(form), ...ctx });
  } catch (err) {
    result = { action: null, code: err.code || 'thrown', error: err };
  }
  return { result, sdk };
}
async function publishTable(ctx, sdk) {
  try { return await flr.publishDeclaredFormTable({ store: ctx.store, barrier: ctx.barrier, sdk, table: 'new_ticket' }); } catch (err) { return { code: err.code, hold: err.hold, error: err }; }
}

test('the publication a settled form owes is paid once per table by one plain PublishXml, also by a later run that changes nothing', async () => {
  const wire = createManagedWire();
  const w = etagged(wire);
  const A = guid(4100);
  await onWire(wire, A, 'Main', 0);
  const spec = wireSpec('Main');
  const ctx = ports({ authorizedAdoption: true });
  const first = await wireRun(w, ctx, spec, A);
  assert.deepEqual([codes(first.result), first.result.action], [[], 'update'], JSON.stringify(first.result));
  assert.equal(groupOf(ctx, spec.forms[0]).committed.publication.state, 'owed');
  assert.equal(wire.publishes().length, 0, 'reconcile never publishes');
  assert.doesNotMatch(wire.published.get(A).formxml, /new_code/);
  // The run ended before its publish. The next one changes nothing and still pays what the first owed.
  const retry = await wireRun(w, ctx, spec, A);
  assert.equal(retry.result.action, 'noop');
  const paid = await publishTable(ctx, retry.sdk);
  assert.equal(paid.sent, true, JSON.stringify(paid));
  assert.deepEqual(wire.publishes().map((e) => e.body.ParameterXml), ['<importexportxml><entities><entity>new_ticket</entity></entities></importexportxml>']);
  assert.match(wire.published.get(A).formxml, /new_code/);
  assert.equal(groupOf(ctx, spec.forms[0]).committed.publication.state, 'confirmed');
  const third = await wireRun(w, ctx, spec, A);
  assert.equal(third.result.action, 'noop');
  assert.equal((await publishTable(ctx, third.sdk)).sent, false);
  assert.equal(wire.publishes().length, 1, 'paid once');
});

test('a form left pending on the table holds the publish of a settled sibling: nothing goes live until the pending one is proved', async () => {
  const wire = createManagedWire();
  const w = etagged(wire);
  const A = guid(4100);
  const B = guid(4200);
  await onWire(wire, A, 'Main', 0);
  await onWire(wire, B, 'Other', 100);
  const ctx = ports({ authorizedAdoption: true });
  const a = await wireRun(w, ctx, wireSpec('Main'), A);
  assert.deepEqual([codes(a.result), a.result.action], [[], 'update'], JSON.stringify(a.result));
  // B's write is answered as saved, but the store keeps another field where the build put new_code.
  const b = await wireRun(w, ctx, wireSpec('Other'), B, { afterPush: () => { const row = wire.saved.get(B); row.formxml = row.formxml.replace(/datafieldname="new_code"/g, 'datafieldname="new_extra"'); } });
  assert.deepEqual(codes(b.result), ['form-layout-unproved'], JSON.stringify(b.result));
  assert.ok(groupOf(ctx, wireSpec('Other').forms[0]).pending, 'B stays pending');
  const held = await publishTable(ctx, b.sdk);
  assert.deepEqual([held.sent, held.withheld], [false, true], JSON.stringify(held));
  assert.equal(wire.publishes().length, 0, 'nothing is published while B is pending');
  // The next run still holds the table: A changes nothing, and its publish still sends nothing.
  const again = await wireRun(w, ctx, wireSpec('Main'), A);
  assert.equal(again.result.action, 'noop');
  assert.ok(ctx.debt.some((d) => d.key === flr.formLayoutKey(wireSpec('Other').forms[0])), JSON.stringify(ctx.debt));
  const still = await publishTable(ctx, again.sdk);
  assert.deepEqual([still.sent, still.withheld], [false, true], JSON.stringify(still));
  assert.equal(wire.publishes().length, 0);
  assert.doesNotMatch(wire.published.get(A).formxml, /new_code/, 'A\'s saved layer is not put live');
});
