'use strict';
// lib/maker-sdk.js is how every script makes the bundled SDK: with the vendored TypeScript compiler as its page compiler. Without one the SDK
// refuses to push a page whose source changed (GENPAGE_COMPILER_UNAVAILABLE), so a script that required the bundle directly would make an
// instance that fails only when a page is first pushed. This pins the wiring and that no production script goes around it.
const test = require('node:test');
const assert = require('node:assert');
const { scriptsMatching } = require('./helpers/production-scripts.js');

test('an SDK made through lib/maker-sdk.js is given the vendored compiler, lazily; an explicit one wins', () => {
  const { withVendoredCompiler } = require('../lib/maker-sdk.js');
  const seen = [];
  const create = withVendoredCompiler((options) => { seen.push(options); return options; });
  const made = create({ instanceUrl: 'https://contoso.crm.dynamics.com', languageCode: 3082 });
  assert.strictEqual(made.instanceUrl, 'https://contoso.crm.dynamics.com', 'the caller\'s options pass through');
  assert.strictEqual(made.languageCode, 3082);
  assert.strictEqual(typeof made.typescript, 'function', 'a provider, called only when a page is compiled');
  const ts = made.typescript();
  assert.strictEqual(ts.version, '5.8.3', 'the vendored compiler');
  const fake = { version: '5.8.3', transpileModule() {} };
  assert.strictEqual(create({ typescript: fake }).typescript, fake, 'a caller\'s own compiler wins');
});

test('lib/maker-sdk.js exports the bundle\'s surface, with createMakerSdk wired', () => {
  const sdk = require('../lib/maker-sdk.js');
  const bundle = require('../vendor/cds-maker-sdk.cjs');
  for (const name of Object.keys(bundle)) assert.ok(name in sdk, `${name} is exported`);
  assert.notStrictEqual(sdk.createMakerSdk, bundle.createMakerSdk, 'the wired factory, not the bundle\'s');
  assert.strictEqual(sdk.createNodeWorkspaceStorage, bundle.createNodeWorkspaceStorage);
});

test('no production script requires the SDK bundle itself — only lib/maker-sdk.js does', () => {
  assert.deepStrictEqual(scriptsMatching(/require\([^)]*vendor\/cds-maker-sdk\.cjs/), ['lib/maker-sdk.js']);
});
