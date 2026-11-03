'use strict';
// The LANGUAGE of a label held in one language only, through download and rebuild — over the REAL vendored SDK, the plugin's own HTTP
// client and the stateful fake Dataverse the lifecycle tests share (helpers/fake-lifecycle-org.js, which stores each label under the LCID
// it was sent with, as Dataverse does).
//
// A download writes a label as a plain string, and a rebuild writes a plain string in the language IT resolves. A label the source holds
// in one language only came back as a plain string whatever that language was, so a table labelled only in Spanish, downloaded from an
// environment whose base language is English, was rebuilt with its Spanish text as the ENGLISH label — in a fresh environment that had
// Spanish as much as in one that had not. The download now writes such a label as a one-entry LCID map when its language is not the
// download's authoring language (labelFromDataverse in download-model-app.js), and these cases pin, by what the target environment holds:
//   * the download keeps the Spanish labels in Spanish and the English one as the plain string it always was;
//   * a rebuild into a fresh environment that has Spanish stores them in Spanish;
//   * a rebuild into a fresh environment without Spanish stops at the start of its data model and names the language (the build's
//     existing guard), where it used to store them as English;
//   * a rebuild into the same environment writes no label;
//   * a download with --language-code 3082, rebuilt with it (as the flag requires), keeps the ENGLISH label in English.
// The fake stores a label in exactly the languages it was sent in, which lets the first cases hold a label in Spanish alone on an
// English-base environment. Dataverse does not (measured): it fills the base language in, with the same text, when a label is created
// in another language only, so on a live environment the one language a label holds alone is the base language, and the change shows
// as the last case does — a label held only in the base language, downloaded with --language-code naming another.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, appUniqueName } = require('./helpers/lifecycle-harness.js');
const { validateAppSpec } = require('../lib/app-spec.js');

const es = (text) => ({ 3082: text });
// A table labelled in Spanish only — its name, plural, primary column, a column, a choice's options and its lookup to a stock table —
// beside one column labelled in English, built in an environment whose base language is English and which has Spanish too.
const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoPedidos', displayName: 'Contoso Pedidos', publisherPrefix: 'contoso' },
  app: { name: 'Pedidos' },
  entities: [{
    schemaName: 'contoso_pedido', displayName: es('Pedido'), pluralName: es('Pedidos'),
    primaryAttribute: { schemaName: 'contoso_name', displayName: es('Nombre') },
    columns: [
      { schemaName: 'contoso_importe', displayName: es('Importe'), type: 'Integer' },
      { schemaName: 'contoso_estado', displayName: es('Estado'), type: 'Choice', options: [es('Abierto'), es('Cerrado')] },
      { schemaName: 'contoso_nota', displayName: 'Note', type: 'Text' },
    ],
  }],
  relationships: [{ type: 'OneToMany', referenced: 'account', referencing: 'contoso_pedido', lookup: { schemaName: 'contoso_cliente', displayName: es('Cliente') } }],
  appShell: { areas: [{ label: 'Work', groups: [{ label: 'Orders', subAreas: [{ entity: 'contoso_pedido', title: 'Pedidos' }] }] }] },
};
const BILINGUAL = { baseLanguage: 1033, provisionedLanguages: [1033, 3082] };

const ran = (step, label) => {
  assert.ok(step, `${label} ran`);
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
};

// What an environment holds of the table's labels, each as `<LCID>:<text>` per language it holds.
function labelsOf(org) {
  const table = org.metadata.tables.get('contoso_pedido');
  const held = (label) => (label ? label.LocalizedLabels.map((l) => `${l.LanguageCode}:${l.Label}`).join(' ') : null);
  const column = (name) => table.Attributes.get(name);
  return {
    table: held(table.DisplayName),
    plural: held(table.DisplayCollectionName),
    primary: held(column('contoso_name').DisplayName),
    importe: held(column('contoso_importe').DisplayName),
    estado: held(column('contoso_estado').DisplayName),
    options: column('contoso_estado').OptionSet.Options.map((o) => held(o.Label)),
    nota: held(column('contoso_nota').DisplayName),
    cliente: held(column('contoso_cliente').DisplayName),
  };
}
const SPANISH_AND_ONE_ENGLISH = {
  table: '3082:Pedido', plural: '3082:Pedidos', primary: '3082:Nombre', importe: '3082:Importe', estado: '3082:Estado',
  options: ['3082:Abierto', '3082:Cerrado'], nota: '1033:Note', cliente: '3082:Cliente',
};

// The source environment with the app built in it, and the spec a download of it writes (with --language-code when `languageCode`).
async function downloaded(languageCode) {
  const org = createLifecycleOrg(BILINGUAL);
  const root = makeTempDir('label-language-');
  const harness = createLifecycleHarness(org, root);
  const build = ran(await harness.measure(() => harness.build(spec)), 'the source build');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  assert.deepEqual(labelsOf(org), SPANISH_AND_ONE_ENGLISH, 'the source holds each label in its one language');
  const out = path.join(root, 'download');
  const download = ran(await harness.measure(() => harness.download(appUniqueName(spec), out, { languageCode })), 'the download');
  assert.equal(download.value.emitted.ok, true, JSON.stringify(download.value.emitted));
  return { org, root, harness, out, spec: download.value.spec };
}
let englishP;
const english = () => englishP || (englishP = downloaded());
const rebuiltInFresh = async (source, options, languageCode) => {
  const fresh = createLifecycleOrg(options);
  const target = createLifecycleHarness(fresh, path.join(source.root, `fresh-${(options.provisionedLanguages || []).join('-')}-${languageCode || 'base'}`));
  return { fresh, step: await target.measure(() => target.build(source.spec, languageCode ? { languageCode } : {})) };
};

test('label language: a download keeps a label held only in Spanish in Spanish, and the English one as the plain string it always was', async () => {
  const { spec: got } = await english();
  const table = got.entities.find((e) => e.schemaName === 'contoso_pedido');
  const column = (name) => table.columns.find((c) => c.schemaName === name);
  assert.deepEqual(
    { table: table.displayName, plural: table.pluralName, primary: table.primaryAttribute.displayName, importe: column('contoso_importe').displayName, estado: column('contoso_estado').displayName, options: column('contoso_estado').options, nota: column('contoso_nota').displayName, cliente: got.relationships.find((r) => r.referenced === 'account').lookup.displayName },
    { table: es('Pedido'), plural: es('Pedidos'), primary: es('Nombre'), importe: es('Importe'), estado: es('Estado'), options: [es('Abierto'), es('Cerrado')], nota: 'Note', cliente: es('Cliente') },
  );
  assert.deepEqual(validateAppSpec(got, { profile: 'plan', reconstructed: true }).errors, []);
});

test('label language: rebuilt into a fresh environment that has Spanish, every label is stored in its own language — not the Spanish text as English', async () => {
  const { fresh, step } = await rebuiltInFresh(await english(), BILINGUAL);
  ran(step, 'the fresh build');
  assert.equal(step.value.result.ok, true, JSON.stringify(step.value.result.errors));
  assert.deepEqual(labelsOf(fresh), SPANISH_AND_ONE_ENGLISH);
});

test('label language: rebuilt into a fresh environment without Spanish, the build stops before its data model and names the language', async () => {
  const { fresh, step } = await rebuiltInFresh(await english(), { baseLanguage: 1033, provisionedLanguages: [1033] });
  assert.deepEqual(step.unexpected, []);
  const said = step.error ? step.error.message : JSON.stringify(step.value && step.value.result);
  assert.match(said, /not provisioned in this organization: 3082/, 'the language it lacks is named');
  // The build's language guard stands at the start of the data-model phase, after the solution phase has made the solution and its
  // publisher: no table, column or app is written — no Spanish text is stored as an English label.
  assert.deepEqual(Object.keys(step.writes).sort(), ['POST publishers', 'POST solutions']);
  assert.equal(fresh.metadata.tables.get('contoso_pedido'), undefined);
});

test('label language: rebuilt into the same environment, the downloaded spec writes no label', async () => {
  const source = await english();
  const step = ran(await source.harness.measure(() => source.harness.build(source.spec, { appFolder: source.out, workspace: path.join(source.out, '.maker-workspace') })), 'the rebuild');
  assert.equal(step.value.result.ok, true, JSON.stringify(step.value.result.errors));
  assert.deepEqual(Object.keys(step.writes).filter((write) => /EntityDefinitions|OptionSet|InsertOptionValue|UpdateOptionValue/.test(write)), [], 'no table, column or option is written');
  assert.deepEqual(labelsOf(source.org), SPANISH_AND_ONE_ENGLISH);
});

test('label language: downloaded with --language-code 3082 and rebuilt with it, the English label stays English', async () => {
  // The flag decides the authoring language: the Spanish labels are plain strings (the build writes them in Spanish, as the flag must be
  // given to it too), and the English one keeps its language.
  const source = await downloaded(3082);
  const table = source.spec.entities.find((e) => e.schemaName === 'contoso_pedido');
  assert.equal(table.displayName, 'Pedido');
  assert.deepEqual(table.columns.find((c) => c.schemaName === 'contoso_nota').displayName, { 1033: 'Note' });
  const { fresh, step } = await rebuiltInFresh(source, BILINGUAL, 3082);
  ran(step, 'the fresh build');
  assert.equal(step.value.result.ok, true, JSON.stringify(step.value.result.errors));
  assert.deepEqual(labelsOf(fresh), SPANISH_AND_ONE_ENGLISH);
});
