'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { diffPhases, summarizeDiff, stableStringify } = require('../lib/phase-diff.js');

const spec = () => ({
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  app: { name: 'A' }, appShell: { areas: [{ label: 'M', groups: [] }] },
  entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
  relationships: [], globalChoices: [],
  views: [{ entity: 'new_x', name: 'Active X', columns: ['new_name'] }],
  charts: [], forms: [{ entity: 'new_x', name: 'X', layout: 'auto' }],
  pages: [{ key: 'overview', name: 'overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }],
  ai: { appFeatures: { formFill: true } },
  sampleData: { new_x: [{ new_name: 'a' }] },
});

test('diffPhases: no snapshot -> every diffable phase is "changed" (a first build)', () => {
  const changed = diffPhases(spec(), null);
  assert.ok(changed.includes('data-model') && changed.includes('pages') && changed.includes('app-shell'));
  assert.ok(!changed.includes('publish'), 'publish is not a diffable phase (always runs)');
});

test('diffPhases: identical specs -> nothing changed', () => {
  assert.deepStrictEqual(diffPhases(spec(), spec()), []);
});

test('diffPhases: editing ONLY the page slice reports only pages', () => {
  const cur = spec();
  cur.pages[0].prompt = 'refreshed';
  assert.deepStrictEqual(diffPhases(cur, spec()), ['pages']);
});

test('diffPhases: a data-model change is reported under data-model (drives the full-build recommendation)', () => {
  const cur = spec();
  cur.entities[0].columns.push({ schemaName: 'new_y', type: 'Text' });
  const changed = diffPhases(cur, spec());
  assert.ok(changed.includes('data-model'));
  assert.ok(!changed.includes('pages'), 'unrelated phases are not falsely flagged');
});

test('diffPhases: app OR appShell change reports app-shell', () => {
  const cur = spec();
  cur.appShell.areas[0].label = 'Renamed';
  assert.deepStrictEqual(diffPhases(cur, spec()), ['app-shell']);
});

test('diffPhases: key REORDER (same values) is NOT a change (stable-stringify)', () => {
  const a = spec();
  const b = spec();
  b.solution = { publisherPrefix: 'new', uniqueName: 'S' }; // keys reordered, same values
  assert.ok(!diffPhases(b, a).includes('solution'), 'reordered keys must not report a false change');
});

test('diffPhases: forms and views are independent slices', () => {
  const cur = spec();
  cur.forms[0].notes = true;
  assert.deepStrictEqual(diffPhases(cur, spec()), ['forms']);
});

test('summarizeDiff: no changes, page-only, and data-model messages', () => {
  assert.match(summarizeDiff([]), /No spec changes/);
  assert.match(summarizeDiff(['pages']), /Changed since last apply: pages/);
  assert.match(summarizeDiff(['pages']), /Data model unchanged/);
  assert.match(summarizeDiff(['data-model', 'forms']), /FULL build is recommended/);
});

test('stableStringify: arrays keep order, object keys sort', () => {
  assert.strictEqual(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.strictEqual(stableStringify([3, 1, 2]), '[3,1,2]');
  assert.strictEqual(stableStringify(undefined), 'null');
});

test('diffPhases: a personas[] change surfaces as a changed "security" phase', () => {
  const prior = { entities: [{ schemaName: 'new_x' }], personas: [{ persona: 'Agent', jobs: [{ name: 'w', privileges: [{ entity: 'new_x', access: ['read'] }] }] }] };
  const cur = JSON.parse(JSON.stringify(prior));
  cur.personas[0].jobs[0].privileges[0].access = ['read', 'write'];
  assert.ok(diffPhases(cur, prior).includes('security'));
  // no persona change => security not listed
  assert.ok(!diffPhases(prior, prior).includes('security'));
});
