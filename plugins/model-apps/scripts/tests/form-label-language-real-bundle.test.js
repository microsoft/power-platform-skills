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
const test = require('node:test');
const assert = require('node:assert');
const ai = require('../lib/artifact-intent.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { buildModelApp } = require('../build-model-app.js');
const { createHarness, seedForm, verifyForms } = require('./helpers/form-store-harness.js');

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
  const alone = topology(await verifyForms(h, spec));
  assert.strictEqual(alone.present, false, 'told nothing, verify holds the captions to the organization\u2019s English');
  assert.match(alone.detail, /tab 'tab_main' is deployed with no label in language 1033 \(it has "Aper\u00e7u" in 1036\), the spec declares label: "Aper\u00e7u" in language 1033/);
  assert.match(alone.detail, /the labels were compared in the organization's base language \(1033\), because verify was told no other: if the build was run with --language-code, give verify the same flag \(or pin "languageCode" in the spec\)/);
  for (const [what, opts, mutate] of [
    ['--language-code, as the standalone verify hands it', { languageCode: 1036 }, undefined],
    ['the language the build\u2019s SDK was made for', { preResolvedLanguageCode: 1036 }, undefined],
    ['both, as the build\u2019s own verify hands them', { languageCode: 1036, preResolvedLanguageCode: 1036 }, undefined],
    ['the flag, over a languageCode the spec pins to the organization\u2019s', { languageCode: 1036 }, (s) => { s.languageCode = 1033; }],
    ['a languageCode the spec pins', undefined, (s) => { s.languageCode = 1036; }],
  ]) {
    const s = { ...spec };
    if (mutate) mutate(s);
    const chk = topology(await verifyForms(h, s, opts));
    assert.strictEqual(chk.present, true, `${what}: ${chk.detail}`);
  }
  // A language that is given is held strictly: the form carries no English caption, so the English language does not verify it.
  const english = topology(await verifyForms(h, spec, { languageCode: 1033 }));
  assert.strictEqual(english.present, false);
  assert.match(english.detail, /no label in language 1033 \(it has "Aper\u00e7u" in 1036\)/);
  assert.doesNotMatch(english.detail, /compared in the organization's base language/, 'told the language, verify does not blame its guess');
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
