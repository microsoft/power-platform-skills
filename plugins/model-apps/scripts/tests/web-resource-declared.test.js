'use strict';
// A declared web resource (webResources[].reconcile: "declared"): its validation and verify messages, and the whole build —
// runSdkBuild's web-resources phase with the build's own featureCtx, creation port and settlement. The SDK is an in-memory
// double that records every call, so each case can say exactly which reads and writes reached it and in what order: a create,
// an adoption that waits for its approval, a settlement that stops the build (never retried), the receipt of an unconfirmed
// publication, and an undeclared resource that keeps the old path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { writeUnconfirmedWebResources, readUnconfirmedWebResources } = require('../lib/web-resource-records.js');
const { RETRY } = require('../lib/retry-policy.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { verifySpec } = require('../lib/verify-spec.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ENV = 'https://contoso.crm.dynamics.com';
const ROW = 'abababab-abab-4bab-8bab-abababababab';
const NEWID = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const NAME = 'contoso_/scripts/form.js';
const KEY = NAME.toLowerCase();
const WANT = 'var a = 1;';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const specOf = (webResources) => ({
  schemaVersion: 2, solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' }, app: { name: 'Contoso' },
  languageCode: 1033, entities: [], appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
  webResources,
});
const declared = (extra = {}) => [{ name: NAME, type: 'js', content: WANT, reconcile: 'declared', ...extra }];
const DEPENDENTS = [
  { t: 60, id: '11111111-1111-4111-8111-111111111111' },
  { t: 60, id: '22222222-2222-4222-8222-222222222222' },
  { t: 26, id: '33333333-3333-4333-8333-333333333333' },
];

// One build of the web-resources phase over an in-memory SDK. `exists` puts a row of NAME on the server with `live` as its
// published content; `receipt` records an earlier unconfirmed write of that row; `store` brings a managed-artifacts store.
async function run({ webResources = declared(), exists = false, live = 'var a = 0;', dependentsFail = false, membershipFails = false,
  approval = {}, store = false, receipt = false, publishedAbsent = false, updateThrows = null } = {}) {
  const ledger = [];
  const seq = [];
  const calls = { creates: [], updates: [], adds: [] };
  const L = (x) => ledger.push(x);
  // The raw reads the helper makes (lib/web-resource-reconcile.js webResourceReads, readWebResourceDependents):
  //   GET /webresourceset?$select=webresourceid,name,webresourcetype&$filter=name eq '<name>'               the row of that name
  //   GET /webresourceset(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=...              the saved row of a recorded id
  //   GET /RetrieveDependentComponents(ObjectId=@p1,ComponentType=@p2)?@p1=<id>&@p2=61               its platform-reported dependents
  //   GET /webresourceset(<id>)?$select=webresourceid,content                                         its published content
  const get = async (p) => {
    if (p.startsWith('/webresourceset?')) { L('GET byName'); return { status: 200, body: { value: exists ? [{ webresourceid: ROW, name: NAME, webresourcetype: 3 }] : [] } }; }
    if (p.includes('RetrieveUnpublished')) { L('GET saved(id)'); return exists ? { status: 200, body: { webresourceid: ROW, name: NAME, webresourcetype: 3 } } : { status: 404, body: { error: { code: '0x80040217' } } }; }
    if (p.startsWith('/RetrieveDependentComponents')) {
      L('GET dependents');
      if (dependentsFail) return { status: 500, body: { error: { code: '0x80040216', message: 'boom' } } };
      return { status: 200, body: { value: DEPENDENTS.map((d) => ({ dependentcomponenttype: d.t, dependentcomponentobjectid: d.id })) } };
    }
    if (p.startsWith(`/webresourceset(${ROW})?`)) { L('GET published(id)'); return publishedAbsent ? { status: 404, body: { error: { code: '0x80040217' } } } : { status: 200, body: { webresourceid: ROW, content: b64(live) } }; }
    L(`GET other ${p.slice(0, 60)}`);
    return { status: 404, body: { error: { code: '0x80040217' } } };
  };
  const sdk = {
    queryRecords: async (entity) => { L(`queryRecords(${entity})`); return []; },
    addSolutionComponent: async (c) => {
      L(`addSolutionComponent(${c.componentType})`);
      seq.push(`member:${c.componentType}`);
      calls.adds.push(`${c.componentType}:${c.componentId}`);
      if (membershipFails && c.componentType === 61) throw new Error('simulated solution membership refusal');
      return {};
    },
    createWebResource: async (o) => { L('createWebResource'); calls.creates.push(o.name); return { id: NEWID }; },
    updateWebResource: async (id, c) => {
      L(`updateWebResource(${id === ROW ? 'row' : id})`);
      calls.updates.push({ id, content: c.content });
      if (updateThrows) throw Object.assign(new Error('publication not confirmed'), { code: updateThrows, id });
      return { id };
    },
    dataverse: { get },
  };
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-declared-'));
  dirs.push(appDir);
  const workspaceDir = path.join(appDir, '.ws');
  fs.mkdirSync(workspaceDir, { recursive: true });
  if (receipt) writeUnconfirmedWebResources(workspaceDir, ENV, new Map([[KEY, { name: NAME, id: ROW }]]));
  const rows = new Map();
  const managedArtifacts = store ? { lookup: (kind, key) => rows.get(`${kind}|${key}`) || null, recordApplied: (b) => { seq.push(`bind:${b.kind}`); rows.set(`${b.kind}|${b.key}`, b); } } : undefined;
  let result;
  let halt = null;
  try {
    result = await runSdkBuild(specOf(webResources), {
      sdk, provisionSdk: sdk, apply: true, appDir, workspaceDir, env: ENV, phases: ['web-resources'], emit: () => {},
      ...approval, ...(managedArtifacts ? { managedArtifacts } : {}),
    });
  } catch (e) {
    halt = e;
  }
  const recorded = readUnconfirmedWebResources(workspaceDir, ENV);
  return {
    result, halt, ledger, seq, bindings: [...rows.keys()],
    creates: calls.creates, updates: calls.updates, adds: calls.adds,
    map: result ? { ...result.created.webResources } : null,
    receiptAfter: recorded.has(KEY) ? recorded.get(KEY).id : null,
  };
}

// The web resource's own approval (--authorize adopt:webresource:<name>), as build-model-app.js main() hands it to the engine.
const approve = { authorizedWebResourceAdoption: new Set([KEY]) };

// Every halt of a declared web resource that did not settle: the phase's BuildHalt, never retried, and its own first code.
function assertNeverHalt(r, code) {
  assert.ok(r.halt, `expected the build to halt with ${code}`);
  assert.equal(r.halt.retry, RETRY.NEVER);
  assert.equal(r.halt.transient, false);
  assert.ok(String(r.halt.message).includes(code), r.halt.message);
  assert.equal(r.map, null, 'no output map is returned from a halted build');
}

test('a new declared web resource is created once and joins the solution with the server id before its binding is recorded', async () => {
  const r = await run({ store: true });
  assert.equal(r.halt, null, r.halt && r.halt.message);
  assert.deepEqual(r.creates, [NAME]);
  assert.ok(r.adds.includes(`61:${NEWID}`));
  assert.ok(r.seq.indexOf('member:61') >= 0 && r.seq.indexOf('member:61') < r.seq.indexOf('bind:web-resource'), r.seq.join(','));
  assert.equal(r.map[NAME], NEWID);
});

test('without a managed-artifacts store (as the CLI runs) a new declared web resource is created and added, and no binding is kept', async () => {
  const r = await run();
  assert.equal(r.halt, null, r.halt && r.halt.message);
  assert.deepEqual(r.creates, [NAME]);
  assert.ok(r.adds.includes(`61:${NEWID}`));
  assert.deepEqual(r.bindings, []);
  assert.equal(r.map[NAME], NEWID);
});

test('a declared web resource whose solution add fails stops the build: managed-membership-failed, no binding, no map entry', async () => {
  const r = await run({ membershipFails: true, store: true });
  assertNeverHalt(r, 'managed-membership-failed');
  assert.deepEqual(r.bindings, []);
});

test('a declared web resource whose content file is missing stops the build before any request', async () => {
  const r = await run({ webResources: [{ name: NAME, type: 'js', contentPath: 'scripts/gone.js', reconcile: 'declared' }] });
  assertNeverHalt(r, 'web-resource-source-unreadable');
  assert.deepEqual(r.ledger, []);
});

test('an existing row with other content is not written without the adoption approval; the halt names it, the row and its dependents', async () => {
  const r = await run({ exists: true });
  assertNeverHalt(r, 'web-resource-adoption-not-authorized');
  assert.ok(r.halt.message.includes(`row ${ROW}`), r.halt.message);
  assert.ok(r.halt.message.includes('3 dependent component(s) (1 of component type 26, 2 of component type 60)'), r.halt.message);
  assert.deepEqual(r.updates, []);
  assert.deepEqual(r.creates, []);
});

test('with the adoption approval the existing row is written once, by id, and the map holds it', async () => {
  const r = await run({ exists: true, approval: approve });
  assert.equal(r.halt, null, r.halt && r.halt.message);
  assert.deepEqual(r.updates.map((u) => u.id), [ROW]);
  assert.ok(r.adds.includes(`61:${ROW}`));
  assert.equal(r.map[NAME], ROW);
});

test('an existing row whose content already matches needs no approval and is not written', async () => {
  const r = await run({ exists: true, live: WANT });
  assert.equal(r.halt, null, r.halt && r.halt.message);
  assert.deepEqual(r.updates, []);
  assert.deepEqual(r.creates, []);
  assert.equal(r.map[NAME], ROW);
});

test('dependents that cannot be read stop the build even with the approval, and nothing is written', async () => {
  const r = await run({ exists: true, dependentsFail: true, approval: approve });
  assertNeverHalt(r, 'web-resource-dependents-unreadable');
  assert.deepEqual(r.updates, []);
});

test('an earlier unconfirmed write is written again by id only with the approval, and its receipt is cleared after settling', async () => {
  const refused = await run({ exists: true, receipt: true, publishedAbsent: true });
  assertNeverHalt(refused, 'web-resource-adoption-not-authorized');
  assert.deepEqual(refused.updates, []);
  assert.equal(refused.receiptAfter, ROW, 'the receipt is kept');

  const approved = await run({ exists: true, receipt: true, publishedAbsent: true, approval: approve });
  assert.equal(approved.halt, null, approved.halt && approved.halt.message);
  assert.equal(approved.ledger[0], 'GET saved(id)');
  assert.deepEqual(approved.updates.map((u) => u.id), [ROW]);
  assert.equal(approved.receiptAfter, null);
  assert.equal(approved.map[NAME], ROW);
});

test('a write whose publication is not confirmed stops the build and keeps the receipt for the next run', async () => {
  const r = await run({ exists: true, approval: approve, updateThrows: 'WEB_RESOURCE_UNVERIFIED' });
  assertNeverHalt(r, 'web-resource-publication-unconfirmed');
  assert.equal(r.receiptAfter, ROW);
});

test('an undeclared web resource keeps the existing path: no dependents read, no binding, no halt', async () => {
  const r = await run({ webResources: [{ name: NAME, type: 'js', content: WANT }], store: true });
  assert.equal(r.halt, null, r.halt && r.halt.message);
  assert.deepEqual(r.bindings, []);
  assert.ok(!r.ledger.includes('GET dependents'), r.ledger.join(','));
});

// ---- validation and verify

const gateSpec = (extra = {}) => ({
  schemaVersion: 2, solution: { uniqueName: 'contoso', displayName: 'Contoso', publisherPrefix: 'contoso', publisherName: 'Contoso' },
  app: { name: 'Contoso', uniqueName: 'contoso_app' }, entities: [], appShell: { areas: [] }, ...extra,
});
const wr = (extra = {}) => ({ name: 'contoso_/scripts/Form.js', displayName: 'Form', type: 'js', content: 'var a = 1;', ...extra });
const validate = (spec) => validateAppSpec(spec, { profile: 'plan' });
const floorWarnings = (v) => v.warnings.filter((w) => w.includes('minimumPluginVersion'));

test('validation: reconcile on a web resource is "declared" or absent, never with external, and asks for the 2.21.0 floor', () => {
  const ok = validate(gateSpec({ minimumPluginVersion: '2.21.0', webResources: [wr({ reconcile: 'declared' })] }));
  assert.ok(!ok.errors.some((e) => /reconcile/.test(e)), JSON.stringify(ok.errors));
  assert.deepEqual(floorWarnings(ok), []);
  assert.equal(floorWarnings(validate(gateSpec({ webResources: [wr({ reconcile: 'declared' })] }))).length, 1, 'a declared web resource without the floor is warned');
  assert.deepEqual(floorWarnings(validate(gateSpec({ webResources: [wr()] }))), [], 'an undeclared one is not');
  const other = validate(gateSpec({ minimumPluginVersion: '2.21.0', webResources: [wr({ reconcile: 'other' })] }));
  assert.ok(other.errors.some((e) => e.includes('reconcile must be "declared"')), JSON.stringify(other.errors));
  const ext = validate(gateSpec({ minimumPluginVersion: '2.21.0', webResources: [wr({ reconcile: 'declared', external: true })] }));
  assert.ok(ext.errors.some((e) => e.includes('cannot also be declared')), JSON.stringify(ext.errors));
});

test('validation: a declared web resource needs a name no other web resource shares, letter case aside', () => {
  const sameRow = (v) => v.errors.filter((e) => e.includes('name one web resource'));
  const two = validate(gateSpec({ minimumPluginVersion: '2.21.0', webResources: [wr({ name: 'contoso_/scripts/form.js', reconcile: 'declared' }), wr({ reconcile: 'declared', content: 'var b = 2;' })] }));
  assert.equal(sameRow(two).length, 1, JSON.stringify(two.errors));
  assert.ok(sameRow(two)[0].includes("'contoso_/scripts/form.js'") && sameRow(two)[0].includes("'contoso_/scripts/Form.js'"), sameRow(two)[0]);
  const withUndeclared = validate(gateSpec({ minimumPluginVersion: '2.21.0', webResources: [wr({ reconcile: 'declared' }), wr({ name: 'CONTOSO_/SCRIPTS/FORM.JS' })] }));
  assert.equal(sameRow(withUndeclared).length, 1, 'a declared entry may not share its row with an undeclared one either');
  const exact = validate(gateSpec({ minimumPluginVersion: '2.21.0', webResources: [wr({ reconcile: 'declared' }), wr({ reconcile: 'declared' })] }));
  assert.equal(sameRow(exact).length, 1, 'the same name twice is one row too');
  // Neighbours that must not change: undeclared duplicates keep the acceptance earlier releases gave them, and distinct names pass.
  assert.deepEqual(sameRow(validate(gateSpec({ webResources: [wr(), wr({ name: 'CONTOSO_/scripts/form.js' })] }))), []);
  assert.deepEqual(sameRow(validate(gateSpec({ minimumPluginVersion: '2.21.0', webResources: [wr({ reconcile: 'declared' }), wr({ name: 'contoso_/scripts/Other.js', reconcile: 'declared' })] }))), []);
});

test('validation: reconcile on a form, dashboard or business rule is still an error, and names the kinds that take it', () => {
  const v = validate(gateSpec({ minimumPluginVersion: '2.21.0', dashboards: [{ name: 'D', reconcile: 'declared' }], forms: [{ name: 'F', entity: 'account', reconcile: 'declared' }], businessRules: [{ name: 'R', reconcile: 'declared' }] }));
  for (const kind of ['dashboards', 'forms', 'businessRules']) {
    assert.ok(v.errors.some((e) => e.startsWith(`${kind}:`) && e.includes('only on views, charts and web resources')), `${kind}: ${JSON.stringify(v.errors)}`);
  }
});

test('verify: a declared web resource whose deployed content differs says to build again; an undeclared one keeps its message', async () => {
  const reader = (rows) => ({ webResource: async (n) => rows[n] || null, sitemapXml: async () => '', findTable: async () => null, findColumns: async () => [], queryRecords: async () => [] });
  const rows = { 'contoso_/scripts/Form.js': { id: 'wr-1', content: b64('var a = 0;') } };
  const d = (await verifySpec({ webResources: [wr({ reconcile: 'declared' })] }, reader(rows))).checks.find((c) => c.kind === 'web-resource');
  assert.equal(d.present, false);
  assert.match(d.detail, /^its deployed content differs from the spec's — run the build again/);
  const u = (await verifySpec({ webResources: [wr()] }, reader(rows))).checks.find((c) => c.kind === 'web-resource');
  assert.equal(u.present, false);
  assert.match(u.detail, /a rebuild does not write the content of a web resource that exists/);
});
// ---- the approvals, through the CLI and over the real vendored SDK

// What build-model-app.js's main() hands the engine for these `--authorize` keys (authorizationKeys): a view's or chart's
// approval and a web resource's are kept apart, so one family's flag can never write the other's artifact.
function approvals(spec, ...keys) {
  const { authorizationKeys } = require('../build-model-app.js');
  const a = authorizationKeys(keys.flatMap((k) => ['--authorize', k]), spec);
  assert.equal(a.error, null);
  return {
    ...(a.adopt.size ? { authorizedAdoption: a.adopt } : {}),
    ...(a.overwrite.size ? { authorizedOverwrite: a.overwrite } : {}),
    ...(a.webResourceAdopt && a.webResourceAdopt.size ? { authorizedWebResourceAdoption: a.webResourceAdopt } : {}),
    ...(a.webResourceOverwrite && a.webResourceOverwrite.size ? { authorizedWebResourceOverwrite: a.webResourceOverwrite } : {}),
  };
}

test('the CLI hands the engine a web resource\'s approvals in their own sets, never as a view\'s or chart\'s', async () => {
  const { loadCli } = require('./helpers/cli-harness.js');
  const scriptsDir = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-declared-cli-'));
  dirs.push(dir);
  const spec = JSON.parse(fs.readFileSync(path.join(scriptsDir, '..', 'samples', 'app-spec.support-desk.json'), 'utf8'));
  spec.webResources = [{ name: 'new_/scripts/Case.js', type: 'js', content: 'var a = 1;', reconcile: 'declared' }];
  fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify(spec));
  const engines = [];
  const cli = loadCli(path.join(scriptsDir, 'build-model-app.js'), {
    argv: ['--env', ENV, '--spec', `@${path.join(dir, 'app-spec.json')}`, '--no-live-plan', '--authorize', 'adopt:webresource:new_/scripts/case.js', '--authorize=overwrite:webresource:NEW_/scripts/Case.js'],
    env: { PATH: path.dirname(process.execPath), POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    requires: {
      './lib/dataverse-auth.js': loadCli(path.join(scriptsDir, 'lib', 'dataverse-auth.js')).exports,
      './lib/sdk-http-client.js': { createAzHttpClient: () => ({}), SQL_DEADLOCK_VICTIM: /Sql Number: 1205/ },
      './lib/maker-sdk.js': { createNodeWorkspaceStorage: (d) => ({ dir: d }), createMakerSdk: () => ({ initWorkspace: async () => {} }) },
      './lib/sdk-build.js': { ...require('../lib/sdk-build.js'), runSdkBuild: async (s, options) => { engines.push(options); return { ok: true, dryRun: true, planItems: [] }; } },
    },
  });
  await assert.rejects(cli.main(), (err) => err && err.exitCode === 0);
  assert.equal(engines.length, 1);
  assert.deepEqual([...(engines[0].authorizedWebResourceAdoption || [])], ['new_/scripts/case.js']);
  assert.deepEqual([...(engines[0].authorizedWebResourceOverwrite || [])], ['new_/scripts/case.js']);
  assert.equal(engines[0].authorizedAdoption, undefined, 'no view or chart is approved');
  assert.equal(engines[0].authorizedOverwrite, undefined);
});

// A declared view `script` of contoso_case and a declared web resource named contoso_case/script, built by the real vendored
// SDK against the stateful fake environment (helpers/fake-app-build-org.js), so what is asserted is what reached the wire.
function realBundle() {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
  const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');
  const org = createFakeBuildOrg({ entities: { contoso_case: { attributes: { contoso_name: 'String', contoso_code: 'String' } } }, solution: { uniqueName: 'Contoso' } });
  // The fake has no route for a web resource's dependents or for reading one row by id; add them (writes and publication stay the fake's).
  org.intercept((c) => c.method === 'GET' && c.path.startsWith('/RetrieveDependentComponents'), () => ({ status: 200, body: { value: [] } }));
  org.intercept((c) => c.method === 'GET' && /^\/webresourceset\([^)]+\)/.test(c.path), (c) => {
    const row = org.resources.get(/^\/webresourceset\(([^)]+)\)/.exec(c.path)[1]);
    if (!row) return { status: 404, body: { error: { code: '0x80040217' } } };
    return { status: 200, body: { ...row, content: c.path.includes('RetrieveUnpublished') ? row.content : row.publishedContent } };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-declared-real-'));
  dirs.push(dir);
  const spec = {
    schemaVersion: 2, minimumPluginVersion: '2.21.0',
    solution: { uniqueName: 'Contoso', publisherPrefix: 'contoso', displayName: 'Contoso' },
    app: { name: 'Cases', uniqueName: 'contoso_cases' },
    entities: [{ schemaName: 'contoso_case', existing: true, displayName: 'Case', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [{ schemaName: 'contoso_code', displayName: 'Code', type: 'Text' }] }],
    views: [{ entity: 'contoso_case', name: 'script', columns: ['contoso_name'], reconcile: 'declared' }],
    webResources: [{ name: 'contoso_case/script', type: 'js', content: 'var initial = 1;', reconcile: 'declared' }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Cases', subAreas: [{ entity: 'contoso_case', title: 'Cases' }] }] }] },
  };
  const build = async (s, opts = {}) => {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
    await sdk.initWorkspace();
    const mark = org.calls.length;
    let err;
    try {
      await runSdkBuild(s, { sdk, apply: true, publish: false, workspaceDir: dir, appDir: dir, env: org.origin, phases: ['web-resources', 'views'], warn: () => {}, ...opts });
    } catch (e) { err = e; }
    const patches = org.calls.slice(mark).filter((c) => c.method === 'PATCH');
    return { err, wrPatches: patches.filter((c) => c.path.startsWith('/webresourceset(')), viewPatches: patches.filter((c) => c.path.startsWith('/savedqueries(')) };
  };
  return { spec, build };
}

test('real SDK: a view\'s approval never writes the web resource of the same name, and a web resource\'s never writes the view', async () => {
  const { spec, build } = realBundle();
  assert.equal((await build(spec)).err, undefined);
  const changed = structuredClone(spec);
  changed.views[0].columns.push('contoso_code');
  changed.webResources[0].content = 'var changed = 1;';

  const viewOnly = await build(changed, approvals(changed, 'adopt:contoso_case/script'));
  assert.equal(viewOnly.err && viewOnly.err.code, 'web-resource-adoption-not-authorized', 'the web resource still waits for its own approval');
  assert.ok(viewOnly.err.message.includes('--authorize adopt:webresource:contoso_case/script'), viewOnly.err.message);
  assert.deepEqual([viewOnly.wrPatches.length, viewOnly.viewPatches.length], [0, 0]);

  const wrOnly = await build(changed, approvals(changed, 'adopt:webresource:contoso_case/script'));
  assert.equal(wrOnly.err && wrOnly.err.code, 'view-adoption-not-authorized', 'the view still waits for its own approval');
  assert.ok(wrOnly.err.message.includes('--authorize adopt:view:contoso_case/script'), wrOnly.err.message);
  assert.ok(!wrOnly.err.message.includes('adopt:webresource:'), wrOnly.err.message);
  assert.deepEqual([wrOnly.wrPatches.length, wrOnly.viewPatches.length], [1, 0]);
  assert.equal(Buffer.from(wrOnly.wrPatches[0].body.content, 'base64').toString('utf8'), 'var changed = 1;');

  const both = await build(changed, approvals(changed, 'adopt:contoso_case/script', 'adopt:webresource:contoso_case/script'));
  assert.equal(both.err, undefined, both.err && both.err.message);
  assert.deepEqual([both.wrPatches.length, both.viewPatches.length], [0, 1], 'the web resource already holds the spec\'s content');
});
test('real SDK: emptying a declared web resource halts naming --allow-destructive, and following that halt writes it empty', async () => {
  const { remedyFor } = require('../lib/reconcile-common.js');
  assert.match(remedyFor('web-resource-clear-not-authorized'), /destructive approval/);
  const { spec, build } = realBundle();
  assert.equal((await build(spec)).err, undefined);
  const cleared = structuredClone(spec);
  cleared.webResources[0].content = '';
  const adopt = approvals(cleared, 'adopt:webresource:contoso_case/script');
  const refused = await build(cleared, adopt);
  assert.equal(refused.err && refused.err.code, 'web-resource-clear-not-authorized', 'the adoption approval is not consent to empty it');
  assert.ok(refused.err.message.includes('(approve with --allow-destructive)'), refused.err.message);
  assert.equal(refused.wrPatches.length, 0);
  const approved = await build(cleared, { ...adopt, allowDestructive: true });
  assert.equal(approved.err, undefined, approved.err && approved.err.message);
  assert.deepEqual(approved.wrPatches.map((c) => c.body.content), ['']);
});