'use strict';
// The LANGUAGE of Choice option labels two options share, through download and rebuild — over the REAL vendored SDK, the plugin's own
// HTTP client and the stateful fake Dataverse the lifecycle tests share (helpers/fake-lifecycle-org.js, which stores each label under the
// LCID it was sent with, as Dataverse does).
//
// Dataverse lets two options of a column carry the same label. A download keeps a label held in one language other than its authoring
// language as a one-entry map, and the validator refuses a text two options share when it is not visible on the line. A download used to
// write EVERY option of such a column as a plain string to keep the column typed — so one shared label moved every option's label, the
// unrelated ones too, into the language a rebuild resolves, and no warning said a language was lost. These cases pin, by what a fresh
// environment holds after the rebuild:
//   * two options sharing their text in ONE language keep it (a duplicate the validator warns about, as it does two plain strings), and
//     so does every other option;
//   * two options sharing their text in DIFFERENT languages are the only ones written as plain strings — the only shape the spec takes
//     for them — and the download names each label that loses its language; every other option keeps its own;
//   * two options labelled alike as Dataverse holds them — it fills the base language in with the same text, so each label holds two
//     languages, identically — keep the column typed and both labels (it was captured untyped);
//   * a text two options hold in different languages still leaves the column untyped, and the warning says so — not that the option set
//     could not be read, which stays the warning for an option set that really was not read.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, appUniqueName } = require('./helpers/lifecycle-harness.js');
const { validateAppSpec } = require('../lib/app-spec.js');

const LANGUAGES = { baseLanguage: 1033, provisionedLanguages: [1033, 1036, 3082] };
// A Choice column whose options are labelled in French and Spanish only, built in an environment whose base language is English.
const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoStages', displayName: 'Contoso Stages', publisherPrefix: 'contoso' },
  app: { name: 'Stages' },
  entities: [{
    schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
    columns: [{ schemaName: 'contoso_stage', type: 'Choice', displayName: 'Stage', options: [{ 1036: 'Ouvert' }, { 3082: 'Abierto' }, { 3082: 'Cerrado' }] }],
  }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
};

const ran = (step, label) => {
  assert.ok(step, `${label} ran`);
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
};
const options = (org) => org.metadata.tables.get('contoso_item').Attributes.get('contoso_stage').OptionSet.Options;
// What an environment holds of the column's options, `<LCID>:<text>` per language each holds — or, where a rebuild made the column
// without its type, what it made instead.
const held = (org) => {
  const column = org.metadata.tables.get('contoso_item').Attributes.get('contoso_stage');
  if (!column.OptionSet) return [`a ${column.AttributeType} column, with no options`];
  return options(org).map((o) => o.Label.LocalizedLabels.map((l) => `${l.LanguageCode}:${l.Label}`).join(' '));
};

// A Label as the platform stores one: `[1033, 'Abierto'], [3082, 'Abierto']` is held in those two languages.
const labelled = (...pairs) => ({ LocalizedLabels: pairs.map(([LanguageCode, Label]) => ({ Label, LanguageCode, IsManaged: false })), UserLocalizedLabel: null });
const relabelSecond = (lcid, text) => (held) => { held[1].Label = labelled([lcid, text]); };

// The source with the column built, its options relabelled as a maker can in the designer (`relabel` gets the stored options; Dataverse
// allows a label two options share), and the spec a download of it writes. `refuseOptionSets` answers the download's option-set read with
// a 503, as a service that is down for a moment does.
async function downloaded(relabel, { refuseOptionSets = false } = {}) {
  const org = createLifecycleOrg(LANGUAGES);
  const state = { refuse: false };
  const request = async (req) => {
    const url = decodeURIComponent(String(req.url));
    if (state.refuse && req.method === 'GET' && url.includes('/Microsoft.Dynamics.CRM.PicklistAttributeMetadata') && url.includes('OptionSet')) {
      return { statusCode: 503, headers: { 'content-type': 'application/json; odata.metadata=minimal' }, body: JSON.stringify({ error: { code: '0x80040216', message: 'The service is unavailable.' } }) };
    }
    return org.request(req);
  };
  const root = makeTempDir('option-label-language-');
  const harness = createLifecycleHarness({ ...org, request }, root);
  const build = ran(await harness.measure(() => harness.build(spec)), 'the source build');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  if (relabel) relabel(options(org));
  state.refuse = refuseOptionSets;
  const download = ran(await harness.measure(() => harness.download(appUniqueName(spec), path.join(root, 'download'))), 'the download');
  assert.equal(download.value.emitted.ok, true, JSON.stringify(download.value.emitted));
  const got = download.value.spec;
  assert.deepEqual(validateAppSpec(got, { profile: 'plan', reconstructed: true }).errors, []);
  const column = got.entities[0].columns.find((c) => c.schemaName === 'contoso_stage');
  return { root, spec: got, source: held(org), column, warnings: download.value.stderr.split('\n').filter((line) => line.startsWith('WARNING: ')) };
}

// The same, and what a fresh environment holds after a rebuild of the downloaded spec.
async function roundTrip(relabel) {
  const trip = await downloaded(relabel);
  const fresh = createLifecycleOrg(LANGUAGES);
  const target = createLifecycleHarness(fresh, path.join(trip.root, 'fresh'));
  const rebuild = ran(await target.measure(() => target.build(trip.spec)), 'the fresh build');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result.errors));
  return { ...trip, fresh: held(fresh) };
}

test('option label language: two options sharing their text in one language keep it through download and rebuild, and so does every other option', async () => {
  const trip = await roundTrip(relabelSecond(1036, 'Ouvert'));
  assert.deepEqual(trip.source, ['1036:Ouvert', '1036:Ouvert', '3082:Cerrado']);
  assert.deepEqual(trip.column.options, [{ 1036: 'Ouvert' }, { 1036: 'Ouvert' }, { 3082: 'Cerrado' }]);
  assert.equal(trip.column.type, 'Choice');
  assert.deepEqual(trip.fresh, trip.source, 'a fresh environment holds each option in the language the source holds it in');
  assert.ok(trip.warnings.some((w) => /'Ouvert' names BOTH options\[0\] and options\[1\]/.test(w)), 'the duplicate is still reported');
  assert.equal(trip.warnings.some((w) => /could not be kept/.test(w)), false, 'no language is lost, and none is said to be');
});

test('option label language: two options sharing their text in different languages lose only their own language, and the download names each', async () => {
  const trip = await roundTrip(relabelSecond(3082, 'Ouvert'));
  assert.deepEqual(trip.source, ['1036:Ouvert', '3082:Ouvert', '3082:Cerrado']);
  assert.deepEqual(trip.column.options, ['Ouvert', 'Ouvert', { 3082: 'Cerrado' }]);
  assert.equal(trip.column.type, 'Choice');
  assert.deepEqual(trip.fresh, ['1033:Ouvert', '1033:Ouvert', '3082:Cerrado'], 'the unrelated option keeps its language');
  const lost = trip.warnings.find((w) => /could not be kept/.test(w));
  assert.ok(lost, JSON.stringify(trip.warnings));
  assert.match(lost, /contoso_item\.contoso_stage options\[0\] 'Ouvert' \(1036\), contoso_item\.contoso_stage options\[1\] 'Ouvert' \(3082\)/);
  assert.doesNotMatch(lost, /Cerrado/);
});

// MEASURED: Dataverse fills the environment's base language in, with the same text, when a label is created in another language only.
// Two options created as Spanish "Abierto" on an English-base environment are therefore held as 1033 "Abierto" + 3082 "Abierto" each —
// identical in every language they hold. A download captured such a column WITHOUT a type and blamed an option set it had read, so a
// rebuild into a fresh environment would have made it a single-line text column.
const asHeld = (held) => {
  held[0].Label = labelled([1033, 'Abierto'], [3082, 'Abierto']);
  held[1].Label = labelled([1033, 'Abierto'], [3082, 'Abierto']);
  held[2].Label = labelled([1033, 'Cerrado'], [3082, 'Cerrado']);
};

test('option label language: two options labelled alike as Dataverse holds them — the base language filled in — keep the column typed, its options and both languages', async () => {
  const trip = await roundTrip(asHeld);
  assert.deepEqual(trip.source, ['1033:Abierto 3082:Abierto', '1033:Abierto 3082:Abierto', '1033:Cerrado 3082:Cerrado']);
  assert.deepEqual(trip.fresh, trip.source, 'a fresh environment holds the options the source holds');
  assert.equal(trip.column.type, 'Choice');
  assert.deepEqual(trip.column.options, [{ 1033: 'Abierto', 3082: 'Abierto' }, { 1033: 'Abierto', 3082: 'Abierto' }, { 1033: 'Cerrado', 3082: 'Cerrado' }]);
  assert.equal(trip.warnings.filter((w) => /'Abierto' names BOTH options\[0\] and options\[1\]/.test(w)).length, 1, `the duplicate is reported once: ${JSON.stringify(trip.warnings)}`);
  assert.equal(trip.warnings.some((w) => /WITHOUT a type/.test(w)), false, 'the column is not reported untyped');
});

test('option label language: a text two options hold in different languages still leaves the column untyped, and the warning names the clash, not the read', async () => {
  const trip = await downloaded((held) => {
    held[0].Label = labelled([1033, 'Open'], [3082, 'Abierto']);
    held[1].Label = labelled([1033, 'Abierto'], [3082, 'Cerrado']);
    held[2].Label = labelled([1033, 'Pending'], [3082, 'Pendiente']);
  });
  assert.deepEqual([trip.column.type, trip.column.options], [undefined, undefined], 'which option "Abierto" means depends on the language: the spec cannot hold it');
  const untyped = trip.warnings.filter((w) => /WITHOUT a type/.test(w));
  assert.equal(untyped.length, 1, JSON.stringify(trip.warnings));
  assert.match(untyped[0], /because one text names two of their options \(contoso_item\.contoso_stage: 'Abierto' names options\[0\] and options\[1\]\)/);
  assert.match(untyped[0], /Their option sets were read/);
  assert.doesNotMatch(untyped[0], /could not be read/);
});

test('option label language: an option set that could not be read still leaves the column untyped, with the read named', async () => {
  const trip = await downloaded(asHeld, { refuseOptionSets: true });
  assert.deepEqual([trip.column.type, trip.column.options], [undefined, undefined]);
  assert.ok(trip.warnings.some((w) => /^WARNING: the Choice\/MultiChoice option-set read failed for 1 table\(s\) \(contoso_item \(HTTP 503\)\)/.test(w)), JSON.stringify(trip.warnings));
  assert.ok(trip.warnings.some((w) => /^WARNING: 1 column\(s\) were captured WITHOUT a type \(contoso_item\.contoso_stage\) — most likely Choice\/MultiChoice columns whose option set could not be read\./.test(w)), JSON.stringify(trip.warnings));
  assert.equal(trip.warnings.some((w) => /names two of their options/.test(w)), false, 'no clash is claimed for an option set that was not read');
});