'use strict';
// #455 — REAL BUNDLE: the authoring language must reach the serializers.
//
// The plugin's data-model labels have honoured the org language since #447, but form, sitemap and
// dashboard labels went through SDK serializers that hardcoded `const LCID = 1033` with no caller
// override. That is now `MakerSdkOptions.languageCode`, and the plugin threads a resolved LCID into
// `createMakerSdk` (see `makeSdk` in build-model-app.js).
//
// COVERAGE: form labels, sitemap titles, AND dashboard labels are all covered below.
//
// The dashboard half was an open hole until now, and the reason is worth keeping: an EMPTY dashboard
// emits no `<labels>` at all, so there was nothing to assert. It needs a POPULATED one. A re-vendor
// that dropped dashboard parameterization while leaving form and sitemap intact would previously
// have passed this file; it no longer can.
//
// Live status: the FORM half is live-verified — a form pushed against a genuinely Spanish org
// (base language 3082) came back FROM THE SERVER with `languagecode="3082"` on every label. The
// sitemap and dashboard halves are real-bundle-verified only. That is a real limit, not an
// oversight: every scratch organization available here provisions 1033 ONLY (30/30 probed), and the
// #456 guard correctly refuses to build at an LCID the org has not provisioned — so a live non-1033
// dashboard cannot be produced without a language pack nobody has installed. Observing 1033 on a
// 1033-only org proves nothing here, because 1033 is exactly what the OLD hardcoded serializer
// emitted; only the non-default assertions below separate the two.
//
// This drives the REAL vendored bundle rather than a mock, because the whole failure mode is "the
// mock accepts an option the bundle ignores". A mock-based test would stay green against a bundle
// that dropped the option on the floor — precisely the state this file exists to detect after a
// re-vendor.
//
// NOTE: `createArtifact` does NOT serialize. FormXML and sitemap XML are produced at PUSH time, so
// these capture the push payload, the same way vendor-sdk-smoke.test.js does.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const dirs = [];

// Offline client that records every write so the serialized payload can be inspected. Reads answer
// with an empty envelope; nothing here needs a live org.
function sdkAt(languageCode) {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcid-'));
  dirs.push(dir);
  const capture = [];
  const rec = (verb) => async (url, body) => { capture.push({ verb, url, body }); return {}; };
  const sdk = createMakerSdk({
    workspacePath: dir,
    instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: { get: async () => ({}), post: rec('post'), patch: rec('patch'), put: rec('put'), delete: rec('delete') },
    ...(languageCode ? { languageCode } : {}),
  });
  sdk.initWorkspace();
  return { sdk, capture };
}

const langsIn = (s) => [...new Set(String(s || '').match(/languagecode="\d+"/g) || [])];
const lcidsIn = (s) => [...new Set(String(s || '').match(/LCID="\d+"/g) || [])];

async function pushedForm(languageCode) {
  const { sdk, capture } = sdkAt(languageCode);
  const form = sdk.createArtifact('form', { entityLogicalName: 'account', name: 'LCID Form' });
  await sdk.pushArtifact('form', form.id);
  const write = capture.find((c) => c.body && typeof c.body.formxml === 'string');
  assert.ok(write, 'a write carrying FormXML was issued; got ' + JSON.stringify(capture.map((c) => c.url)));
  return write.body.formxml;
}

test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('REAL BUNDLE: createMakerSdk({ languageCode }) stamps FormXML labels at that LCID (#455)', async () => {
  const xml = await pushedForm(1031);
  assert.deepStrictEqual(langsIn(xml), ['languagecode="1031"'],
    `every FormXML label must carry the configured LCID and nothing else; got ${JSON.stringify(langsIn(xml))}`);
});

test('REAL BUNDLE: omitting languageCode preserves the previous 1033 behaviour exactly', async () => {
  // This is what makes threading the option safe: a build that passes nothing must behave exactly as
  // before, so the change is opt-in rather than a silent re-labelling of every existing app.
  const xml = await pushedForm(undefined);
  assert.deepStrictEqual(langsIn(xml), ['languagecode="1033"'], 'the SDK default LCID is unchanged');
});

test('REAL BUNDLE: the sitemap title LCID follows the configured language too (#455)', async () => {
  // The sitemap is the other half of #455 — <Titles><Title LCID="…"> was hardcoded alongside FormXML.
  const { sdk, capture } = sdkAt(1036);
  const app = sdk.createArtifact('app', { name: 'LCID App' });
  await sdk.pushArtifact('app', app.id);
  const write = capture.find((c) => c.body && typeof c.body.sitemapxml === 'string');
  assert.ok(write, 'a write carrying sitemap XML was issued; got ' + JSON.stringify(capture.map((c) => c.url)));
  const found = lcidsIn(write.body.sitemapxml);
  assert.ok(found.length > 0, 'the sitemap carries at least one Title LCID');
  assert.deepStrictEqual(found, ['LCID="1036"'],
    `sitemap titles must use the configured LCID; got ${JSON.stringify(found)}`);
});

test('REAL BUNDLE: languageCode is a live contract — two LCIDs must not serialize identically', async () => {
  // The guard against a future re-vendor quietly dropping the option. If a bundle ignored
  // `languageCode`, both branches would produce identical bytes and a single-LCID assertion could
  // still pass by coincidence on the default path.
  const a = await pushedForm(1031);
  const b = await pushedForm(3082);
  assert.notStrictEqual(a, b, 'identical input at two different LCIDs must not serialize identically');
  assert.deepStrictEqual(langsIn(a), ['languagecode="1031"']);
  assert.deepStrictEqual(langsIn(b), ['languagecode="3082"']);
});

// --- dashboards: the third serializer #455 parameterized -------------------------------------
//
// Pushes the payload PRODUCTION builds, via the exported `dashboardComponent`, rather than a
// hand-copied literal. A duplicated shape would keep passing after production changed, which is the
// failure mode this whole file exists to prevent.
async function pushedDashboard(languageCode) {
  const { dashboardComponent } = require(path.resolve(__dirname, '..', 'lib', 'sdk-build.js'));
  const { sdk, capture } = sdkAt(languageCode);
  const art = sdk.createArtifact('dashboard', { name: 'LCID Dashboard' });
  // A tile must carry a NAME: the name becomes the cell's <label description="…">, and a dashboard
  // with no labelled tile emits no <labels> at all — which is exactly why this was uncoverable
  // before. One list tile and one chart tile, so both branches of dashboardComponent are exercised.
  const tiles = [
    { type: 'list', name: 'Recent', targetEntity: 'account', viewId: '{11111111-1111-1111-1111-111111111111}' },
    { type: 'chart', name: 'By Priority', targetEntity: 'account', viewId: '{11111111-1111-1111-1111-111111111111}', visualizationId: '{22222222-2222-2222-2222-222222222222}' },
  ];
  for (let i = 0; i < tiles.length; i++) {
    await sdk.addElement('dashboard', art.id, '/components', dashboardComponent(tiles[i], i));
  }
  await sdk.pushArtifact('dashboard', art.id);
  const write = capture.find((c) => c.body && typeof c.body.formxml === 'string');
  assert.ok(write, 'a write carrying dashboard FormXML was issued; got ' + JSON.stringify(capture.map((c) => c.url)));
  return write.body.formxml;
}

// Does EVERY <label> element carry languagecode="<lcid>"?
//
// One predicate, used for both the assertion and its guard. That matters: the earlier version
// counted `<label` occurrences against `languagecode="…"` occurrences inline, and its guard
// re-derived those counts with its own expressions — so making the primary comparison tautological
// (both sides counting `<label`) would have left the guard passing independently. A guard that does
// not run the code it guards proves nothing about it.
//
// Inspects each label TAG rather than counting attributes document-wide, so an attribute belonging
// to some other element cannot stand in for a missing one:
//   <label description="Recent" languagecode="1031" />
function allLabelsHaveLanguage(xml, lcid) {
  const labels = String(xml || '').match(/<label\b[^>]*>/g) || [];
  if (!labels.length) return false;
  return labels.every((tag) => new RegExp(`languagecode="${lcid}"`).test(tag));
}

test('REAL BUNDLE: a POPULATED dashboard stamps its labels at the configured LCID (#455)', async () => {
  const xml = await pushedDashboard(1031);
  assert.deepStrictEqual(langsIn(xml), ['languagecode="1031"'],
    `every dashboard label must carry the configured LCID and nothing else; got ${JSON.stringify(langsIn(xml))}`);
  // `langsIn` DEDUPES and only sees labels that carry the attribute at all, so on its own it cannot
  // distinguish "every label is 1031" from "one label is 1031 and another has no languagecode".
  assert.ok((xml.match(/<label\b/g) || []).length > 0, 'a populated dashboard emits at least one label');
  assert.strictEqual(allLabelsHaveLanguage(xml, 1031), true,
    'every <label> element must carry languagecode="1031"');
  // GUARD THE GUARD: prove that SAME predicate can FAIL. Delete the attribute from one label and it
  // must go false. Without this, a predicate that always returned true would look identical to a
  // passing test — which is exactly how the tautology in header-nav-real-bundle.test.js survived.
  const doctored = xml.replace(/ languagecode="1031"/, '');
  assert.strictEqual(allLabelsHaveLanguage(doctored, 1031), false,
    'the completeness predicate must detect a label whose languagecode was removed');
});

test('REAL BUNDLE: omitting languageCode leaves dashboard labels at 1033', async () => {
  const xml = await pushedDashboard(undefined);
  assert.deepStrictEqual(langsIn(xml), ['languagecode="1033"'],
    'the SDK dashboard default LCID is unchanged, so threading the option stays opt-in');
});

test('REAL BUNDLE: two LCIDs must not serialize a dashboard identically', async () => {
  // Same drift guard as the form case: a bundle that ignored the option would emit identical bytes.
  const a = await pushedDashboard(1031);
  const b = await pushedDashboard(3082);
  assert.notStrictEqual(a, b, 'identical dashboard input at two LCIDs must not serialize identically');
  assert.deepStrictEqual(langsIn(a), ['languagecode="1031"']);
  assert.deepStrictEqual(langsIn(b), ['languagecode="3082"']);
});

test('REAL BUNDLE: a chart tile serializes VisualizationId, never ChartId', async () => {
  // Belongs here because this is the only place the production tile payload is pushed through the
  // real bundle and the resulting XML inspected. `ChartId` is rejected by the platform's dashboard
  // FormXML schema and cost a whole phase; the mock-based test had asserted the wrong name, so the
  // suite agreed with the bug. Asserting on the SERIALIZED bytes cannot be fooled the same way.
  const xml = await pushedDashboard(1031);
  assert.match(xml, /<VisualizationId>\{22222222-2222-2222-2222-222222222222\}<\/VisualizationId>/,
    'the chart tile binds its visualization through VisualizationId');
  assert.doesNotMatch(xml, /ChartId/,
    'ChartId is not a legal child of <parameters> and must never be emitted');
});
