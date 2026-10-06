'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { fitsGrid } = require('../lib/form-occupancy.js');

const clone = (v) => JSON.parse(JSON.stringify(v));
function jpTokens(ptr) { return ptr === '' ? [] : ptr.split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~')); }
function jpGet(obj, ptr) { let cur = obj; for (const t of jpTokens(ptr)) { if (cur == null) return undefined; cur = cur[t]; } return cur; }
function jpSet(obj, ptr, val) { const toks = jpTokens(ptr); const last = toks.pop(); let cur = obj; for (const t of toks) cur = cur[t]; cur[last] = val; }
function jpRemove(obj, ptr) { const toks = jpTokens(ptr); const last = toks.pop(); let cur = obj; for (const t of toks) cur = cur[t]; if (Array.isArray(cur)) cur.splice(Number(last), 1); else delete cur[last]; }

function mockSdk({ existingFormJson, formsByName = { Probe: { id: 'form-existing', entity: 'new_project', isdefault: false } }, failPromoteIds = new Set() } = {}) {
  const calls = [];
  const store = {};
  const systemForms = new Map(Object.entries(formsByName).map(([name, row]) => [name, { name, ...row }]));
  const formById = (id) => [...systemForms.values()].find((f) => String(f.id) === String(id));
  const seed = (id) => Object.assign(clone(existingFormJson), { id });
  const sdk = {
    queryRecords: async (set, opts = {}) => {
      calls.push({ name: 'queryRecords', args: [set, opts] });
      const filter = opts.filter || '';
      if (set === 'solution') return [{ solutionid: 'solution-id' }];
      if (set === 'publisher') return [{ publisherid: 'publisher-id' }];
      if (set === 'systemform') {
        const byId = /formid eq (\S+)/.exec(filter);
        if (byId) {
          const row = formById(byId[1]);
          return row ? [{ formid: row.id, objecttypecode: row.entity, isdefault: row.isdefault === true, formactivationstate: row.formactivationstate }] : [];
        }
        const byName = /name eq '([^']+)'/.exec(filter);
        if (byName) {
          const row = systemForms.get(byName[1]);
          return row ? [{ formid: row.id, objecttypecode: row.entity, isdefault: row.isdefault === true }] : [];
        }
        if (/type eq 2/.test(filter)) {
          return [...systemForms.values()].map((row) => ({ formid: row.id, objecttypecode: row.entity, isdefault: row.isdefault === true, formactivationstate: row.formactivationstate }));
        }
      }
      return [];
    },
    fetchArtifact: async (type, id) => {
      calls.push({ name: 'fetchArtifact', args: [type, id] });
      if (type === 'form' && !store[`${type}:${id}`]) store[`${type}:${id}`] = seed(id);
      return store[`${type}:${id}`] || { id };
    },
    getArtifact: async (type, id) => {
      calls.push({ name: 'getArtifact', args: [type, id] });
      return store[`${type}:${id}`] || (type === 'form' ? seed(id) : { id });
    },
    updateElement: async (type, id, ptr, patch) => {
      calls.push({ name: 'updateElement', args: [type, id, ptr, patch] });
      const art = store[`${type}:${id}`] || (store[`${type}:${id}`] = seed(id));
      const current = jpGet(art, ptr);
      const mergeable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
      jpSet(art, ptr, mergeable(current) && mergeable(patch) ? Object.assign({}, current, clone(patch)) : clone(patch));
      return clone(art);
    },
    addElement: async (type, id, ptr, element, opts = {}) => {
      calls.push({ name: 'addElement', args: [type, id, ptr, element, opts] });
      const art = store[`${type}:${id}`] || (store[`${type}:${id}`] = seed(id));
      const arr = jpGet(art, ptr);
      if (!Array.isArray(arr)) return clone(art);
      const pos = opts.position;
      let at = arr.length;
      if (pos === 'start') at = 0;
      else if (pos && typeof pos === 'object' && 'index' in pos) at = Math.max(0, Math.min(pos.index, arr.length));
      arr.splice(at, 0, clone(element));
      return clone(art);
    },
    moveElement: async (type, id, fromPtr, toPtr, opts = {}) => {
      calls.push({ name: 'moveElement', args: [type, id, fromPtr, toPtr, opts] });
      const art = store[`${type}:${id}`] || (store[`${type}:${id}`] = seed(id));
      const el = jpGet(art, fromPtr);
      const target = jpGet(art, toPtr);
      if (el === undefined || !Array.isArray(target)) return clone(art);
      jpRemove(art, fromPtr);
      target.splice(opts.index === undefined ? target.length : opts.index, 0, el);
      return clone(art);
    },
    removeElement: async (type, id, ptr) => {
      calls.push({ name: 'removeElement', args: [type, id, ptr] });
      const art = store[`${type}:${id}`];
      if (art) jpRemove(art, ptr);
      return clone(art || { id });
    },
    updateRecord: async (set, id, data) => {
      calls.push({ name: 'updateRecord', args: [set, id, data] });
      if (data && data.isdefault === true && failPromoteIds.has(String(id))) throw new Error('promotion failed');
      const row = formById(id);
      if (row && data && Object.prototype.hasOwnProperty.call(data, 'isdefault')) row.isdefault = data.isdefault;
    },
    pushArtifact: async (type, id) => { calls.push({ name: 'pushArtifact', args: [type, id] }); return { type, id, saved: true, shipped: false, publish: { kind: 'notRequested' } }; },
    publishArtifact: async (type, id) => { calls.push({ name: 'publishArtifact', args: [type, id] }); return { type, id, shipped: true, publish: { kind: 'verified' } }; },
    addSolutionComponent: async (component) => { calls.push({ name: 'addSolutionComponent', args: [component] }); },
  };
  return { sdk, calls, systemForms };
}

function cell(name, extra = {}) {
  return { id: `cell-${name}`, ...extra, control: { fieldName: `new_${name}`, id: `control-${name}` } };
}
function spacer(extra = {}) { return { id: 'maker-spacer', ...extra }; }
function existingForm(columns, rows) {
  return { id: 'form-existing', name: 'Probe', tabs: [{ name: 'probe', label: 'Probe', columns: [{ width: '100%', sections: [{ name: 'fields', label: 'Fields', columns, rows: rows.map((cells) => ({ cells })) }] }] }], bag: { a: [], c: [] } };
}
function specFor({ columns, fields, forms = null }) {
  const spec = {
    solution: { uniqueName: 'LayoutProbe', displayName: 'Layout Probe', publisherPrefix: 'new' },
    app: { name: 'Layout Probe' },
    entities: [{ schemaName: 'new_project', displayName: 'Project', primaryAttribute: { schemaName: 'new_a', displayName: 'A' }, columns: ['b', 'c', 'd', 'e', 'f'].map((f) => ({ schemaName: `new_${f}`, displayName: f.toUpperCase(), type: 'Text' })) }],
    views: [], charts: [],
    forms: forms || [{ entity: 'new_project', name: 'Probe', formType: 'Main', layout: 'explicit', tabs: [{ name: 'probe', label: 'Probe', sections: [{ name: 'fields', label: 'Fields', columns, fields }] }] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Work', subAreas: [{ entity: 'new_project', title: 'Projects' }] }] }] },
  };
  const validation = validateAppSpec(spec);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors));
  return spec;
}
function sectionOf(form) { return form.tabs[0].columns[0].sections[0]; }
async function runTwice(spec, existing, options = {}) {
  const mock = mockSdk({ existingFormJson: existing, ...options });
  const warnings = [];
  const first = await runSdkBuild(spec, { sdk: mock.sdk, provisionSdk: mock.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) });
  const second = await runSdkBuild(spec, { sdk: mock.sdk, provisionSdk: mock.sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(String(m)) });
  const form = await mock.sdk.getArtifact('form', 'form-existing');
  return { ...mock, first, second, warnings, form, section: sectionOf(form) };
}
function assertFits(section) {
  assert.ok(fitsGrid(section.rows || [], Number(section.columns)), `rows must fit ${section.columns} columns: ${JSON.stringify(section.rows)}`);
}

for (const [name, existing, desired, wantColumns, wantSkip] of [
  ['ordinary shrink', existingForm(4, [[cell('a'), cell('b'), cell('c'), cell('d')]]), ['new_a', 'new_b', 'new_c', 'new_d'], 2, false],
  ['trailing-span shrink', existingForm(4, [[cell('a'), cell('b'), cell('c'), cell('d', { rowspan: 3 })]]), ['new_a', 'new_b', 'new_c', 'new_d'], 2, false],
  ['following row own overflow', existingForm(4, [[cell('a', { rowspan: 2 })], [cell('b'), cell('c'), cell('d')]]), ['new_a', 'new_b', 'new_c', 'new_d'], 4, true],
  ['carried-reservation-only overflow', existingForm(4, [[cell('a', { rowspan: 2 })], [cell('b'), cell('c')], [cell('d')]]), ['new_a', 'new_b', 'new_c', 'new_d'], 4, true],
  ['spacer carried overflow', existingForm(4, [[cell('a', { rowspan: 2 })], [spacer(), cell('b')], [cell('c'), cell('d')]]), ['new_a', 'new_b', 'new_c', 'new_d'], 4, true],
  ['safe reservation shrink', existingForm(4, [[cell('a', { rowspan: 2 })], [cell('b')], [cell('c'), cell('d')]]), ['new_a', 'new_b', 'new_c', 'new_d'], 2, false],
]) {
  test(`form layout row occupancy: ${name}`, async () => {
    const spec = specFor({ columns: 2, fields: desired });
    const { section, second } = await runTwice(spec, existing);
    assert.strictEqual(Number(section.columns), wantColumns);
    assertFits(section);
    assert.strictEqual(second.skipped.layout.length > 0, wantSkip, JSON.stringify(second.skipped.layout));
  });
}

test('form layout row occupancy: raise a span on a followed cell is skipped', async () => {
  const spec = specFor({ columns: 2, fields: ['new_b', 'new_c', 'new_d', { name: 'new_a', rowspan: 2 }] });
  const { section, second } = await runTwice(spec, existingForm(2, [[cell('a'), cell('b')], [cell('c'), cell('d')]]));
  const a = section.rows.flatMap((r) => r.cells || []).find((c) => c.control && c.control.fieldName === 'new_a');
  assert.strictEqual(Number(a.rowspan) || 1, 1);
  assert.ok(second.skipped.layout.some((m) => /rowspan/.test(m)), JSON.stringify(second.skipped.layout));
  assertFits(section);
});

test('form layout row occupancy: widening beside a span is skipped', async () => {
  const spec = specFor({ columns: 2, fields: ['new_a', { name: 'new_b', colspan: 2 }, 'new_c', 'new_d'] });
  const { section, second } = await runTwice(spec, existingForm(2, [[cell('a', { rowspan: 2 }), cell('b')], [cell('c')], [cell('d')]]));
  const b = section.rows.flatMap((r) => r.cells || []).find((c) => c.control && c.control.fieldName === 'new_b');
  assert.strictEqual(Number(b.colspan) || 1, 1);
  assert.ok(second.skipped.layout.length > 0, 'a layout skip must be reported');
  assertFits(section);
});

test('form layout row occupancy: new fields after a trailing span choose rows with effective capacity', async () => {
  const spec = specFor({ columns: 2, fields: ['new_a', 'new_b', 'new_c', 'new_d'] });
  const { section } = await runTwice(spec, existingForm(2, [[cell('a', { rowspan: 3 })]]));
  assertFits(section);
  for (const f of ['new_a', 'new_b', 'new_c', 'new_d']) {
    assert.ok(section.rows.flatMap((r) => r.cells || []).some((c) => c.control && c.control.fieldName === f), `${f} exists`);
  }
});

test('form layout row occupancy: pre-existing overflow does not force new-field placement to a new row', async () => {
  const spec = specFor({ columns: 2, fields: ['new_a', 'new_b', 'new_c', 'new_d', 'new_e'] });
  const { section } = await runTwice(spec, existingForm(2, [[cell('a'), cell('b'), cell('c')], [cell('d')]]));

  assert.deepStrictEqual(section.rows.map((r) => (r.cells || []).map((c) => c.control && c.control.fieldName)),
    [['new_a', 'new_b', 'new_c'], ['new_d', 'new_e']],
    'the unrelated row-1 overflow must not stop placement from using the roomy last row');
});

test('form layout row occupancy: a too-wide new field can use an empty row despite an unrelated overflow', async () => {
  const spec = specFor({ columns: 2, fields: ['new_a', 'new_b', 'new_c', { name: 'new_e', colspan: 4 }] });
  const { section } = await runTwice(spec, existingForm(2, [[cell('a'), cell('b'), cell('c')], []]));

  const eRow = section.rows.find((r) => (r.cells || []).some((c) => c.control && c.control.fieldName === 'new_e'));
  assert.ok(eRow, 'the new field must be placed');
  assert.strictEqual(section.rows.indexOf(eRow), 1, 'the existing empty last row accepts the clamped wide cell');
});

test('form layout row occupancy: a safe span change is not skipped because another row already overflows', async () => {
  const spec = specFor({ columns: 3, fields: ['new_a', { name: 'new_b', colspan: 2 }, 'new_c', 'new_d', 'new_e', 'new_f'] });
  const { section, second } = await runTwice(spec, existingForm(3, [
    [cell('a', { rowspan: 2 })],
    [cell('b')],
    [cell('c'), cell('d'), cell('e'), cell('f')],
  ]));

  const b = section.rows.flatMap((r) => r.cells || []).find((c) => c.control && c.control.fieldName === 'new_b');
  assert.strictEqual(Number(b.colspan) || 1, 2, "row 2 uses one reserved column plus b's two columns, which fits grid 3");
  assert.deepStrictEqual(second.skipped.layout, [], 'the unrelated row-3 overflow must not make the safe span change look unsafe');
});

test('default Main form promotion demotes only declared sibling defaults', async () => {
  const forms = [
    { entity: 'new_project', name: 'Operations', formType: 'Main' },
    { entity: 'new_project', name: 'Manager', formType: 'Main', isDefault: true },
  ];
  const existing = existingForm(2, [[cell('a')]]);
  const spec = specFor({ columns: 2, fields: ['new_a'], forms });
  const { calls } = await runTwice(spec, existing, { formsByName: {
    Operations: { id: 'form-ops', entity: 'new_project', isdefault: true },
    Manager: { id: 'form-manager', entity: 'new_project', isdefault: false },
    Outside: { id: 'form-outside', entity: 'new_project', isdefault: true },
    Review: { id: 'form-review', entity: 'new_project', isdefault: false },
  } });
  const updates = calls.filter((c) => c.name === 'updateRecord').map((c) => c.args);
  assert.ok(updates.some(([set, id, data]) => set === 'systemform' && id === 'form-manager' && data.isdefault === true), 'chosen form is promoted');
  assert.ok(updates.some(([set, id, data]) => set === 'systemform' && id === 'form-ops' && data.isdefault === false), 'declared default sibling is demoted');
  assert.ok(!updates.some(([, id, data]) => id === 'form-outside' && data.isdefault === false), 'non-spec form is untouched');
  assert.ok(!updates.some(([, id, data]) => id === 'form-review' && data.isdefault === false), 'non-default sibling is untouched');
});

test('default Main form promotion failure skips sibling demotion', async () => {
  const spec = specFor({ columns: 2, fields: ['new_a'], forms: [
    { entity: 'new_project', name: 'Operations', formType: 'Main' },
    { entity: 'new_project', name: 'Manager', formType: 'Main', isDefault: true },
  ] });
  const { calls, warnings } = await runTwice(spec, existingForm(2, [[cell('a')]]), { failPromoteIds: new Set(['form-manager']), formsByName: {
    Operations: { id: 'form-ops', entity: 'new_project', isdefault: true },
    Manager: { id: 'form-manager', entity: 'new_project', isdefault: false },
  } });
  assert.ok(warnings.some((w) => /could not make form the default/.test(w)), JSON.stringify(warnings));
  assert.ok(!calls.some((c) => c.name === 'updateRecord' && c.args[1] === 'form-ops' && c.args[2].isdefault === false), 'no demotion after failed promote');
});

// --- Rows a removal leaves empty -------------------------------------------------------------------
// An empty <row/> renders as a blank line, so a row a pruned or moved field leaves holding nothing is
// removed. A row still holding a slot reserved by a row-spanning cell above is NOT empty, and a row
// that was already empty before this run is not this run's to remove.

const rowShape = (section) => (section.rows || []).map((r) => ((r && r.cells) || []).map((c) => {
  const fn = c.control && c.control.fieldName ? c.control.fieldName.replace(/^new_/, '') : 'spacer';
  return (Number(c.rowspan) || 1) > 1 ? `${fn} rs${c.rowspan}` : fn;
}));
const rowRemovals = (calls) => calls.filter((c) => c.name === 'removeElement' && /\/rows\/\d+$/.test(c.args[2]));

for (const [name, columns, rows, fields, wantShape, wantRowRemovals] of [
  ['pruning the only field in a row removes the row', 2,
    [[cell('a'), cell('b')], [cell('c')], [cell('d')]], ['new_a', 'new_b', 'new_c'], [['a', 'b'], ['c']], 1],
  ['pruning two fields in adjacent rows removes both rows', 4,
    [[cell('a', { rowspan: 2 })], [cell('b'), cell('c')], [cell('d')], [cell('e')]], ['new_a', 'new_b', 'new_c'], [['a rs2'], ['b', 'c']], 2],
  ['an emptied row a span above still reserves is kept', 4,
    [[cell('a', { rowspan: 2 })], [cell('d')], [cell('b'), cell('c')]], ['new_a', 'new_b', 'new_c'], [['a rs2'], [], ['b', 'c']], 0],
  ['pruning a spanning field removes the rows its span left empty', 2,
    [[cell('a'), cell('b')], [cell('d', { rowspan: 2 })], []], ['new_a', 'new_b'], [['a', 'b']], 2],
  ['a row that was already empty is left alone', 2,
    [[cell('a'), cell('b')], [], [cell('c')]], ['new_a', 'new_b'], [['a', 'b'], []], 1],
]) {
  test(`form rows after a prune: ${name}`, async () => {
    const spec = specFor({ columns, fields });
    const { section, calls } = await runTwice(spec, existingForm(columns, rows));
    assert.deepStrictEqual(rowShape(section), wantShape);
    // Both applies ran: the second finds nothing left to remove.
    assert.strictEqual(rowRemovals(calls).length, wantRowRemovals, JSON.stringify(rowRemovals(calls).map((c) => c.args[2])));
    assertFits(section);
  });
}

// The move paths (`fieldOptions[x].after`) remove a row they empty too, and must keep one a span above
// still reserves: deleting it pulled every row beneath it up under the span.
function movedSpec(fields) {
  return specFor({ columns: 2, fields, forms: [{ entity: 'new_project', name: 'Probe', formType: 'Main', layout: 'explicit', prune: false,
    fieldOptions: { new_c: { after: 'new_d' } },
    tabs: [{ name: 'probe', label: 'Probe', sections: [{ name: 'fields', label: 'Fields', columns: 2, fields }] }] }] });
}

test('form rows after a move: a row the moved field emptied is removed', async () => {
  const { section } = await runTwice(movedSpec(['new_a', 'new_b', 'new_d', 'new_e']), existingForm(2, [[cell('a'), cell('b')], [cell('c')], [cell('d'), cell('e')]]));
  assert.deepStrictEqual(rowShape(section), [['a', 'b'], ['d', 'c', 'e']]);
});

test('form rows after a move: an emptied row a span above still reserves is kept', async () => {
  const { section } = await runTwice(movedSpec(['new_a', 'new_b', 'new_d', 'new_e']), existingForm(2, [[cell('a', { rowspan: 2 }), cell('b')], [cell('c')], [cell('d'), cell('e')]]));
  assert.deepStrictEqual(rowShape(section), [['a rs2', 'b'], [], ['d', 'c', 'e']]);
});

test('form rows after a move: a moved spanning field frees the rows its span covered', async () => {
  // Row 2 holds nothing but c's reserved slot. Once c leaves, both of its rows are blank.
  const { section } = await runTwice(movedSpec(['new_a', 'new_b', 'new_d', 'new_e']), existingForm(2, [[cell('a'), cell('b')], [cell('c', { rowspan: 2 })], [], [cell('d'), cell('e')]]));
  assert.deepStrictEqual(rowShape(section), [['a', 'b'], ['d', 'c rs2', 'e']]);
});

// The other move path: a field the layout puts in ANOTHER section is relocated there, and the rows it
// leaves behind in its old section go the same way.
function relocatedSpec() {
  return specFor({ columns: 2, fields: [], forms: [{ entity: 'new_project', name: 'Probe', formType: 'Main', layout: 'explicit',
    tabs: [{ name: 'probe', label: 'Probe', sections: [
      { name: 'fields', label: 'Fields', columns: 2, fields: ['new_a', 'new_b'] },
      { name: 'other', label: 'Other', columns: 1, fields: ['new_c'] },
    ] }] }] });
}
const namedSection = (form, name) => form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections)).find((s) => s.name === name);

for (const [name, rows, wantShape] of [
  ['the row it emptied is removed', [[cell('a'), cell('b')], [cell('c')]], [['a', 'b']]],
  ['a spanning field frees the rows its span covered', [[cell('a'), cell('b')], [cell('c', { rowspan: 2 })], []], [['a', 'b']]],
  ['an emptied row a span above still reserves is kept', [[cell('a', { rowspan: 2 }), cell('b')], [cell('c')]], [['a rs2', 'b'], []]],
]) {
  test(`form rows after a relocation: ${name}`, async () => {
    const { form } = await runTwice(relocatedSpec(), existingForm(2, rows));
    assert.deepStrictEqual(rowShape(namedSection(form, 'fields')), wantShape);
    assert.deepStrictEqual(rowShape(namedSection(form, 'other')).flat().map((c) => c.split(' ')[0]), ['c'], 'the field did move');
  });
}
