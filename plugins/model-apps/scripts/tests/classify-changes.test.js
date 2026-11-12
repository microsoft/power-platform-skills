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

// #583: the fast app-shell apply writes only the sitemap, so a routing-description edit riding on it
// would be dropped. The app object is compared WHOLE, which is what routes this to a full build — pin
// it so narrowing that comparison to named keys cannot silently skip `app.aiDescription`.
test('#583 an app.aiDescription-only change -> full, and phase-diff reports app-shell', () => {
  const prior = spec();
  const cur = spec();
  cur.app.aiDescription = 'Route order work here.';
  const r = C.classifyChanges(cur, prior);
  assert.strictEqual(r.verdict, 'full');
  assert.ok(r.fullReasons.some((x) => /app object/.test(x)));
  assert.deepStrictEqual(require('../lib/phase-diff.js').diffPhases(cur, prior), ['app-shell']);
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

// #845: two declared views of one name on one table, each under its own key.
const twins = (s) => { s.views = [{ key: 'v1', entity: 'new_x', name: 'Twin', reconcile: 'declared', columns: ['new_name'] }, { key: 'v2', entity: 'new_x', name: 'Twin', reconcile: 'declared', columns: ['new_name', 'createdon'] }]; return s; };

test('#845: an edit of the EARLIER of two same-named views is seen — with a page edit it is never a pages-only change', () => {
  const prior = twins(spec());
  const cur = twins(spec());
  cur.views[0].columns.push('createdon'); // an append to v1, the view the later namesake used to hide
  cur.pages[0].__contentSha = 'psha2';
  const r = C.classifyChanges(cur, prior);
  assert.deepStrictEqual(r.fastChanges.map((c) => [c.shape, c.identity]), [['view', 'new_x|Twin (view key v1)'], ['page', 'overview']]);
  // A non-append edit of v1 is a full build with debt named by its key.
  const edited = twins(spec());
  edited.views[0].columns = ['createdon'];
  edited.pages[0].__contentSha = 'psha2';
  const e = C.classifyChanges(edited, prior);
  assert.strictEqual(e.verdict, 'full');
  // The debt is owed under the view's name and key, not its label (a view may be named like a label; see below).
  assert.deepStrictEqual(e.debt, [{ artifactType: 'view', identity: '["new_x|Twin","v1"]', reason: 'view-nonappend-edit' }]);
  assert.match(e.fullReasons.join('\n'), /view 'new_x\|Twin \(view key v1\)' changed beyond a pure column-append/);
});

test('#845 controls: the later namesake edit, a pages-only change, a second key added and a key removed', () => {
  const prior = twins(spec());
  const later = twins(spec());
  later.views[1].columns.push('modifiedon');
  later.pages[0].__contentSha = 'psha2';
  assert.deepStrictEqual(C.classifyChanges(later, prior).fastChanges.map((c) => [c.shape, c.identity]), [['view', 'new_x|Twin (view key v2)'], ['page', 'overview']]);
  const pagesOnly = twins(spec());
  pagesOnly.pages[0].__contentSha = 'psha2';
  const p = C.classifyChanges(pagesOnly, prior);
  assert.strictEqual(p.verdict, 'fast');
  assert.deepStrictEqual(p.fastChanges.map((c) => c.shape), ['page']);
  const one = spec();
  one.views = [prior.views[0]];
  const added = C.classifyChanges(prior, one);
  assert.strictEqual(added.verdict, 'full');
  assert.match(added.fullReasons[0], /1 new view\(s\) added/);
  assert.deepStrictEqual(added.debt, []);
  const removed = C.classifyChanges(one, prior);
  assert.deepStrictEqual(removed.debt, [{ artifactType: 'view', identity: '["new_x|Twin","v2"]', reason: 'view-removed' }]);
});

test('#845: two changed views keep two debt entries when one is named like the label of the other\'s key', () => {
  // 'Twin (view key v2)' is a legal view name of its own: a debt identity built from the label would make it and the keyed v2 one entry.
  const views = (s) => { s.views = [...twins(s).views, { key: 'third', entity: 'new_x', name: 'Twin (view key v2)', reconcile: 'declared', columns: ['new_name'] }]; return s; };
  const prior = views(spec());
  const cur = views(spec());
  cur.views[1].columns = ['createdon'];
  cur.views[2].columns = ['createdon'];
  cur.pages[0].__contentSha = 'psha2';
  const r = C.classifyChanges(cur, prior);
  assert.strictEqual(r.verdict, 'full');
  assert.deepStrictEqual(r.debt, [
    { artifactType: 'view', identity: '["new_x|Twin","v2"]', reason: 'view-nonappend-edit' },
    { artifactType: 'view', identity: 'new_x|Twin (view key v2)', reason: 'view-nonappend-edit' },
  ]);
  // The messages still name each view as a person reads it.
  assert.deepStrictEqual(r.fullReasons.filter((m) => /beyond a pure column-append/.test(m)).length, 2);
});

test('#845: same-named views without a key of their own each cannot be aligned — any change among them is a full build with debt', () => {
  const legacy = (s) => { s.views = [{ entity: 'new_x', name: 'Twin', columns: ['new_name'] }, { entity: 'new_x', name: 'Twin', columns: ['new_name', 'createdon'] }]; return s; };
  const prior = legacy(spec());
  const cur = legacy(spec());
  cur.views[0].columns.push('createdon');
  cur.pages[0].__contentSha = 'psha2';
  const r = C.classifyChanges(cur, prior);
  assert.strictEqual(r.verdict, 'full');
  assert.deepStrictEqual(r.debt, [{ artifactType: 'view', identity: 'new_x|Twin', reason: 'view-nonappend-edit' }]);
  // Unchanged, they are left alone: a page edit beside them is still a pages-only change.
  const still = legacy(spec());
  still.pages[0].__contentSha = 'psha2';
  assert.deepStrictEqual(C.classifyChanges(still, prior).fastChanges.map((c) => c.shape), ['page']);
});

test('a changed phase in which no change could be classified forces a full build, even beside a fast page edit', () => {
  const prior = spec();
  prior.views.push({ entity: 'new_x', name: 'Other', columns: ['new_name'] });
  const cur = spec();
  cur.views = [prior.views[1], prior.views[0]]; // the same views in another order: the slice differs, no view changed
  cur.pages[0].__contentSha = 'psha2';
  const r = C.classifyChanges(cur, prior);
  assert.strictEqual(r.verdict, 'full');
  assert.deepStrictEqual(r.fullReasons, ['views: changed, but no change in it could be classified — full build (fail-closed)']);
  assert.deepStrictEqual(r.debt, []);
});
