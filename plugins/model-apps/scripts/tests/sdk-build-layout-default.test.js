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
    entities: [{ schemaName: 'new_project', displayName: 'Project', primaryAttribute: { schemaName: 'new_a', displayName: 'A' }, columns: ['b', 'c', 'd'].map((f) => ({ schemaName: `new_${f}`, displayName: f.toUpperCase(), type: 'Text' })) }],
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
