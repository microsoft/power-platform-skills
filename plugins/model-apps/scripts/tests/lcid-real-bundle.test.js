'use strict';
// #455 — REAL BUNDLE: the authoring language must reach the serializers.
//
// The plugin's data-model labels have honoured the org language since #447, but form, sitemap and
// dashboard labels went through SDK serializers that hardcoded `const LCID = 1033` with no caller
// override. That is now `MakerSdkOptions.languageCode`, and the plugin threads a resolved LCID into
// `createMakerSdk` (see `makeSdk` in build-model-app.js).
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
