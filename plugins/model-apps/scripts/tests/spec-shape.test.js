'use strict';
// Both authoring gates run on WORK-IN-PROGRESS specs, so every shape below is a realistic mid-edit
// state, not a pathological one: a collection still being reshaped (`{}`), or a hole left behind by
// deleting an entry (`[null]`). Each of these threw a raw TypeError before the shared normalizer —
// "object is not iterable" from `for...of`, "map is not a function", or a null dereference — which
// killed the authoring flow instead of reporting the problem.
const { test } = require('node:test');
const assert = require('node:assert');
const { validateAppSpec, migrateAppSpec } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { normalizeSpecShape } = require('../lib/spec-shape.js');

const base = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' } };
const ent0 = [{ schemaName: 'new_t', displayName: 'T', primaryAttribute: { schemaName: 'new_name', displayName: 'N' }, columns: [] }];
const withEntity = (extra) => ({
  ...base,
  entities: [{ schemaName: 'new_t', displayName: 'T', primaryAttribute: { schemaName: 'new_name', displayName: 'N' }, columns: [], ...extra }],
});
const shell = (areas) => ({ ...withEntity({}), appShell: { areas } });

// Every gate must survive these; the message text is asserted separately below.
const MALFORMED = [
  ['entity.columns = {}', withEntity({ columns: {} })],
  ['entity.columns = "x"', withEntity({ columns: 'x' })],
  ['entity.alternateKeys = {}', withEntity({ alternateKeys: {} })],
  ['entity.statusReasons = {}', withEntity({ statusReasons: {} })],
  ['entity.columns = [null]', withEntity({ columns: [null] })],
  ['appShell.areas = {}', shell({})],
  ['area.groups = {}', shell([{ label: 'A', groups: {} }])],
  ['group.subAreas = {}', shell([{ label: 'A', groups: [{ label: 'G', subAreas: {} }] }])],
  ['areas = [null]', shell([null])],
  ['persona.jobs = {}', { ...withEntity({}), personas: [{ persona: 'P', jobs: {} }] }],
  ['job.privileges = {}', { ...withEntity({}), personas: [{ persona: 'P', jobs: [{ name: 'j', privileges: {} }] }] }],
  ['form.subgrids = {}', { ...withEntity({}), forms: [{ entity: 'new_t', subgrids: {} }] }],
  ['dashboard.tiles = {}', { ...withEntity({}), dashboards: [{ name: 'D', tiles: {} }] }],
];

for (const [label, spec] of MALFORMED) {
  test(`validateAppSpec returns a structured result (never throws) for ${label}`, () => {
    const r = validateAppSpec(spec);
    assert.ok(Array.isArray(r.errors), 'must return a structured result rather than throwing');
  });
  test(`lintAppSpec returns findings (never throws) for ${label}`, () => {
    const r = lintAppSpec(spec);
    assert.ok(Array.isArray(r.errors), 'must return a structured result');
  });
}

// A non-array is a shape ERROR; so is a null HOLE, because validation checks its own normalized COPY
// while the caller keeps the ORIGINAL. A silently-repaired `appShell.areas: [null]` used to PASS
// validation and then throw inside the build — after the solution and data model had been written.
test('every malformed shape BLOCKS validation, so the build never starts', () => {
  for (const [label, spec] of MALFORMED) {
    assert.strictEqual(validateAppSpec(spec).ok, false, `${label} must not pass validation`);
  }
});

test('a null entry is reported rather than silently repaired', () => {
  assert.ok(validateAppSpec(shell([null])).errors.includes('appShell.areas[0] must be an object'));
  assert.ok(validateAppSpec(withEntity({ columns: [null] })).errors.includes('entities[0].columns[0] must be an object'));
});

test('a non-array nested collection is named by its exact path, not reported generically', () => {
  assert.ok(validateAppSpec(withEntity({ columns: {} })).errors.includes('entities[0].columns must be an array'));
  assert.ok(validateAppSpec(shell({})).errors.includes('appShell.areas must be an array'));
  assert.ok(validateAppSpec(shell([{ label: 'A', groups: {} }])).errors.includes('appShell.areas[0].groups must be an array'));
  assert.ok(validateAppSpec(shell([{ label: 'A', groups: [{ label: 'G', subAreas: {} }] }])).errors.includes('appShell.areas[0].groups[0].subAreas must be an array'));
  // Both gates share one normalizer, so they cannot disagree about what a malformed spec is.
  assert.ok(lintAppSpec(withEntity({ columns: {} })).errors.includes('entities[0].columns must be an array'));
});

// These paths crashed lint even AFTER the first round of hardening, because the registry was a flat
// per-owner list that silently omitted them. They are the reason the descriptor is now recursive.
test('the deeper collections both gates traverse are covered', () => {
  const deep = [
    [{ ...base, entities: ent0, views: [{ entity: 'new_t', name: 'V', filters: {} }] }, 'views[0].filters must be an array'],
    [{ ...base, entities: ent0, forms: [{ entity: 'new_t', tabs: {} }] }, 'forms[0].tabs must be an array'],
    [{ ...base, entities: ent0, forms: [{ entity: 'new_t', tabs: [{ label: 't', sections: {} }] }] }, 'forms[0].tabs[0].sections must be an array'],
    [{ ...base, entities: ent0, pages: [{ key: 'p', name: 'P', dataSources: {} }] }, 'pages[0].dataSources must be an array'],
    [{ ...base, entities: ent0, pages: [{ key: 'p', name: 'P', navigatesTo: {} }] }, 'pages[0].navigatesTo must be an array'],
    [{ ...base, entities: ent0, commands: [{ entity: 'new_t', buttons: [{ label: 'b', children: {} }] }] }, 'commands[0].buttons[0].children must be an array'],
  ];
  for (const [spec, expected] of deep) {
    assert.ok(validateAppSpec(spec).errors.includes(expected), `validate: ${expected}`);
    assert.ok(Array.isArray(lintAppSpec(spec).errors), 'lint must not throw');
    assert.ok(lintAppSpec(spec).errors.includes(expected), `lint: ${expected}`);
  }
});

// Migration runs BEFORE validation at every CLI entry point, so it must neither crash nor REPAIR —
// repairing would hand the gate a clean spec and the real problem would vanish.
test('migrateAppSpec survives malformed collections without hiding them from validation', () => {
  for (const [spec, expected] of [
    [{ ...base, entities: ent0, pages: {} }, 'pages must be an array'],
    [{ ...base, entities: ent0, appShell: { areas: {} } }, 'appShell.areas must be an array'],
    [{ ...base, entities: ent0, appShell: { areas: [null] } }, 'appShell.areas[0] must be an object'],
    [{ ...base, entities: {} }, 'entities must be an array'],
  ]) {
    let migrated;
    assert.doesNotThrow(() => { migrated = migrateAppSpec(spec); }, 'migration must not crash before the gate runs');
    assert.ok(validateAppSpec(migrated).errors.includes(expected), `after migration the gate still reports: ${expected}`);
  }
});

// The root-level message text predates the shared normalizer and other callers/tests read it.
test('root-level collection errors keep their original unprefixed wording', () => {
  assert.ok(validateAppSpec({ ...base, entities: {} }).errors.includes('entities must be an array'));
  assert.ok(lintAppSpec({ ...base, entities: {} }).errors.includes('entities must be an array'));
});

// Scalar collections are legitimately arrays of strings. Coercing their entries to objects would
// destroy real values, so the normalizer must leave them exactly as authored.
test('normalizeSpecShape preserves scalar collections verbatim', () => {
  const spec = {
    ...base,
    entities: [{ schemaName: 'new_t', columns: [{ schemaName: 'new_c', type: 'Choice', options: ['Open', 'Closed'] }], alternateKeys: [{ schemaName: 'k', columns: ['new_c'] }] }],
    views: [{ entity: 'new_t', name: 'V', columns: ['new_name', 'new_c'] }],
    personas: [{ persona: 'P', jobs: [{ name: 'j', privileges: [{ entity: 'new_t', access: ['read', 'write'] }] }] }],
  };
  const { spec: out, errors } = normalizeSpecShape(spec);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(out.entities[0].columns[0].options, ['Open', 'Closed']);
  assert.deepStrictEqual(out.entities[0].alternateKeys[0].columns, ['new_c']);
  assert.deepStrictEqual(out.views[0].columns, ['new_name', 'new_c']);
  assert.deepStrictEqual(out.personas[0].jobs[0].privileges[0].access, ['read', 'write']);
});

// A validator that rewrote its input would corrupt the document the author is still editing.
test('normalizeSpecShape never mutates the caller spec', () => {
  const spec = { ...base, entities: [{ schemaName: 'new_t', columns: {} }], appShell: { areas: {} } };
  const snapshot = JSON.stringify(spec);
  const { spec: out } = normalizeSpecShape(spec);
  assert.strictEqual(JSON.stringify(spec), snapshot, 'input is untouched');
  assert.notStrictEqual(out, spec);
  assert.deepStrictEqual(out.entities[0].columns, []);
  assert.deepStrictEqual(out.appShell.areas, []);
});

// The contract both gates were written against: every ROOT collection exists as an array afterwards,
// including ones the spec never declared. Making that conditional would be a behaviour change
// disguised as an optimization, so it is pinned. NESTED collections are the opposite — an entity
// that never declared `columns` must not silently gain an empty one.
test('normalizeSpecShape materializes absent root collections but not absent nested ones', () => {
  const { spec: out } = normalizeSpecShape({ ...base, entities: [{ schemaName: 'new_t' }] });
  for (const key of ['entities', 'relationships', 'globalChoices', 'webResources', 'views', 'charts', 'forms', 'commands', 'dashboards', 'pages', 'personas']) {
    assert.ok(Array.isArray(out[key]), `${key} must be materialized as an array`);
  }
  assert.strictEqual(out.entities[0].columns, undefined, 'an undeclared nested collection stays undeclared');
  assert.strictEqual(out.appShell, undefined, 'an absent appShell is not invented');
});

// A clean spec must pass through with its nested objects untouched by identity, so nothing
// downstream that compares references can be disturbed by validation.
test('normalizeSpecShape leaves well-formed nested objects by reference', () => {
  const entity = { schemaName: 'new_t', columns: [{ schemaName: 'new_c' }] };
  const area = { label: 'A', groups: [{ label: 'G', subAreas: [] }] };
  const { spec: out, errors } = normalizeSpecShape({ ...base, entities: [entity], appShell: { areas: [area] } });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(out.entities[0], entity, 'a clean entity is not copied');
  assert.strictEqual(out.appShell.areas[0], area, 'a clean area is not copied');
});

test('normalizeSpecShape tolerates a non-object spec without throwing', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const r = normalizeSpecShape(bad);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.spec, bad);
  }
});
