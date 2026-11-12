'use strict';
// REAL BUNDLE: a form and a dashboard are each read and written only as their own kind. `systemforms` holds every
// form kind and every dashboard, and the SDK used to project ANY row a by-id read named through the grammar the caller
// asked for — a dashboard became a "form", a form a "dashboard" — and a push wrote the re-serialized document back. It
// now decodes the row's `type` from the read it already makes and refuses (SYSTEMFORM_KIND_MISMATCH) before it
// projects or writes, and a form push refuses to change the form's type (FORM_TYPE_IMMUTABLE: the platform ignores a
// type change, so the push would report a change that never happened).
//
// The plugin addresses forms and dashboards by id in three places a wrong id can reach: the forms phase (a form it
// resolved or created), the security-roles/order step (form-order-real-bundle.test.js) and a download, which reads
// every dashboard its app's sitemap names. The plugin's own pin checks refuse a wrong pin first (resolveExistingFormId,
// findPinnedDashboard); these pin the SDK's second line and what the download does with it. The stub holds ONE
// systemform row, whose `type` a test changes the way a platform would answer it.
const test = require('node:test');
const assert = require('node:assert');
const ai = require('../lib/artifact-intent.js');
const { readDashboards } = require('../download-model-app.js');
const { createHarness, seedForm, NOTES_CLASS_ID } = require('./helpers/form-store-harness.js');

const spec = {
  $schemaVersion: '1.0',
  solution: { uniqueName: 'Kinds', displayName: 'Kinds', publisherPrefix: 'new' },
  app: { name: 'Kinds', uniqueName: 'new_kinds' },
  entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', existing: true,
    primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [{ schemaName: 'new_code', displayName: 'Code', type: 'Text' }] }],
  forms: [{ entity: 'new_ticket', name: 'Main', tabs: [{ name: 'tab_a', label: 'A', sections: [{ name: 'sec_main', label: 'Main', columns: 1, fields: ['new_name', 'new_code'] }] }] }],
};
const tabs = () => ai.compileFormIntent(spec, spec.forms[0], { notesClassId: NOTES_CLASS_ID }).tabs;

const harnesses = [];
// A harness whose one row is a Main form that has been serialized, and an SDK over it.
async function seeded() {
  const h = createHarness();
  harnesses.push(h);
  await seedForm(h, tabs());
  const { sdk } = await h.freshSdk();
  const patches = () => h.writes.filter((w) => w.method === 'patch');
  return { h, sdk, id: h.formId, patches };
}
test.after(() => { for (const h of harnesses) h.cleanup(); });

const KIND = (code, pattern) => (err) => { assert.strictEqual(err.code, code, err.message); assert.match(err.message, pattern); return true; };

test('a dashboard\u2019s id is refused as a form, and a form\u2019s as a dashboard, and neither is stored', async () => {
  const { h, sdk, id } = await seeded();
  // A Main form (type 2) fetched as a dashboard.
  await assert.rejects(sdk.fetchArtifact('dashboard', id), KIND('SYSTEMFORM_KIND_MISMATCH', /Refusing to fetch systemform '[^']+' as a dashboard: it is a Main form \(type 2\)\. Nothing was read into the workspace\. Fetch it as a form\./));
  assert.deepStrictEqual(await sdk.listArtifacts('dashboard'), [], 'no dashboard copy was stored');
  // The same row, now a dashboard (type 0), fetched as a form.
  h.store.row.type = 0;
  await assert.rejects(sdk.fetchArtifact('form', id), KIND('SYSTEMFORM_KIND_MISMATCH', /as a form: it is a dashboard \(type 0\)\. Nothing was read into the workspace\. Fetch it as a dashboard\./));
  assert.ok(!(await sdk.listArtifacts('form')).some((a) => a.id === id), 'no form copy was stored');
});

test('a form a copy was fetched for, whose row has since become another kind, is refused at push and nothing is written', async () => {
  const { h, sdk, id, patches } = await seeded();
  await sdk.fetchArtifact('form', id);
  await sdk.updateElement('form', id, '/name', 'Renamed');
  h.store.row.type = 10; // an interactive dashboard now holds this id
  const before = patches().length;
  await assert.rejects(sdk.pushArtifact('form', id), KIND('SYSTEMFORM_KIND_MISMATCH', /Refusing to write systemform '[^']+' as a form: it is an? interactive dashboard \(type 10\)\. Nothing was written\./));
  assert.strictEqual(patches().length, before, 'no PATCH');
  assert.notStrictEqual(h.store.row.name, 'Renamed');
});

test('a form push cannot change the form\u2019s type: refused FORM_TYPE_IMMUTABLE, nothing written', async () => {
  // The plugin never edits an existing form's type (a changed `formType` finds no row of that type and creates a new
  // form), so this is the SDK refusing what the platform would silently ignore.
  const { h, sdk, id, patches } = await seeded();
  await sdk.fetchArtifact('form', id);
  await sdk.updateElement('form', id, '/formType', 'QuickCreate');
  const before = patches().length;
  await assert.rejects(sdk.pushArtifact('form', id), KIND('FORM_TYPE_IMMUTABLE', /it would change it from a Main form \(type 2\) to a Quick Create form \(type 7\)\. The platform ignores a type change[\s\S]*Nothing was written\./));
  assert.strictEqual(patches().length, before, 'no PATCH');
  assert.strictEqual(h.store.row.type, 2);
});

test('a form pushed with the type it has is written as it always was', async () => {
  const { sdk, id, patches } = await seeded();
  await sdk.fetchArtifact('form', id);
  await sdk.updateElement('form', id, '/name', 'Renamed');
  const pushed = await sdk.pushArtifact('form', id);
  assert.notStrictEqual(pushed.saved, false, JSON.stringify(pushed.error && pushed.error.message));
  assert.strictEqual(patches().length, 1);
  assert.strictEqual(patches()[0].body.name, 'Renamed');
});

test('download: a sitemap dashboard subarea whose id is a form is reported as unreadable and left out, never read as a dashboard', async () => {
  const { sdk, id } = await seeded();
  const app = { siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'DashBoard', dashboardId: id, title: 'Ops' }] }] }] } };
  const warnings = [];
  const dashboards = await readDashboards(sdk, app, (message) => warnings.push(message));
  assert.deepStrictEqual(dashboards, [], 'nothing is emitted for it');
  assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /^dashboard 'Ops' \([0-9a-f-]{36}\) could not be read: Refusing to fetch systemform '[0-9a-f-]{36}' as a dashboard: it is a Main form \(type 2\)\./);
});
