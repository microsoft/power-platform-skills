'use strict';
// REAL BUNDLE: `--verify` holds a form's tab and section captions to the language the BUILD wrote them in.
//
// A build's authoring language is its `--language-code`, else the spec's `languageCode`, else the organization's base language, and the
// SDK it writes with is made for the result, so every caption is published in it. A build run with the flag in an organization whose base
// language is another one therefore publishes its captions in the flag's language — and a verify that did not know the flag held them to
// the organization's, and reported the captions it had just been given as missing. Verify now takes the same option the build does
// (`--language-code`, handed to verifySpec as `languageCode`; the build's own verify hands it `preResolvedLanguageCode` too) and uses it
// before the spec's language and the organization's. And when it can establish no language at all, it says the captions are UNVERIFIED —
// it does not pick one, because a language picked for it would pass a stale caption as readily as it fails a correct one.
//
// This drives the real vendored SDK over a fake HTTP server that stores one systemform: the form is built and published in French in an
// organization whose base language is English, and read back through the plugin's own reader.
//
// The platform also decides which languages' labels the FormXML it returns carries, and it can carry fewer than the form stores: live, a form
// published with Spanish (3082) captions in an English (1033) organization reads back with its labels in 1033 alone, though a translation export
// finds both. A language the read does not carry is one it cannot show, so the captions compared in it are UNVERIFIED — not missing — while a
// language it does carry is compared exactly as before. The Spanish tests at the end drive that: the store keeps what the build wrote, and
// `store.readLanguages` (the harness) limits the languages a read shows.
const test = require('node:test');
const assert = require('node:assert');
const ai = require('../lib/artifact-intent.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { buildModelApp } = require('../build-model-app.js');
const { createHarness, seedForm, verifyForms } = require('./helpers/form-store-harness.js');
const { readLanguageCodeFlag } = require('../lib/dataverse-auth.js');
const { workbookXml, zipOf, exportZip, exportAnswer } = require('./helpers/translation-export.js');

const harnesses = [];
test.after(() => { for (const h of harnesses) h.cleanup(); });

function frenchSpec(over = {}) {
  return {
    solution: { uniqueName: 'FormProbe', displayName: 'Form Probe', publisherPrefix: 'new' },
    app: { name: 'Form Probe', uniqueName: 'new_formprobe' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [
      { schemaName: 'new_code', displayName: 'Code', type: 'Text' }, { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' },
    ] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
    forms: [{ entity: 'new_ticket', name: 'Main', formType: 'Main', layout: 'explicit', prune: false, notes: false,
      tabs: [{ name: 'tab_main', label: 'Aper\u00e7u', sections: [{ name: 'sec_main', label: 'D\u00e9tails', columns: 1, fields: ['new_name', 'new_code', 'new_notes'] }] }] }],
    ...over,
  };
}

// An organization whose base language is English and a build made for French: the form is published carrying "Aperçu" / "Détails" in 1036.
async function publishedInFrench({ organizationLanguage = 1033 } = {}) {
  const h = createHarness({ languageCode: organizationLanguage, sdkLanguageCode: 1036 });
  harnesses.push(h);
  const spec = frenchSpec();
  // The form exists before the spec asks for a read-only field, as a maker's would: the build then has an edit to make, and publishes it.
  await seedForm(h, ai.compileFormIntent(spec, spec.forms[0]).tabs);
  spec.forms[0].fieldOptions = { new_code: { readOnly: true } };
  h.writes.length = 0;
  const { sdk } = await h.freshSdk();
  const built = await runSdkBuild(spec, { sdk, apply: true, phases: ['forms'], languageCode: 1036, preResolvedLanguageCode: 1036 });
  assert.strictEqual(built.ok, true, JSON.stringify(built));
  assert.ok(h.writes.some((w) => /\/PublishXml/.test(w.url)), 'the reconciled form is published');
  assert.match(h.store.row.formxml, /<label description="Aper\u00e7u" languagecode="1036" \/>/, 'the tab\u2019s caption is published in the build\u2019s language');
  assert.match(h.store.row.formxml, /<label description="D\u00e9tails" languagecode="1036" \/>/, 'and the section\u2019s');
  return { h, spec };
}
const topology = (verification) => verification.checks.find((c) => c.kind === 'form-topology');

test('REAL BUNDLE: a form built in French in an English organization verifies — in the language the build was run in, however verify is told it', async () => {
  const { h, spec } = await publishedInFrench();
  // Told nothing, verify looks for the organization's English. The form carries no label in English anywhere, so what it cannot find is not missing from the
  // form — it is a language the read cannot show: the French captions are listed unverified, with the flag that settles it.
  const alone = await verifyForms(h, spec);
  assert.strictEqual(topology(alone).present, true, topology(alone).detail);
  assert.strictEqual(alone.unverified.length, 1, JSON.stringify(alone.unverified));
  assert.match(alone.unverified[0], /^form-labels:new_ticket\.Main \(the labels of tab 'tab_main', section 'sec_main' in language 1033 were not compared: the environment's form read returns labels only in 1036, so labels written in 1033 cannot be read back from it\. /);
  assert.match(alone.unverified[0], /\(verify used the organization's base language, because it was told no other: if the build was run with --language-code, give verify the same flag, or pin "languageCode" in the spec\)\)$/);
  for (const [what, opts, mutate] of [
    ['--language-code, as the standalone verify hands it', { languageCode: 1036 }, undefined],
    ['the language the build\u2019s SDK was made for', { preResolvedLanguageCode: 1036 }, undefined],
    ['both, as the build\u2019s own verify hands them', { languageCode: 1036, preResolvedLanguageCode: 1036 }, undefined],
    ['the flag, over a languageCode the spec pins to the organization\u2019s', { languageCode: 1036 }, (s) => { s.languageCode = 1033; }],
    ['a languageCode the spec pins', undefined, (s) => { s.languageCode = 1036; }],
  ]) {
    const s = { ...spec };
    if (mutate) mutate(s);
    const verification = await verifyForms(h, s, opts);
    assert.strictEqual(topology(verification).present, true, `${what}: ${topology(verification).detail}`);
    assert.strictEqual(verification.unverified, undefined, `${what}: told the language, verify has nothing left it cannot tell`);
  }
  // A language that is given and that the read does not carry is not held to it either — but a language the read carries is held strictly: once a maker has
  // added an English caption to the tab, the form can show English, and the build's French is not the English one.
  const given = await verifyForms(h, spec, { languageCode: 1033 });
  assert.strictEqual(topology(given).present, true, topology(given).detail);
  assert.match(given.unverified[0], /in language 1033 were not compared: the environment's form read returns labels only in 1036/);
  assert.doesNotMatch(given.unverified[0], /organization's base language/, 'told the language, verify does not blame its guess');
  h.store.row.formxml = h.store.row.formxml.replace('<label description="Aper\u00e7u" languagecode="1036" />', '<label description="Overview" languagecode="1033" /><label description="Aper\u00e7u" languagecode="1036" />');
  const strict = topology(await verifyForms(h, spec, { languageCode: 1033 }));
  assert.strictEqual(strict.present, false);
  assert.match(strict.detail, /tab 'tab_main' is deployed with label "Overview" in language 1033, the spec declares label: "Aper\u00e7u" in language 1033/);
  assert.match(strict.detail, /section 'sec_main' is deployed with no label in language 1033 \(it has "D\u00e9tails" in 1036\)/);
  assert.doesNotMatch(strict.detail, /compared in the organization's base language/, 'told the language, verify does not blame its guess');
});

test('REAL BUNDLE: the build\u2019s own verify of that form passes — the language it wrote is handed to it', async () => {
  const { h, spec } = await publishedInFrench();
  const logs = [];
  let handed;
  const built = await buildModelApp(spec, { apply: true, verify: true, env: 'https://contoso.crm.dynamics.com', languageCode: 1036, preResolvedLanguageCode: 1036 }, {
    log: (m) => logs.push(m),
    // The build itself was done above; this is the build's verification step with its real wiring, over the form that build published.
    runBuild: async () => ({ ok: true, dryRun: false, created: {}, skipped: {} }),
    verify: async (s, options) => { handed = options; return verifyForms(h, s, options); },
  });
  assert.strictEqual(built.ok, true);
  assert.strictEqual(handed.languageCode, 1036);
  assert.strictEqual(handed.preResolvedLanguageCode, 1036);
  const failed = (built.verify.missing || []).filter((m) => /^form-topology:/.test(m));
  assert.deepStrictEqual(failed, [], `the captions the build just wrote are not reported missing: ${logs.filter((l) => /form-topology/.test(l)).join(' | ')}`);
});

test('REAL BUNDLE: when the organization cannot say its language, verify reports the captions unverified — a stale one no longer passes, a correct one no longer fails', async () => {
  // The organization row has no language (the read answers no usable value), so nothing says which language the build wrote in.
  const { h, spec } = await publishedInFrench({ organizationLanguage: null });
  const alone = await verifyForms(h, spec);
  assert.strictEqual(topology(alone).present, true, `the correct French captions are not failed on a guessed English: ${topology(alone).detail}`);
  assert.strictEqual(alone.unverified.length, 1, JSON.stringify(alone.unverified));
  assert.match(alone.unverified[0], /^form-labels:new_ticket\.Main \(the labels of tab 'tab_main', section 'sec_main' were not compared: the language the build wrote them in could not be established \(organization\.languagecode was missing or not a valid LCID\)\. Pass --language-code <lcid>/);
  // …and the same form once a maker has left a STALE French caption beside the English one the spec's text matches: it used to pass on the guess.
  h.store.row.formxml = h.store.row.formxml.replace('<label description="Aper\u00e7u" languagecode="1036" />', '<label description="Ancien" languagecode="1036" /><label description="Aper\u00e7u" languagecode="1033" />');
  const stale = await verifyForms(h, spec);
  assert.strictEqual(stale.unverified.length, 1, 'neither passed nor failed: reported');
  const known = await verifyForms(h, spec, { languageCode: 1036 });
  assert.strictEqual(topology(known).present, false, 'told the language, verify holds the stale caption to it');
  assert.match(topology(known).detail, /tab 'tab_main' is deployed with label "Ancien" in language 1036, the spec declares label: "Aper\u00e7u" in language 1036/);
  assert.strictEqual(known.unverified, undefined);
});

// --- A read that cannot show the language the build wrote ------------------------------------------------------------------------------------
//
// A build made for Spanish (3082) in an organization whose base language is English: the form is published with its captions in Spanish, and the
// platform keeps the English ones beside them (the live run found both stored). What a read then returns is limited to the languages the platform
// shows the caller — English only, live — so nothing a verify can read says the Spanish captions are missing, and nothing says they are there.
function spanishSpec() {
  const spec = frenchSpec();
  spec.forms[0].tabs[0].label = 'Resumen';
  spec.forms[0].tabs[0].sections[0].label = 'Detalles';
  return spec;
}

// The form built and published in Spanish, then read as the platform shows it: the English captions only (`store.readLanguages`).
async function publishedInSpanish() {
  const h = createHarness({ languageCode: 1033, sdkLanguageCode: 3082 });
  harnesses.push(h);
  const spec = spanishSpec();
  await seedForm(h, ai.compileFormIntent(spec, spec.forms[0]).tabs);
  spec.forms[0].fieldOptions = { new_code: { readOnly: true } };
  h.writes.length = 0;
  const { sdk } = await h.freshSdk();
  const built = await runSdkBuild(spec, { sdk, apply: true, phases: ['forms'], languageCode: 3082, preResolvedLanguageCode: 3082 });
  assert.strictEqual(built.ok, true, JSON.stringify(built));
  assert.ok(h.writes.some((w) => /\/PublishXml/.test(w.url)), 'the reconciled form is published');
  assert.match(h.store.row.formxml, /<label description="Resumen" languagecode="3082" \/>/, 'the build wrote the tab\u2019s caption in Spanish');
  assert.match(h.store.row.formxml, /<label description="Detalles" languagecode="3082" \/>/, 'and the section\u2019s');
  h.store.row.formxml = h.store.row.formxml
    .replace('<label description="Resumen" languagecode="3082" />', '<label description="Overview" languagecode="1033" /><label description="Resumen" languagecode="3082" />')
    .replace('<label description="Detalles" languagecode="3082" />', '<label description="Basics" languagecode="1033" /><label description="Detalles" languagecode="3082" />');
  h.store.readLanguages = [1033];
  return { h, spec };
}
const SPANISH_ENTRY = /^form-labels:new_ticket\.Main \(the labels of tab 'tab_main', section 'sec_main' in language 3082 were not compared: the environment's form read returns labels only in 1033, so labels written in 3082 cannot be read back from it\. Check them in Power Apps with that language, or verify in a language the read carries\)$/;
const asBuildReports = (m) => `${m.kind}:${m.name}${m.detail ? ` (${m.detail})` : ''}`;

test('REAL BUNDLE: a form built in Spanish in an English organization, read back with its English labels only, is UNVERIFIED — after the build, standalone with either flag, and with a spec pin', async () => {
  const { h, spec } = await publishedInSpanish();
  // The same form read as the store holds it: the Spanish captions are there and right, and the checks that fail are the fixture's own (it publishes no
  // sitemap) — what unverified must neither add to nor take from.
  h.store.readLanguages = undefined;
  const whole = await verifyForms(h, spec, { languageCode: 3082 });
  assert.strictEqual(topology(whole).present, true, `the Spanish captions are on the form: ${topology(whole).detail}`);
  assert.strictEqual(whole.unverified, undefined);
  h.store.readLanguages = [1033];

  // Inline, after the build: the real buildModelApp with its completed-build seam, handed the language the build wrote.
  const logs = [];
  let handed;
  const built = await buildModelApp(spec, { apply: true, verify: true, env: 'https://contoso.crm.dynamics.com', languageCode: 3082, preResolvedLanguageCode: 3082 }, {
    log: (m) => logs.push(m),
    runBuild: async () => ({ ok: true, dryRun: false, created: {}, skipped: {} }),
    verify: async (s, options) => { handed = options; return verifyForms(h, s, options); },
  });
  assert.strictEqual(built.ok, true);
  assert.strictEqual(handed.languageCode, 3082);
  assert.deepStrictEqual(built.verify.missing, whole.missing.map(asBuildReports), 'the build\u2019s own verify finds what a read that shows Spanish finds, and no caption more');
  assert.strictEqual(built.verify.ok, whole.ok);
  assert.strictEqual(built.verify.unverified.length, 1, JSON.stringify(built.verify.unverified));
  assert.match(built.verify.unverified[0], SPANISH_ENTRY);
  assert.match(logs.join('\n'), /⊘ 1 check could not be verified — it is neither passed nor failed/);
  assert.ok(logs.some((l) => l.includes(built.verify.unverified[0])), 'named, with its reason');

  // Standalone, told the language by either spelling of the flag (read as the CLI reads it) …
  for (const [what, flags] of [['--language-code', { 'language-code': '3082' }], ['--languageCode', { languageCode: '3082' }]]) {
    const standalone = await verifyForms(h, spec, { languageCode: readLanguageCodeFlag(flags) });
    assert.strictEqual(topology(standalone).present, true, `${what}: ${topology(standalone).detail}`);
    assert.deepStrictEqual(standalone.missing, whole.missing, `${what}: unverified is not a failure`);
    assert.strictEqual(standalone.ok, whole.ok, what);
    assert.strictEqual(standalone.unverified.length, 1, `${what}: ${JSON.stringify(standalone.unverified)}`);
    assert.match(standalone.unverified[0], SPANISH_ENTRY, what);
  }
  // … or by the spec's own pin.
  const pinned = await verifyForms(h, { ...spec, languageCode: 3082 });
  assert.strictEqual(topology(pinned).present, true, topology(pinned).detail);
  assert.deepStrictEqual(pinned.missing, whole.missing);
  assert.strictEqual(pinned.unverified.length, 1);
  assert.match(pinned.unverified[0], SPANISH_ENTRY);
});

test('REAL BUNDLE: a read that carries the Spanish captions is compared as before — a right caption passes, a stale one fails', async () => {
  const { h, spec } = await publishedInSpanish();
  h.store.readLanguages = [1033, 3082];
  const right = await verifyForms(h, spec, { languageCode: 3082 });
  assert.strictEqual(topology(right).present, true, topology(right).detail);
  assert.strictEqual(right.unverified, undefined, 'the read shows Spanish: nothing is left it cannot tell');
  // A maker's stale Spanish caption on the tab: the read shows it, and it is not the spec's.
  h.store.row.formxml = h.store.row.formxml.replace('<label description="Resumen" languagecode="3082" />', '<label description="Antiguo" languagecode="3082" />');
  const stale = await verifyForms(h, spec, { languageCode: 3082 });
  assert.strictEqual(topology(stale).present, false);
  assert.match(topology(stale).detail, /tab 'tab_main' is deployed with label "Antiguo" in language 3082, the spec declares label: "Resumen" in language 3082/);
  assert.doesNotMatch(topology(stale).detail, /section 'sec_main'/, 'the section\u2019s caption is right');
  assert.strictEqual(stale.unverified, undefined);
});

test('REAL BUNDLE: a {1033, 3082} label map over that form — the English captions are compared (right passes, stale fails), the Spanish ones are listed', async () => {
  const { h, spec } = await publishedInSpanish();
  const mapSpec = JSON.parse(JSON.stringify(spec));
  mapSpec.forms[0].tabs[0].label = { 1033: 'Overview', 3082: 'Resumen' };
  mapSpec.forms[0].tabs[0].sections[0].label = { 1033: 'Basics', 3082: 'Detalles' };
  const MAP_ENTRY = /^form-labels:new_ticket\.Main \(the labels of tab 'tab_main', section 'sec_main' in language 3082 were not compared: the environment's form read returns labels only in 1033, so labels written in 3082 cannot be read back from it\. Check them in Power Apps with that language\)$/;
  const right = await verifyForms(h, mapSpec);
  assert.strictEqual(topology(right).present, true, topology(right).detail);
  assert.strictEqual(right.unverified.length, 1, JSON.stringify(right.unverified));
  assert.match(right.unverified[0], MAP_ENTRY);
  // A stale English caption fails, strictly, and the Spanish one is not reported missing beside it.
  h.store.row.formxml = h.store.row.formxml.replace('<label description="Overview" languagecode="1033" />', '<label description="Old overview" languagecode="1033" />');
  const stale = await verifyForms(h, mapSpec);
  assert.strictEqual(topology(stale).present, false);
  assert.match(topology(stale).detail, /tab 'tab_main' is deployed with label "Old overview" in language 1033, the spec declares label: "Overview" in language 1033/);
  assert.doesNotMatch(topology(stale).detail, /3082/, 'a language the read cannot show is not reported missing');
  assert.match(stale.unverified[0], MAP_ENTRY, 'and it is still listed');
});

// --- The same form, read with ONE translation export -------------------------------------------------------------------------------------------
//
// What the form read cannot show a translation export can: it carries every provisioned language, the published layer, and a tab's or a section's captions are the rows whose
// Object ID is the `id` the element has in the FormXML. The harness answers the export for the form it stores (`exportOfStoredForm`: a row per tab and section, with the captions
// the store holds in each language — what the platform would write), and the reader that asks for it is the plugin's own (`readerFor`, over the real SDK's Dataverse client).
const idsOf = (h) => Object.fromEntries([...h.store.row.formxml.matchAll(/<(tab|section)\b([^>]*)>/g)].map((m) => [/\bname="([^"]*)"/.exec(m[2])[1], /\bid="([^"]+)"/.exec(m[2])[1]]));
function exportOfStoredForm(h, { override = {}, languages = [1033, 3082] } = {}) {
  const ids = idsOf(h);
  const captions = [];
  for (const m of h.store.row.formxml.matchAll(/<(tab|section)\b([^>]*)>\s*<labels>([\s\S]*?)<\/labels>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[2])[1];
    const texts = {};
    for (const l of m[3].matchAll(/<label description="([^"]*)" languagecode="(\d+)" \/>/g)) texts[Number(l[2])] = l[1];
    captions.push({ entity: h.entity, id, texts: { ...texts, ...(override[Object.keys(ids).find((name) => ids[name] === id)] || {}) } });
  }
  return exportAnswer(exportZip(workbookXml({ languages, captions })));
}
const EXPORT_URL = /\/api\/data\/v9\.\d\/solutions\/Microsoft\.Dynamics\.CRM\.ExportTranslation$/;

test('REAL BUNDLE: a form built in Spanish in an English organization, whose read shows English only, is VERIFIED from one translation export — after the build, with either flag, and with a spec pin', async () => {
  const { h, spec } = await publishedInSpanish();
  assert.deepStrictEqual(Object.keys(idsOf(h)), ['tab_main', 'sec_main'], 'the SDK gave the tab and the section the ids a translation export keys their captions by');
  h.store.exportTranslation = exportOfStoredForm(h);
  // The same form read as the store holds it: the baseline the export must neither add to nor take from.
  h.store.readLanguages = undefined;
  const whole = await verifyForms(h, spec, { languageCode: 3082 });
  assert.strictEqual(h.exportsAsked.length, 0, 'a read that carries Spanish needs no export');
  h.store.readLanguages = [1033];

  const logs = [];
  let handed;
  const built = await buildModelApp(spec, { apply: true, verify: true, env: 'https://contoso.crm.dynamics.com', languageCode: 3082, preResolvedLanguageCode: 3082 }, {
    log: (m) => logs.push(m),
    runBuild: async () => ({ ok: true, dryRun: false, created: {}, skipped: {} }),
    verify: async (s, options) => { handed = options; return verifyForms(h, s, options); },
  });
  assert.strictEqual(built.ok, true);
  assert.strictEqual(handed.languageCode, 3082);
  assert.deepStrictEqual(built.verify.missing, whole.missing.map(asBuildReports), 'the build\u2019s own verify finds what a read that shows Spanish finds, and no caption more');
  assert.strictEqual(built.verify.unverified, undefined, 'the Spanish captions are no longer left unverified');
  assert.doesNotMatch(logs.join('\n'), /could not be verified/);
  assert.strictEqual(h.exportsAsked.length, 1, 'one export for the two captions of the form');
  assert.match(h.exportsAsked[0].url, EXPORT_URL);
  assert.deepStrictEqual(h.exportsAsked[0].body, { SolutionName: 'FormProbe' });

  for (const [what, options, over] of [
    ['--language-code', { languageCode: readLanguageCodeFlag({ 'language-code': '3082' }) }, {}],
    ['--languageCode', { languageCode: readLanguageCodeFlag({ languageCode: '3082' }) }, {}],
    ['the language the build\u2019s SDK was made for', { preResolvedLanguageCode: 3082 }, {}],
    ['a languageCode the spec pins', undefined, { languageCode: 3082 }],
  ]) {
    h.exportsAsked.length = 0;
    const verification = await verifyForms(h, { ...spec, ...over }, options);
    assert.strictEqual(topology(verification).present, true, `${what}: ${topology(verification).detail}`);
    assert.deepStrictEqual(verification.missing, whole.missing, `${what}: the same failures the whole form has`);
    assert.strictEqual(verification.unverified, undefined, `${what}: settled by the export`);
    assert.strictEqual(h.exportsAsked.length, 1, what);
  }
});

test('REAL BUNDLE: a Spanish caption the export shows stale, or not at all, fails — the tab or the section by name, and the right one beside it passes', async () => {
  const { h, spec } = await publishedInSpanish();
  const opts = { languageCode: 3082 };
  h.store.exportTranslation = exportOfStoredForm(h, { override: { tab_main: { 3082: 'Antiguo' } } });
  const stale = await verifyForms(h, spec, opts);
  assert.strictEqual(topology(stale).present, false);
  assert.match(topology(stale).detail, /tab 'tab_main' is deployed with label "Antiguo" in language 3082 \(the translation export of solution 'FormProbe' shows it; the form read does not carry language 3082\), the spec declares label: "Resumen" in language 3082/);
  assert.doesNotMatch(topology(stale).detail, /section 'sec_main'/, 'the section\u2019s caption is right');
  assert.strictEqual(stale.unverified, undefined, 'the export settled both captions');
  h.store.exportTranslation = exportOfStoredForm(h, { override: { sec_main: { 3082: '' } } });
  const empty = await verifyForms(h, spec, opts);
  assert.strictEqual(topology(empty).present, false);
  assert.match(topology(empty).detail, /section 'sec_main' is deployed with no label in language 3082 \(the translation export of solution 'FormProbe' has none, only "Basics" in 1033; the form read does not carry language 3082\), the spec declares label: "Detalles" in language 3082/);
  assert.doesNotMatch(topology(empty).detail, /tab 'tab_main'/);
  // An export that has the language as a column and nothing in the cells says the same of every caption.
  h.store.exportTranslation = exportOfStoredForm(h, { override: { tab_main: { 3082: '' }, sec_main: { 3082: '' } } });
  assert.strictEqual((topology(await verifyForms(h, spec, opts)).detail.match(/is deployed with no label in language 3082/g) || []).length, 2);
});

test('REAL BUNDLE: an export that fails, or that cannot be read, leaves the Spanish captions unverified with the reason — it never passes them', async () => {
  const { h, spec } = await publishedInSpanish();
  const opts = { languageCode: 3082 };
  const baseline = await verifyForms(h, spec, opts);
  assert.strictEqual(baseline.unverified.length, 1, 'with no export to ask for, the captions are listed as they always were');
  assert.match(baseline.unverified[0], SPANISH_ENTRY);
  assert.strictEqual(h.exportsAsked.length, 0);
  for (const [what, answer, reason] of [
    ['a refusal', { status: 403, headers: {}, body: { error: { code: '0x80040220', message: 'Principal user is missing prvExportTranslation privilege' } } }, /could not be read \(HTTP 403: Principal user is missing prvExportTranslation privilege\)/],
    ['a server error', { status: 500, headers: {}, body: { error: { message: 'An unexpected error occurred' } } }, /could not be read \(HTTP 500: An unexpected error occurred\)/],
    ['an answer that is no export', { status: 200, headers: {}, body: { value: [] } }, /could not be read \(the answer holds no ExportTranslationFile\)/],
    ['bytes that are no zip', exportAnswer(Buffer.from('this is some text that goes on and on and is no zip archive at all')), /could not be read \(the archive of the export is not readable: the archive has no end-of-central-directory record\)/],
    ['an archive without the workbook', exportAnswer(zipOf([{ name: 'Other.xml', data: '<a/>' }])), /could not be read \(the archive of the export is not readable: the archive has no entry named 'CrmTranslations\.xml'\)/],
    ['a workbook that is not the platform\u2019s', exportAnswer(zipOf([{ name: 'CrmTranslations.xml', data: '<html>sign in</html>' }])), /could not be read \(the workbook of the export is not readable: it is not a spreadsheet workbook/],
  ]) {
    h.store.exportTranslation = answer;
    h.exportsAsked.length = 0;
    const res = await verifyForms(h, spec, opts);
    assert.strictEqual(topology(res).present, true, `${what}: nothing says a caption is wrong: ${topology(res).detail}`);
    assert.deepStrictEqual(res.missing, baseline.missing, `${what}: unverified is not a failure`);
    assert.strictEqual(res.ok, baseline.ok, what);
    assert.strictEqual(res.unverified.length, 1, `${what}: ${JSON.stringify(res.unverified)}`);
    assert.match(res.unverified[0], /^form-labels:new_ticket\.Main \(the labels of tab 'tab_main', section 'sec_main' in language 3082 were not compared: the environment's form read returns labels only in 1033, so labels written in 3082 cannot be read back from it\. A translation export of solution 'FormProbe' /, what);
    assert.match(res.unverified[0], reason, what);
    assert.strictEqual(h.exportsAsked.length, 1, `${what}: asked once`);
  }
});

test('REAL BUNDLE: an export without a row for the form, or with the language missing, leaves the captions unverified with what it lacks', async () => {
  const { h, spec } = await publishedInSpanish();
  const opts = { languageCode: 3082 };
  // No caption row for this form: the table has others (the export holds every form of the table), but not this form's.
  h.store.exportTranslation = exportAnswer(exportZip(workbookXml({ captions: [{ entity: h.entity, id: '0a0a0a0a-0000-4000-8000-0000000000ff', texts: { 1033: 'Another form\u2019s tab', 3082: 'La pesta\u00f1a de otro formulario' } }] })));
  const noRow = await verifyForms(h, spec, opts);
  assert.strictEqual(topology(noRow).present, true, topology(noRow).detail);
  assert.strictEqual(noRow.unverified.length, 1);
  assert.match(noRow.unverified[0], /A translation export of solution 'FormProbe' was read, but it cannot settle them: the export has no caption row for tab 'tab_main' \(id [0-9a-f-]{36}, table new_ticket\); the export has no caption row for section 'sec_main' \(id [0-9a-f-]{36}, table new_ticket\)\. Check them in Power Apps/);
  // An environment that has not provisioned Spanish has no column for it, and nothing in the export can say what the form holds in it.
  h.store.exportTranslation = exportOfStoredForm(h, { languages: [1033] });
  const noColumn = await verifyForms(h, spec, opts);
  assert.strictEqual(topology(noColumn).present, true, topology(noColumn).detail);
  assert.match(noColumn.unverified[0], /was read, but it cannot settle them: the export has no column for language 3082\. Check them/);
});

test('REAL BUNDLE: a form whose read carries the Spanish captions asks for no export at all — a wrong caption fails from the read, as before', async () => {
  const { h, spec } = await publishedInSpanish();
  h.store.exportTranslation = exportOfStoredForm(h);
  h.store.readLanguages = [1033, 3082];
  const right = await verifyForms(h, spec, { languageCode: 3082 });
  assert.strictEqual(topology(right).present, true, topology(right).detail);
  h.store.row.formxml = h.store.row.formxml.replace('<label description="Resumen" languagecode="3082" />', '<label description="Antiguo" languagecode="3082" />');
  const stale = await verifyForms(h, spec, { languageCode: 3082 });
  assert.strictEqual(topology(stale).present, false);
  assert.doesNotMatch(topology(stale).detail, /translation export/, 'a caption the read shows is judged by the read');
  assert.strictEqual(h.exportsAsked.length, 0);
});
