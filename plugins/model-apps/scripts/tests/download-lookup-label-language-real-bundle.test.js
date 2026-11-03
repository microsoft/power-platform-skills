'use strict';
// Whether a download may leave a LOOKUP's label out, now that a label keeps its language — over the REAL vendored SDK, the plugin's own
// HTTP client and the stateful fake Dataverse the lifecycle tests share (helpers/fake-lifecycle-org.js, which stores each label under the
// LCID it was sent with, as Dataverse does).
//
// A download leaves out a lookup label a rebuild would write by itself (ADO 6691205): a lookup that sets none is labelled with its
// parent's label — the downloaded table's display name, or, for a stock table, the label the build reads for it in its authoring
// language. A downloaded table now keeps a label held in one language other than the authoring one as a one-entry map, so the same TEXT
// no longer proves the same label: an English "Contact" on a lookup to a table labelled only in French "Contact" is not what a rebuild
// writes (it would inherit the French label), nor is a French "Utilisateur" on a lookup to `systemuser` (the build reads "User", in
// English). These cases pin, by what a fresh environment holds after the rebuild, that a label is left out only where the rebuild writes
// the same label in the same language, and carried — in its own language — everywhere else:
//   * the download carries exactly the two labels a rebuild would move, and leaves out the two it reproduces;
//   * rebuilt into a fresh environment that has French, every lookup holds the label it held in the source, in the same language;
//   * rebuilt into a fresh environment without French, the lookup labelled only in French stops the build at the start of its data
//     model, naming the language (the build's existing guard), where it used to be rebuilt as the English "User".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, appUniqueName } = require('./helpers/lifecycle-harness.js');
const { validateAppSpec } = require('../lib/app-spec.js');

const fr = (text) => ({ 1036: text });
const BILINGUAL = { baseLanguage: 1033, provisionedLanguages: [1033, 1036] };
const ENGLISH_ONLY = { baseLanguage: 1033, provisionedLanguages: [1033] };
// The stock `systemuser` table as an environment with English and French holds it: a label in each language.
const SYSTEMUSER_LABEL = {
  LocalizedLabels: [{ Label: 'User', LanguageCode: 1033 }, { Label: 'Utilisateur', LanguageCode: 1036 }],
  UserLocalizedLabel: { Label: 'User', LanguageCode: 1033 },
};
const named = (schemaName, displayName, extra = {}) => ({ schemaName, displayName, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [], ...extra });
const lookup = (referenced, referencing, schemaName, displayName) => ({ type: 'OneToMany', referenced, referencing, lookup: { schemaName, displayName } });

// A table labelled only in French, and four lookups: to it and to `systemuser`, from two tables, each labelled either as a rebuild would
// label it or with the same text in the other language.
const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoContacts', displayName: 'Contoso Contacts', publisherPrefix: 'contoso' },
  app: { name: 'Contacts' },
  entities: [
    named('contoso_contact', fr('Contact'), { pluralName: fr('Contacts') }),
    named('contoso_case', 'Case'),
    named('contoso_visit', 'Visit'),
  ],
  relationships: [
    lookup('contoso_contact', 'contoso_case', 'contoso_contactid', 'Contact'),
    lookup('contoso_contact', 'contoso_visit', 'contoso_contactid', fr('Contact')),
    lookup('systemuser', 'contoso_case', 'contoso_agentid', fr('Utilisateur')),
    lookup('systemuser', 'contoso_visit', 'contoso_agentid', 'User'),
  ],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_contact', title: 'Contacts' }, { entity: 'contoso_case', title: 'Cases' }, { entity: 'contoso_visit', title: 'Visits' }] }] }] },
};
// What the source holds on each lookup column, `<LCID>:<text>` per language it holds.
const SOURCE_LOOKUPS = {
  'contoso_case.contoso_contactid': '1033:Contact',
  'contoso_visit.contoso_contactid': '1036:Contact',
  'contoso_case.contoso_agentid': '1036:Utilisateur',
  'contoso_visit.contoso_agentid': '1033:User',
};

const ran = (step, label) => {
  assert.ok(step, `${label} ran`);
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
};

const environment = (options) => {
  const org = createLifecycleOrg(options);
  org.metadata.tables.get('systemuser').DisplayName = structuredClone(SYSTEMUSER_LABEL);
  return org;
};

function lookupsOf(org, specOfIt) {
  const out = {};
  for (const r of specOfIt.relationships) {
    const table = org.metadata.tables.get(r.referencing);
    const column = table && table.Attributes.get(r.lookup.schemaName);
    out[`${r.referencing}.${r.lookup.schemaName}`] = column ? column.DisplayName.LocalizedLabels.map((l) => `${l.LanguageCode}:${l.Label}`).join(' ') : null;
  }
  return out;
}

// The source environment with `app` built in it, and the spec a download of it writes.
async function downloaded(app) {
  const org = environment(BILINGUAL);
  const root = makeTempDir('lookup-label-language-');
  const harness = createLifecycleHarness(org, root);
  const build = ran(await harness.measure(() => harness.build(app)), 'the source build');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  const out = path.join(root, 'download');
  const download = ran(await harness.measure(() => harness.download(appUniqueName(app), out)), 'the download');
  assert.equal(download.value.emitted.ok, true, JSON.stringify(download.value.emitted));
  return { org, root, spec: download.value.spec };
}
let sourceP;
const source = () => sourceP || (sourceP = downloaded(spec));
const rebuiltInFresh = async (from, options) => {
  const fresh = environment(options);
  const target = createLifecycleHarness(fresh, path.join(from.root, `fresh-${options.provisionedLanguages.join('-')}`));
  return { fresh, step: await target.measure(() => target.build(from.spec)) };
};

test('lookup label language: a download leaves out only the lookup labels a rebuild writes in the same language, and carries the others in theirs', async () => {
  const { org, spec: got } = await source();
  assert.deepEqual(lookupsOf(org, spec), SOURCE_LOOKUPS, 'the source holds each lookup label in its one language');
  const lookupOf = (referenced, referencing) => got.relationships.find((r) => r.referenced === referenced && r.referencing === referencing).lookup;
  assert.deepEqual(got.entities.find((e) => e.schemaName === 'contoso_contact').displayName, fr('Contact'), 'the parent keeps its French label');
  assert.deepEqual(lookupOf('contoso_contact', 'contoso_case'), { schemaName: 'contoso_contactid', displayName: 'Contact' }, 'the English label with the French parent\'s text is carried, in English');
  assert.deepEqual(lookupOf('contoso_contact', 'contoso_visit'), { schemaName: 'contoso_contactid' }, 'the parent\'s own French label is left out');
  assert.deepEqual(lookupOf('systemuser', 'contoso_case'), { schemaName: 'contoso_agentid', displayName: fr('Utilisateur') }, 'a French label is not the English one a rebuild reads for a stock parent');
  assert.deepEqual(lookupOf('systemuser', 'contoso_visit'), { schemaName: 'contoso_agentid' }, 'the label a rebuild reads for the stock parent is left out');
  assert.deepEqual(validateAppSpec(got, { profile: 'plan', reconstructed: true }).errors, []);
});

test('lookup label language: rebuilt into a fresh environment that has French, every lookup holds the label it held, in the same language', async () => {
  const from = await source();
  const { fresh, step } = await rebuiltInFresh(from, BILINGUAL);
  ran(step, 'the fresh build');
  assert.equal(step.value.result.ok, true, JSON.stringify(step.value.result.errors));
  assert.deepEqual(lookupsOf(fresh, spec), SOURCE_LOOKUPS);
});

test('lookup label language: a lookup labelled only in French, to a stock table, stops a rebuild into a fresh environment without French and names it', async () => {
  // Only the lookup carries French here, so nothing else in the spec makes the build's language guard stop it.
  const single = {
    ...spec,
    solution: { ...spec.solution, uniqueName: 'ContosoAgents' },
    app: { name: 'Agents' },
    entities: [named('contoso_case', 'Case')],
    relationships: [lookup('systemuser', 'contoso_case', 'contoso_agentid', fr('Utilisateur'))],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_case', title: 'Cases' }] }] }] },
  };
  const from = await downloaded(single);
  assert.deepEqual(from.spec.relationships[0].lookup, { schemaName: 'contoso_agentid', displayName: fr('Utilisateur') });
  const { fresh, step } = await rebuiltInFresh(from, ENGLISH_ONLY);
  assert.deepEqual(step.unexpected, []);
  const said = step.error ? step.error.message : JSON.stringify(step.value && step.value.result);
  assert.match(said, /not provisioned in this organization: 1036/, 'the language it lacks is named');
  assert.deepEqual(Object.keys(step.writes).sort(), ['POST publishers', 'POST solutions'], 'no table or lookup is written');
  assert.equal(fresh.metadata.tables.get('contoso_case'), undefined);
});
