'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { stageFacts } = require('../lib/facts.js');

// A minimal but valid schemaVersion:2 spec covering all stage primitives: one entity with a
// Choice column, a view, a chart, a form, an intent page (no .tsx), and a sitemap subarea for each.
// The page key and name are the same string to avoid the linter's name-vs-key ambiguity in subarea
// references (spec-lint.js validates sa.page against p.name, not p.key).
const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  app: { name: 'T', description: '' },
  entities: [{
    schemaName: 'new_order', displayName: 'Order',
    primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [{ schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['New', 'Done'] }],
  }],
  views: [{ entity: 'new_order', name: 'Active Orders', columns: ['new_name', 'new_status'], activeOnly: true }],
  charts: [{ entity: 'new_order', name: 'Orders by Status', groupBy: 'new_status', measure: 'count', chartType: 'Pie' }],
  forms: [{ entity: 'new_order', type: 'main', name: 'Order', layout: 'auto' }],
  // The page's name matches the key (both "overview"); validateAppSpec(v2) checks sa.page against
  // page keys, while lintAppSpec checks against page names — making key === name satisfies both.
  pages: [{ key: 'overview', name: 'overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'overview' }] }],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [
    { entity: 'new_order', title: 'Orders' },
    { page: 'overview', title: 'Overview' },
  ] }] }] },
};

test('stageFacts.author validates under the plan profile and lints clean', async () => {
  const f = await stageFacts(spec);
  assert.strictEqual(f.author.validate.ok, true, JSON.stringify(f.author.validate.errors));
  assert.strictEqual(f.author.lint.errors.length, 0, JSON.stringify(f.author.lint.errors));
});

test('stageFacts.data/ui expose normalized structural facts', async () => {
  const f = await stageFacts(spec);
  assert.deepStrictEqual(f.data.tables.map((t) => t.logicalName), ['new_order']);
  assert.deepStrictEqual(f.ui.views.map((v) => v.name), ['Active Orders']);
  assert.deepStrictEqual(f.ui.charts.map((c) => c.name), ['Orders by Status']);
  assert.ok(f.ui.forms[0].fields.includes('new_name'), 'primary field placed in form');
});

test('stageFacts.app resolves every sitemap subarea and reports no dangling nav', async () => {
  const f = await stageFacts(spec);
  const refs = f.app.areas.flatMap((a) => a.groups.flatMap((g) => g.subAreas.map((s) => s.ref)));
  assert.ok(refs.every((r) => r), `all subareas should have a resolved ref; got ${JSON.stringify(refs)}`);
  // overview→overview: targetKey "overview" matches p.key "overview" → not dangling.
  assert.deepStrictEqual(f.app.danglingNav, []);
});

test('stageFacts.plan groups items by known engine phase; verify runs offline', async () => {
  const f = await stageFacts(spec);
  assert.ok(f.plan.phases.every((p) => f.PHASES.includes(p)), `unknown phase in plan: ${f.plan.phases.filter((p) => !f.PHASES.includes(p))}`);
  // verifySpec either succeeds (ok:true) or degrades gracefully (skipped string) — never throws.
  assert.ok(f.verify.ok === true || typeof f.verify.skipped === 'string', `unexpected verify result: ${JSON.stringify(f.verify)}`);
});
