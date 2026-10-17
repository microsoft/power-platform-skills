'use strict';
// lib/maker-sdk.js is how every script makes the bundled SDK: with the vendored TypeScript compiler as its page compiler. Without one the SDK
// refuses to push a page whose source changed (GENPAGE_COMPILER_UNAVAILABLE), so a script that required the bundle directly would make an
// instance that fails only when a page is first pushed. This pins the wiring and that no production script goes around it — and the one
// option the factory adds, `connectivity`, which hands a caller that asks the plugin's Power Apps service client.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
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

// --- `connectivity`: the Power Apps service client, for a caller that asks ------------------------------------------------------------

const ORG = 'https://contoso.crm.dynamics.com';

test('a caller that asks for connectivity is given the plugin\'s Power Apps service client, and the SDK is never told about the request itself', () => {
  const { withVendoredCompiler } = require('../lib/maker-sdk.js');
  const seen = [];
  const create = withVendoredCompiler((options) => { seen.push(options); return options; });
  const made = create({ instanceUrl: ORG, connectivity: true });
  assert.strictEqual('connectivity' in made, false, 'the SDK has no such option: the factory consumes it');
  assert.strictEqual(typeof made.powerAppsServiceClient.get, 'function');
  assert.strictEqual(typeof made.typescript, 'function', 'the vendored compiler is still given');
  assert.strictEqual(made.instanceUrl, ORG);
  // The client sends GETs only: the SDK's other client methods are refused rather than carried out.
  assert.deepStrictEqual(Object.keys(made.powerAppsServiceClient).sort(), ['delete', 'get', 'patch', 'patchRaw', 'post', 'postRaw', 'put']);
});

test('a caller that does not ask gets exactly what it always got: no client, and no key the factory did not add before', () => {
  const { withVendoredCompiler } = require('../lib/maker-sdk.js');
  const create = withVendoredCompiler((options) => options);
  for (const options of [{ instanceUrl: ORG }, { instanceUrl: ORG, connectivity: false }, { instanceUrl: ORG, connectivity: undefined }, { instanceUrl: ORG, connectivity: 0 }]) {
    const made = create(options);
    assert.deepStrictEqual(Object.keys(made).sort(), ['instanceUrl', 'typescript'], JSON.stringify(options));
  }
  assert.deepStrictEqual(Object.keys(create()).sort(), ['typescript'], 'no options at all');
  assert.deepStrictEqual(Object.keys(create(null)).sort(), ['typescript']);
});

test('a powerAppsServiceClient the caller names wins, as an explicit compiler does — also beside connectivity', () => {
  const { withVendoredCompiler } = require('../lib/maker-sdk.js');
  const create = withVendoredCompiler((options) => options);
  const own = { get() {} };
  assert.strictEqual(create({ powerAppsServiceClient: own }).powerAppsServiceClient, own);
  assert.strictEqual(create({ powerAppsServiceClient: own, connectivity: true }).powerAppsServiceClient, own);
});

test('the client module is loaded only when connectivity is asked for — an instance that reads no connections pays nothing', () => {
  const { spawnSync } = require('node:child_process');
  const probe = [
    "const loaded = () => Object.keys(require.cache).some((k) => /power-apps-service-client\\.js$/.test(k));",
    "const { withVendoredCompiler } = require('./lib/maker-sdk.js');",
    "const create = withVendoredCompiler((o) => o);",
    "const before = loaded();",
    "create({ instanceUrl: 'x' });",
    "const afterPlain = loaded();",
    "create({ instanceUrl: 'x', connectivity: true });",
    "console.log(JSON.stringify({ before, afterPlain, afterAsked: loaded() }));",
  ].join('\n');
  const run = spawnSync(process.execPath, ['-e', probe], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.stdout), { before: false, afterPlain: false, afterAsked: true });
});

test('REAL BUNDLE: with connectivity the SDK reads connections (it reaches the org); without it the three reads are refused before any request', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maker-sdk-connectivity-'));
  try {
    const requests = [];
    const refuseAll = async (url) => { requests.push(url); return { status: 503, headers: {}, body: { error: { message: 'down' } } }; };
    const httpClient = { get: refuseAll, post: refuseAll, patch: refuseAll, delete: refuseAll, put: refuseAll };

    const plain = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORG, httpClient });
    for (const read of [() => plain.listConnections(), () => plain.listConnectorOperations('shared_sql'), () => plain.getConnectorOperationSchema('shared_sql', 'GetTables')]) {
      await assert.rejects(read(), (err) => err.code === 'CONNECTIVITY_NOT_CONFIGURED');
    }
    assert.deepStrictEqual(requests, [], 'refused before any request');

    const asked = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORG, httpClient, connectivity: true });
    await assert.rejects(asked.listConnections(), (err) => err.code === 'CONNECTION_ERROR' && /RetrieveCurrentOrganization/.test(err.message), 'it went on to read the environment from the org');
    assert.strictEqual(requests.length, 1);
    assert.match(requests[0], /\/api\/data\/v9\.0\/RetrieveCurrentOrganization/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
