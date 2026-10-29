'use strict';
// THE OPTIONS THE SKILLS PASS TO THE BUNDLED SDK, AND WHETHER IT STILL READS THEM.
//
// An option is a property of a plain object, so an SDK that renames or drops one does not fail: it ignores it, and the behaviour the
// option asked for silently goes away — the language a form's labels are written in, the recovery of a form create whose answer was
// lost, the publish a build defers to one envelope. sdk-surface-contract.test.js guards the METHODS the skills call; this file guards
// their OPTIONS, at the real bundle's boundary:
//
//   1. Factory options. Every option a script passes to createMakerSdk — found by scanning the call sites, so a new one is forced into
//      SKILL_FACTORY_OPTIONS — is READ by the bundle's own createMakerSdk (an options object that records the keys read of it). The
//      bundle reads each option by name at construction (measured: it never spreads or enumerates the object, so an option it does not
//      know is never read — the meta test proves an unknown key is not reported as read). lib/maker-sdk.js adds two (the compiler, the
//      Power Apps service client) and keeps one of the plugin's own (`connectivity`) from reaching the SDK.
//   2. Per-call options with no trace on a fault-free request: `overwrite` (fetchArtifact discards a dirty local copy), `publish:false` and
//      `excludeViewIds` (enrichDefaultViews defers its publish and leaves the author's views alone), and the read options of queryRecords
//      and findTables. Each is called on the stateful fake environment with an options object that records what is read, and the effect
//      of `publish:false` — no publish sent, the publish owed reported — is asserted as well.
//
// What the options DO is pinned by the tests that own each behaviour (named beside each option below); the request trail of the whole
// lifecycle (lifecycle-trail-golden-real-bundle.test.js) pins the effect of every option that changes a fault-free request. A failure here
// says which option the bundle no longer reads: find what the SDK calls it now, and move every call site and this list to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { productionScripts, scriptLabel, withoutComments } = require('./helpers/production-scripts.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { seedForeignWork, FOREIGN } = require('./helpers/lifecycle-harness.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const makerSdk = require('../lib/maker-sdk.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

// Every option the scripts pass to createMakerSdk, and where its effect is pinned. Alphabetical, one per line.
const SKILL_FACTORY_OPTIONS = {
  createRecovery: 'form-create-recovery-real-bundle.test.js — a Main form create whose answer was lost is adopted when it is exact',
  httpClient: 'every real-bundle test — the transport',
  instanceUrl: 'every real-bundle test — the environment the requests go to',
  languageCode: 'form-label-language-real-bundle.test.js, lcid-real-bundle.test.js — the language labels are written in',
  readConcurrency: 'sdk-opt-ins.test.js — a page\'s file downloads overlap',
  solutionUniqueName: 'apps-real-bundle.test.js, form-create-recovery-real-bundle.test.js — the solution a create joins',
  workspaceStorage: 'workspace-projection-real-bundle.test.js — where the workspace copies are kept',
};
// What lib/maker-sdk.js adds to every instance (and which a caller may name to override).
const FACTORY_ADDED_OPTIONS = {
  powerAppsServiceClient: 'connectivity-real-bundle.test.js — the client of the connection and connector reads, for a caller that asks for `connectivity`',
  typescript: 'genpage-sdk-real-bundle.test.js — the compiler a page is compiled with',
};
// The plugin's own request to lib/maker-sdk.js; it must never reach the SDK.
const PLUGIN_ONLY_OPTIONS = ['connectivity'];

// The keys of the object literal that opens at `open` (a `{`): `key: value`, a shorthand `key`, and the keys of each object literal inside a
// spread (`...(languageCode ? { languageCode } : {})`). Strings and template literals are skipped; nested objects in a VALUE are not keys.
//   createMakerSdk({ workspaceStorage: storage(dir), instanceUrl: env, httpClient, ...(lang ? { languageCode: lang } : {}) })
//   -> workspaceStorage, instanceUrl, httpClient, languageCode
function objectKeys(src, open) {
  const keys = [];
  let depth = 0;
  let i = open;
  let expectKey = false;
  let spreadFrom = -1;
  const skipString = (at) => {
    const quote = src[at];
    let j = at + 1;
    while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
    return j;
  };
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\'' || ch === '"' || ch === '`') { i = skipString(i); continue; }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
      if (depth === 1) expectKey = true;
      else if (ch === '{' && spreadFrom >= 0) {
        const inner = objectKeys(src, i);
        keys.push(...inner.keys);
        i = inner.end;
        depth--;
      }
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) return { keys, end: i };
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ',') { expectKey = true; spreadFrom = -1; continue; }
    if (!expectKey || /\s/.test(ch)) continue;
    expectKey = false;
    if (src.startsWith('...', i)) { spreadFrom = i; i += 2; continue; }
    const m = /^([A-Za-z_$][\w$]*)\s*(?=[:,}])/.exec(src.slice(i, i + 80));
    if (m) { keys.push(m[1]); i += m[1].length - 1; }
  }
  return { keys, end: i };
}

// Every key a production script passes in a `createMakerSdk({ … })` call, with the scripts that pass it.
function factoryOptionsPassed() {
  const found = new Map();
  for (const file of productionScripts()) {
    const src = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/\bcreateMakerSdk\(\s*\{/g)) {
      for (const key of objectKeys(src, m.index + m[0].length - 1).keys) {
        if (!found.has(key)) found.set(key, new Set());
        found.get(key).add(scriptLabel(file));
      }
    }
  }
  return found;
}

// The keys `create` reads of the options it is given (an options object that records each `get`).
function keysReadBy(create, options) {
  const read = new Set();
  const recording = new Proxy(options, { get(target, key, receiver) { if (typeof key === 'string') read.add(key); return Reflect.get(target, key, receiver); } });
  create(recording);
  return read;
}

const NOOP_CLIENT = { get: async () => ({}), post: async () => ({}), patch: async () => ({}), delete: async () => ({}), put: async () => ({}) };
function everyFactoryOption(dir) {
  const bundle = require(BUNDLE);
  return {
    workspaceStorage: bundle.createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient: NOOP_CLIENT,
    solutionUniqueName: 'ContosoCore', languageCode: 1036, createRecovery: 'adoptExact', readConcurrency: 4,
    typescript: () => null, powerAppsServiceClient: NOOP_CLIENT,
  };
}

test('SDK options: every option a script passes to createMakerSdk is in SKILL_FACTORY_OPTIONS (or is the plugin\'s own)', () => {
  const passed = factoryOptionsPassed();
  const known = new Set([...Object.keys(SKILL_FACTORY_OPTIONS), ...Object.keys(FACTORY_ADDED_OPTIONS), ...PLUGIN_ONLY_OPTIONS]);
  const unlisted = [...passed].filter(([key]) => !known.has(key)).map(([key, files]) => `${key} (${[...files].join(', ')})`);
  assert.deepEqual(unlisted, [], `Add these createMakerSdk options to SKILL_FACTORY_OPTIONS, with the test that pins their effect: ${unlisted.join('; ')}`);
  for (const key of ['workspaceStorage', 'instanceUrl', 'httpClient', 'solutionUniqueName', 'languageCode', 'createRecovery', 'readConcurrency']) {
    assert.ok(passed.has(key), `the scan finds ${key} at a call site (a scan that finds nothing guards nothing)`);
  }
});

test('SDK options: the bundled SDK\'s createMakerSdk reads every option the skills give it', () => {
  const bundle = require(BUNDLE);
  const read = keysReadBy(bundle.createMakerSdk, everyFactoryOption(makeTempDir('sdk-options-')));
  const ignored = [...Object.keys(SKILL_FACTORY_OPTIONS), ...Object.keys(FACTORY_ADDED_OPTIONS)].filter((key) => !read.has(key));
  assert.deepEqual(ignored, [], `The bundled SDK no longer reads these options, so what each asked for is silently lost: ${ignored.map((k) => `${k} (${SKILL_FACTORY_OPTIONS[k] || FACTORY_ADDED_OPTIONS[k]})`).join('; ')}`);
});

test('SDK options: lib/maker-sdk.js gives the SDK its compiler and keeps the plugin\'s own `connectivity` from reaching it', () => {
  let given;
  const create = makerSdk.withVendoredCompiler((options) => { given = options; return {}; });
  create({ instanceUrl: 'https://contoso.crm.dynamics.com', connectivity: true, powerAppsServiceClient: NOOP_CLIENT });
  assert.equal(typeof given.typescript, 'function', 'the vendored compiler, loaded when a page is first compiled');
  assert.equal(given.powerAppsServiceClient, NOOP_CLIENT, 'a client the caller names wins');
  for (const key of PLUGIN_ONLY_OPTIONS) assert.equal(Object.prototype.hasOwnProperty.call(given, key), false, `${key} is the plugin's own`);
});

// The per-call options, on the stateful fake environment with another maker's work in it (a table with its generated default views, an app).
test('SDK options: fetchArtifact, enrichDefaultViews, queryRecords and findTables read the options the skills pass them, and publish:false defers the publish', async () => {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const client = createAzHttpClient(org.origin, { getToken: () => 'sdk-options-token-0123456789', request: org.request, sleep: async () => {} });
  const sdk = makerSdk.createMakerSdk({ workspaceStorage: makerSdk.createNodeWorkspaceStorage(makeTempDir('sdk-options-call-')), instanceUrl: org.origin, httpClient: client });
  await sdk.initWorkspace();
  const WIDGET_COLUMNS = [{ name: 'fabrikam_name', width: 300, order: 0 }];
  const call = async (fn, options) => {
    const read = new Set();
    const recording = new Proxy(options, { get(target, key, receiver) { if (typeof key === 'string') read.add(key); return Reflect.get(target, key, receiver); } });
    const mark = org.mark();
    const value = await fn(recording);
    return { read, value, sent: org.since(mark) };
  };

  // lib/sdk-build.js, lib/genpage-sdk.js: a fetch that takes the environment's copy over the workspace's (workspace-projection-real-bundle.test.js pins the effect).
  const fetched = await call((o) => sdk.fetchArtifact('app', FOREIGN.app, o), { overwrite: true });
  assert.ok(fetched.read.has('overwrite'), 'fetchArtifact reads `overwrite`');

  // lib/sdk-build.js (views phase, with --publish): the default views are saved, their publish left to the build's one envelope.
  const deferred = await call((o) => sdk.enrichDefaultViews('fabrikam_widget', WIDGET_COLUMNS, o), { excludeViewIds: [], publish: false });
  assert.deepEqual([...deferred.read].sort(), ['excludeViewIds', 'publish'], 'enrichDefaultViews reads both options');
  assert.ok(deferred.value.updated.length > 0, `the table's generated default views were enriched: ${JSON.stringify(deferred.value)}`);
  assert.equal(deferred.sent.filter((r) => r.path === '/PublishXml').length, 0, 'publish:false sends no publish');
  assert.ok((deferred.value.pendingPublish || []).length > 0, 'and reports the publish it owes');
  // The same call without the option publishes at once: the option, not the call, is what deferred it.
  const published = await call((o) => sdk.enrichDefaultViews('fabrikam_widget', WIDGET_COLUMNS, o), {});
  assert.equal(published.sent.filter((r) => r.path === '/PublishXml').length, 1, 'without it, the enrichment publishes the table');

  // download-model-app.js, verify-model-app.js, …: the read options of queryRecords, and findTables' cap (lib/entity-provision.js).
  const queried = await call((o) => sdk.queryRecords('solution', o), { select: ['solutionid'], filter: "uniquename eq 'FabrikamCore'", top: 1 });
  assert.deepEqual([...queried.read].filter((k) => ['select', 'filter', 'top'].includes(k)).sort(), ['filter', 'select', 'top'], 'queryRecords reads select, filter and top');
  assert.equal(queried.value.length, 1, 'and the filter is applied');
  const paged = await call((o) => sdk.queryRecords('solution', o), { select: ['solutionid'], paginate: true });
  assert.ok(paged.read.has('paginate'), 'queryRecords reads paginate');
  const tables = await call((o) => sdk.findTables('fabrikam_widget', o), { top: 50 });
  assert.ok(tables.read.has('top'), 'findTables reads top');
});

// The guard of the guard: the recorder does not report a key the factory never reads, and the scan finds options in each form a
// call site writes them — so neither check can pass because it sees nothing.
test('SDK options (meta): an option the SDK does not know is not reported as read, and the scan reads key, shorthand and spread forms', () => {
  const bundle = require(BUNDLE);
  const read = keysReadBy(bundle.createMakerSdk, { ...everyFactoryOption(makeTempDir('sdk-options-meta-')), contosoRenamedOption: true });
  assert.equal(read.has('contosoRenamedOption'), false);
  const src = "createMakerSdk({ workspaceStorage: storage(dir, { nested: 1 }), instanceUrl: 'https://x/{y}', httpClient, ...(lang ? { languageCode: lang } : {}), readConcurrency: 4 })";
  assert.deepEqual(objectKeys(src, src.indexOf('{')).keys, ['workspaceStorage', 'instanceUrl', 'httpClient', 'languageCode', 'readConcurrency']);
});
