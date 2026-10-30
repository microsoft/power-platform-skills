'use strict';
// Declared form layout through the REAL vendored SDK over a stored systemform: declared fields are packed
// in order around a maker's controls, which keep their exact slots; existing cells keep their ids; a free
// slot a later cell must skip is a spacer; an unchanged layout sends nothing; and every refusal writes
// nothing. The column-slot model (form-occupancy slotGrid) is pinned directly where the shape matters.
const test = require('node:test');
const assert = require('node:assert/strict');
const { guid, createHarness, seedForm } = require('./helpers/form-store-harness.js');
const { fakeManaged, fakePublication, fakeCreates } = require('./helpers/feature-ports.js');
const { compileFormIntent } = require('../lib/artifact-intent.js');
const { slotGrid, rowOccupancy } = require('../lib/form-occupancy.js');
const { packDeclaredLayout, planDeclaredFormLayout, applyDeclaredFormLayout, declaredLayoutOf } = require('../lib/form-layout-reconcile.js');

const harnesses = [];
test.after(() => { for (const h of harnesses) h.cleanup(); });

const cell = (n, field, extra = {}) => ({ id: guid(n), control: { id: `ctl_${field}`, fieldName: field, ...(extra.control || {}) }, ...extra.cell });
const section = (name, columns, rows) => ({ name, label: name, columns, visible: true, showLabel: true, rows });
const tab = (sections) => ({ name: 'tab_main', label: 'Overview', visible: true, expanded: true, columns: [{ width: '100%', sections }] });

function formSpec(fields, { reconcile = 'declared', columns = 2, fieldOptions } = {}) {
  const form = { entity: 'new_ticket', name: 'Main', formType: 'Main', layout: 'explicit', prune: false, notes: false,
    tabs: [{ name: 'tab_main', label: 'Overview', sections: [{ name: 'sec_main', label: 'Basics', columns, fields }] }] };
  if (reconcile) form.reconcile = reconcile;
  if (fieldOptions) form.fieldOptions = fieldOptions;
  return {
    solution: { uniqueName: 'FormProbe', displayName: 'Form Probe', publisherPrefix: 'new' },
    app: { name: 'Form Probe', uniqueName: 'new_formprobe' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [
      { schemaName: 'new_code', displayName: 'Code', type: 'Text' }, { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' },
      { schemaName: 'new_area', displayName: 'Area', type: 'Text' }, { schemaName: 'new_extra', displayName: 'Extra', type: 'Text' },
    ] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
    forms: [form],
  };
}

async function deployed(sections) {
  const h = createHarness();
  harnesses.push(h);
  await seedForm(h, [tab(sections)]);
  return h;
}

// The stored layout of a section, read back through a fresh SDK: each row as the fields it holds in
// order ('.' for a spacer), plus each field's slot and cell id.
async function layoutOf(h, name) {
  const { sdk } = await h.freshSdk();
  await sdk.fetchArtifact('form', h.formId);
  const form = await sdk.getArtifact('form', h.formId);
  const s = form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections)).find((x) => x.name === name);
  const g = slotGrid(s.rows, s.columns);
  const at = {};
  for (const p of g.placed) {
    const c = s.rows[p.row].cells[p.cell];
    if (c.control && c.control.fieldName) at[c.control.fieldName] = { r: p.r, c: p.c, id: c.id, readOnly: c.control.isReadOnly === true, hidden: c.visible === false };
  }
  return { rows: s.rows.map((row) => (row.cells || []).map((c) => (c.control ? c.control.fieldName : '.'))), at, overflow: g.overflow };
}

// `ctx.creates` defaults to a faithful double of the creation-identity port; a test that needs no port
// passes `creates: null`.
async function reconcile(h, spec, ctx = {}, extra = {}) {
  ctx = { creates: fakeCreates(), ...ctx };
  const { sdk, mutations } = await h.freshSdk();
  const writesBefore = h.writes.length;
  const plan = await planDeclaredFormLayout({ form: spec.forms[0], formId: h.formId, intentTabs: compileFormIntent(spec, spec.forms[0]).tabs, sdk, ...extra }, ctx);
  const result = await applyDeclaredFormLayout(plan, { sdk }, ctx);
  return { plan, result, mutations, writes: h.writes.slice(writesBefore) };
}

test('slot model: a cell beside a row-spanning cell sits in the column the span leaves free, not under it', () => {
  const g = slotGrid([{ cells: [{ rowspan: 2 }, {}] }, { cells: [{}] }], 2);
  assert.deepEqual(g.placed.map((p) => [p.r, p.c]), [[0, 0], [0, 1], [1, 1]]);
  assert.deepEqual(rowOccupancy([{ cells: [{ rowspan: 2 }, {}] }, { cells: [{}] }]).map((o) => o.used), [2, 2], 'the width-only model is unchanged');
  assert.deepEqual(slotGrid([{ cells: [{ colspan: 2 }] }], 1).overflow, [{ row: 0, cell: 0 }]);
});

test('declared fields pack in order around a maker field that keeps its slot; existing cells keep their ids; a re-run sends nothing', async () => {
  const h = await deployed([section('sec_main', 2, [
    { cells: [cell(1, 'new_name'), cell(2, 'new_extra')] },
    { cells: [cell(3, 'new_code')] },
  ])]);
  const spec = formSpec(['new_code', 'new_name', 'new_area']);
  const managed = fakeManaged();
  const publication = fakePublication();
  const { result } = await reconcile(h, spec, { authorizedAdoption: true, managed, publication });
  assert.deepEqual(result.saved.map((s) => s.kind), ['form-layout'], JSON.stringify(result));
  assert.equal(publication.queued.length, 1);
  const after = await layoutOf(h, 'sec_main');
  assert.deepEqual(after.rows, [['new_code', 'new_extra'], ['new_name', 'new_area']]);
  assert.deepEqual([after.at.new_extra.r, after.at.new_extra.c, after.at.new_extra.id], [0, 1, guid(2)], 'the maker field did not move');
  assert.equal(after.at.new_name.id, guid(1));
  assert.equal(after.at.new_code.id, guid(3));
  managed.persist(result.managedBindings);

  const again = await reconcile(h, spec, { managed, publication: fakePublication() });
  assert.equal(again.plan.action, 'noChange');
  assert.equal(again.writes.length, 0, 'no push and no publish');
  assert.deepEqual(again.mutations, []);
});

test('a free slot before a maker field is held by a spacer, and a row-spanning maker field in the middle keeps the declared cells around it', async () => {
  const h = await deployed([section('sec_main', 2, [
    { cells: [cell(1, 'new_code'), cell(2, 'new_extra', { cell: { rowspan: 2 } })] },
    { cells: [cell(3, 'new_name')] },
  ])]);
  const spec = formSpec([{ name: 'new_name', colspan: 2 }, 'new_code']);
  const managed = fakeManaged();
  const { result } = await reconcile(h, spec, { authorizedAdoption: true, managed });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  managed.persist(result.managedBindings);
  const after = await layoutOf(h, 'sec_main');
  // new_name needs both columns, which only row 2 has; the maker's span still covers column 1 of rows 0-1.
  assert.deepEqual(after.rows, [['.', 'new_extra'], [], ['new_name'], ['new_code']]);
  assert.deepEqual([after.at.new_extra.r, after.at.new_extra.c], [0, 1]);
  assert.deepEqual([after.at.new_name.r, after.at.new_name.c], [2, 0]);
  assert.deepEqual([after.at.new_code.r, after.at.new_code.c], [3, 0]);
  assert.deepEqual(after.overflow, []);
  // The stored spacer reads back as the same cell, so a re-run sees no change.
  const again = await reconcile(h, spec, { managed });
  assert.equal(again.plan.action, 'noChange');
  assert.equal(again.writes.length, 0);
});

test('a field declared in this section but held in a maker section moves in one mutation; the maker section keeps its other control in place', async () => {
  const h = await deployed([
    section('sec_main', 2, [{ cells: [cell(1, 'new_name')] }]),
    section('maker_section', 2, [{ cells: [cell(2, 'new_code'), cell(3, 'new_extra')] }]),
  ]);
  const { result, mutations } = await reconcile(h, formSpec(['new_name', 'new_code']), { authorizedAdoption: true });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  assert.deepEqual(mutations.map((m) => [m.method, m.args[2]]), [['updateElement', '/tabs']]);
  assert.deepEqual((await layoutOf(h, 'sec_main')).rows, [['new_name', 'new_code']]);
  const maker = await layoutOf(h, 'maker_section');
  assert.deepEqual(maker.rows, [['.', 'new_extra']], 'a spacer keeps the maker field in column 1');
  assert.equal((await layoutOf(h, 'sec_main')).at.new_code.id, guid(2));
});

test('an explicit false clears the flag on a declared field only; a maker field keeps its own; an omitted flag is left as it is', async () => {
  const h = await deployed([section('sec_main', 2, [
    { cells: [cell(1, 'new_name', { control: { isReadOnly: true } }), cell(2, 'new_extra', { control: { isReadOnly: true }, cell: { visible: false } })] },
    { cells: [cell(3, 'new_code', { cell: { visible: false } })] },
  ])]);
  const { result } = await reconcile(h, formSpec([{ name: 'new_name', readOnly: false }, 'new_code']), { authorizedAdoption: true });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  const after = await layoutOf(h, 'sec_main');
  assert.equal(after.at.new_name.readOnly, false);
  assert.equal(after.at.new_code.hidden, true, 'hidden was not declared, so the maker choice stays');
  assert.deepEqual([after.at.new_extra.readOnly, after.at.new_extra.hidden], [true, true]);
});

test('a maker field wider than the declared section width is refused, and nothing is written', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_extra', { cell: { colspan: 2 } })] }, { cells: [cell(2, 'new_name')] }])]);
  const { result, writes } = await reconcile(h, formSpec(['new_name'], { columns: 1 }), { authorizedAdoption: true });
  assert.deepEqual(result.refused.map((r) => r.code), ['form-layout-obstacle-unplaceable']);
  assert.equal(writes.length, 0);
});

test('an unmanaged form needs adoption approval, a moved declared field is drift until the overwrite is approved, and both write nothing', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_code')] }])]);
  const spec = formSpec(['new_code', 'new_name']);
  // A declared layout that already matches is not a refusal, and is not bound without approval either.
  const same = await reconcile(h, formSpec(['new_name', 'new_code']));
  assert.deepEqual([same.plan.action, same.result.refused, same.result.managedBindings, same.writes.length], ['noChange', [], [], 0]);
  const unapproved = await reconcile(h, spec);
  assert.deepEqual(unapproved.result.refused.map((r) => r.code), ['form-layout-adoption-not-authorized']);
  assert.equal(unapproved.writes.length, 0);

  const managed = fakeManaged();
  const first = await reconcile(h, spec, { authorizedAdoption: true, managed });
  managed.persist(first.result.managedBindings);
  assert.deepEqual((await layoutOf(h, 'sec_main')).rows, [['new_code', 'new_name']]);
  // A maker swaps them back by hand.
  const maker = await h.freshSdk();
  await maker.sdk.fetchArtifact('form', h.formId);
  const live = await maker.sdk.getArtifact('form', h.formId);
  const cells = live.tabs[0].columns[0].sections[0].rows[0].cells;
  await maker.sdk.updateElement('form', h.formId, '/tabs/0/columns/0/sections/0/rows/0', { cells: [cells[1], cells[0]] });
  await maker.sdk.pushArtifact('form', h.formId);

  const drift = await reconcile(h, spec, { managed });
  assert.deepEqual(drift.result.refused.map((r) => r.code), ['form-layout-drift']);
  assert.equal(drift.writes.length, 0);
  const overwrite = await reconcile(h, spec, { managed, authorizedOverwrite: true });
  assert.equal(overwrite.result.saved.length, 1);
  assert.deepEqual((await layoutOf(h, 'sec_main')).rows, [['new_code', 'new_name']]);
});

test('a field the form holds twice in the declared section is refused; a form without the opt-in is not read at all', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_name')] }])]);
  const twice = await reconcile(h, formSpec(['new_name']), { authorizedAdoption: true });
  assert.deepEqual(twice.result.refused.map((r) => r.code), ['form-layout-field-ambiguous']);
  assert.equal(twice.writes.length, 0);

  const readsBefore = h.reads.length;
  const legacy = await reconcile(h, formSpec(['new_name'], { reconcile: null }), { authorizedAdoption: true });
  assert.equal(legacy.plan.action, null);
  assert.equal(h.reads.length, readsBefore);
  assert.equal(legacy.writes.length, 0);
});

test('declared layout keeps an explicit false from the spec, which the additive compiler drops', () => {
  const spec = formSpec([{ name: 'new_name', readOnly: false, hidden: true }, 'new_code'], { fieldOptions: { new_code: { readOnly: false } } });
  const layout = declaredLayoutOf(spec.forms[0], compileFormIntent(spec, spec.forms[0]).tabs);
  assert.deepEqual(layout.sections.map((s) => [s.section, s.fields]), [['sec_main', [{ name: 'new_name', readOnly: false, hidden: true }, { name: 'new_code', readOnly: false }]]]);
  // The pure pack: a duplicated field stays a refusal path through the plan; a new field gets a minimal cell.
  const packed = packDeclaredLayout({ rows: [], width: 2, fields: [{ name: 'new_area', colspan: 2 }] });
  assert.deepEqual(packed.rows, [{ cells: [{ control: { fieldName: 'new_area' }, colspan: 2 }] }]);
});

test('a row the pack empties above a maker field stays, so the maker field keeps its row', () => {
  const rows = [{ cells: [cell(1, 'new_name')] }, { cells: [cell(2, 'new_extra')] }];
  const packed = packDeclaredLayout({ rows, width: 2, fields: [], owned: new Set(['new_name']), carried: { new_name: rows[0].cells[0] } });
  const g = slotGrid(packed.rows, 2);
  assert.deepEqual(g.placed.map((p) => [p.r, p.c]), [[1, 0]], 'the maker field is still on row 1');
  assert.deepEqual(packed.rows[0].cells, []);
  // Below the last maker field an emptied row still goes: nothing it holds up can move.
  const tail = [{ cells: [cell(2, 'new_extra')] }, { cells: [cell(1, 'new_name')] }];
  const after = packDeclaredLayout({ rows: tail, width: 2, fields: [], owned: new Set(['new_name']), carried: { new_name: tail[1].cells[0] } });
  assert.deepEqual(after.rows.map((r) => r.cells.map((c) => c.control.fieldName)), [['new_extra']]);
});

test('a new declared field gets its cell and control ids from the creation port before the write; without the port nothing is written', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name')] }])]);
  const spec = formSpec(['new_name', 'new_code']);
  const none = await reconcile(h, spec, { authorizedAdoption: true, creates: null });
  assert.deepEqual(none.result.refused.map((r) => r.code), ['creation-port-unavailable']);
  assert.equal(none.writes.length, 0);

  const creates = fakeCreates();
  const { result } = await reconcile(h, spec, { authorizedAdoption: true, creates });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  assert.equal(creates.calls.length, 1);
  const call = creates.calls[0];
  assert.deepEqual([call.op.kind, call.op.key, call.op.childKeys], ['form-layout', 'new_ticket/main', ['cell:new_code', 'control:new_code']]);
  const { sdk } = await h.freshSdk();
  await sdk.fetchArtifact('form', h.formId);
  const stored = (await sdk.getArtifact('form', h.formId)).tabs[0].columns[0].sections[0].rows[0].cells[1];
  assert.deepEqual([stored.id, stored.control.id], [call.ids.childIds['cell:new_code'], call.ids.childIds['control:new_code']], 'the SDK keeps the reserved ids');
});

test('a new form cell whose earlier write lost its answer is refused until the maker resolves it, and nothing is written', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name')] }])]);
  const out = await reconcile(h, formSpec(['new_name', 'new_code']), { authorizedAdoption: true, creates: fakeCreates({ pendingUnknown: ['new_ticket/main'] }) });
  assert.deepEqual(out.result.refused.map((r) => r.code), ['creation-pending-unknown']);
  assert.equal(out.writes.length, 0);
  const adopted = await reconcile(h, formSpec(['new_name', 'new_code']), { authorizedAdoption: true,
    creates: fakeCreates({ pendingUnknown: ['new_ticket/main'], adopt: { 'new_ticket/main': { id: h.formId, childIds: {} } } }) });
  assert.deepEqual(adopted.result.refused.map((r) => r.code), ['creation-adopted-rerun']);
  assert.deepEqual([adopted.writes.length, adopted.result.managedBindings.length], [0, 0]);
});

test('a stated section width is written with the rows packed for it; an omitted width keeps the section as it is', async () => {
  const h = await deployed([section('sec_main', 1, [{ cells: [cell(1, 'new_name')] }, { cells: [cell(2, 'new_code')] }])]);
  const { result, mutations } = await reconcile(h, formSpec(['new_name', 'new_code']), { authorizedAdoption: true });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  assert.deepEqual(mutations.map((m) => [m.method, m.args[2]]), [['updateElement', '/tabs']], 'width and rows in one mutation');
  const { sdk } = await h.freshSdk();
  await sdk.fetchArtifact('form', h.formId);
  const s = (await sdk.getArtifact('form', h.formId)).tabs[0].columns[0].sections[0];
  assert.equal(s.columns, 2);
  assert.deepEqual(slotGrid(s.rows, s.columns).overflow, []);
  assert.deepEqual((await layoutOf(h, 'sec_main')).rows, [['new_name', 'new_code']]);

  // A spec that leaves `columns` out does not shrink a maker's four-column section to the compiler's default of 1.
  const wide = await deployed([section('sec_main', 4, [{ cells: [cell(1, 'new_name'), cell(2, 'new_extra', { cell: { colspan: 2 } }), cell(3, 'new_code')] }])]);
  const omitted = formSpec(['new_name', 'new_code']);
  delete omitted.forms[0].tabs[0].sections[0].columns;
  const kept = await reconcile(wide, omitted, { authorizedAdoption: true });
  assert.deepEqual([kept.plan.action, kept.result.refused, kept.writes.length], ['noChange', [], 0]);
});

test('starting to declare a flag, or a field the form already holds, is an edit and not drift', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_code')] }, { cells: [cell(3, 'new_extra')] }])]);
  const managed = fakeManaged();
  const first = await reconcile(h, formSpec(['new_name', 'new_code']), { authorizedAdoption: true, managed });
  assert.equal(first.plan.action, 'noChange');
  managed.persist(first.result.managedBindings);

  const flag = await reconcile(h, formSpec([{ name: 'new_name', hidden: true }, 'new_code']), { managed });
  assert.deepEqual([flag.result.refused, flag.result.saved.length], [[], 1]);
  assert.ok(managed.all()[0].partsSha256, 'the binding records a hash per part');
  managed.persist(flag.result.managedBindings);
  assert.equal((await layoutOf(h, 'sec_main')).at.new_name.hidden, true);

  const more = await reconcile(h, formSpec([{ name: 'new_name', hidden: true }, 'new_extra', 'new_code']), { managed });
  assert.deepEqual([more.result.refused, more.result.saved.length], [[], 1]);
  assert.deepEqual((await layoutOf(h, 'sec_main')).rows, [['new_name', 'new_extra'], ['new_code']]);
});

test('a maker change to a field the spec starts to declare is still drift', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [cell(1, 'new_name'), cell(2, 'new_code')] }, { cells: [cell(3, 'new_extra')] }])]);
  const managed = fakeManaged();
  const first = await reconcile(h, formSpec(['new_name', 'new_code']), { authorizedAdoption: true, managed });
  managed.persist(first.result.managedBindings);
  // A maker hides new_extra by hand after the last build.
  const maker = await h.freshSdk();
  await maker.sdk.fetchArtifact('form', h.formId);
  const live = await maker.sdk.getArtifact('form', h.formId);
  await maker.sdk.updateElement('form', h.formId, '/tabs/0/columns/0/sections/0/rows/1', { cells: [{ ...live.tabs[0].columns[0].sections[0].rows[1].cells[0], visible: false }] });
  await maker.sdk.pushArtifact('form', h.formId);
  const out = await reconcile(h, formSpec(['new_name', { name: 'new_extra', hidden: false }, 'new_code']), { managed });
  assert.deepEqual(out.result.refused.map((r) => r.code), ['form-layout-drift']);
  assert.equal(out.writes.length, 0);
});

test('an explicit false is honored under tabs[].columns[].sections as under tabs[].sections; an omitted flag is left as it is', async () => {
  const h = await deployed([section('sec_main', 2, [{ cells: [
    cell(1, 'new_name', { control: { isReadOnly: true }, cell: { visible: false } }),
    cell(2, 'new_code', { control: { isReadOnly: true }, cell: { visible: false } }),
  ] }])]);
  const spec = formSpec([{ name: 'new_name', hidden: false, readOnly: false }, 'new_code']);
  const t0 = spec.forms[0].tabs[0];
  t0.columns = [{ width: '100%', sections: t0.sections }];
  delete t0.sections;
  const { result } = await reconcile(h, spec, { authorizedAdoption: true });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  const after = await layoutOf(h, 'sec_main');
  assert.deepEqual([after.at.new_name.readOnly, after.at.new_name.hidden], [false, false]);
  assert.deepEqual([after.at.new_code.readOnly, after.at.new_code.hidden], [true, true]);
});

test('a field the form holds in two sections is refused even when one of them is the declared section', async () => {
  const h = await deployed([
    section('sec_main', 2, [{ cells: [cell(1, 'new_name')] }]),
    section('maker_section', 2, [{ cells: [cell(2, 'new_name')] }]),
  ]);
  const out = await reconcile(h, formSpec([{ name: 'new_name', hidden: true }]), { authorizedAdoption: true });
  assert.deepEqual(out.result.refused.map((r) => r.code), ['form-layout-field-ambiguous']);
  assert.equal(out.writes.length, 0);
});

test('a new declared form compiles a row-spanning field in the middle of a section on the slot model; other forms compile as before', () => {
  const fields = [{ name: 'new_name', rowspan: 2 }, 'new_code', 'new_extra', 'new_area'];
  const spec = formSpec(fields);
  const rows = compileFormIntent(spec, spec.forms[0]).tabs[0].columns[0].sections[0].rows;
  const g = slotGrid(rows, 2);
  assert.deepEqual(g.overflow, []);
  const at = Object.fromEntries(g.placed.map((p) => [rows[p.row].cells[p.cell].control.fieldName, [p.r, p.c]]));
  assert.deepEqual(at, { new_name: [0, 0], new_code: [0, 1], new_extra: [1, 1], new_area: [2, 0] });
  const legacy = formSpec(fields, { reconcile: null });
  const legacyRows = compileFormIntent(legacy, legacy.forms[0]).tabs[0].columns[0].sections[0].rows;
  assert.deepEqual(legacyRows.map((r) => r.cells.map((c) => c.control.fieldName)), [['new_name', 'new_code'], ['new_extra', 'new_area']], 'the additive compiler is unchanged');
  // Without a row span the two compilers agree.
  for (const list of [['new_name', 'new_code', 'new_extra'], ['new_name', { name: 'new_code', colspan: 2 }, 'new_extra'], ['new_name', { name: 'new_code', rowspan: 2 }]]) {
    const a = formSpec(list);
    const b = formSpec(list, { reconcile: null });
    assert.deepEqual(compileFormIntent(a, a.forms[0]).tabs, compileFormIntent(b, b.forms[0]).tabs, JSON.stringify(list));
  }
});