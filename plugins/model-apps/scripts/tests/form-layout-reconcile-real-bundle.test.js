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
const { createManagedWire, sdkOver, clientOver, ORIGIN } = require('./helpers/managed-wire.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { createAttemptSendObserver } = require('../lib/managed-feature-contract.js');
const { compileFormIntent } = require('../lib/artifact-intent.js');
const { slotGrid, rowOccupancy } = require('../lib/form-occupancy.js');
const { openManagedContext, COMPLETION_BASE_BYTES, COMPLETION_MAX_BYTES } = require('../lib/managed-bindings.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { createIntentCatalog } = require('../lib/creates-catalog.js');
const flr = require('../lib/form-layout-reconcile.js');
const { systemFormLayerSha256 } = require('../lib/systemform-published.js');

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
// The build's halt factory as managedStop answers it (a coded, never-retry error it does not throw), and a membership
// that records what it was asked to include: both are required ports of reconcileDeclaredForm.
const haltFactory = (phase, label, code, { cause } = {}) => Object.assign(new Error(`${label} did not settle (${code})`), { code, phase, cause, retry: 'never' });
function ports(extra = {}) {
  const dir = makeTempDir('form-layout-');
  const members = [];
  return { dir, ...openRun(dir), halt: haltFactory, members, ensureMembership: async ({ root }) => { if (root) members.push(root.id); }, ...extra };
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
  // Approvals are typed by family: the bare key, or the same key under another family, approves nothing here.
  const key = flr.formLayoutKey(spec.forms[0]);
  for (const other of [new Set([key]), new Set([`view:${key}`])]) {
    ctx.authorizedAdoption = other;
    const untyped = await reconcile(h, spec, ctx);
    assert.deepEqual([codes(untyped.result), untyped.writes], [['form-layout-adoption-not-authorized'], []], [...other][0]);
  }
  ctx.authorizedAdoption = new Set([`form:${key}`]);
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
  ctx.authorizedOverwrite = new Set([key]);
  const untypedOverwrite = await reconcile(h, spec, ctx);
  assert.deepEqual([codes(untypedOverwrite.result), untypedOverwrite.writes], [['form-layout-drift'], []], 'an untyped key overwrites nothing');
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

test('a create whose answer is lost binds nothing and holds its table; the next run proves it from the stored proof, binds it only under the form adoption approval, and never sends it again', async () => {
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
  // Its answer never came back, so the store never saw the root acknowledged: a fresh read that proves the row is not
  // the maker's approval to manage it. Without the form adoption approval nothing is bound, nothing joins the solution,
  // and nothing is written — not even by a later run whose spec would edit it.
  const unapproved = await reconcile(lost.h, spec, ctx);
  assert.deepEqual(codes(unapproved.result), ['managed-adoption-required']);
  assert.deepEqual(unapproved.writes, []);
  assert.deepEqual(ctx.members, [], 'membership is not asked for an unapproved root');
  assert.equal(nothingSettled(ctx, form).token, pending.token, 'the attempt is kept under its token');
  const edited = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name', 'new_code'] }]);
  const later = await reconcile(lost.h, edited, ctx);
  assert.deepEqual(codes(later.result), ['managed-adoption-required']);
  assert.deepEqual(later.writes, [], 'no edit is sent to an unapproved root');
  assert.equal(nothingSettled(ctx, form).token, pending.token);
  // Only the form family's typed key approves: the bare key, or another family's approval of the same text, is none.
  for (const other of [new Set([flr.formLayoutKey(form)]), new Set([`view:${flr.formLayoutKey(form)}`])]) {
    ctx.authorizedAdoption = other;
    const untyped = await reconcile(lost.h, spec, ctx);
    assert.deepEqual([codes(untyped.result), untyped.writes, ctx.members], [['managed-adoption-required'], [], []], [...other][0]);
  }
  ctx.authorizedAdoption = new Set([`form:${flr.formLayoutKey(form)}`]);
  const recovered = await reconcile(lost.h, spec, ctx);
  assert.deepEqual(codes(recovered.result), [], JSON.stringify(recovered.result));
  assert.equal(recovered.result.action, 'recovered');
  assert.deepEqual(recovered.writes, [], 'proved, never sent again');
  assert.deepEqual(ctx.members, [lost.h.formId], 'membership follows the approval');
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
  // The debt names the saved layer exactly as the shared form reader (LAYER_READERS.form) hashes it, so the publish
  // below, which reads every covered group with its family's shared reader, can show it safe and confirm it.
  assert.equal(groupOf(ctx, spec.forms[0]).committed.publication.desiredSha256, systemFormLayerSha256(wire.saved.get(A)));
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

test('the publish of a declared form table answers the client\'s answer unchanged, and throws a failure it knows of with its cause kept, never as a definite no-start', async () => {
  // A settled form owes its table's publish. The publish request reaches the wire through the barrier's permit; the
  // client's answer to it is replaced by `answer` (a function of the real one), as an SDK answering otherwise would.
  const owed = async (answer) => {
    const wire = createManagedWire();
    const w = etagged(wire);
    const A = guid(4100);
    await onWire(wire, A, 'Main', 0);
    const spec = wireSpec('Main');
    const ctx = ports({ authorizedAdoption: true });
    const first = await wireRun(w, ctx, spec, A);
    assert.deepEqual([codes(first.result), first.result.action], [[], 'update'], JSON.stringify(first.result));
    // What the callback hands back to the shared publication, as the permit runs it.
    const returned = [];
    const permit = ctx.barrier.withSendPermit.bind(ctx.barrier);
    ctx.barrier.withSendPermit = (o, fn) => permit(o, async (...a) => { const r = await fn(...a); returned.push(r); return r; });
    const answers = [];
    const dv = first.sdk.dataverse;
    const post = dv.post.bind(dv);
    dv.post = async (url, ...rest) => {
      const real = await post(url, ...rest);
      const given = /PublishXml/.test(url) ? await answer(real) : real;
      answers.push(given);
      return given;
    };
    return { wire, ctx, spec, sdk: first.sdk, returned, answers };
  };


  // The SDK answers the publish as failed (sent, and it may still complete): the callback throws, keeping the SDK's
  // own error as the cause and claiming no definite no-start, so the debt is unconfirmed and the scope held.
  const sdkError = { code: 'CONNECTION_ERROR', message: 'the connection was reset' };
  const failed = await owed(() => ({ type: 'table', id: 'new_ticket', shipped: false, publish: { kind: 'failed', error: sdkError } }));
  const held = await publishTable(failed.ctx, failed.sdk);
  assert.deepEqual([held.code, held.hold], ['managed-publication-unconfirmed', true], JSON.stringify(held));
  const thrown = held.error.cause;
  assert.ok(thrown instanceof Error, 'the callback threw');
  assert.equal(thrown.definiteNoStart, undefined, 'a failed publish is never a definite no-start');
  assert.equal(thrown.cause, sdkError, 'the SDK\'s own error is kept as the cause');
  assert.equal(thrown.answer, failed.answers.at(-1), 'and the answer with it');
  assert.equal(failed.returned.length, 0, 'a failure is thrown, not returned');
  assert.equal(failed.wire.publishes().length, 1, 'the one request was sent');
  assert.ok(['dispatching', 'unconfirmed'].includes(groupOf(failed.ctx, failed.spec.forms[0]).committed.publication.state));
  // The refusal names its dispatch, the typed approval that would accept the risk and the remedy, as data.
  assert.ok(held.error.dispatchToken, 'a dispatch token');
  assert.equal(held.error.dispatchToken, groupOf(failed.ctx, failed.spec.forms[0]).committed.publication.dispatchToken);
  assert.equal(held.error.approval, 'publication-risk:table:new_ticket');
  assert.equal(typeof held.error.remedy, 'string');

  // The transport throws after the request went out (an answer that never came): the same, with that error as the cause.
  const lost = new Error('socket hang up');
  const dropped = await owed(() => { throw lost; });
  const unknown = await publishTable(dropped.ctx, dropped.sdk);
  assert.deepEqual([unknown.code, unknown.hold], ['managed-publication-unconfirmed', true], JSON.stringify(unknown));
  assert.equal(unknown.error.cause.cause, lost);
  assert.equal(unknown.error.cause.definiteNoStart, undefined);
  assert.equal(dropped.returned.length, 0);

  // A success: the client's answer is returned as it came, the same object, for the shared publication to judge.
  const ok = await owed((real) => real);
  const paid = await publishTable(ok.ctx, ok.sdk);
  assert.equal(paid.sent, true, JSON.stringify(paid));
  assert.equal(ok.returned.length, 1);
  assert.equal(ok.returned[0], ok.answers.at(-1), 'the answer is returned unchanged');
  assert.equal(groupOf(ok.ctx, ok.spec.forms[0]).committed.publication.state, 'confirmed');
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

test('a change over a publish of the form that may have been sent first confirms it read-only through the build\'s client; one that did not land stops the change before anything is sent', async () => {
  const spec = wireSpec('Main');
  const form = spec.forms[0];
  const A = guid(4100);
  const changed = wireSpec('Main');
  changed.forms[0].tabs[0].sections[0].fields = ['new_name', 'new_code', 'new_extra'];
  // A settled form owes its publish; the publish's answer is lost (503), so whether it put the layer live is unknown.
  const strand = async (unapplied) => {
    const wire = createManagedWire();
    const w = etagged(wire);
    await onWire(wire, A, 'Main', 0);
    const ctx = ports({ authorizedAdoption: true });
    const first = await wireRun(w, ctx, spec, A);
    assert.deepEqual([codes(first.result), first.result.action], [[], 'update'], JSON.stringify(first.result));
    wire.script((e) => /PublishXml/.test(e.path), { statusCode: 503, body: { error: { code: '0x80040216' } }, unapplied });
    assert.equal((await publishTable(ctx, first.sdk)).code, 'managed-publication-unconfirmed');
    const old = groupOf(ctx, form).committed;
    assert.ok(['dispatching', 'unconfirmed'].includes(old.publication.state), old.publication.state);
    return { wire, w, ctx, old };
  };

  // The publish landed: the next change confirms it by a fresh read, then makes its edit, which owes its own publish.
  const s = await strand(false);
  const next = await wireRun(s.w, s.ctx, changed, A);
  assert.deepEqual([codes(next.result), next.result.action], [[], 'update'], JSON.stringify(next.result));
  const now = groupOf(s.ctx, form).committed;
  assert.notEqual(now.generation, s.old.generation);
  assert.equal(now.publication.state, 'owed', 'the new generation keeps its own debt');
  assert.match(s.wire.saved.get(A).formxml, /new_extra/);
  assert.doesNotMatch(s.wire.published.get(A).formxml, /new_extra/, 'the old publish confirms only what it published');
  // The run opened with that publish uncertain, so its scope stays blocked for this run (openManagedContext); the next
  // invocation, which finds it confirmed, pays the new debt.
  const publishes = s.wire.publishes().length;
  const blocked = await publishTable(s.ctx, next.sdk);
  assert.deepEqual([blocked.sent, blocked.withheld], [false, true], JSON.stringify(blocked));
  const later = await wireRun(s.w, s.ctx, changed, A);
  assert.equal(later.result.action, 'noop');
  assert.equal((await publishTable(s.ctx, later.sdk)).sent, true);
  assert.equal(s.wire.publishes().length, publishes + 1);
  assert.match(s.wire.published.get(A).formxml, /new_extra/);

  // The publish did not land: the fresh read cannot confirm it, so the change stops before anything is prepared or sent.
  const u = await strand(true);
  const patches = u.wire.log.filter(isFormPatch).length;
  const stopped = await wireRun(u.w, u.ctx, changed, A);
  assert.deepEqual(codes(stopped.result), ['managed-publication-unconfirmed'], JSON.stringify(stopped.result));
  assert.equal(u.wire.log.filter(isFormPatch).length, patches, 'nothing sent');
  assert.deepEqual(groupOf(u.ctx, form), { committed: u.old, pending: null, effects: [] }, 'nothing prepared or committed');
  assert.doesNotMatch(u.wire.saved.get(A).formxml, /new_extra/);
});

// ---- Safety gates every path settles through: a dirty local copy, the required ports, the adoption approval. ----

// One build invocation over a GIVEN SDK (its workspace kept across calls), with the context's ports and `override`.
async function reconcileOver(h, spec, ctx, local, { newForm = false, beforePush, override = {} } = {}) {
  Object.assign(ctx, openRun(ctx.dir));
  const form = spec.forms[0];
  const writesBefore = h.writes.length;
  let result;
  try {
    result = await flr.reconcileDeclaredForm({ form, spec, def: compileFormIntent(spec, form, INTENT), sdk: local.sdk, beforePush,
      resolveExisting: async () => (newForm ? undefined : h.formId) }, { ...ctx, catalog: catalogOf(form), ...override });
  } catch (err) {
    result = { action: null, code: err.code || 'thrown', error: err };
  }
  return { result, writes: h.writes.slice(writesBefore) };
}
// sha256 of every file under a workspace folder: a local copy that was overwritten, deleted or re-fetched changes it.
function filesOf(dir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [k, v] of Object.entries(filesOf(full))) out[`${entry.name}/${k}`] = v;
    else out[entry.name] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  return out;
}

test('a pending attempt is never recovered over a local copy with unsent edits: two identical retries keep its bytes and its token', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const form = spec.forms[0];
  const ctx = ports({ authorizedAdoption: true });
  const h = createHarness({ formId: derivedFormId(form) });
  harnesses.push(h);
  const local = await h.freshSdk();
  answerLost(local.sdk);
  const first = await reconcileOver(h, spec, ctx, local, { newForm: true });
  assert.deepEqual(codes(first.result), ['form-layout-write-unknown']);
  const token = nothingSettled(ctx, form).token;
  // The failed write put its own copy back (a create's never-synced copy is removed), so what follows is the maker's:
  // the form, read from the service, then edited in the workspace and never sent. Recovery reads the form with a
  // fetch that overwrites the local copy, so it must refuse before that read, on every run.
  assert.deepEqual((await local.sdk.diffArtifact('form', h.formId)).changes, [], 'the build left no copy of its own');
  await local.sdk.fetchArtifact('form', h.formId, { overwrite: true });
  await local.sdk.updateElement('form', h.formId, '/tabs/0/label', 'UNSENT MAKER CAPTION');
  const before = filesOf(local.dir);
  for (let i = 0; i < 2; i += 1) {
    const reopened = await h.freshSdk(local.dir);
    const fetch = reopened.sdk.fetchArtifact.bind(reopened.sdk);
    const fetches = [];
    reopened.sdk.fetchArtifact = async (...a) => { fetches.push(a); return fetch(...a); };
    const run = await reconcileOver(h, spec, ctx, reopened);
    assert.deepEqual(codes(run.result), ['create-completion-required'], `retry ${i + 1}`);
    assert.equal(run.result.error.cause.category, 'workspace-copy-unsent-edits');
    assert.deepEqual(fetches, [], 'nothing was fetched over the copy');
    assert.deepEqual(run.writes, []);
    assert.deepEqual(filesOf(local.dir), before, 'the local copy is byte-identical');
    assert.equal((await reopened.sdk.getArtifact('form', h.formId)).tabs[0].label, 'UNSENT MAKER CAPTION');
    assert.equal(nothingSettled(ctx, form).token, token, 'the attempt keeps its token');
  }
  assert.deepEqual(ctx.members, [], 'nothing joined the solution');
});

test('an existing form whose local copy holds unsent edits refuses before anything is fetched over it or written', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const local = await h.freshSdk();
  await local.sdk.fetchArtifact('form', h.formId);
  await local.sdk.updateElement('form', h.formId, '/tabs/0/label', 'UNSENT EXISTING CAPTION');
  const before = filesOf(local.dir);
  const run = await reconcileOver(h, formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]), ports({ authorizedAdoption: true }), local);
  assert.deepEqual(codes(run.result), ['create-completion-required']);
  assert.deepEqual(run.writes, []);
  assert.deepEqual(filesOf(local.dir), before);
});

test('the halt factory and solution membership are required: a missing one stops before anything is created, read or written', async () => {
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  const form = spec.forms[0];
  for (const missing of ['halt', 'ensureMembership']) {
    const ctx = ports();
    const h = createHarness({ formId: derivedFormId(form) });
    harnesses.push(h);
    const local = await h.freshSdk();
    const readsBefore = h.reads.length;
    const run = await reconcileOver(h, spec, ctx, local, { newForm: true, override: { [missing]: undefined } });
    assert.deepEqual(codes(run.result), ['managed-not-settled'], missing);
    assert.match(run.result.error.message, new RegExp(missing));
    assert.deepEqual(run.writes, [], `${missing}: nothing written`);
    assert.equal(h.reads.length, readsBefore, `${missing}: nothing read`);
    assert.deepEqual(local.mutations, [], `${missing}: nothing created in the workspace`);
    assert.deepEqual([groupOf(ctx, form).committed, groupOf(ctx, form).pending], [null, null], `${missing}: nothing stored`);
  }
  // A halt factory that makes no error is itself a stop the build cannot see: refused as unsettled, not thrown as given.
  const bare = createHarness({ formId: derivedFormId(form) });
  harnesses.push(bare);
  const run = await reconcileOver(bare, spec, ports(), { sdk: null },
    { newForm: true, override: { store: null, halt: () => 'stop' } });
  assert.deepEqual(codes(run.result), ['managed-not-settled']);
});

test('a declared section renamed or exchanged under its recorded id is not planned into: refused before any re-baseline, nothing written', async () => {
  const spec = formSpec([{ name: 'sec_a', columns: 1, fields: ['new_name'] }, { name: 'sec_b', columns: 1, fields: ['new_code'] }]);
  const form = spec.forms[0];
  const ctx = ports();
  const made = await create(spec, ctx);
  assert.equal(made.result.action, 'create', JSON.stringify(made.result));
  const generation = groupOf(ctx, form).committed.generation;
  const original = made.h.store.row.formxml;
  // Only the names are exchanged; every id stands where it was.
  made.h.store.row.formxml = original.replace(/name="sec_a"/g, 'name="swap"').replace(/name="sec_b"/g, 'name="sec_a"').replace(/name="swap"/g, 'name="sec_b"');
  const swapped = await reconcile(made.h, spec, ctx);
  assert.deepEqual(codes(swapped.result), ['form-layout-container-moved'], JSON.stringify(swapped.result));
  assert.deepEqual(swapped.writes, []);
  assert.equal(groupOf(ctx, form).committed.generation, generation, 'no new baseline');
  // An override approval does not make a moved container the declared one either.
  ctx.authorizedOverwrite = true;
  assert.deepEqual(codes((await reconcile(made.h, spec, ctx)).result), ['form-layout-container-moved']);
  delete ctx.authorizedOverwrite;
  // A label is not part of the declared mapping: a maker's label edit on the same section is still settled.
  made.h.store.row.formxml = original;
  await makerEdit(made.h, (tabs) => { allSections({ tabs }).find((s) => s.name === 'sec_a').label = 'Renamed by maker'; });
  assert.notEqual(made.h.store.row.formxml, original, 'the fixture changed a section label');
  const relabelled = await reconcile(made.h, spec, ctx);
  assert.deepEqual(codes(relabelled.result), [], JSON.stringify(relabelled.result));
});

test('a tracked host section that now stands or is named otherwise refuses before the unchanged form is re-baselined', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }], { notes: true });
  const ctx = ports({ authorizedAdoption: true });
  const added = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(added.result), [], JSON.stringify(added.result));
  const form = spec.forms[0];
  assert.ok(groupOf(ctx, form).committed.consumerState.children['section:timeline'], 'the timeline host section is tracked');
  assert.equal((await reconcile(h, spec, ctx)).result.action, 'noop');
  const generation = groupOf(ctx, form).committed.generation;
  h.store.row.formxml = h.store.row.formxml.replace(/name="section_notes"/g, 'name="section_moved"');
  const moved = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(moved.result), ['form-layout-container-moved'], JSON.stringify(moved.result));
  assert.deepEqual(moved.writes, []);
  assert.equal(groupOf(ctx, form).committed.generation, generation);
});

test('a declared handler whose options changed is refused before anything is written; verify and download never certify options that were not stored', async () => {
  const event = { event: 'onload', library: 'new_/ticket.js', function: 'Ticket.onLoad', enabled: true, passExecutionContext: true, parameters: 'oldValue' };
  const spec = formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }]);
  spec.forms[0].events = [event];
  const ctx = ports();
  const made = await create(spec, ctx, { events: [event] });
  assert.equal(made.result.action, 'create', JSON.stringify(made.result));
  const changedEvent = { ...event, enabled: false, passExecutionContext: false, parameters: 'newValue' };
  const next = structuredClone(spec);
  next.forms[0].events = [changedEvent];
  const changed = await reconcile(made.h, next, ctx, { events: [changedEvent] });
  assert.deepEqual(codes(changed.result), ['form-handler-options-unsupported'], JSON.stringify(changed.result));
  assert.deepEqual(changed.writes, []);
  assert.match(made.h.store.row.formxml, /parameters="oldValue"/);
  const live = await storedForm(made.h);
  const group = groupOf(ctx, spec.forms[0]).committed;
  const intentTabs = compileFormIntent(next, next.forms[0], INTENT).tabs;
  assert.deepEqual(flr.verifyDeclaredForm({ form: next.forms[0], spec: next, intentTabs, events: [changedEvent], liveForm: live, group }).map((i) => i.code), ['form-event']);
  assert.deepEqual(flr.verifyDeclaredForm({ form: spec.forms[0], spec, intentTabs, events: [event], liveForm: live, group }).map((i) => i.code), [], 'the stored options verify');
  // What was stored is what download restores; a declaration naming options the form does not hold is stale.
  assert.deepEqual(flr.hydrateDeclaredForm(group, { formId: made.h.formId, liveForm: live }).form.events, [event]);
  const claimed = structuredClone(group);
  claimed.consumerState.declaration.events = [changedEvent];
  assert.match(flr.hydrateDeclaredForm(claimed, { formId: made.h.formId, liveForm: live }).stale, /Ticket\.onLoad/);
  // The same handler declared twice with different options is refused on a new form too.
  const twice = await create(formSpec([{ name: 'sec_main', columns: 1, fields: ['new_name'] }], { name: 'Twice' }), ports(), { events: [event, changedEvent] });
  assert.deepEqual(codes(twice.result), ['form-handler-options-unsupported']);
  assert.deepEqual(twice.writes, []);
});

// ---- Recovery under the attempt's own token: continued, resumed, or only proved. ----

// One build invocation over the wire whose transport carries the build's send observer (createAttemptSendObserver,
// inside the barrier's gate, as build-model-app.js installs it), over a workspace folder kept across runs as the
// CLI keeps its own. `observe: false` is a build without the observer.
// It answers which tokens the run sent under (markSending), the send window epoch each claim answered, and how many
// attempts it prepared: a continuation or a resumption sends under the stranded attempt's own token, in a new epoch,
// and prepares none. Every invocation is a fresh store, SDK and observer: a stopped run's are retired, as a build's are.
async function observedRun(w, ctx, spec, id, { workspace, beforePush, observe = true, override = {} } = {}) {
  Object.assign(ctx, openRun(ctx.dir));
  const sendTokens = [];
  const sendEpochs = [];
  const savedAcks = [];
  const savedReceipts = [];
  let prepared = 0;
  const { markSending, prepareAttempt, noteSaved } = ctx.store;
  ctx.store.markSending = (token, ...a) => {
    sendTokens.push(token);
    const marked = markSending.call(ctx.store, token, ...a);
    sendEpochs.push(marked ? marked.epoch : marked);
    return marked;
  };
  ctx.store.prepareAttempt = (...a) => { prepared += 1; return prepareAttempt.apply(ctx.store, a); };
  ctx.store.noteSaved = (token, o, ...a) => {
    savedAcks.push(o && o.acknowledgedRoot);
    savedReceipts.push(((o && o.acknowledgedChildCreates) || []).map((c) => c.key.slice(c.key.indexOf('#') + 1)).sort());
    return noteSaved.call(ctx.store, token, o, ...a);
  };
  const observer = observe ? createAttemptSendObserver() : null;
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(workspace), instanceUrl: ORIGIN, httpClient: clientOver(w, { barrier: ctx.barrier, observer }) });
  await sdk.initWorkspace();
  const form = spec.forms[0];
  let result;
  try {
    result = await flr.reconcileDeclaredForm({ form, spec, def: compileFormIntent(spec, form, INTENT), sdk, events: [], beforePush, resolveExisting: async () => id },
      { catalog: catalogOf(form), ...ctx, ...(observer ? { sendObserver: observer } : {}), ...override });
  } catch (err) {
    result = { action: null, code: err.code || 'thrown', error: err };
  }
  return { result, sdk, sendTokens, sendEpochs, prepared, savedAcks, savedReceipts };
}
const isFormPatch = (e) => e.method === 'PATCH' && /^systemforms\(/i.test(e.path);
const isFormCreate = (e) => e.method === 'POST' && /^systemforms$/i.test(e.path);
const refusedUnapplied = { statusCode: 400, body: { error: { code: '0x80040203', message: 'refused' } }, unapplied: true };
// A published form on the wire as onWire seeds it, plus a tab of the maker's the declaration does not name.
async function onWireWithMaker(wire, id) {
  const h = createHarness({ formId: id, formName: 'Main' });
  harnesses.push(h);
  await seedForm(h, [
    tab([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)], 900),
    { ...tab([section('sec_maker', 1, [{ cells: [cell(3, 'new_extra')] }], 60)], 901), name: 'tab_maker', label: 'Maker' },
  ], { name: 'Main' });
  wire.putForm({ ...h.store.row, formid: id }, { publishedToo: true });
}
// The bytes this build does not own: the maker's tab, and the header and footer the store keeps.
const makerBytes = (formxml) => [/<tab [^>]*name="tab_maker"[\s\S]*?<\/tab>/.exec(formxml)?.[0], /<header[\s\S]*<\/footer>/.exec(formxml)?.[0]];

test('an edit the service refused unapplied is continued by the next observed run under its own token: one more edit, then committed', async () => {
  const wire = createManagedWire();
  const w = etagged(wire);
  const A = guid(4100);
  await onWireWithMaker(wire, A);
  const maker = makerBytes(wire.saved.get(A).formxml);
  assert.ok(maker[0] && maker[1], 'the maker tab and the header and footer are on the wire');
  const spec = wireSpec('Main');
  const form = spec.forms[0];
  const ctx = ports({ authorizedAdoption: true });
  const workspace = makeTempDir('form-observed-');
  wire.script(isFormPatch, refusedUnapplied);
  const first = await observedRun(w, ctx, spec, A, { workspace });
  assert.ok(first.result.code, JSON.stringify(first.result));
  const stranded = nothingSettled(ctx, form);
  assert.deepEqual([stranded.phase, stranded.sendWindow, first.sendEpochs], ['sending', { possible: 0, notStarted: 1, epoch: 1 }, [1]]);
  assert.deepEqual((await first.sdk.diffArtifact('form', A)).changes, [], 'the refused edit was taken back out of the local copy');
  assert.doesNotMatch(wire.saved.get(A).formxml, /new_code/);
  assert.notDeepEqual(openRun(ctx.dir).debt.map((d) => d.kind), ['eligible'], 'the unsettled attempt holds its scope');
  const again = await observedRun(w, ctx, spec, A, { workspace });
  assert.deepEqual([codes(again.result), again.result.action, again.result.continued], [[], 'recovered', true], JSON.stringify(again.result));
  assert.deepEqual([again.sendTokens, again.sendEpochs, again.prepared], [[stranded.token], [2], 0], 'sent again under the stranded attempt\'s own token, claimed in a new epoch; no new attempt');
  assert.equal(wire.log.filter(isFormPatch).length, 2, 'the refused edit and its one continuation');
  assert.match(wire.saved.get(A).formxml, /new_code/);
  assert.deepEqual(makerBytes(wire.saved.get(A).formxml), maker, 'no maker byte was lost');
  assert.deepEqual([...wire.saved.keys()], [A], 'no second root');
  assert.equal(recordOf(ctx, form).origin, 'adopted', 'an existing form edited under its adoption approval is not recorded as created');
  const { committed, pending } = groupOf(ctx, form);
  assert.equal(pending, null);
  assert.equal(committed.publication.state, 'owed');
  assert.deepEqual(ctx.members, [A]);
  assert.deepEqual(openRun(ctx.dir).debt.map((d) => d.kind), ['eligible'], 'its hold ended: only its publication is owed');
  assert.equal((await observedRun(w, ctx, spec, A, { workspace })).result.action, 'noop');

  // A build that does not observe its sends cannot tell the refusal from a write that landed: it only proves, which
  // fails, and nothing is sent again; the attempt keeps its token.
  const plainWire = createManagedWire();
  const pw = etagged(plainWire);
  await onWire(plainWire, A, 'Main', 0);
  const pctx = ports({ authorizedAdoption: true });
  const pws = makeTempDir('form-observed-');
  plainWire.script(isFormPatch, refusedUnapplied);
  await observedRun(pw, pctx, spec, A, { workspace: pws });
  const token = nothingSettled(pctx, form).token;
  const proved = await observedRun(pw, pctx, spec, A, { workspace: pws, observe: false });
  assert.ok(proved.result.code, 'only proved, and the proof fails');
  assert.equal(plainWire.log.filter(isFormPatch).length, 1, 'never sent again');
  assert.equal(nothingSettled(pctx, form).token, token);

  // A maker edits the form between the refused edit and the next run: the replan is not the plan the attempt recorded
  // (another base), so nothing is sent over the maker's edit and the attempt keeps its token.
  const mWire = createManagedWire();
  const mw = etagged(mWire);
  await onWireWithMaker(mWire, A);
  const mctx = ports({ authorizedAdoption: true });
  const mws = makeTempDir('form-observed-');
  mWire.script(isFormPatch, refusedUnapplied);
  await observedRun(mw, mctx, spec, A, { workspace: mws });
  const mToken = nothingSettled(mctx, form).token;
  const edited = mWire.saved.get(A).formxml.replace('description="Maker"', 'description="Maker, renamed"');
  assert.notEqual(edited, mWire.saved.get(A).formxml);
  mWire.saved.set(A, { ...mWire.saved.get(A), formxml: edited });
  const stopped = await observedRun(mw, mctx, spec, A, { workspace: mws });
  assert.deepEqual([codes(stopped.result), stopped.sendTokens], [['create-completion-required'], []], JSON.stringify(stopped.result));
  assert.equal(mWire.log.filter(isFormPatch).length, 1, 'nothing sent over the maker edit');
  assert.equal(mWire.saved.get(A).formxml, edited, 'the maker edit is kept');
  assert.equal(nothingSettled(mctx, form).token, mToken);
});

test('a create whose local edits failed before any request is continued under its id; a changed declaration is not sent under the old token', async () => {
  const spec = wireSpec('Main');
  const form = spec.forms[0];
  const id = derivedFormId(form);
  const localFailure = async () => { throw Object.assign(new Error('the local copy could not be edited'), { code: 'LOCAL_EDIT_FAILED' }); };
  const strand = async () => {
    const wire = createManagedWire();
    const ctx = ports();
    const workspace = makeTempDir('form-observed-');
    const first = await observedRun(wire, ctx, spec, undefined, { workspace, beforePush: localFailure });
    assert.deepEqual(codes(first.result), ['LOCAL_EDIT_FAILED']);
    assert.deepEqual(wire.writes(), [], 'nothing reached the service');
    const pending = nothingSettled(ctx, form);
    assert.deepEqual([pending.phase, pending.sendWindow, pending.root.id, first.sendEpochs], ['sending', { possible: 0, notStarted: 0, epoch: 1 }, id, [1]]);
    assert.deepEqual((await first.sdk.diffArtifact('form', id)).changes, [], 'the never-sent copy was removed');
    return { wire, ctx, workspace, token: pending.token };
  };

  const s = await strand();
  const again = await observedRun(s.wire, s.ctx, spec, undefined, { workspace: s.workspace });
  assert.deepEqual([codes(again.result), again.result.action, again.result.continued, again.result.formId], [[], 'recovered', true, id], JSON.stringify(again.result));
  assert.equal(s.wire.log.filter(isFormCreate).length, 1, 'one create');
  assert.deepEqual([...s.wire.saved.keys()], [id]);
  assert.equal(recordOf(s.ctx, form).origin, 'created', 'this run\'s own create answer acknowledged it: no adoption approval needed');
  assert.deepEqual(s.ctx.members, [id]);
  assert.deepEqual([again.sendTokens, again.sendEpochs, again.prepared, again.savedAcks], [[s.token], [2], 0, [true]], 'sent under the stranded attempt\'s own token, claimed in a new epoch; no new attempt; its own create answer acknowledged the root');
  assert.equal(groupOf(s.ctx, form).pending, null);

  // A build without the observer cannot prove from the window that nothing left; the root reads absent in both
  // layers, so the same create is resumed under the same token instead.
  const r = await strand();
  const resumed = await observedRun(r.wire, r.ctx, spec, undefined, { workspace: r.workspace, observe: false });
  assert.deepEqual([codes(resumed.result), resumed.result.action, resumed.result.resumed, resumed.sendTokens, resumed.sendEpochs, resumed.prepared], [[], 'recovered', true, [r.token], [2], 0], JSON.stringify(resumed.result));
  assert.deepEqual([r.wire.log.filter(isFormCreate).length, [...r.wire.saved.keys()]], [1, [id]], 'one create, one root');
  assert.equal(recordOf(r.ctx, form).origin, 'created');
  // The spec changed since: the plan is not the one the attempt recorded, so nothing is sent and the attempt is kept.
  const c = await strand();
  const changed = wireSpec('Main');
  changed.forms[0].tabs[0].sections[0].fields = ['new_name'];
  const refused = await observedRun(c.wire, c.ctx, changed, undefined, { workspace: c.workspace });
  assert.deepEqual(codes(refused.result), ['create-completion-required'], JSON.stringify(refused.result));
  assert.deepEqual(c.wire.writes(), []);
  assert.equal(nothingSettled(c.ctx, form).token, c.token, 'the attempt keeps its token');
  assert.deepEqual(c.ctx.members, []);
});

test('a create whose answer never came is sent again under its id when its row reads absent; a row that is there needs the form adoption approval', async () => {
  const spec = wireSpec('Main');
  const form = spec.forms[0];
  const id = derivedFormId(form);
  const strand = async (unapplied) => {
    const wire = createManagedWire();
    const ctx = ports();
    const workspace = makeTempDir('form-observed-');
    // The connection drops after the create went out, and again on the client's own retries of it, so the service
    // may or may not hold the row. The answers are armed for this run only.
    const armed = { on: true };
    wire.script((e) => armed.on && isFormCreate(e), { error: 'ECONNRESET', unapplied });
    for (let i = 0; i < 5; i += 1) wire.script((e) => armed.on && isFormCreate(e), { error: 'ECONNRESET', unapplied: true });
    const first = await observedRun(wire, ctx, spec, undefined, { workspace });
    armed.on = false;
    assert.deepEqual(codes(first.result), ['form-layout-write-unknown'], JSON.stringify(first.result));
    const { sendWindow } = nothingSettled(ctx, form);
    assert.ok(sendWindow.possible >= 1 && sendWindow.notStarted === 0, `the create may have landed: ${JSON.stringify(sendWindow)}`);
    return { wire, ctx, workspace, creates: wire.log.filter(isFormCreate).length, token: nothingSettled(ctx, form).token };
  };

  const absent = await strand(true);
  assert.equal(absent.wire.saved.size, 0);
  const resumed = await observedRun(absent.wire, absent.ctx, spec, undefined, { workspace: absent.workspace, observe: false });
  assert.deepEqual([codes(resumed.result), resumed.result.action, resumed.result.resumed], [[], 'recovered', true], JSON.stringify(resumed.result));
  assert.deepEqual([resumed.sendTokens, resumed.sendEpochs, resumed.prepared, resumed.savedAcks], [[absent.token], [2], 0, [true]], 'resumed under the attempt\'s own token; its own create answer acknowledged the root');
  assert.equal(absent.wire.log.filter(isFormCreate).length, absent.creates + 1, 'the same create, sent once more');
  assert.deepEqual([...absent.wire.saved.keys()], [id]);
  assert.equal(recordOf(absent.ctx, form).origin, 'created');

  // It landed: the presence read finds it, so it is proved, never sent again, and bound only under form:<key>.
  const present = await strand(false);
  const unapproved = await observedRun(present.wire, present.ctx, spec, undefined, { workspace: present.workspace });
  assert.deepEqual(codes(unapproved.result), ['managed-adoption-required'], JSON.stringify(unapproved.result));
  assert.match(unapproved.result.error.cause.message, new RegExp(`form:${flr.formLayoutKey(form)}`));
  assert.deepEqual(present.ctx.members, []);
  present.ctx.authorizedAdoption = new Set([`form:${flr.formLayoutKey(form)}`]);
  const adopted = await observedRun(present.wire, present.ctx, spec, undefined, { workspace: present.workspace });
  assert.deepEqual([codes(adopted.result), adopted.result.action, adopted.result.resumed], [[], 'recovered', undefined], JSON.stringify(adopted.result));
  assert.equal(present.wire.log.filter(isFormCreate).length, present.creates, 'never sent again');
  assert.deepEqual([adopted.sendTokens, adopted.prepared, adopted.savedAcks, [...present.wire.saved.keys()]], [[], 0, [], [id]], 'proved, not sent; one root');
  assert.equal(recordOf(present.ctx, form).origin, 'adopted');
});

test('a new form is never created over a local copy with edits the service has not seen under its id', async () => {
  const spec = wireSpec('Main');
  const form = spec.forms[0];
  const id = derivedFormId(form);
  const wire = createManagedWire();
  const workspace = makeTempDir('form-observed-');
  const maker = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(workspace), instanceUrl: ORIGIN, httpClient: clientOver(wire) });
  await maker.initWorkspace();
  await maker.createArtifact('form', { id, name: 'Main', entityLogicalName: 'new_ticket', formType: 'Main' });
  const before = filesOf(workspace);
  const ctx = ports();
  const run = await observedRun(wire, ctx, spec, undefined, { workspace });
  assert.deepEqual(codes(run.result), ['create-completion-required'], JSON.stringify(run.result));
  assert.equal(run.result.error.cause.category, 'workspace-copy-unsent-edits');
  assert.deepEqual(wire.writes(), []);
  assert.deepEqual(filesOf(workspace), before, 'the copy is kept');
});

// ---- What a write's own answer acknowledges: the root only for this run's own create; cells an edit adds by receipt. ----

test('an existing form at the catalog id, edited under its adoption approval, stays adopted: an edit answer is no root create', async () => {
  const wire = createManagedWire();
  const w = etagged(wire);
  const spec = wireSpec('Main');
  const form = spec.forms[0];
  const id = derivedFormId(form);
  await onWireWithMaker(wire, id);
  const ctx = ports({ authorizedAdoption: new Set([`form:${flr.formLayoutKey(form)}`]) });
  const run = await observedRun(w, ctx, spec, id, { workspace: makeTempDir('form-observed-') });
  assert.deepEqual([codes(run.result), run.result.action], [[], 'update'], JSON.stringify(run.result));
  assert.equal(wire.log.filter(isFormCreate).length, 0, 'nothing was created');
  assert.deepEqual([run.savedAcks, run.savedReceipts], [[false], [['cell:new_code', 'control:new_code']]], 'the edit answer acknowledges only the cell it added');
  assert.equal(recordOf(ctx, form).origin, 'adopted', 'the root was there before this run: adopted, whatever its id');
  assert.deepEqual(['cell:new_code', 'control:new_code', 'cell:new_name', 'section:tab_main/sec_main'].map((k) => recordOf(ctx, form, k).origin), ['created', 'created', 'adopted', 'adopted']);
});

test('an approved adopted form with cells added commits the root adopted and the added cells created; a later recovery needs the approval again', async () => {
  const spec = wireSpec('Main');
  const form = spec.forms[0];
  const typed = () => new Set([`form:${flr.formLayoutKey(form)}`]);
  const id = guid(4514);
  const strand = async () => {
    const wire = createManagedWire();
    const w = etagged(wire);
    await onWireWithMaker(wire, id);
    const ctx = ports({ authorizedAdoption: typed() });
    const workspace = makeTempDir('form-observed-');
    const memberBlocked = async () => { throw Object.assign(new Error('membership failed'), { code: 'MEMBER_BLOCKED' }); };
    const first = await observedRun(w, ctx, spec, id, { workspace, override: { ensureMembership: memberBlocked } });
    assert.deepEqual(codes(first.result), ['MEMBER_BLOCKED'], JSON.stringify(first.result));
    assert.deepEqual([first.savedAcks, first.savedReceipts], [[false], [['cell:new_code', 'control:new_code']]], 'the edit acknowledged the cell it added, never the root');
    const stranded = nothingSettled(ctx, form);
    assert.notEqual(stranded.acknowledgedRoot, true, 'no root create is recorded for an edit');
    assert.deepEqual(stranded.acknowledgedChildCreates.map((c) => c.key.slice(c.key.indexOf('#') + 1)).sort(), ['cell:new_code', 'control:new_code'], 'its receipt names only the cell it added');
    return { wire, w, ctx, workspace, token: stranded.token, patches: wire.log.filter(isFormPatch).length };
  };

  // Without the adoption approval now, the edit's answer does not bind the root: nothing is sent, nothing bound.
  const s = await strand();
  s.ctx.authorizedAdoption = new Set();
  const refused = await observedRun(s.w, s.ctx, spec, id, { workspace: s.workspace });
  assert.deepEqual(codes(refused.result), ['managed-adoption-required'], JSON.stringify(refused.result));
  assert.deepEqual([refused.sendTokens, s.wire.log.filter(isFormPatch).length], [[], s.patches], 'nothing sent again');
  assert.equal(nothingSettled(s.ctx, form).token, s.token, 'the attempt is kept');
  assert.deepEqual(s.ctx.members, []);
  // With it again, the same attempt is proved and committed from its own receipt: root adopted, added cells created.
  s.ctx.authorizedAdoption = typed();
  const settled = await observedRun(s.w, s.ctx, spec, id, { workspace: s.workspace });
  assert.deepEqual([codes(settled.result), settled.result.action, settled.sendTokens], [[], 'recovered', []], JSON.stringify(settled.result));
  assert.equal(recordOf(s.ctx, form).origin, 'adopted');
  assert.deepEqual(['cell:new_code', 'control:new_code', 'cell:new_name'].map((k) => recordOf(s.ctx, form, k).origin), ['created', 'created', 'adopted']);
  assert.equal(recordOf(s.ctx, form, 'cell:new_extra'), null, 'the maker\'s cell is not the build\'s');
  assert.deepEqual(s.ctx.members, [id]);
});

// ---- The original declaration: what the attempt was planned from is what its commit records. ----

test('a form commits the declaration its attempt was planned from; a recovery under a changed spec commits the original one, not today\'s', async () => {
  const spec = wireSpec('Main');
  const form = spec.forms[0];
  const { prune, ...declared } = form;
  assert.equal(prune, false);
  const wire = createManagedWire();
  const ctx = ports();
  const run = await observedRun(wire, ctx, spec, undefined, { workspace: makeTempDir('form-observed-') });
  assert.deepEqual(codes(run.result), [], JSON.stringify(run.result));
  const made = groupOf(ctx, form).committed;
  assert.deepEqual([made.originalDeclaration, made.consumerState.declaration], [declared, declared], 'the authored form, kept as written');

  // A create whose answer never came, and whose row landed: the next run, under a spec changed since, proves it from
  // the attempt's own expected proof, so the declaration that proof was built from is what is committed.
  const lost = createManagedWire();
  const lw = etagged(lost);
  const lctx = ports();
  const workspace = makeTempDir('form-observed-');
  const armed = { on: true };
  lost.script((e) => armed.on && isFormCreate(e), { error: 'ECONNRESET', unapplied: false });
  for (let i = 0; i < 5; i += 1) lost.script((e) => armed.on && isFormCreate(e), { error: 'ECONNRESET', unapplied: true });
  const first = await observedRun(lw, lctx, spec, undefined, { workspace });
  armed.on = false;
  assert.deepEqual(codes(first.result), ['form-layout-write-unknown'], JSON.stringify(first.result));
  assert.deepEqual(nothingSettled(lctx, form).declaration, declared, 'the attempt recorded the authored declaration before anything was sent');
  const changed = { ...spec, forms: [{ ...form, fieldOptions: { new_code: { readOnly: true } } }] };
  lctx.authorizedAdoption = new Set([`form:${flr.formLayoutKey(form)}`]);
  const recovered = await observedRun(lw, lctx, changed, undefined, { workspace });
  assert.deepEqual([codes(recovered.result), recovered.result.action, recovered.sendTokens], [[], 'recovered', []], JSON.stringify(recovered.result));
  const settled = groupOf(lctx, form).committed;
  assert.deepEqual([settled.originalDeclaration, settled.consumerState.declaration], [declared, declared], 'the original declaration, not null and not today\'s');
  assert.equal((await publishTable(lctx, recovered.sdk)).sent, true, 'its owed publication is paid');
  // Today's spec differs from what was proved, so the next run plans its change rather than a no-op.
  const next = await observedRun(lw, lctx, changed, undefined, { workspace });
  assert.deepEqual([codes(next.result), next.result.action], [[], 'update'], JSON.stringify(next.result));
  assert.deepEqual(groupOf(lctx, form).committed.consumerState.declaration, (({ prune: _p, ...d }) => d)(changed.forms[0]));
});
// ---- The completion reservation: a large form's commit fits in what its attempt reserved. ----

test('a large declared form reserves, when its attempt is prepared, room for everything its completion commits: records, proof, consumer state and original declaration', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  // 48 sections of 16 fields: 768 field cells, 816 children with their sections and tab.
  const sections = [{ name: 'sec_main', columns: 1, fields: ['new_name'] }];
  const columns = [];
  for (let s = 0; s < 48; s += 1) {
    const fields = Array.from({ length: 16 }, (_, f) => `new_field_${String(s).padStart(2, '0')}_${String(f).padStart(2, '0')}`);
    for (const f of fields) columns.push({ schemaName: f, displayName: f, type: 'Text' });
    sections.push({ name: `sec_${s}`, columns: 2, fields });
  }
  const spec = formSpec(sections);
  spec.entities[0].columns.push(...columns);
  const form = spec.forms[0];
  const ctx = ports({ authorizedAdoption: true });
  // The reservation as the store holds it on the attempt, read just before its commit (membership comes after the proof),
  // and the store file's size then and after the commit.
  const fs = require('node:fs');
  const path = require('node:path');
  const storeFile = () => {
    const found = fs.readdirSync(ctx.dir, { recursive: true }).map((f) => path.join(ctx.dir, String(f)))
      .filter((f) => f.endsWith('.json') && fs.statSync(f).isFile())
      .filter((f) => { try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(d.groups) && Array.isArray(d.attempts); } catch { return false; } });
    assert.equal(found.length, 1, 'one store file');
    return found[0];
  };
  let reserve = null;
  let beforeCommit = 0;
  ctx.ensureMembership = async () => {
    const { pending } = ctx.store.readGroup(flr.FAMILY, flr.formLayoutKey(form));
    if (pending) { reserve = { ...pending.completionReserve }; beforeCommit = fs.statSync(storeFile()).size; }
  };
  const run = await reconcile(h, spec, ctx);
  assert.deepEqual([codes(run.result), run.result.action], [[], 'update'], JSON.stringify(run.result));
  const g = groupOf(ctx, form).committed;
  assert.ok(g && reserve, 'committed, from a reserved attempt');
  assert.ok(g.records.length > 800, String(g.records.length));
  // The completion as the store file holds it: indented two spaces, its fields four deeper than standalone
  // (data → groups → [i] → field).
  const inFile = (v) => { const text = JSON.stringify(v, null, 2); return Buffer.byteLength(text, 'utf8') + text.split('\n').length * 4; };
  const completion = inFile({ records: g.records, proof: g.proof, consumerState: g.consumerState, originalDeclaration: g.originalDeclaration });
  assert.ok(completion > COMPLETION_BASE_BYTES + inFile(g.originalDeclaration), `a completion beyond the store's default reservation (${completion})`);
  assert.ok(reserve.bytes >= completion, `reserved ${reserve.bytes} bytes for a completion of ${completion}`);
  assert.ok(reserve.bytes < COMPLETION_MAX_BYTES, `sized to the form, not the cap (${reserve.bytes})`);
  assert.ok(reserve.used < reserve.bytes, `the writes after the send stayed within it (${reserve.used} of ${reserve.bytes})`);
  // What the store charges the attempt from its send to its commit: its writes after the send (noteSaved's proof and
  // child-create receipt), then the commit's own growth, which the reservation held free until that moment.
  const charged = reserve.used + Math.max(0, fs.statSync(storeFile()).size - beforeCommit);
  assert.ok(charged <= reserve.bytes, `charged ${charged} of ${reserve.bytes}`);
});

test('a declared form whose completion could outgrow the most one attempt may reserve is refused before anything is prepared or sent', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }], 50)]);
  const sections = [{ name: 'sec_main', columns: 1, fields: ['new_name'] }];
  const columns = [];
  for (let s = 0; s < 64; s += 1) {
    const fields = Array.from({ length: 64 }, (_, f) => `new_f${String(s).padStart(2, '0')}_${String(f).padStart(2, '0')}`);
    for (const f of fields) columns.push({ schemaName: f, displayName: f, type: 'Text' });
    sections.push({ name: `sec_${s}`, columns: 2, fields });
  }
  const spec = formSpec(sections);
  spec.entities[0].columns.push(...columns);
  const ctx = ports({ authorizedAdoption: true });
  const run = await reconcile(h, spec, ctx);
  assert.deepEqual(codes(run.result), ['managed-binding-store-full'], JSON.stringify(run.result && run.result.code));
  assert.match(run.result.error.cause.message, /nothing was sent/);
  assert.deepEqual(run.writes, [], 'nothing sent');
  assert.deepEqual(groupOf(ctx, spec.forms[0]), { committed: null, pending: null, effects: [] }, 'nothing prepared');
});
