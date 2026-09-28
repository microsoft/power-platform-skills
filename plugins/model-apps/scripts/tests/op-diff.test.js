'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { classifyOps, sitemapTargets, formRemovals } = require(path.join(__dirname, '..', 'lib', 'op-diff.js'));

const desk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8'));

// Minimal form topology matching artifact-intent.js formFieldLogicals' walk:
// tabs[].columns[].sections[].rows[].cells[].control.fieldName
const cell = (fn) => ({ control: { fieldName: fn } });
const formOf = (fields) => ({ tabs: [{ columns: [{ sections: [{ rows: fields.map((f) => ({ cells: [cell(f)] })) }] }] }] });

test('sitemapTargets extracts entity/url subareas (lowercased); omits dashboard/genpage subareas', () => {
  const container = { areas: [{ groups: [{ subAreas: [
    { entity: 'New_Ticket', title: 'Tickets' },
    { url: 'https://x/y' },
    { dashboard: 'Ops' }, // omitted — not id-comparable from a read-only fetch (design §11 v1)
    { pageKey: 'home' },  // omitted
  ] }] }] };
  assert.deepStrictEqual(sitemapTargets(container), ['entity:new_ticket', 'url:https://x/y']);
});

test('sitemapTargets tolerates an empty/missing container', () => {
  assert.deepStrictEqual(sitemapTargets({}), []);
  assert.deepStrictEqual(sitemapTargets({ areas: [] }), []);
  assert.deepStrictEqual(sitemapTargets(null), []);
});

test('formRemovals returns pruned fields for an explicit layout only (never the primary)', () => {
  const def = Object.assign(formOf(['new_name', 'new_subject']), { __explicitLayout: true, __primaryField: 'new_name' });
  const deployed = formOf(['new_name', 'new_subject', 'new_priority', 'new_stale']);
  assert.deepStrictEqual(formRemovals(deployed, def), ['new_priority', 'new_stale']);
});

test('formRemovals never removes the primary field, even if absent from the want set', () => {
  const def = Object.assign(formOf(['new_subject']), { __explicitLayout: true, __primaryField: 'new_name' });
  const deployed = formOf(['new_name', 'new_subject']);
  assert.deepStrictEqual(formRemovals(deployed, def), []);
});

test('formRemovals is empty for an auto layout (auto never prunes)', () => {
  const def = Object.assign(formOf(['new_subject']), { __explicitLayout: false, __primaryField: 'new_name' });
  const deployed = formOf(['new_name', 'new_subject', 'new_priority']);
  assert.deepStrictEqual(formRemovals(deployed, def), []);
});

test('classifyOps: no destructive ops when nothing is discovered', () => {
  assert.deepStrictEqual(classifyOps({ app: { name: 'X' } }, {}), { destructive: [], hasDestructive: false });
});

test('classifyOps: an existing app is an app-collision op', () => {
  const r = classifyOps({ app: { name: 'Support Desk' } }, { collision: { appExists: true, appUnique: 'new_supportdesk' } });
  assert.strictEqual(r.hasDestructive, true);
  assert.strictEqual(r.destructive.length, 1);
  assert.strictEqual(r.destructive[0].kind, 'app-collision');
  assert.match(r.destructive[0].label, /new_supportdesk/);
});

test('classifyOps: an existing SOLUTION alone (no app) is NOT a collision — normal run-1->run-2 reuse', () => {
  // Locks the safety-critical invariant: only appExists is destructive. A regression that started
  // reading solutionExists would silently block every second build (the solution always exists on
  // rebuild), yet would pass every other test — so this negative must be asserted explicitly.
  const r = classifyOps({ app: { name: 'X' } }, { collision: { appExists: false, solutionExists: true, solutionName: 'contoso' } });
  assert.deepStrictEqual(r, { destructive: [], hasDestructive: false });
});

test('classifyOps: an explicit-layout form field removal is destructive', () => {
  const def = Object.assign(formOf(['new_name']), { __explicitLayout: true, __primaryField: 'new_name' });
  const deployed = formOf(['new_name', 'new_priority']);
  const r = classifyOps({}, { forms: [{ label: 'form "Ticket" (new_ticket)', deployedForm: deployed, def }] });
  assert.strictEqual(r.hasDestructive, true);
  assert.strictEqual(r.destructive[0].kind, 'form-field-removal');
  assert.match(r.destructive[0].detail, /new_priority/);
});

test('classifyOps: an auto-layout form in discovered.forms is never destructive', () => {
  // End-to-end guard on the classifyOps form-loop (not just the formRemovals unit): an auto layout
  // is additive-only, so even with fields on the deployed form that the spec no longer lists, the
  // gate must NOT flag it.
  const def = Object.assign(formOf(['new_name']), { __explicitLayout: false, __primaryField: 'new_name' });
  const deployed = formOf(['new_name', 'new_priority', 'new_stale']);
  const r = classifyOps({}, { forms: [{ label: 'form "Ticket" (new_ticket)', deployedForm: deployed, def }] });
  assert.deepStrictEqual(r, { destructive: [], hasDestructive: false });
});

test('classifyOps: a dropped sitemap target is destructive', () => {
  const r = classifyOps({}, { sitemap: { deployedTargets: ['entity:new_customer', 'entity:new_ticket'], wantTargets: ['entity:new_customer'] } });
  assert.strictEqual(r.hasDestructive, true);
  assert.strictEqual(r.destructive[0].kind, 'sitemap-removal');
  assert.match(r.destructive[0].detail, /entity:new_ticket/);
});

test('classifyOps: teardown mode maps every planTeardown step to a destructive op', () => {
  const r = classifyOps(desk, {}, { teardown: true });
  assert.strictEqual(r.hasDestructive, true);
  assert.ok(r.destructive.length > 0);
  assert.ok(r.destructive.every((o) => o.kind === 'teardown'));
  assert.ok(r.destructive.some((o) => /app module/.test(o.label)), 'includes the app-module delete');
  assert.ok(r.destructive.some((o) => /^table /.test(o.label)), 'includes a table delete');
});
