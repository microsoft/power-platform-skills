'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../lib/classify-changes.js');

// A minimal ANNOTATED spec (pages carry __contentSha as annotateContentHashes would produce).
function spec() {
  return {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A', icon: 'i1', description: 'd1' },
    appShell: { areas: [{ label: 'M', groups: [{ items: [{ entity: 'new_x' }] }] }] },
    entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    relationships: [], globalChoices: [],
    views: [{ entity: 'new_x', name: 'Active X', columns: ['new_name', 'createdon'] }],
    charts: [{ entity: 'new_x', name: 'By Status', kind: 'bar' }],
    forms: [{ entity: 'new_x', name: 'Main', formType: 'Main', layout: 'auto' }],
    commands: [{ entity: 'new_x', name: 'Approve' }],
    dashboards: [{ name: 'Ops' }],
    webResources: [{ name: 'wr_a', type: 'css', __contentSha: 'wsha1' }],
    pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' }, __contentSha: 'psha1' }],
    ai: {}, sampleData: {},
  };
}

test('no prior snapshot -> full build', () => {
  const r = C.classifyChanges(spec(), null);
  assert.strictEqual(r.verdict, 'full');
  assert.match(r.fullReasons[0], /no prior snapshot/);
});

test('identical specs -> noop', () => {
  const r = C.classifyChanges(spec(), spec());
  assert.strictEqual(r.verdict, 'noop');
  assert.deepStrictEqual(r.changedPhases, []);
});

test('a persona-only change forces a FULL build (never a silent changed-only no-op)', () => {
  const prior = spec();
  prior.personas = [{ persona: 'Agent', jobs: [{ name: 'w', privileges: [{ entity: 'new_x', access: ['read'] }] }] }];
  const cur = JSON.parse(JSON.stringify(prior));
  cur.personas[0].jobs[0].privileges[0].access = ['read', 'write']; // widen access
  const r = C.classifyChanges(cur, prior);
  assert.strictEqual(r.verdict, 'full');
  assert.ok(r.changedPhases.includes('security'));
  assert.ok(r.fullReasons.some((x) => /security/.test(x)), JSON.stringify(r.fullReasons));
});

test('adding personas to a spec that had none is a detected (full-build) change', () => {
  const prior = spec();
  const cur = JSON.parse(JSON.stringify(prior));
  cur.personas = [{ persona: 'Agent', jobs: [{ name: 'w', privileges: [{ entity: 'new_x', access: ['read'] }] }] }];
  const r = C.classifyChanges(cur, prior);
  assert.strictEqual(r.verdict, 'full');
  assert.ok(r.changedPhases.includes('security'));
});

test('#1 page CONTENT-only edit -> fast (page shape), no debt', () => {
  const cur = spec();
  cur.pages[0].__contentSha = 'psha2'; // only the .tsx bytes changed
  const r = C.classifyChanges(cur, spec());
  assert.strictEqual(r.verdict, 'fast');
  assert.deepStrictEqual(r.changedPhases, ['pages']);
  assert.strictEqual(r.fastChanges.length, 1);
  assert.strictEqual(r.fastChanges[0].shape, 'page');
  assert.strictEqual(r.debt.length, 0);
});

test('page STRUCTURAL edit (name/nav) -> full build, not a content re-upload', () => {
  const cur = spec();
  cur.pages[0].name = 'Overview 2';
  const r = C.classifyChanges(cur, spec());
  assert.strictEqual(r.verdict, 'full');
  assert.ok(r.fullReasons.some((x) => /structurally/.test(x)));
});

test('page ADDED -> full (creates), page REMOVED -> full + debt', () => {
  const added = spec();
  added.pages.push({ key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'd.tsx' }, __contentSha: 'x' });
  const ra = C.classifyChanges(added, spec());
  assert.strictEqual(ra.verdict, 'full');
  assert.strictEqual(ra.debt.length, 0, 'a new page is created by a full build — no debt');

  const removed = spec();
  removed.pages = [];
  const rr = C.classifyChanges(removed, spec());
  assert.strictEqual(rr.verdict, 'full');
  assert.ok(rr.debt.some((d) => d.artifactType === 'page' && d.reason === 'page-removed'));
});

test('#3 view pure column APPEND -> fast (view shape)', () => {
  const cur = spec();
  cur.views[0].columns = ['new_name', 'createdon', 'new_status']; // appended one
  const r = C.classifyChanges(cur, spec());
  assert.strictEqual(r.verdict, 'fast');
  assert.strictEqual(r.fastChanges[0].shape, 'view');
  assert.match(r.fastChanges[0].detail, /append 1 column/);
  assert.strictEqual(r.debt.length, 0);
});

test('view column REORDER/REMOVE/width edit -> full + debt (engine only unions)', () => {
  const reorder = spec();
  reorder.views[0].columns = ['createdon', 'new_name']; // reordered — breaks the prefix
  const rr = C.classifyChanges(reorder, spec());
  assert.strictEqual(rr.verdict, 'full');
  assert.ok(rr.debt.some((d) => d.reason === 'view-nonappend-edit'));

  const removed = spec();
  removed.views[0].columns = ['new_name']; // removed createdon
  const rm = C.classifyChanges(removed, spec());
  assert.strictEqual(rm.verdict, 'full');
  assert.ok(rm.debt.some((d) => d.reason === 'view-nonappend-edit'));
});

test('view ADDED -> full build (no debt)', () => {
  const cur = spec();
  cur.views.push({ entity: 'new_x', name: 'Inactive X', columns: ['new_name'] });
  const r = C.classifyChanges(cur, spec());
  assert.strictEqual(r.verdict, 'full');
  assert.strictEqual(r.debt.length, 0);
});

test('#4 app-shell SITEMAP-only change -> fast (app icon/description unchanged)', () => {
  const cur = spec();
  cur.appShell.areas[0].groups[0].items.push({ entity: 'new_y' }); // sitemap grew
  const r = C.classifyChanges(cur, spec());
  assert.strictEqual(r.verdict, 'fast');
  assert.strictEqual(r.fastChanges[0].shape, 'app-shell');
});

test('app ICON/description change -> full (not a sitemap-only edit)', () => {
  const cur = spec();
  cur.app.icon = 'i2';
  const r = C.classifyChanges(cur, spec());
  assert.strictEqual(r.verdict, 'full');
  assert.ok(r.fullReasons.some((x) => /app object/.test(x)));
});

test('data-model change -> full build, NO debt (a full build applies it)', () => {
  const cur = spec();
  cur.entities[0].columns.push({ schemaName: 'new_amount', type: 'Money' });
  const r = C.classifyChanges(cur, spec());
  assert.strictEqual(r.verdict, 'full');
  assert.ok(r.fullReasons.some((x) => /data-model/.test(x)));
  assert.strictEqual(r.debt.length, 0);
});

test('chart/command/dashboard EDIT (existing) -> full + debt; ADD -> full no debt', () => {
  const edit = spec();
  edit.charts[0].kind = 'pie'; // additive engine skips this edit
  const re = C.classifyChanges(edit, spec());
  assert.strictEqual(re.verdict, 'full');
  assert.ok(re.debt.some((d) => d.artifactType === 'chart' && d.reason === 'chart-edit-not-convergent'));

  const add = spec();
  add.charts.push({ entity: 'new_x', name: 'By Owner', kind: 'bar' });
  const ra = C.classifyChanges(add, spec());
  assert.strictEqual(ra.verdict, 'full');
  assert.strictEqual(ra.debt.length, 0, 'a new chart is created by a full build');
});

test('web-resource CONTENT edit -> full + debt (content skipped on rebuild)', () => {
  const cur = spec();
  cur.webResources[0].__contentSha = 'wsha2';
  const r = C.classifyChanges(cur, spec());
  assert.strictEqual(r.verdict, 'full');
  assert.ok(r.debt.some((d) => d.artifactType === 'webResource' && d.reason === 'webResource-edit-not-convergent'));
});

test('form EDIT -> full + debt-candidate (placement verified at build time); ADD -> full no debt', () => {
  const edit = spec();
  edit.forms[0].layout = 'explicit';
  const re = C.classifyChanges(edit, spec());
  assert.strictEqual(re.verdict, 'full');
  assert.ok(re.debt.some((d) => d.artifactType === 'form' && d.reason === 'form-edit-verify-at-build'));

  const add = spec();
  add.forms.push({ entity: 'new_x', name: 'Quick', formType: 'QuickCreate', layout: 'auto' });
  const ra = C.classifyChanges(add, spec());
  assert.strictEqual(ra.verdict, 'full');
  assert.strictEqual(ra.debt.length, 0);
});

test('MIXED: a fast page edit + an unsupported chart edit -> verdict FULL (the chart forces it) with chart debt', () => {
  const cur = spec();
  cur.pages[0].__contentSha = 'psha2'; // would be a fast page shape alone
  cur.charts[0].kind = 'pie';          // but this forces a full build
  const r = C.classifyChanges(cur, spec());
  assert.strictEqual(r.verdict, 'full', 'ANY full reason downgrades the whole apply to full');
  assert.ok(r.debt.some((d) => d.artifactType === 'chart'));
});

test('MULTIPLE fast shapes together (page content + view append + sitemap) -> fast with 3 shapes', () => {
  const cur = spec();
  cur.pages[0].__contentSha = 'psha2';
  cur.views[0].columns = ['new_name', 'createdon', 'new_status'];
  cur.appShell.areas[0].groups[0].items.push({ entity: 'new_y' });
  const r = C.classifyChanges(cur, spec());
  assert.strictEqual(r.verdict, 'fast');
  const shapes = r.fastChanges.map((c) => c.shape).sort();
  assert.deepStrictEqual(shapes, ['app-shell', 'page', 'view']);
  assert.strictEqual(r.debt.length, 0);
});

test('isColumnPrefix: exact leading prefix only', () => {
  assert.strictEqual(C.isColumnPrefix(['a', 'b'], ['a', 'b', 'c']), true);
  assert.strictEqual(C.isColumnPrefix(['a', 'b'], ['a', 'b']), true);
  assert.strictEqual(C.isColumnPrefix(['a', 'c'], ['a', 'b', 'c']), false);
  assert.strictEqual(C.isColumnPrefix(['a', 'b', 'c'], ['a', 'b']), false, 'longer prefix is never a prefix');
});

test('equalExcept ignores the named keys, order-independent', () => {
  assert.ok(C.equalExcept({ a: 1, b: 2, __x: 9 }, { b: 2, a: 1, __x: 5 }, ['__x']));
  assert.ok(!C.equalExcept({ a: 1, __x: 9 }, { a: 2, __x: 9 }, ['__x']));
});
