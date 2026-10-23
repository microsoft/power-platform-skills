'use strict';
// A download keeps a table's plural when a rebuild would not derive it. A plain plural used to be left out of every download as
// "derivable", but only "<display name>s" is: "Tag Catalog" is not derivable from "Tag", so a downloaded spec rebuilt into another
// environment named the table "Tags". Now the download leaves out exactly the plural the build's own derivation (derivedPluralName,
// lib/app-spec.js) writes for a spec without one, and keeps every other. Pinned at two levels:
//   - the projection (entityFromMetadata): which plurals are written, the bytes of an ordinary table (unchanged), localized labels
//     (unchanged), and the one derivation the build, lint and the download share;
//   - the round trip over the REAL vendored SDK and the lifecycle fake (helpers/fake-lifecycle-org.js, helpers/lifecycle-harness.js):
//     build -> download -> the plural where one is needed; the downloaded spec rebuilt in place writes no table; built into a fresh
//     environment it names each table as the first one does.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, appUniqueName } = require('./helpers/lifecycle-harness.js');
const { entityFromMetadata } = require('../download-model-app.js');
const { derivedPluralName, validateAppSpec } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');

// ====================================================================================================================================
// THE PROJECTION. `meta` is what readEntityWithDescriptions hands entityFromMetadata: the SDK's flattened `displayName`, and the raw
// Dataverse labels of the table read beside it.

const dvLabel = (pairs) => ({ LocalizedLabels: pairs.map(([LanguageCode, Label]) => ({ Label, LanguageCode })) });
const tableMeta = (singular, plural, extra = {}) => ({
  logicalName: 'contoso_tag', schemaName: 'contoso_tag', displayName: typeof singular === 'string' ? singular : 'Tag', primaryNameAttribute: 'contoso_name',
  ...(singular !== undefined ? { DisplayName: typeof singular === 'string' ? dvLabel([[1033, singular]]) : dvLabel(Object.entries(singular).map(([k, v]) => [Number(k), v])) } : {}),
  ...(plural !== undefined ? { DisplayCollectionName: typeof plural === 'string' ? dvLabel([[1033, plural]]) : dvLabel(Object.entries(plural).map(([k, v]) => [Number(k), v])) } : {}),
  attributes: [],
  ...extra,
});

test('a plain plural that is not the display name plus "s" is written, because a rebuild would derive another', () => {
  assert.equal(entityFromMetadata(tableMeta('Tag', 'Tag Catalog'), 'contoso_tag').pluralName, 'Tag Catalog');
  assert.equal(entityFromMetadata(tableMeta('Box', 'Boxes'), 'contoso_tag').pluralName, 'Boxes');
  // Exact, as the build writes it: a plural that differs from the derivation only in case is a different label.
  assert.equal(entityFromMetadata(tableMeta('Tag', 'tags'), 'contoso_tag').pluralName, 'tags');
});

test('a plain plural a rebuild would derive is left out, and the table downloads byte for byte as before', () => {
  const e = entityFromMetadata(tableMeta('Tag', 'Tags'), 'contoso_tag');
  assert.equal('pluralName' in e, false);
  // The bytes an earlier release wrote for this table, unchanged.
  assert.equal(JSON.stringify(e), '{"schemaName":"contoso_tag","displayName":"Tag","primaryAttribute":{"schemaName":"contoso_name","displayName":"Name"},"columns":[],"existing":true}');
});

test('a localized plural, or a plural beside a localized display name, is written exactly as before', () => {
  const both = entityFromMetadata(tableMeta({ 1033: 'Tag', 3082: 'Etiqueta' }, { 1033: 'Tags', 3082: 'Etiquetas' }), 'contoso_tag');
  assert.equal(JSON.stringify({ displayName: both.displayName, pluralName: both.pluralName }), '{"displayName":{"1033":"Tag","3082":"Etiqueta"},"pluralName":{"1033":"Tags","3082":"Etiquetas"}}');
  // A plural that is derivable in English is still written beside a localized display name: validateAppSpec requires it there.
  const singularLocalized = entityFromMetadata(tableMeta({ 1033: 'Tag', 3082: 'Etiqueta' }, 'Tags'), 'contoso_tag');
  assert.equal(singularLocalized.pluralName, 'Tags');
  const pluralLocalized = entityFromMetadata(tableMeta('Tag', { 1033: 'Tags', 3082: 'Etiquetas' }), 'contoso_tag');
  assert.deepEqual(pluralLocalized.pluralName, { 1033: 'Tags', 3082: 'Etiquetas' });
});

test('without a usable display label, the plural is compared with the one derived from the name the spec falls back to', () => {
  // The table's own label is empty, so the spec carries the SDK's flattened `displayName` — and the derivation is of that.
  const derivable = entityFromMetadata(tableMeta(undefined, 'Tags', { DisplayName: dvLabel([]) }), 'contoso_tag');
  assert.equal(derivable.displayName, 'Tag');
  assert.equal('pluralName' in derivable, false);
  const kept = entityFromMetadata(tableMeta(undefined, 'Tag Catalog', { DisplayName: dvLabel([]) }), 'contoso_tag');
  assert.equal(kept.pluralName, 'Tag Catalog');
  // With no table labels read at all (that read failed), there is no plural to write, as before.
  assert.equal('pluralName' in entityFromMetadata(tableMeta(undefined, undefined), 'contoso_tag'), false);
});

test('derivedPluralName is the build\'s rule: the display name in the build\'s language, else the schema name, plus "s"', () => {
  assert.equal(derivedPluralName({ schemaName: 'contoso_tag', displayName: 'Tag' }), 'Tags');
  assert.equal(derivedPluralName({ schemaName: 'contoso_tag' }), 'contoso_tags');
  assert.equal(derivedPluralName({ schemaName: 'contoso_tag', displayName: '' }), 'contoso_tags');
  assert.equal(derivedPluralName({ schemaName: 'contoso_tag', displayName: { 1033: 'Tag', 3082: 'Etiqueta' } }, 3082), 'Etiquetas');
  assert.equal(derivedPluralName({ schemaName: 'contoso_tag', displayName: { 1033: 'Tag', 3082: 'Etiqueta' } }), 'Tags');
});

test('lint names the stock default views by the same derivation the build writes', () => {
  // A view named like a table's "Active <plural>" merges onto that stock view; lint must predict the plural the build will write.
  const spec = (pluralName, viewName) => ({
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoTags', publisherPrefix: 'contoso' },
    app: { name: 'Tags' },
    entities: [{ schemaName: 'contoso_tag', displayName: 'Tag', ...(pluralName ? { pluralName } : {}), primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    views: [{ entity: 'contoso_tag', name: viewName, columns: ['contoso_name'] }],
  });
  const merges = (s) => lintAppSpec(s).warnings.some((w) => /stock default view/.test(w));
  assert.equal(merges(spec(undefined, 'Active Tags')), true);
  assert.equal(merges(spec('Tag Catalog', 'Active Tag Catalog')), true);
  assert.equal(merges(spec('Tag Catalog', 'Active Tags')), false);
});

// ====================================================================================================================================
// THE ROUND TRIP, over the real bundle. One environment, walked in order: the build, the download, the rebuild of the downloaded spec,
// and the same spec built into a fresh environment.

// One table of each kind: no plural (the build derives "Tags"), a plural a rebuild derives ("Orders"), and two it does not ("Ledger" for
// "Ledger Entry", and "Boxes", which is not "Box" plus "s").
const spec = {
  schemaVersion: 2,
  minimumPluginVersion: '2.13.0',
  solution: { uniqueName: 'ContosoStock', displayName: 'Contoso Stock', publisherPrefix: 'contoso', description: 'Stock keeping.' },
  app: { name: 'Stock Room', description: 'What is in the stock room.' },
  entities: [
    { schemaName: 'contoso_tag', displayName: 'Tag', description: 'A label.', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] },
    { schemaName: 'contoso_order', displayName: 'Order', pluralName: 'Orders', description: 'An order.', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] },
    { schemaName: 'contoso_ledgerentry', displayName: 'Ledger Entry', pluralName: 'Ledger', description: 'A line of the ledger.', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] },
    { schemaName: 'contoso_box', displayName: 'Box', pluralName: 'Boxes', description: 'A box on a shelf.', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] },
  ],
  appShell: { areas: [{ label: 'Stock', groups: [{ label: 'Records', subAreas: [
    { entity: 'contoso_tag', title: 'Tags' }, { entity: 'contoso_order', title: 'Orders' },
    { entity: 'contoso_ledgerentry', title: 'Ledger' }, { entity: 'contoso_box', title: 'Boxes' },
  ] }] }] },
};

// Each table's plural as the environment holds it.
const plurals = (org) => Object.fromEntries(spec.entities.map((e) => {
  const table = org.metadata.tables.get(e.schemaName);
  return [e.schemaName, table ? org.metadata.textOf(table.DisplayCollectionName) : null];
}));

const ran = (step, what) => {
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${what} sent is one the fake models`);
  return step;
};

let walkP;
const walk = () => walkP || (walkP = (async () => {
  const org = createLifecycleOrg();
  const root = makeTempDir('download-plural-');
  const harness = createLifecycleHarness(org, root);
  const build = ran(await harness.measure(() => harness.build(spec)), 'the build');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  const built = plurals(org);
  const download = ran(await harness.measure(() => harness.download(appUniqueName(spec), path.join(root, 'download'))), 'the download');
  return { org, root, harness, built, download };
})());

test('the build names a table without a plural by the derivation, and keeps each one the spec gives', async () => {
  const { built } = await walk();
  assert.deepEqual(built, { contoso_tag: 'Tags', contoso_order: 'Orders', contoso_ledgerentry: 'Ledger', contoso_box: 'Boxes' });
  assert.equal(built.contoso_tag, derivedPluralName(spec.entities[0], 1033));
});

test('a download writes the plural of each table a rebuild would name differently, and only those', async () => {
  const { download } = await walk();
  const { emitted, spec: downloaded } = download.value;
  assert.equal(emitted.ok, true, JSON.stringify(emitted));
  assert.deepEqual(Object.fromEntries(downloaded.entities.map((e) => [e.schemaName, e.pluralName === undefined ? null : e.pluralName])), {
    contoso_tag: null, contoso_order: null, contoso_ledgerentry: 'Ledger', contoso_box: 'Boxes',
  });
  assert.deepEqual(validateAppSpec(downloaded, { profile: 'plan', reconstructed: true }).errors, []);
});

test('the downloaded spec rebuilt in the same environment writes no table', async () => {
  const { org, harness, root, download } = await walk();
  const before = org.inventory();
  const dir = path.join(root, 'download');
  const rebuild = ran(await harness.measure(() => harness.build(download.value.spec, { appFolder: dir, workspace: path.join(dir, '.maker-workspace') })), 'the rebuild of the downloaded spec');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result.errors));
  const tableWrites = Object.keys(rebuild.writes).filter((w) => /EntityDefinitions/.test(w));
  assert.deepEqual(tableWrites, [], `no table is created or changed: ${JSON.stringify(rebuild.writes)}`);
  assert.deepEqual(org.inventory(), before);
});

test('the downloaded spec built into a fresh environment names each table as the first environment does', async () => {
  const { built, download } = await walk();
  const org = createLifecycleOrg();
  const harness = createLifecycleHarness(org, makeTempDir('download-plural-fresh-'));
  const build = ran(await harness.measure(() => harness.build(download.value.spec)), 'the build into a fresh environment');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  assert.deepEqual(plurals(org), built);
});
