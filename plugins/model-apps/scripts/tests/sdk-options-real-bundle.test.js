'use strict';
// THE OPTIONS THE SKILLS PASS TO THE BUNDLED SDK: THAT IT STILL READS THEM, AND THAT EACH STILL DOES WHAT IT IS PASSED FOR.
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
//   3. EFFECTS. A read is only a rename detector: an SDK that reads an option and then ignores it passes it. So what each option is passed
//      for is asserted by what it changes, here or in the test that owns that behaviour (named beside each factory option below):
//        readConcurrency   here: the page backend's four file downloads are in flight at once
//        excludeViewIds    here: an excluded default view is not written; without the option it is
//        overwrite         here: an edited workspace copy is handed back without it, replaced with it
//        publish:false     here: no publish is sent and the publish owed is reported; without it one is sent
//        queryRecords      here: select, filter, orderBy and top reach the query; paginate reads to the last page, and without it the
//                          first page only; findTables' top caps its answer
//        detail            genpage-verbs-real-bundle.test.js (generateGenPageRuntimeTypes, through `genpage.js types`)
//        verify            sdk-publication-real-bundle.test.js (publishArtifact answers `verified` from its read-back)
//      The options that are a request's DATA — a column's maxLength, a status reason's label, a lookup's criteria (resolveArtifact,
//      findArtifact), the members a push adds — change the request body or URL, which the lifecycle's request trail pins for every call
//      on its path (lifecycle-trail-golden-real-bundle.test.js). Off that path and not pinned: updateColumn's options, the BPF reads' orderBy
//      beyond the query string (no lifecycle BPF), seedRecordGraph's entitySetFor/createdIds beyond the sample data the lifecycle seeds.
// A failure says which option no longer reads, or no longer does what it is passed for: find what the SDK calls or does now, and move every
// call site and this file to it.
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
  createRecovery: 'form-create-recovery-real-bundle.test.js — a lost-answer Main form create is adopted with it, and halts without it',
  httpClient: 'every real-bundle test — the transport',
  instanceUrl: 'every real-bundle test — the environment the requests go to',
  languageCode: 'lcid-real-bundle.test.js — FormXML labels stamped at the LCID given, and at 1033 without it',
  readConcurrency: 'this file (effect): a page\'s four file downloads are in flight at once; sdk-opt-ins.test.js: passed exactly where a read it overlaps is made',
  solutionUniqueName: 'table-columns-in-create.test.js — each column request carries MSCRM.SolutionUniqueName; form-create-recovery-real-bundle.test.js — which instance carries it',
  workspaceStorage: 'workspace-projection-real-bundle.test.js — where the workspace copies are kept',
};
// What lib/maker-sdk.js adds to every instance (and which a caller may name to override).
const FACTORY_ADDED_OPTIONS = {
  powerAppsServiceClient: 'connectivity-real-bundle.test.js — the client of the connection and connector reads, for a caller that asks for `connectivity`',
  typescript: 'genpage-sdk-real-bundle.test.js — every page create the backend makes is compiled through it',
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

// ====================================================================================================================================
// THE EFFECT OF EACH OPTION. That the bundle reads an option (above) catches a rename; it does not prove the option still does what the
// skills pass it for — an SDK that reads `readConcurrency` and then runs one request at a time, or reads `excludeViewIds` and then
// ignores it, passes every read check. Each option below is asserted by what it changes in the requests or the result, with and without
// it where the difference is the point. The options whose effect another test already owns are named in SKILL_FACTORY_OPTIONS.

// What lib/genpage-sdk.js passes it for: a page's file downloads overlap (four at a time). The page backend is made as the scripts make
// it, and its four file downloads are held at a gate that opens when all four are in flight at once — or after a second, so an SDK that
// sends them one by one is measured (as one in flight at a time) instead of hanging.
test('SDK option effects: the page backend\'s readConcurrency overlaps a page\'s file downloads (four in flight at once)', async () => {
  const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const FILE_DOWNLOAD = /\/uxagentprojectfiles\([^)]*\)\/filecontent/;
  let inFlight = 0;
  let most = 0;
  let downloads = 0;
  const waiting = [];
  const gated = async (req) => {
    if (req.method !== 'GET' || !FILE_DOWNLOAD.test(decodeURIComponent(req.url))) return org.request(req);
    downloads += 1;
    inFlight += 1;
    most = Math.max(most, inFlight);
    if (inFlight >= 4) waiting.splice(0).forEach((open) => open());
    else await new Promise((open) => { waiting.push(open); setTimeout(open, 1000); });
    try { return await org.request(req); } finally { inFlight -= 1; }
  };
  const client = createAzHttpClient(org.origin, { getToken: () => 'sdk-options-token-0123456789', request: gated, sleep: async () => {} });
  const genpage = makeGenpageSdk(org.origin, { httpClient: client });
  try {
    const page = await genpage.read(FOREIGN.page);
    assert.equal(typeof page.source, 'string', 'the page was read');
  } finally {
    await genpage.dispose();
  }
  assert.equal(downloads, 4, 'the seeded page has four files');
  assert.equal(most, 4, `the four downloads were in flight at once (most at once: ${most})`);
});

// What lib/sdk-build.js passes it for: the default-view enrichment leaves the author's own views alone. The other maker's table has its
// generated pair; with the Active view excluded only the Inactive one is enriched — and without the option both are.
test('SDK option effects: enrichDefaultViews leaves an excluded view untouched, and enriches it when it is not excluded', async () => {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const client = createAzHttpClient(org.origin, { getToken: () => 'sdk-options-token-0123456789', request: org.request, sleep: async () => {} });
  const sdk = makerSdk.createMakerSdk({ workspaceStorage: makerSdk.createNodeWorkspaceStorage(makeTempDir('sdk-options-exclude-')), instanceUrl: org.origin, httpClient: client });
  await sdk.initWorkspace();
  const idOf = (name) => org.find('savedqueries', (v) => v.returnedtypecode === 'fabrikam_widget' && v.name === name)[0].savedqueryid;
  const active = idOf('Active Widgets');
  const inactive = idOf('Inactive Widgets');
  const columns = [{ name: 'fabrikam_name', width: 300, order: 0 }];
  const patchedBy = async (options) => {
    const mark = org.mark();
    const record = await sdk.enrichDefaultViews('fabrikam_widget', columns, options);
    const patched = org.since(mark).filter((r) => r.method === 'PATCH' && /^\/savedqueries\(/.test(r.path)).map((r) => /\(([^)]+)\)/.exec(r.path)[1].toLowerCase());
    return { updated: record.updated.map((v) => String(v.id || v).toLowerCase()).sort(), patched: patched.sort() };
  };
  const excluded = await patchedBy({ excludeViewIds: [active], publish: false });
  assert.deepEqual(excluded.patched, [inactive.toLowerCase()], 'only the view that is not excluded is written');
  assert.deepEqual(excluded.updated, [inactive.toLowerCase()], 'and only it is reported enriched');
  const both = await patchedBy({ publish: false });
  assert.deepEqual(both.patched, [active, inactive].map((id) => id.toLowerCase()).sort(), 'without the option the pair is written');
});

// What lib/genpage-sdk.js and lib/sdk-build.js pass it for: fetching takes the environment's copy over the workspace's. A copy edited in
// the workspace is handed back as it is without the option, and replaced by the environment's with it.
test('SDK option effects: fetchArtifact with overwrite replaces an edited workspace copy; without it the edit is handed back', async () => {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const client = createAzHttpClient(org.origin, { getToken: () => 'sdk-options-token-0123456789', request: org.request, sleep: async () => {} });
  const sdk = makerSdk.createMakerSdk({ workspaceStorage: makerSdk.createNodeWorkspaceStorage(makeTempDir('sdk-options-overwrite-')), instanceUrl: org.origin, httpClient: client });
  await sdk.initWorkspace();
  const server = await sdk.fetchArtifact('app', FOREIGN.app, { overwrite: true });
  await sdk.updateElement('app', FOREIGN.app, '/description', 'an edit only the workspace holds');
  const kept = await sdk.fetchArtifact('app', FOREIGN.app);
  assert.equal(kept.description, 'an edit only the workspace holds', 'without overwrite the edited copy is handed back');
  const replaced = await sdk.fetchArtifact('app', FOREIGN.app, { overwrite: true });
  assert.equal(replaced.description, server.description, 'with overwrite the environment\'s copy replaces it');
});

// The read options of queryRecords, on a transport that records each URL and answers the solution list in two pages: select, filter,
// orderBy (lib/sdk-build.js reads business process flows in order) and top reach the query; paginate follows the continuation link to
// the end, and a read without it stops at the first page. findTables' top caps what it answers (lib/entity-provision.js).
test('SDK option effects: queryRecords puts select, filter, orderBy and top in the query, paginate reads every page, and findTables honours top', async () => {
  const ORG = 'https://contoso.crm.dynamics.com';
  const NEXT = `${ORG}/api/data/v9.2/solutions?$select=solutionid&$skiptoken=page2`;
  const urls = [];
  const answer = (body) => ({ status: 200, headers: {}, body });
  const httpClient = {
    get: async (url) => {
      const u = decodeURIComponent(String(url));
      urls.push(u);
      if (/EntityDefinitions\(LogicalName='solution'\)/.test(u)) return answer({ EntitySetName: 'solutions', LogicalName: 'solution' });
      if (/skiptoken=page2/.test(u)) return answer({ value: [{ solutionid: 'b' }] });
      if (/\/solutions\?/.test(u)) return answer({ value: [{ solutionid: 'a' }], '@odata.nextLink': NEXT });
      if (/\/EntityDefinitions\?/.test(u)) {
        const table = (n) => ({ LogicalName: `contoso_item${n}`, SchemaName: `contoso_Item${n}`, EntitySetName: `contoso_item${n}s`, IsCustomEntity: true, DisplayName: { UserLocalizedLabel: { Label: `Item ${n}` } } });
        return answer({ value: [table(1), table(2), table(3)] });
      }
      return answer({});
    },
    post: async () => ({ status: 204, headers: {}, body: null }), patch: async () => ({ status: 204, headers: {}, body: null }),
    put: async () => ({ status: 204, headers: {}, body: null }), delete: async () => ({ status: 204, headers: {}, body: null }),
  };
  const bundle = require(BUNDLE);
  const sdk = bundle.createMakerSdk({ workspaceStorage: bundle.createNodeWorkspaceStorage(makeTempDir('sdk-options-query-')), instanceUrl: ORG, httpClient });
  await sdk.initWorkspace();

  urls.length = 0;
  await sdk.queryRecords('solution', { select: ['solutionid', 'uniquename'], filter: "uniquename eq 'ContosoCore'", orderBy: 'uniquename asc', top: 1 });
  const query = urls.find((u) => /\/solutions\?/.test(u));
  for (const part of ['$select=solutionid,uniquename', "$filter=uniquename eq 'ContosoCore'", '$orderby=uniquename asc', '$top=1']) assert.ok(query.includes(part), `${part} in ${query}`);

  urls.length = 0;
  assert.deepEqual((await sdk.queryRecords('solution', { select: ['solutionid'], paginate: true })).map((r) => r.solutionid), ['a', 'b'], 'paginate reads to the last page');
  assert.ok(urls.some((u) => /skiptoken=page2/.test(u)), 'through the continuation link');
  urls.length = 0;
  assert.deepEqual((await sdk.queryRecords('solution', { select: ['solutionid'] })).map((r) => r.solutionid), ['a'], 'without it, the first page only');
  assert.equal(urls.some((u) => /skiptoken=page2/.test(u)), false);

  assert.equal((await sdk.findTables('contoso_item', { top: 2 })).length, 2, 'findTables answers at most top tables');
  assert.equal((await sdk.findTables('contoso_item', { top: 50 })).length, 3, 'and all of them under a larger cap');
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
