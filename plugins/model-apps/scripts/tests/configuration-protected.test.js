'use strict';
// Protected configuration (`configurationIdentity: "stable-v1"`): the opt-in, the whole-plan read-only preflight that stops an
// unsupported edit before the build changes anything, and the build-side hookup of the configuration create driver.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { skipWithoutDowngrade, requireDowngrade } = require('./helpers/downgrade-release.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { validateAppSpec, CONFIGURATION_IDENTITY_MIN_VERSION } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { configurationSendOnce } = require('../lib/configuration-transport.js');
const { createDeferredManagedCreateGate } = require('../lib/managed-create-transport.js');
const { createManagedCreateContext } = require('../lib/managed-create-context.js');
const { openManagedBindings, managedManifestView, storeFileName } = require('../lib/managed-bindings.js');
const { readerFor } = require('../verify-model-app.js');
const { createConfigurationRuntime } = require('../lib/configuration-build.js');
const { readDeploymentBindings, configurationAuthorizationKeys, authorizeFlags, configurationHaltMessage } = require('../lib/configuration-artifacts.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { STAGES } = require('../lib/stages.js');
const { RETRY } = require('../lib/retry-policy.js');
const B = require('../lib/configuration-create-bindings.js');
const P = require('../lib/configuration-protected.js');

const SOL = 'ContosoSol';
function baseSpec(extra = {}) {
  return {
    solution: { uniqueName: SOL, displayName: 'Contoso', publisherPrefix: 'contoso' },
    app: { name: 'Configured', uniqueName: 'contoso_configured' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' } }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
    environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', defaultValue: 'https://example.invalid' }],
    ...extra,
  };
}

test('configurationIdentity takes exactly "stable-v1" and asks for a 2.23.0 floor', () => {
  const errorsOf = (spec) => validateAppSpec(spec).errors.filter((e) => /configurationIdentity/.test(e));
  assert.equal(CONFIGURATION_IDENTITY_MIN_VERSION, '2.23.0');
  assert.deepEqual(errorsOf(baseSpec()), []);
  assert.deepEqual(errorsOf(baseSpec({ configurationIdentity: 'stable-v1' })), []);
  for (const bad of ['stable-v2', 'Stable-V1', true, null, '', 1]) {
    const errors = errorsOf(baseSpec({ configurationIdentity: bad }));
    assert.equal(errors.length, 1, JSON.stringify(bad));
    assert.match(errors[0], /^create-identity-invalid: configurationIdentity must be "stable-v1" or absent/);
  }
  // No alias: another spelling is not the opt-in (and createIdentity alone does not turn it on).
  assert.deepEqual(errorsOf(baseSpec({ createIdentity: 'stable-v1' })), []);
  const floor = (spec) => lintAppSpec(spec).warnings.filter((w) => /when using configurationIdentity/.test(w));
  assert.equal(floor(baseSpec({ configurationIdentity: 'stable-v1' })).length, 1, 'no floor: older plugins ignore the field');
  assert.equal(floor(baseSpec({ configurationIdentity: 'stable-v1', minimumPluginVersion: '2.22.0' })).length, 1);
  assert.deepEqual(floor(baseSpec({ configurationIdentity: 'stable-v1', minimumPluginVersion: '2.23.0' })), []);
  assert.deepEqual(floor(baseSpec()), [], 'no opt-in, no warning');
  assert.equal(lintAppSpec(baseSpec({ configurationIdentity: 'stable-v1' })).errors.length, 0, 'a warning, never an error');
});

// ---------------------------------------------------------------------------------------------
// The protected path against the fake org: the real SDK behind the real send-once gate, bound to a real binding store,
// and the build's configuration runtime given the hookup (createProtectedConfiguration) the build makes over them.

const API = { uniqueName: 'contoso_Calc', isFunction: true, requestParameters: [{ uniqueName: 'A', type: 'integer' }], responseProperties: [{ uniqueName: 'R', type: 'string' }] };
const RULE = { key: 'email', name: 'Same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] };
function configSpec(over = {}) {
  return {
    // The opt-in asks for a 2.23.0 floor; this older floor only adds a lint warning, which these tests do not judge.
    minimumPluginVersion: '2.21.0', configurationIdentity: 'stable-v1',
    solution: { uniqueName: SOL, displayName: 'Contoso', publisherPrefix: 'contoso' },
    app: { name: 'Configured', uniqueName: 'contoso_configured' }, schemaVersion: 2, entities: [],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Links', subAreas: [{ url: 'https://contoso.example/help', title: 'Help' }] }] }] },
    environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', defaultValue: 'https://api.contoso.com' }],
    customApis: [API],
    duplicateDetectionRules: [RULE],
    ...over,
  };
}
const api = (over) => ({ customApis: [{ ...API, ...over }] });
const rule = (over) => ({ duplicateDetectionRules: [{ ...RULE, ...over }] });

// `storeSeed`: a binding store file as an earlier plugin version wrote it, put where this one opens it.
async function harness({ hookup = true, intercept, storeSeed } = {}) {
  const org = createConfigOrg({ tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }], solution: { uniqueName: SOL, version: '1.0.0.0', prefix: 'contoso' }, ...(intercept ? { intercept } : {}) });
  const gate = createDeferredManagedCreateGate();
  const httpClient = createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request: org.request, sleep: async () => {}, sendOnce: configurationSendOnce, workflowEffectGate: gate });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('cfg-protected-sdk-')), instanceUrl: org.origin, httpClient, solutionUniqueName: SOL });
  await sdk.initWorkspace();
  const storeDir = makeTempDir('cfg-protected-store-');
  if (storeSeed) fs.writeFileSync(path.join(storeDir, storeFileName(storeSeed.environmentFingerprint, 'contoso_configured', SOL)), JSON.stringify(storeSeed, null, 2));
  const store = openManagedBindings({ workspaceDir: storeDir, environment: org.origin, appUniqueName: 'contoso_configured', solutionUniqueName: SOL });
  gate.bind(store);
  const ctx = createManagedCreateContext({ store, notFoundCode: B.NOT_FOUND_CODE });
  const protectedConfiguration = hookup ? P.createProtectedConfiguration({ store, gate, ctx, apiBase: `${org.origin}/api/data/v9.0` }) : undefined;
  return { org, sdk, store, gate, ctx, protectedConfiguration };
}
// A later process over the same binding store: a fresh managed create context (none of the earlier answers), with the
// maker's exact approvals.
// An `@<row id>` approval reaches the context as the build's parser types it (build-model-app.js, through
// configurationAuthorizationKeys, against `typedAs`); a token it refuses is passed as given, so a test can still offer one,
// and `typedAs: null` passes every token as given.
function reopen(h, approvals = [], typedAs = configSpec()) {
  const typed = approvals.flatMap((t) => {
    if (!typedAs || !/@[0-9a-f]{8}-/i.test(t)) return [t];
    const read = configurationAuthorizationKeys([t], typedAs);
    return read.problems.length ? [t] : [...read.rowApprovals];
  });
  const ctx = createManagedCreateContext({ store: h.store, approvals: typed, notFoundCode: B.NOT_FOUND_CODE });
  return { ...h, ctx, protectedConfiguration: P.createProtectedConfiguration({ store: h.store, gate: h.gate, ctx, apiBase: `${h.org.origin}/api/data/v9.0` }) };
}
// One configuration pass as the build runs it: the preflight, then the data-model step. Answers what it sent. A harness
// made by laterProcess over another plugin runtime (`h.runtime`) runs that runtime's build.
async function pass(h, spec, opts = {}) {
  const mark = h.org.requests.length;
  const make = h.runtime ? h.runtime.createConfigurationRuntime : createConfigurationRuntime;
  const runtime = make({ spec, sdk: h.sdk, opts: { protectedConfiguration: h.protectedConfiguration, ...opts }, appUniqueName: 'contoso_configured' });
  let halt = null;
  let step = null;
  try {
    await runtime.preflight();
    step = await runtime.apply('data-model');
    runtime.throwIfIncomplete(step);
  } catch (error) {
    halt = error;
  }
  return { halt, step, sent: h.org.requests.slice(mark).filter((r) => r.method !== 'GET') };
}
async function created(h, spec = configSpec(), opts = {}) {
  const first = await pass(h, spec, opts);
  assert.equal(first.halt, null, first.halt && `${first.halt.code}: ${first.halt.message}`);
  return first;
}
const committed = (h, kind, key) => h.store.readGroup(kind, key).committed;
// The maker's one approval that replaces a protected item's local copy with the server's, as build-model-app.js reads
// `--authorize overwrite:<kind>:<key>` into opts.authorizedOverwrite (the flag minus its verb).
const overwriteCopy = (kind, key) => ({ authorizedOverwrite: new Set([`${kind}:${key}`]) });
// A build that found the item's local copy differing from the server's: it stops before any write, the copy kept, and
// names the exact approval that replaces it.
function assertCopyStop(out, kind, key) {
  assert.equal(out.halt && out.halt.code, 'workspace-copy-unsent-edits', out.halt && `${out.halt.code}: ${out.halt.message}`);
  assert.equal(out.halt.phase, 'preflight');
  assert.ok(out.halt.message.includes(`--authorize overwrite:${kind}:${key}`), out.halt.message);
  assert.deepEqual(out.sent, [], 'nothing is written while the local copy differs');
}

test('protected configuration is created at its derived ids through the binding store, and an unchanged rerun sends nothing', async () => {
  const h = await harness();
  const first = await created(h);
  assert.ok(first.sent.length > 0);
  for (const [kind, key] of [['environmentVariable', 'contoso_apibase'], ['customApi', 'contoso_calc'], ['duplicateRule', 'email']]) {
    const group = committed(h, kind, key);
    assert.ok(group, `${kind} is bound`);
    assert.ok(group.records.every((r) => r.origin === 'created'), `${kind}: every row is this build's create`);
  }
  assert.equal(h.org.rows('duplicaterules')[0].statecode, 1, 'the rule completed its initial publication');
  assert.deepEqual(h.org.unexpected, []);
  const again = await pass(h, configSpec());
  assert.equal(again.halt, null, again.halt && again.halt.message);
  assert.deepEqual(again.sent, [], 'an unchanged rerun writes nothing');
});

test('under the opt-in without the binding store the build stops before any request is sent', async () => {
  const h = await harness({ hookup: false });
  const out = await pass(h, configSpec());
  assert.equal(out.halt && out.halt.code, 'create-identity-unverified');
  assert.equal(out.halt.phase, 'preflight');
  assert.equal(out.halt.retry, RETRY.NEVER);
  assert.match(out.halt.message, /No service changes were sent by this build/);
  assert.deepEqual(h.org.requests, [], 'not even a read');
});

test('every later edit of a protected duplicate rule stops in preflight with nothing sent', async () => {
  for (const [label, over] of [
    ['a field', rule({ name: 'Same email address' })],
    ['a condition', rule({ conditions: [{ key: 'e', column: 'lastname', match: 'exact' }] })],
    ['an added condition', rule({ conditions: [...RULE.conditions, { key: 'l', column: 'lastname', match: 'exact' }] })],
    ['the state', rule({ status: 'unpublished' })],
  ]) {
    const h = await harness();
    await created(h);
    const out = await pass(h, configSpec(over));
    assert.equal(out.halt && out.halt.code, 'configuration-edit-unsupported', `${label}: ${out.halt && out.halt.message}`);
    assert.equal(out.halt.phase, 'preflight');
    assert.ok(out.halt.message.includes(P.RULE_EDIT_MESSAGE), label);
    assert.deepEqual(out.sent, [], `${label}: nothing sent`);
  }
});

test('first conditions, a removed condition, or an added condition with a field change of a protected rule stop in preflight', async () => {
  const TWO = [...RULE.conditions, { key: 'l', column: 'lastname', match: 'exact' }];
  for (const [label, base, over] of [
    ['an added condition and a field', rule({}), rule({ name: 'Same email address', conditions: TWO })],
    // A rule created unpublished without conditions is still only verified: its first conditions are an edit too.
    ['first conditions and a name', rule({ status: 'unpublished', conditions: [] }), rule({ status: 'unpublished', name: 'Same email address' })],
    ['a removed condition', rule({ conditions: TWO }), rule({})],
  ]) {
    const h = await harness();
    await created(h, configSpec(base));
    const out = await pass(h, configSpec(over));
    assert.equal(out.halt && out.halt.code, 'configuration-edit-unsupported', `${label}: ${out.halt && out.halt.message}`);
    assert.equal(out.halt.phase, 'preflight');
    assert.ok(out.halt.message.includes(P.RULE_EDIT_MESSAGE), label);
    assert.deepEqual(out.sent, [], `${label}: nothing sent`);
  }
});

test('a rule unpublished outside the plugin is only verified: the rerun stops rather than publishing it again', async () => {
  const h = await harness();
  await created(h);
  const id = committed(h, 'duplicateRule', 'email').records.find((r) => r.kind === 'duplicateRule').id;
  const res = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/duplicaterules(${id})`, method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statecode: 0, statuscode: 0 }) });
  assert.ok(res.statusCode < 300);
  const out = await pass(h, configSpec(rule({ status: 'published' })));
  assert.equal(out.halt && out.halt.code, 'configuration-edit-unsupported');
  assert.deepEqual(out.sent, [], 'no publication is sent for a bound rule');
});

test('unsupported protected Custom API edits stop in preflight with nothing sent', async () => {
  const B2 = { uniqueName: 'B', type: 'string' };
  for (const [label, over, code] of [
    ['the root and a child\'s labels', api({ isPrivate: true, requestParameters: [{ ...API.requestParameters[0], description: 'First' }] }), 'configuration-edit-unsupported'],
    ['a child\'s labels and a new child', api({ requestParameters: [{ ...API.requestParameters[0], description: 'First' }, B2] }), 'configuration-edit-unsupported'],
    ['two children\'s labels', api({ requestParameters: [{ ...API.requestParameters[0], description: 'First' }], responseProperties: [{ ...API.responseProperties[0], description: 'Result' }] }), 'configuration-edit-unsupported'],
    ['a child\'s fixed field', api({ requestParameters: [{ ...API.requestParameters[0], type: 'string' }] }), 'configuration-edit-unsupported'],
    ['a removed child', api({ responseProperties: [] }), B.DELETE_CODE],
    ['a removed child and a root edit', api({ isPrivate: true, responseProperties: [] }), 'configuration-edit-unsupported'],
  ]) {
    const h = await harness();
    await created(h);
    const out = await pass(h, configSpec(over));
    assert.equal(out.halt && out.halt.code, code, `${label}: ${out.halt && out.halt.message}`);
    assert.equal(out.halt.phase, 'preflight');
    if (code === 'configuration-edit-unsupported') assert.ok(out.halt.message.includes(P.API_EDIT_MESSAGE), label);
    assert.deepEqual(out.sent, [], `${label}: nothing sent`);
  }
});

test('supported protected Custom API edits are made through the binding store: one request, or one checked change set', async () => {
  for (const [label, over, want] of [
    ['the root alone', api({ description: 'Adds two numbers' }), ['PATCH']],
    ['one child\'s labels', api({ requestParameters: [{ ...API.requestParameters[0], description: 'First' }] }), ['PATCH']],
    ['one new child', api({ requestParameters: [...API.requestParameters, { uniqueName: 'B', type: 'string' }] }), ['POST']],
    ['the root and new children', api({ description: 'Adds two numbers', requestParameters: [...API.requestParameters, { uniqueName: 'B', type: 'string' }], responseProperties: [...API.responseProperties, { uniqueName: 'S', type: 'integer' }] }), ['$batch']],
    ['new children only', api({ requestParameters: [...API.requestParameters, { uniqueName: 'B', type: 'string' }], responseProperties: [...API.responseProperties, { uniqueName: 'S', type: 'integer' }] }), ['$batch']],
  ]) {
    const h = await harness();
    await created(h);
    const before = committed(h, 'customApi', 'contoso_calc');
    const out = await pass(h, configSpec(over));
    assert.equal(out.halt, null, `${label}: ${out.halt && `${out.halt.code}: ${out.halt.message}`}`);
    const writes = out.sent.filter((r) => r.path !== '/AddSolutionComponent');
    assert.deepEqual(writes.map((r) => (r.path === '/$batch' ? '$batch' : r.method)), want, label);
    for (const r of writes.filter((w) => w.method === 'PATCH')) assert.match(String(r.headers['if-match'] || r.headers['If-Match']), /^W\/"\d+"$/, `${label}: the PATCH carries the row version it was planned from`);
    const after = committed(h, 'customApi', 'contoso_calc');
    assert.notEqual(after.generation, before.generation, `${label}: the edit was settled into the store`);
    assert.ok(before.records.every((r) => after.records.some((x) => x.id === r.id)), `${label}: every bound row keeps its id`);
    assert.deepEqual(h.org.unexpected, []);
    const again = await pass(h, configSpec(over));
    assert.equal(again.halt, null);
    assert.deepEqual(again.sent, [], `${label}: the rerun writes nothing`);
  }
});

test('under the opt-in the binding store, not the managed-artifacts manifest, names the row an edit is sent to', async () => {
  const h = await harness();
  await created(h);
  const boundId = committed(h, 'customApi', 'contoso_calc').records.find((r) => r.kind === 'customApi').id;
  const res = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/customapis`, method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uniquename: 'contoso_Other', name: 'contoso_Other', displayname: 'Other', bindingtype: 0, isfunction: true }) });
  assert.ok(res.statusCode < 300);
  const otherId = /\(([0-9a-f-]{36})\)/i.exec(res.headers['odata-entityid'])[1];
  // A manifest record that names another row (stale, or written by an older build) must not stand in for the binding,
  // and a bound row is this build's own create, not an adoption: the adoption policy (here refusing all) is not asked.
  const asked = [];
  const managed = { lookup: async (kind) => (kind === 'customApi' ? { id: otherId, childIds: {} } : null), recordApplied: async () => {},
    planAdoption: async (row) => { asked.push(row); return { allowed: false, code: 'ADOPTION_REFUSED' }; } };
  const out = await pass(h, configSpec(api({ description: 'Adds two numbers' })), { managed });
  assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
  const patches = out.sent.filter((r) => r.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.ok(patches[0].path.includes(boundId), `the edit went to the bound row: ${patches[0].path}`);
  assert.ok(!out.sent.some((r) => String(r.path).includes(otherId)), 'the manifest row is never written');
  assert.deepEqual(asked, []);
});
test('a rule whose initial publication failed keeps it owed: the rerun never sends it again, and commits once it is published under the same id', async () => {
  let failPublish = true;
  const h = await harness({ intercept: ({ method, path }) => (failPublish && method === 'POST' && /PublishDuplicateRule$/.test(path) ? { statusCode: 400, body: { error: { code: '0x80040216', message: 'publish failed' } } } : undefined) });
  const first = await pass(h, configSpec());
  assert.ok(first.halt, 'the create is not complete');
  const pending = h.store.readGroup('duplicateRule', 'email');
  assert.equal(pending.committed, null);
  assert.ok(pending.pending, 'the attempt stays pending with its original expectation');
  assert.equal(pending.pending.rowProtocol.completion.ruleState, 'published', 'an omitted status owes the initial publication');
  const ruleId = pending.pending.root.id;
  assert.equal(h.org.rows('duplicaterules').find((r) => r.duplicateruleid === ruleId).statecode, 0);
  failPublish = false;
  const publishes = () => h.org.requests.filter((r) => /PublishDuplicateRule$/.test(r.path)).length;
  const sentPublishes = publishes();

  // The rerun proves the rows and the owed state at the same ids, and does not publish again. The failed send left
  // the workspace copy as it was; the build stops on it until the maker approves replacing it with the server's.
  assertCopyStop(await pass(h, configSpec()), 'duplicateRule', 'email');
  const again = await pass(h, configSpec(), overwriteCopy('duplicateRule', 'email'));
  assert.equal(again.halt && again.halt.code, 'create-completion-required', again.halt && again.halt.message);
  assert.equal(again.halt.phase, 'preflight');
  assert.deepEqual(again.sent, [], 'nothing is sent: the publication is not replayed');
  assert.equal(publishes(), sentPublishes);

  // A changed declaration is not reinterpreted from the row as it is now.
  const changed = await pass(h, configSpec(rule({ status: 'unpublished' })));
  assert.equal(changed.halt && changed.halt.code, 'managed-pending-intent-changed', changed.halt && changed.halt.message);
  assert.deepEqual(changed.sent, []);

  // The maker completes it under the same id. A later process proves the rows the plugin itself created and
  // receipted, and binds them without sending anything.
  const res = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/duplicaterules(${ruleId})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok(res.statusCode < 300);
  const approved = reopen(h);
  const done = await pass(approved, configSpec());
  assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
  assert.deepEqual(done.sent, [], 'binding the completed create sends nothing');
  assert.equal(publishes(), sentPublishes + 1, 'the rule was published once by the plugin, and once by the maker');
  const group = committed(h, 'duplicateRule', 'email');
  assert.ok(group && group.records.some((r) => r.id === ruleId));
  const rerun = await pass(approved, configSpec());
  assert.equal(rerun.halt, null);
  assert.deepEqual(rerun.sent, []);
});
test('a rule whose create answer was lost is never re-created or published by a rerun, and is bound only under its exact approvals', async () => {
  let org = null;
  let lose = true;
  // The service applies the create, and its answer is lost on the way back (a gateway's 503: no verdict on the request).
  const h = await harness({ intercept: async (req) => {
    if (!lose || req.method !== 'POST' || req.path.split('?')[0] !== '/duplicaterules') return undefined;
    lose = false;
    await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    return { statusCode: 503, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
  } });
  org = h.org;
  const first = await pass(h, configSpec());
  assert.ok(first.halt, 'the outcome is unknown');
  const ruleId = h.store.readGroup('duplicateRule', 'email').pending.root.id;
  const writes = () => h.org.requests.filter((r) => r.method !== 'GET').length;

  assertCopyStop(await pass(reopen(h), configSpec()), 'duplicateRule', 'email');
  const again = await pass(reopen(h), configSpec(), overwriteCopy('duplicateRule', 'email'));
  assert.equal(again.halt && again.halt.code, 'create-completion-required', again.halt && again.halt.message);
  assert.deepEqual(again.sent, []);
  assert.equal(h.org.rows('duplicaterules').length, 1, 'the rule is not created again');

  // The maker completes it under the same id: its initial publication and its solution membership.
  const before = writes();
  await h.org.request({ url: `${h.org.origin}/api/data/v9.2/duplicaterules(${ruleId})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const inSolution = new Set(h.org.rows('solutioncomponents').map((c) => c.objectid));
  for (const m of h.store.readGroup('duplicateRule', 'email').pending.rowProtocol.completion.members) {
    if (inSolution.has(m.id)) continue;
    await h.org.request({ url: `${h.org.origin}/api/data/v9.2/AddSolutionComponent`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ SolutionUniqueName: SOL, ComponentId: m.id, ComponentType: m.componentType, AddRequiredComponents: false }) });
  }
  const makerWrites = writes() - before;

  // No answer proved those rows this plugin's own: a later process asks for each row's exact approval and sends nothing.
  const asked = await pass(reopen(h), configSpec());
  assert.equal(asked.halt && asked.halt.code, 'create-ownership-required', asked.halt && asked.halt.message);
  assert.deepEqual(asked.sent, []);
  const quoted = /given after checking those rows are yours: (.*)\.$/.exec(asked.halt.message);
  assert.ok(quoted, asked.halt.message);
  const tokens = JSON.parse(`[${quoted[1]}]`);
  assert.ok(tokens.includes('adopt:duplicateRule:email'), tokens.join(' '));
  assert.ok(tokens.some((t) => t.startsWith('adopt:duplicateRuleCondition:')), tokens.join(' '));

  // A wholesale or partial approval binds nothing.
  const partial = await pass(reopen(h, ['adopt:duplicateRule:email']), configSpec());
  assert.equal(partial.halt && partial.halt.code, 'create-ownership-required');

  const approved = reopen(h, tokens);
  const done = await pass(approved, configSpec());
  assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
  assert.deepEqual(done.sent, []);
  assert.equal(writes() - before, makerWrites, 'the plugin wrote nothing after the lost answer: no create, no publication');
  assert.ok(committed(h, 'duplicateRule', 'email').records.some((r) => r.id === ruleId));
});
test('a bound row deleted outside the plugin is never replaced by a namesake: the build stops before any write', async () => {
  const h = await harness();
  await created(h);
  const id = committed(h, 'customApi', 'contoso_calc').records.find((r) => r.kind === 'customApi').id;
  const res = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/customapis(${id})`, method: 'DELETE', headers: {} });
  assert.ok(res.statusCode < 300);
  const out = await pass(h, configSpec());
  assert.equal(out.halt && out.halt.code, B.NOT_FOUND_CODE, out.halt && out.halt.message);
  assert.deepEqual(out.sent, []);
  assert.equal(h.org.rows('customapis').length, 0, 'nothing was created in its place');
});

test('the build runs the protected preflight before its first write: an earlier writable item and a version change are not sent', async () => {
  const h = await harness();
  await created(h);
  const spec = configSpec({
    solution: { uniqueName: SOL, displayName: 'Contoso', publisherPrefix: 'contoso', version: '1.2.0.0' },
    environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', defaultValue: 'https://api2.contoso.com' }],
    ...rule({ name: 'Same email address' }),
  });
  assert.deepEqual(validateAppSpec(spec).errors, []);
  const mark = h.org.requests.length;
  let caught;
  try {
    await runSdkBuild(spec, { sdk: h.sdk, apply: true, phases: STAGES.data, workspaceDir: makeTempDir('cfg-protected-ws-'), protectedConfiguration: h.protectedConfiguration, emit: () => {} });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught && caught.code, 'configuration-edit-unsupported', caught && caught.message);
  assert.equal(caught.phase, 'preflight');
  assert.equal(caught.retry, RETRY.NEVER);
  assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), [], 'zero service mutations');
  assert.equal(h.org.rows('solutions').find((s) => s.uniquename === SOL).version, '1.0.0.0');
});

// A rule left pending: its initial publication was refused, so its attempt is unfinished in the binding store.
async function pendingRule() {
  const h = await harness({ intercept: ({ method, path }) => (method === 'POST' && /PublishDuplicateRule$/.test(path)
    ? { statusCode: 400, body: { error: { code: '0x80040216', message: 'publish failed' } } } : undefined) });
  assert.ok((await pass(h, configSpec({ environmentVariables: [], customApis: [] }))).halt);
  assert.ok(h.store.readGroup('duplicateRule', 'email').pending);
  return h;
}

test('dropping the declaration of a pending protected item never lets a build go on: with or without the opt-in, nothing is sent', async () => {
  const h = await pendingRule();
  const unrelated = configSpec({ customApis: [], duplicateDetectionRules: [], environmentVariables: [{ schemaName: 'contoso_Unrelated', type: 'string' }] });
  const { configurationIdentity, ...plain } = unrelated;
  for (const spec of [unrelated, plain]) {
    const out = await pass(reopen(h), spec);
    assert.equal(out.halt && out.halt.code, 'managed-settlement-pending', out.halt && out.halt.message);
    assert.equal(out.halt.phase, 'preflight');
    assert.match(out.halt.message, /duplicateRule email: .*no longer declares\. Restore its declaration, with configurationIdentity "stable-v1"/);
    assert.deepEqual(out.sent, [], 'zero service mutations');
    assert.ok(h.store.readGroup('duplicateRule', 'email').pending, 'the debt is kept: never retired or reset');
  }
  // A committed item the App Spec dropped is no debt: its rows simply stay.
  const done = await harness();
  await created(done);
  const out = await pass(reopen(done), unrelated);
  assert.equal(out.halt, null, out.halt && out.halt.message);
  assert.ok(committed(done, 'customApi', 'contoso_calc'), 'its binding is kept');
});

test('a build whose App Spec declares no configuration item still stops on a pending protected attempt before its first write', async () => {
  const h = await pendingRule();
  // No configuration list and no solution version: the build makes no configuration runtime at all.
  const { configurationIdentity, ...spec } = configSpec({ environmentVariables: [], customApis: [], duplicateDetectionRules: [] });
  assert.deepEqual(validateAppSpec(spec).errors, []);
  const mark = h.org.requests.length;
  let caught;
  try {
    await runSdkBuild(spec, { sdk: h.sdk, apply: true, phases: STAGES.data, workspaceDir: makeTempDir('cfg-protected-ws-'), protectedConfiguration: reopen(h).protectedConfiguration, emit: () => {} });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught && caught.code, 'managed-settlement-pending', caught && caught.message);
  assert.equal(caught.phase, 'preflight');
  assert.equal(caught.retry, RETRY.NEVER);
  assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), [], 'zero service mutations');
  assert.ok(h.store.readGroup('duplicateRule', 'email').pending);
});

test('without the opt-in the hookup is ignored: no preflight read, and the plain path creates as before', async () => {
  const h = await harness();
  const { configurationIdentity, ...plain } = configSpec();
  assert.equal(configurationIdentity, 'stable-v1');
  assert.equal(P.configurationIdentityOf(plain), false);
  const runtime = createConfigurationRuntime({ spec: plain, sdk: h.sdk, opts: { protectedConfiguration: h.protectedConfiguration }, appUniqueName: 'contoso_configured' });
  assert.deepEqual(await runtime.preflight(), { halts: [] });
  assert.deepEqual(h.org.requests, [], 'the preflight read nothing');
  const out = await pass(h, plain);
  assert.equal(out.halt, null, out.halt && out.halt.message);
  assert.ok(!h.store.readGroup('customApi', 'contoso_calc').committed, 'nothing is bound without the opt-in');
});
// The first protected create of an item: its namesake query must be read whole and find nothing, else nothing is created.
const variableOnly = () => configSpec({ customApis: [], duplicateDetectionRules: [] });
const VARIABLE_ROW = { schemaname: 'contoso_ApiBase', displayname: 'contoso_ApiBase', type: 100000000, defaultvalue: 'https://api.contoso.com' };
async function insertRow(org, set, row) {
  const res = await org.request({ url: `${org.origin}/api/data/v9.2/${set}`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(row) });
  assert.ok(res.statusCode < 300, `${set}: ${res.statusCode}`);
  return /\(([0-9a-f-]{36})\)/i.exec(res.headers['odata-entityid'])[1];
}

test('a namesake at another id before the first protected create stops it as a conflict: nothing is created or bound', async () => {
  const h = await harness();
  const foreign = await insertRow(h.org, 'environmentvariabledefinitions', VARIABLE_ROW);
  const out = await pass(h, variableOnly());
  // Judged by the read-only preflight, before any step runs: the build stops before its first write.
  assert.equal(out.halt && out.halt.code, 'create-identity-conflict', out.halt && out.halt.message);
  assert.equal(out.halt.phase, 'preflight');
  assert.match(out.halt.message, new RegExp(`environmentVariable contoso_apibase: .*namesake at another id \\(${foreign}\\)`));
  assert.equal(out.step, null, 'no step is applied');
  assert.deepEqual(out.sent, [], 'nothing is sent');
  assert.deepEqual(h.org.rows('environmentvariabledefinitions').map((r) => r.environmentvariabledefinitionid), [foreign], 'the namesake is not adopted, and nothing is created beside it');
  const group = h.store.readGroup('environmentVariable', 'contoso_apibase');
  assert.equal(group.committed, null);
  assert.equal(group.pending, null);
});

test('a namesake query that cannot be read whole stops the first protected create unverified: nothing is created', async () => {
  // The SDK's own name lookup (`$top=2`) answers as usual; the create's complete namesake query answers a first page whose
  // continuation fails, so it cannot prove there is no namesake on a later page.
  const h = await harness({ intercept: ({ method, path }) => {
    if (method !== 'GET' || !path.startsWith('/environmentvariabledefinitions?') || /\$top=/.test(path)) return undefined;
    if (/\$skiptoken=/.test(path)) return { statusCode: 503, body: { error: { code: '0x80040216', message: 'busy' } } };
    return { statusCode: 200, body: { value: [], '@odata.nextLink': 'https://contoso.crm.dynamics.com/api/data/v9.0/environmentvariabledefinitions?$select=environmentvariabledefinitionid,schemaname&$skiptoken=1' } };
  } });
  const out = await pass(h, variableOnly());
  assert.equal(out.halt && out.halt.code, 'create-identity-unverified', out.halt && out.halt.message);
  assert.equal(out.halt.phase, 'preflight');
  assert.equal(out.step, null, 'no step is applied');
  assert.ok(h.org.requests.some((r) => /\$skiptoken=/.test(r.path)), 'the continuation was followed');
  assert.deepEqual(out.sent, [], 'nothing is sent');
  assert.deepEqual(h.org.rows('environmentvariabledefinitions'), []);
  assert.equal(h.store.readGroup('environmentVariable', 'contoso_apibase').committed, null);
});

test('a namesake or a row at the derived id that appears after the preflight is still caught at dispatch: nothing is created or bound', async () => {
  for (const at of ['namesake', 'derived id']) {
    const h = await harness();
    const runtime = createConfigurationRuntime({ spec: variableOnly(), sdk: h.sdk, opts: { protectedConfiguration: h.protectedConfiguration }, appUniqueName: 'contoso_configured' });
    await runtime.preflight();
    const mark = h.org.requests.length;
    // The derived id the preflight read exactly: GET /environmentvariabledefinitions(<id>)?$select=...
    const derived = h.org.requests.map((r) => /^\/environmentvariabledefinitions\(([0-9a-f-]{36})\)/i.exec(r.path)).find(Boolean)[1];
    const row = at === 'namesake' ? VARIABLE_ROW : { ...VARIABLE_ROW, environmentvariabledefinitionid: derived };
    const foreign = await insertRow(h.org, 'environmentvariabledefinitions', row);
    const step = await runtime.apply('data-model');
    // The row seeded at the derived id holds a column value this build cannot read, so its exact read is unknown
    // (unverified); the namesake is a conflict. The preflight of a next build says the same, before any write.
    const code = at === 'namesake' ? 'create-identity-conflict' : 'create-identity-unverified';
    assert.deepEqual(step.halt && step.halt.items, [{ kind: 'environmentVariable', key: 'contoso_ApiBase', code }], at);
    assert.deepEqual(h.org.requests.slice(mark + 1).filter((r) => r.method !== 'GET'), [], `${at}: nothing is sent`);
    assert.deepEqual(h.org.rows('environmentvariabledefinitions').map((r) => r.environmentvariabledefinitionid), [foreign], `${at}: nothing is created`);
    assert.equal(h.store.readGroup('environmentVariable', 'contoso_apibase').committed, null, at);
    const next = await pass(h, variableOnly());
    assert.equal(next.halt && next.halt.code, code, `${at}: ${next.halt && next.halt.message}`);
    assert.equal(next.halt.phase, 'preflight', at);
    assert.deepEqual(next.sent, [], `${at}: the next build sends nothing`);
  }
});

test('a create proved never sent meets the same namesake query before the first write; without a namesake it is sent once', async () => {
  for (const namesake of [true, false]) {
    const h = await harness();
    const types = await B.readComponentTypes(h.sdk.dataverse);
    const planned = B.planOf(variableOnly(), { kind: 'environmentVariable', key: 'contoso_ApiBase', solution: SOL, componentTypes: types.types });
    // An attempt prepared and never dispatched: its recovery proves nothing was sent, so the rerun sends it again.
    h.ctx.begin([planned.plan]);
    const foreign = namesake ? await insertRow(h.org, 'environmentvariabledefinitions', VARIABLE_ROW) : null;
    const out = await pass(reopen(h), variableOnly());
    if (namesake) {
      assert.equal(out.halt && out.halt.code, 'create-identity-conflict', out.halt && out.halt.message);
      assert.equal(out.halt.phase, 'preflight');
      assert.deepEqual(out.sent, [], 'nothing is sent');
      assert.deepEqual(h.org.rows('environmentvariabledefinitions').map((r) => r.environmentvariabledefinitionid), [foreign]);
      assert.ok(h.store.readGroup('environmentVariable', 'contoso_apibase').pending, 'the attempt stays pending');
    } else {
      assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
      assert.deepEqual(out.sent.filter((r) => r.path.startsWith('/environmentvariabledefinitions')).map((r) => r.method), ['POST'], 'sent once');
      assert.ok(committed(h, 'environmentVariable', 'contoso_apibase'));
    }
  }
});

test('clearing a protected variable\'s value would delete its value row: even authorized, it stops in preflight with nothing sent', async () => {
  const spec = variableOnly();
  const valueOf = (Value) => readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value }] }, spec);
  const authorizedDestructive = new Set(['environmentVariableValue:contoso_apibase:value']);
  const h = await harness();
  const first = await pass(h, spec, { configurationBindings: valueOf('https://one.contoso.com') });
  assert.equal(first.halt, null, first.halt && `${first.halt.code}: ${first.halt.message}`);
  const [valueRow] = h.org.rows('environmentvariablevalues');
  assert.ok(valueRow, 'the value was created');
  const cleared = await pass(h, spec, { configurationBindings: valueOf(null), authorizedDestructive });
  assert.equal(cleared.halt && cleared.halt.code, 'configuration-protected-removal-unsupported', cleared.halt && cleared.halt.message);
  assert.equal(cleared.halt.phase, 'preflight');
  assert.match(cleared.halt.message, /No service changes were sent by this build/);
  assert.deepEqual(cleared.sent, [], 'nothing is sent');
  assert.deepEqual(h.org.rows('environmentvariablevalues').map((r) => r.environmentvariablevalueid), [valueRow.environmentvariablevalueid]);
  // The neighbours stay: an authorized replacement is made at the bound value row, and a settings entry that leaves the
  // value alone sends nothing.
  const replaced = await pass(h, spec, { configurationBindings: valueOf('https://two.contoso.com'), authorizedDestructive });
  assert.equal(replaced.halt, null, replaced.halt && `${replaced.halt.code}: ${replaced.halt.message}`);
  assert.deepEqual(replaced.sent.map((r) => r.method), ['PATCH']);
  assert.deepEqual(h.org.rows('environmentvariablevalues').map((r) => [r.environmentvariablevalueid, r.value]), [[valueRow.environmentvariablevalueid, 'https://two.contoso.com']]);
  const untouched = await pass(h, spec, { configurationBindings: valueOf('') });
  assert.equal(untouched.halt, null, untouched.halt && untouched.halt.message);
  assert.deepEqual(untouched.sent, []);
  // Without the opt-in an authorized clear deletes the value, as before.
  const { configurationIdentity, ...plain } = spec;
  assert.equal(configurationIdentity, 'stable-v1');
  const p = await harness({ hookup: false });
  const made = await pass(p, plain, { configurationBindings: valueOf('https://one.contoso.com') });
  assert.equal(made.halt, null, made.halt && made.halt.message);
  const legacy = await pass(p, plain, { configurationBindings: valueOf(null), authorizedDestructive });
  assert.equal(legacy.halt, null, legacy.halt && `${legacy.halt.code}: ${legacy.halt.message}`);
  assert.deepEqual(legacy.sent.map((r) => r.method), ['DELETE']);
  assert.deepEqual(p.org.rows('environmentvariablevalues'), []);
});

test('a first value of a bound protected variable is created at its derived id inside the variable\'s own protected set, and bound', async () => {
  const h = await harness();
  const spec = variableOnly();
  await created(h, spec);
  const before = committed(h, 'environmentVariable', 'contoso_apibase');
  const bindings = readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: 'https://one.contoso.com' }] }, spec);
  const out = await pass(h, spec, { configurationBindings: bindings });
  assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
  assert.deepEqual(out.sent.map((r) => `${r.method} ${r.path.split('?')[0]}`), ['POST /environmentvariablevalues']);
  const after = committed(h, 'environmentVariable', 'contoso_apibase');
  assert.equal(after.records.length, before.records.length + 1);
  const valueRecord = after.records.find((r) => r.kind === 'environmentVariableValue');
  assert.deepEqual(h.org.rows('environmentvariablevalues').map((r) => r.environmentvariablevalueid), [valueRecord.id]);
  const again = await pass(reopen(h), spec, { configurationBindings: bindings });
  assert.equal(again.halt, null, again.halt && again.halt.message);
  assert.deepEqual(again.sent, []);
});

test('a protected variable\'s definition edit commits a new proved baseline, and keeps its bound value without sending it', async () => {
  const h = await harness();
  const spec = variableOnly();
  const valueOf = (Value) => readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value }] }, spec);
  await created(h, spec);
  await created(h, spec, { configurationBindings: valueOf('https://one.contoso.com') });
  const before = committed(h, 'environmentVariable', 'contoso_apibase');
  const valueId = before.records.find((r) => r.kind === 'environmentVariableValue').id;
  // The settings do not name the value this run: the definition edit is made, the value row is neither sent nor dropped.
  const next = { ...spec, environmentVariables: [{ ...spec.environmentVariables[0], description: 'Updated definition' }] };
  const out = await pass(h, next);
  assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
  assert.deepEqual(out.sent.map((r) => `${r.method} ${r.path.split('(')[0]}`), ['PATCH /environmentvariabledefinitions']);
  assert.equal(h.org.rows('environmentvariabledefinitions')[0].description, 'Updated definition');
  const after = committed(h, 'environmentVariable', 'contoso_apibase');
  assert.notEqual(after.generation, before.generation, 'the edit is proved and committed as the new baseline');
  assert.notEqual(after.records[0].intentSha256, before.records[0].intentSha256);
  assert.equal(after.records.find((r) => r.kind === 'environmentVariableValue').id, valueId, 'the bound value stays bound');
  assert.deepEqual(h.org.rows('environmentvariablevalues').map((r) => [r.environmentvariablevalueid, r.value]), [[valueId, 'https://one.contoso.com']]);
  // An authorized replacement of the variable's own value is a conditional PATCH of that row.
  const authorizedDestructive = new Set(['environmentVariableValue:contoso_apibase:value']);
  const replaced = await pass(h, next, { configurationBindings: valueOf('https://two.contoso.com'), authorizedDestructive });
  assert.equal(replaced.halt, null, replaced.halt && `${replaced.halt.code}: ${replaced.halt.message}`);
  assert.deepEqual(replaced.sent.map((r) => `${r.method} ${r.path.split('?')[0]}`), [`PATCH /environmentvariablevalues(${valueId})`]);
  assert.match(String(Object.entries(replaced.sent[0].headers).find(([k]) => k.toLowerCase() === 'if-match')?.[1]), /^W\/"\d+"$/);
  assert.notEqual(committed(h, 'environmentVariable', 'contoso_apibase').generation, after.generation);
});

test('a value made outside the plugin under a bound protected variable is never overwritten or adopted, authorized or not', async () => {
  const h = await harness();
  const spec = variableOnly();
  await created(h, spec);
  const rootId = committed(h, 'environmentVariable', 'contoso_apibase').records[0].id;
  const foreignId = await insertRow(h.org, 'environmentvariablevalues', {
    value: 'foreign-value-before',
    'EnvironmentVariableDefinitionId@odata.bind': `/environmentvariabledefinitions(${rootId})`,
  });
  // A rerun that writes nothing for the variable is not stopped by a value a maker set by hand.
  const quiet = await pass(reopen(h), spec);
  assert.equal(quiet.halt, null, quiet.halt && quiet.halt.message);
  assert.deepEqual(quiet.sent, []);
  const bindings = readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: 'current-value-after' }] }, spec);
  const authorizedDestructive = new Set(['environmentVariableValue:contoso_apibase:value']);
  for (const opts of [{ configurationBindings: bindings, authorizedDestructive }, { configurationBindings: bindings }]) {
    const out = await pass(reopen(h), spec, opts);
    assert.equal(out.halt && out.halt.code, 'create-identity-conflict', out.halt && out.halt.message);
    assert.equal(out.halt.phase, 'preflight');
    assert.deepEqual(out.sent, []);
  }
  // A definition edit would write the variable too: the row it does not hold still stops it.
  const edited = await pass(reopen(h), { ...spec, environmentVariables: [{ ...spec.environmentVariables[0], description: 'Edited' }] });
  assert.equal(edited.halt && edited.halt.code, 'create-identity-conflict', edited.halt && edited.halt.message);
  assert.deepEqual(edited.sent, []);
  // The write itself is held to the plan made from fresh reads (its create set admits only the rows the plan holds): a
  // step run without the preflight still never PATCHes a value row the binding does not hold.
  const runtime = createConfigurationRuntime({ spec, sdk: h.sdk, opts: { protectedConfiguration: reopen(h).protectedConfiguration, configurationBindings: bindings, authorizedDestructive }, appUniqueName: 'contoso_configured' });
  const mark = h.org.requests.length;
  const step = await runtime.apply('data-model').catch((error) => ({ error }));
  assert.ok(step.error || JSON.stringify(step).includes('create-identity-conflict'), JSON.stringify(step).slice(0, 400));
  assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), []);
  assert.deepEqual(h.org.rows('environmentvariablevalues').map((r) => [r.environmentvariablevalueid, r.value]), [[foreignId, 'foreign-value-before']]);
  assert.equal(committed(h, 'environmentVariable', 'contoso_apibase').records.length, 1, 'nothing is adopted');
});

// A pending edit of a bound item, judged from what its attempt persisted. `lostAfterApply` answers the Custom API PATCH with a
// failure after the org applied it (an answer lost after the change); `refuse` answers it with a failure the org never applied.
function editHarness() {
  const mode = { now: null };
  let org;
  const ready = harness({ intercept: async (req) => {
    if (!mode.now || req.method !== 'PATCH' || !req.path.startsWith('/customapis(')) return undefined;
    const how = mode.now;
    mode.now = null;
    if (how === 'lostAfterApply') await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: req.method, headers: req.headers, body: JSON.stringify(req.body) });
    return { statusCode: 400, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
  } }).then((h) => { org = h.org; return h; });
  return { ready, mode };
}
const apiSpec = (over = {}) => configSpec({ environmentVariables: [], duplicateDetectionRules: [], ...over });
// The edit a build would begin for the bound Custom API (as the port's locate plans it), begun here and never sent.
async function beginUnsentApiEdit(h, spec) {
  const types = await B.readComponentTypes(h.sdk.dataverse);
  const group = committed(h, 'customApi', 'contoso_calc');
  const bases = new Map();
  for (const r of group.records) bases.set(r.id, await B.readConfigurationRow(h.sdk.dataverse, r.kind, r.id));
  const root = group.records.find((r) => r.kind === 'customApi');
  const planned = B.planOf(spec, { kind: 'customApi', key: 'contoso_Calc', solution: SOL, componentTypes: types.types, bases,
    boundSlots: ['request:a', 'response:r'], baseGeneration: group.generation, boundIdOf: (k) => (k === 'customApi' ? root.id : undefined) });
  const [attempt] = h.ctx.begin([planned.plan]);
  return { attempt, rootId: root.id };
}

test('a protected Custom API edit whose answer was lost after it applied commits read-only on the rerun: nothing is sent again', async () => {
  const { ready, mode } = editHarness();
  const h = await ready;
  await created(h, apiSpec());
  const before = committed(h, 'customApi', 'contoso_calc');
  const edited = apiSpec(api({ description: 'Edited once' }));
  mode.now = 'lostAfterApply';
  const first = await pass(h, edited);
  assert.ok(first.halt, 'the lost answer stops the build');
  assert.ok(h.store.readGroup('customApi', 'contoso_calc').pending, 'the edit is kept pending');
  assert.equal(h.org.rows('customapis')[0].description, 'Edited once');
  assertCopyStop(await pass(reopen(h), edited), 'customApi', 'contoso_calc');
  const again = await pass(reopen(h), edited, overwriteCopy('customApi', 'contoso_calc'));
  assert.equal(again.halt, null, again.halt && `${again.halt.code}: ${again.halt.message}`);
  assert.deepEqual(again.sent, [], 'the edit is proved from its own expectation, never sent twice');
  const group = h.store.readGroup('customApi', 'contoso_calc');
  assert.equal(group.pending, null);
  assert.notEqual(group.committed.generation, before.generation, 'the proved edit is the new baseline');
  assert.equal(group.committed.records.find((r) => r.kind === 'customApi').id, before.records.find((r) => r.kind === 'customApi').id);
  assert.deepEqual((await pass(reopen(h), edited)).sent, []);
});

test('a protected Custom API edit refused by the org stays owed: the rerun never replays it and nothing is sent', async () => {
  const { ready, mode } = editHarness();
  const h = await ready;
  await created(h, apiSpec());
  const edited = apiSpec(api({ description: 'Edited once' }));
  mode.now = 'refuse';
  assert.ok((await pass(h, edited)).halt);
  assert.notEqual(h.org.rows('customapis')[0].description, 'Edited once', 'the org never applied it');
  assertCopyStop(await pass(reopen(h), edited), 'customApi', 'contoso_calc');
  // Replacing the copy is not consent to replay: the edit stays owed with the approval given, run after run.
  for (let i = 0; i < 2; i += 1) {
    const again = await pass(reopen(h), edited, overwriteCopy('customApi', 'contoso_calc'));
    assert.ok(again.halt, 'an edit that may have been sent is never replayed');
    assert.notEqual(again.halt.code, 'workspace-copy-unsent-edits', again.halt.message);
    assert.deepEqual(again.sent, []);
    assert.ok(h.store.readGroup('customApi', 'contoso_calc').pending, 'its debt is kept');
  }
});

test('a protected Custom API edit proved unsent is resumed under its own attempt and sent exactly once', async () => {
  const h = await harness();
  await created(h, apiSpec());
  const edited = apiSpec(api({ description: 'Edited once' }));
  const { attempt, rootId } = await beginUnsentApiEdit(h, edited);
  assert.equal(h.store.readGroup('customApi', 'contoso_calc').pending.token, attempt.token);
  const out = await pass(reopen(h), edited);
  assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
  assert.deepEqual(out.sent.map((r) => `${r.method} ${r.path.split('?')[0]}`), [`PATCH /customapis(${rootId})`]);
  assert.equal(h.org.rows('customapis')[0].description, 'Edited once');
  assert.equal(h.store.readGroup('customApi', 'contoso_calc').pending, null);
  assert.deepEqual((await pass(reopen(h), edited)).sent, [], 'settled: the rerun sends nothing');
});

test('an unsent protected Custom API edit whose declaration then changed is not sent: it stays owed until restored', async () => {
  const h = await harness();
  await created(h, apiSpec());
  const edited = apiSpec(api({ description: 'Edited once' }));
  await beginUnsentApiEdit(h, edited);
  const other = await pass(reopen(h), apiSpec(api({ description: 'Edited twice' })));
  assert.equal(other.halt && other.halt.code, 'managed-pending-intent-changed');
  assert.deepEqual(other.sent, []);
  assert.ok(h.store.readGroup('customApi', 'contoso_calc').pending);
  const restored = await pass(reopen(h), edited);
  assert.equal(restored.halt, null, restored.halt && `${restored.halt.code}: ${restored.halt.message}`);
  assert.equal(restored.sent.length, 1);
});

test('an unsent protected value edit already at its target asks for the exact approval of its private value: never reported unchanged while it is owed', async () => {
  const h = await harness();
  const spec = variableOnly();
  const bindings = (Value) => readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value }] }, spec);
  await created(h, spec, { configurationBindings: bindings('old-input') });
  const group = committed(h, 'environmentVariable', 'contoso_apibase');
  const types = await B.readComponentTypes(h.sdk.dataverse);
  const bases = new Map();
  for (const row of group.records) bases.set(row.id, await B.readConfigurationRow(h.sdk.dataverse, row.kind, row.id));
  const root = group.records.find((r) => r.kind === 'environmentVariable');
  const child = group.records.find((r) => r.kind === 'environmentVariableValue');
  const next = bindings('next-input');
  const planned = B.planOf(spec, { kind: 'environmentVariable', key: 'contoso_ApiBase', solution: SOL, bindings: next,
    componentTypes: types.types, bases, boundSlots: ['value'], baseGeneration: group.generation, boundIdOf: () => root.id });
  h.ctx.begin([planned.plan]);
  // The target is made outside the plugin: the prepared edit has nothing left to write, but its private value is not the
  // plugin's own until the maker approves it.
  const manual = await h.org.request({ url: `${h.org.origin}/api/data/v9.0/environmentvariablevalues(${child.id})`, method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'next-input' }) });
  assert.ok(manual.statusCode < 300);
  const destructive = new Set(['environmentVariableValue:contoso_apibase:value']);
  const out = await pass(reopen(h), spec, { configurationBindings: next, authorizedDestructive: destructive });
  assert.equal(out.halt && out.halt.code, 'create-ownership-required', out.halt && out.halt.message);
  assert.match(out.halt.message, /given after checking those rows are yours: "adopt:environmentVariableValue:contoso_apibase\/value"\.$/);
  assert.deepEqual(out.sent, []);
  const held = h.store.readGroup('environmentVariable', 'contoso_apibase');
  assert.ok(held.pending, 'the attempt stays owed');
  assert.equal(held.committed.generation, group.generation);
  // Without the preflight, the plan's own resolve stops on the same verdict: nothing is planned as unchanged.
  const runtime = createConfigurationRuntime({ spec, sdk: h.sdk, opts: { protectedConfiguration: reopen(h).protectedConfiguration, configurationBindings: next, authorizedDestructive: destructive }, appUniqueName: 'contoso_configured' });
  const mark = h.org.requests.length;
  const step = await runtime.apply('data-model');
  assert.deepEqual(step.halt && step.halt.items.map(({ kind, code }) => `${kind} ${code}`), ['environmentVariable create-ownership-required']);
  assert.deepEqual(step.outcome.unchanged || [], []);
  assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), []);
  assert.ok(h.store.readGroup('environmentVariable', 'contoso_apibase').pending);
  // The exact approval accepts the same attempt read-only: nothing is sent.
  const approved = await pass(reopen(h, ['adopt:environmentVariableValue:contoso_apibase/value']), spec, { configurationBindings: next, authorizedDestructive: destructive });
  assert.equal(approved.halt, null, approved.halt && `${approved.halt.code}: ${approved.halt.message}`);
  assert.deepEqual(approved.sent, []);
  assert.equal(h.store.readGroup('environmentVariable', 'contoso_apibase').pending, null);
});

test('an unsent protected edit already at its target whose solution membership is gone stops: no membership is added outside its attempt', async () => {
  const h = await harness();
  await created(h, apiSpec());
  const target = apiSpec(api({ description: 'Target already present' }));
  const { rootId } = await beginUnsentApiEdit(h, target);
  const manual = await h.org.request({ url: `${h.org.origin}/api/data/v9.0/customapis(${rootId})`, method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'Target already present' }) });
  assert.ok(manual.statusCode < 300);
  const membership = h.org.rows('solutioncomponents').find((r) => r.objectid === rootId);
  assert.ok(membership);
  const deleted = await h.org.request({ url: `${h.org.origin}/api/data/v9.0/solutioncomponents(${membership.solutioncomponentid})`, method: 'DELETE', headers: {} });
  assert.ok(deleted.statusCode < 300);
  const out = await pass(reopen(h), target);
  assert.equal(out.halt && out.halt.code, 'create-completion-required', out.halt && out.halt.message);
  assert.deepEqual(out.sent, []);
  assert.ok(h.store.readGroup('customApi', 'contoso_calc').pending, 'the attempt stays owed');
  // Without the preflight: the same verdict from resolve, and no AddSolutionComponent.
  const runtime = createConfigurationRuntime({ spec: target, sdk: h.sdk, opts: { protectedConfiguration: reopen(h).protectedConfiguration }, appUniqueName: 'contoso_configured' });
  const mark = h.org.requests.length;
  const step = await runtime.apply('data-model');
  assert.deepEqual(step.halt && step.halt.items.map(({ kind, code }) => `${kind} ${code}`), ['customApi create-completion-required']);
  assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), []);
  assert.ok(h.store.readGroup('customApi', 'contoso_calc').pending);
});

test('an unsent protected edit whose solution membership is gone adds it only inside its own attempt, after its write', async () => {
  const h = await harness();
  await created(h, apiSpec());
  const edited = apiSpec(api({ description: 'Edited once' }));
  const { rootId } = await beginUnsentApiEdit(h, edited);
  const membership = h.org.rows('solutioncomponents').find((r) => r.objectid === rootId);
  const deleted = await h.org.request({ url: `${h.org.origin}/api/data/v9.0/solutioncomponents(${membership.solutioncomponentid})`, method: 'DELETE', headers: {} });
  assert.ok(deleted.statusCode < 300);
  const runtime = createConfigurationRuntime({ spec: edited, sdk: h.sdk, opts: { protectedConfiguration: reopen(h).protectedConfiguration }, appUniqueName: 'contoso_configured' });
  const mark = h.org.requests.length;
  const step = await runtime.apply('data-model');
  assert.equal(step.halt, null, step.halt && JSON.stringify(step.halt.items));
  assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path.split('?')[0]}`),
    [`PATCH /customapis(${rootId})`, 'POST /AddSolutionComponent']);
  assert.equal(h.store.readGroup('customApi', 'contoso_calc').pending, null);
});

test('an unsent protected first value whose row was made at its id outside the plugin is never planned unchanged while its create is owed', async () => {
  const h = await harness();
  const spec = variableOnly();
  await created(h, spec);
  const group = committed(h, 'environmentVariable', 'contoso_apibase');
  const types = await B.readComponentTypes(h.sdk.dataverse);
  const bases = new Map();
  for (const row of group.records) bases.set(row.id, await B.readConfigurationRow(h.sdk.dataverse, row.kind, row.id));
  const root = group.records.find((r) => r.kind === 'environmentVariable');
  const next = readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: 'https://one.contoso.com' }] }, spec);
  const planned = B.planOf(spec, { kind: 'environmentVariable', key: 'contoso_ApiBase', solution: SOL, bindings: next,
    componentTypes: types.types, bases, boundSlots: [], baseGeneration: group.generation, boundIdOf: () => root.id });
  const valueRow = planned.plan.rows.find((r) => r.kind === 'environmentVariableValue');
  assert.equal(valueRow.mode, 'create');
  h.ctx.begin([planned.plan]);
  const manual = await h.org.request({ url: `${h.org.origin}/api/data/v9.0/environmentvariablevalues`, method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ environmentvariablevalueid: valueRow.id, value: 'https://one.contoso.com', schemaname: 'contoso_ApiBase', 'EnvironmentVariableDefinitionId@odata.bind': `/environmentvariabledefinitions(${root.id})` }) });
  assert.ok(manual.statusCode < 300, String(manual.statusCode));
  // Without the preflight, the plan's own resolve says the create is owed: the item is neither unchanged nor written.
  const runtime = createConfigurationRuntime({ spec, sdk: h.sdk, opts: { protectedConfiguration: reopen(h).protectedConfiguration, configurationBindings: next }, appUniqueName: 'contoso_configured' });
  const mark = h.org.requests.length;
  const step = await runtime.apply('data-model');
  assert.deepEqual(step.halt && step.halt.items.map(({ kind, code }) => `${kind} ${code}`), ['environmentVariable create-completion-required']);
  assert.deepEqual(step.outcome.unchanged || [], []);
  assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), []);
  assert.ok(h.store.readGroup('environmentVariable', 'contoso_apibase').pending);
});

test('a bound protected item whose workspace copy differs from the server\'s is never read over: build and verify stop, and only its exact overwrite approval replaces it', async () => {
  const h = await harness();
  const spec = apiSpec();
  await created(h, spec);
  const before = committed(h, 'customApi', 'contoso_calc');
  const id = before.records.find((r) => r.kind === 'customApi').id;
  await h.sdk.updateElement('customApi', id, '/description', 'Retained maker draft');
  const { hasUnsyncedEdits } = require('../lib/unsynced-edits.js');
  const dirty = () => hasUnsyncedEdits(h.sdk, 'customApi', id);
  assert.equal(await dirty(), true);
  const out = await pass(reopen(h), spec);
  assertCopyStop(out, 'customApi', 'contoso_calc');
  assert.match(out.halt.message, /local copy of the customApi "contoso_calc" .* the copy was kept\. Put any change you want to keep into the App Spec, then approve replacing the local copy with the server's: --authorize overwrite:customApi:contoso_calc/);
  assert.equal(await dirty(), true, 'the draft is kept');
  // Without the preflight, the plan's own exact read stops on it too (typed, the id named), before any fetch over it.
  const runtime = createConfigurationRuntime({ spec, sdk: h.sdk, opts: { protectedConfiguration: reopen(h).protectedConfiguration }, appUniqueName: 'contoso_configured' });
  const mark = h.org.requests.length;
  const step = await runtime.apply('data-model');
  assert.deepEqual(step.halt && step.halt.items.map(({ kind, code }) => `${kind} ${code}`), ['customApi create-completion-required']);
  assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), []);
  assert.equal(await dirty(), true);
  // Verify reads it at its exact id too, and does not read over the draft either.
  const checks = await readerFor(h.sdk, 'contoso_configured').configuration(spec, undefined, managedManifestView(h.store.snapshot()));
  assert.equal(checks.find((c) => c.kind === 'customApi' && c.name === 'definition').code, 'create-completion-required');
  assert.equal(await dirty(), true);
  assert.deepEqual(committed(h, 'customApi', 'contoso_calc'), before, 'the binding is kept as it was');
  // An approval for another item, or another family's key of the same spelling, replaces nothing.
  assertCopyStop(await pass(reopen(h), spec, { authorizedOverwrite: new Set(['customApi:contoso_other', 'view:contoso_calc', 'environmentVariable:contoso_calc']) }), 'customApi', 'contoso_calc');
  assert.equal(await dirty(), true);
  // A blanket programmatic `true` names no item, so it approves no replacement either.
  assertCopyStop(await pass(reopen(h), spec, { authorizedOverwrite: true }), 'customApi', 'contoso_calc');
  assert.equal(await dirty(), true, 'a blanket boolean never discards the draft');
  // The maker's decision, the exact approval: the copy is replaced with the server's, and the build goes on and sends
  // nothing for an unchanged item.
  const again = await pass(reopen(h), spec, overwriteCopy('customApi', 'contoso_calc'));
  assert.equal(again.halt, null, again.halt && `${again.halt.code}: ${again.halt.message}`);
  assert.deepEqual(again.sent, []);
  assert.equal(await dirty(), false);
  assert.notEqual(h.org.rows('customapis')[0].description, 'Retained maker draft', 'the draft was never sent');
  assert.deepEqual((await pass(reopen(h), spec)).sent, []);
});

test('a workspace copy an earlier version left, which the SDK refuses, stops the preflight with its own code and remedy, never an overwrite approval that cannot clear it', async () => {
  const h = await harness();
  const spec = apiSpec();
  await created(h, spec);
  const bundle = require('../vendor/cds-maker-sdk.cjs');
  const { LEGACY_COPY_CODE } = require('../lib/workspace-configuration-memory.js');
  // The refusal the workspace overlay raises at the SDK's first touch of a legacy copy it cannot prove clean
  // (lib/workspace-configuration-memory.js): an overwrite fetch is refused the same way, so an overwrite approval
  // could never clear it; only the maker's removal of the two files does.
  const diff = h.sdk.diffArtifact.bind(h.sdk);
  h.sdk.diffArtifact = async (kind, ...rest) => {
    if (kind === 'customApi') throw new bundle.SdkError(LEGACY_COPY_CODE, 'customApis/<id>.json and its metadata were left by an earlier version; delete those two files');
    return diff(kind, ...rest);
  };
  const out = await pass(reopen(h), spec);
  assert.equal(out.halt && out.halt.code, LEGACY_COPY_CODE, out.halt && `${out.halt.code}: ${out.halt.message}`);
  assert.ok(out.halt.message.includes('delete those two files'), out.halt.message);
  assert.ok(!out.halt.message.includes('--authorize overwrite:'), out.halt.message);
  assert.deepEqual(out.sent, [], 'nothing is written');
});

// A protected edit the org refuses, with a local edit written into the shared workspace copy at some point of the
// build's own send. `inject(h, id, sdk)` installs the edit; answers the harness, the root id and the edited App Spec.
async function refusedSendWith(inject) {
  let reject = false;
  const h = await harness({ intercept: ({ method, path }) => (reject && method === 'PATCH' && path.startsWith('/customapis(')
    ? { statusCode: 400, body: { error: { code: '0x80040216', message: 'refused edit' } } } : undefined) });
  await created(h, apiSpec());
  const id = committed(h, 'customApi', 'contoso_calc').records.find((r) => r.kind === 'customApi').id;
  const state = inject(h, id, { update: h.sdk.updateElement.bind(h.sdk), push: h.sdk.pushArtifact.bind(h.sdk), diff: h.sdk.diffArtifact.bind(h.sdk) });
  reject = true;
  const edited = apiSpec(api({ description: 'Build-owned edit' }));
  const out = await pass(h, edited);
  return { h, id, edited, out, state };
}
const holds = async (h, id, text) => JSON.stringify(await h.sdk.diffArtifact('customApi', id)).includes(text);
// The kept copy stops every later build before anything is sent, the maker's edit still in it; only the maker's exact
// approval replaces it, and the refused edit is then recovered from what its attempt persisted: never replayed. `unsent`:
// the attempt never left (the gate refused its push before dispatch), so the approved build sends it once, its first send.
async function assertKeptUntilApproved(h, id, edited, text, { unsent = false } = {}) {
  for (let i = 0; i < 2; i += 1) {
    assertCopyStop(await pass(reopen(h), edited), 'customApi', 'contoso_calc');
    assert.ok(await holds(h, id, text), `the local edit "${text}" survives build ${i + 2}`);
  }
  const approved = await pass(reopen(h), edited, overwriteCopy('customApi', 'contoso_calc'));
  assert.ok(approved.halt, 'the refused edit stays owed');
  assert.notEqual(approved.halt.code, 'workspace-copy-unsent-edits', approved.halt.message);
  assert.deepEqual(approved.sent.map((r) => `${r.method} ${r.path.split('?')[0]}`), unsent ? [`PATCH /customapis(${id})`] : [], 'replacing the copy sends nothing, and the edit is never replayed');
  assert.equal(await holds(h, id, text), false, 'the copy was replaced, as the maker approved');
  assert.ok(h.store.readGroup('customApi', 'contoso_calc').pending, 'its debt is kept');
}

test('a failed protected send keeps the whole workspace copy: a local edit written while the push was pending survives, and the next build stops with the overwrite approval', async () => {
  const { h, id, edited, out, state } = await refusedSendWith((h, id, sdk) => {
    const state = { injected: false };
    h.sdk.pushArtifact = async (...args) => {
      const result = await sdk.push(...args);
      if (!state.injected && args[0] === 'customApi') {
        await h.sdk.updateElement('customApi', id, '/displayName', 'Maker draft arrived during push');
        state.injected = true;
      }
      return result;
    };
    return state;
  });
  assert.ok(state.injected);
  assert.ok(out.halt);
  assert.equal(out.sent.length, 1);
  assert.ok(await holds(h, id, 'Maker draft arrived during push'), 'the edit the build did not make is kept');
  assert.ok(await holds(h, id, 'Build-owned edit'), 'the build\'s own unsent change is kept with it: the copy is never reset');
  await assertKeptUntilApproved(h, id, edited, 'Maker draft arrived during push');
});

test('a local edit made while the build prepares its protected send is never taken for the build\'s own: the failed send keeps it', async () => {
  const { h, id, edited, out, state } = await refusedSendWith((h, id, sdk) => {
    const state = { injected: false };
    // The maker's edit lands between the build's own element updates and its push, through the same SDK.
    h.sdk.updateElement = async (...args) => {
      const value = await sdk.update(...args);
      if (!state.injected && args[0] === 'customApi' && args[2] === '/description') {
        await sdk.update('customApi', id, '/displayName', 'Maker draft before capture');
        state.injected = true;
      }
      return value;
    };
    return state;
  });
  assert.ok(state.injected);
  assert.ok(out.halt);
  // The push now carries a field the build's plan does not hold (the maker's), so the gate refuses it before it leaves.
  assert.deepEqual(out.sent, [], 'the maker\'s field is never sent under the build\'s attempt');
  assert.ok(await holds(h, id, 'Maker draft before capture'), 'the maker\'s edit survives the failed send');
  await assertKeptUntilApproved(h, id, edited, 'Maker draft before capture', { unsent: true });
});

test('a local edit made after a failed protected send, while a build compares the copy, survives: the next build stops with the overwrite approval', async () => {
  const { h, id, edited, out, state } = await refusedSendWith((h, id, sdk) => {
    const state = { failed: false, injected: false };
    h.sdk.pushArtifact = async (...args) => {
      try {
        return await sdk.push(...args);
      } finally {
        if (args[0] === 'customApi') state.failed = true;
      }
    };
    // The maker's edit lands just after the first comparison of the copy that follows the failed send — the
    // diff is not locked, so nothing a comparison answered can be relied on once it has returned.
    h.sdk.diffArtifact = async (...args) => {
      const diff = await sdk.diff(...args);
      if (state.failed && !state.injected && args[0] === 'customApi') {
        await sdk.update('customApi', id, '/displayName', 'Maker draft after comparison');
        state.injected = true;
      }
      return diff;
    };
    return state;
  });
  assert.ok(out.halt);
  assertCopyStop(await pass(reopen(h), edited), 'customApi', 'contoso_calc');
  assert.ok(state.injected, 'the edit landed after a comparison of the copy');
  assert.ok(await holds(h, id, 'Maker draft after comparison'), 'the maker\'s edit survives');
  await assertKeptUntilApproved(h, id, edited, 'Maker draft after comparison');
});

test('a failed protected send never removes its copy, and an approved replacement that cannot read the server\'s row keeps it and stops', async () => {
  let denyRead = false;
  const h = await harness({ intercept: ({ method, path }) => {
    // A 503 says nothing about whether the create was taken, so the attempt stays pending (a 400 with a Dataverse code is
    // a refusal that releases it: see the create-refused tests).
    if (method === 'POST' && path.startsWith('/customapis')) return { statusCode: 503, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
    if (denyRead && method === 'GET' && path.startsWith('/customapis(')) return { statusCode: 403, body: { error: { code: '0x80040220', message: 'read denied' } } };
    return undefined;
  } });
  const spec = apiSpec();
  const fetch = h.sdk.fetchArtifact.bind(h.sdk);
  // Every read of the Custom API into the workspace is refused, as a denied or failed read would be.
  h.sdk.fetchArtifact = async (kind, ...rest) => {
    if (kind === 'customApi') { const e = new Error('read denied'); e.code = 'HTTP_403'; throw e; }
    return fetch(kind, ...rest);
  };
  const out = await pass(h, spec);
  assert.ok(out.halt);
  const listed = async () => (await h.sdk.listArtifacts('customApi')).map((s) => s.id);
  assert.equal((await listed()).length, 1, 'the copy of the refused create is kept, not deleted on a read that proves nothing');
  assertCopyStop(await pass(reopen(h), spec), 'customApi', 'contoso_calc');
  // Approved, but the server's row cannot be read: nothing proves what to put in the copy's place, so it is kept.
  denyRead = true;
  const unread = await pass(reopen(h), spec, overwriteCopy('customApi', 'contoso_calc'));
  assert.equal(unread.halt && unread.halt.code, 'workspace-copy-unsent-edits', unread.halt && unread.halt.message);
  assert.match(unread.halt.message, /could not be replaced with the server's as approved/);
  assert.deepEqual(unread.sent, []);
  assert.equal((await listed()).length, 1);
  // Approved, and the row is proved absent (the create was never taken): the local copy is all there is, and it goes.
  denyRead = false;
  const approved = await pass(reopen(h), spec, overwriteCopy('customApi', 'contoso_calc'));
  assert.ok(!approved.halt || approved.halt.code !== 'workspace-copy-unsent-edits', approved.halt && approved.halt.message);
});
// A rule create whose content the service saved and acknowledged, with its solution membership complete, whose initial
// publication was never dispatched (the process that saved it stopped before the publish left). `settle: true` is what
// the build's own create set does next (it records the children this process saw created); without it, an earlier
// process's answers are gone and nothing persisted proves the conditions this plugin's own.
const publishes = (requests) => requests.filter((r) => /PublishDuplicateRule$/.test(r.path));
const ruleOnly = () => configSpec({ environmentVariables: [], customApis: [] });
async function savedUnpublishedRule(h, { settle }) {
  const types = await B.readComponentTypes(h.sdk.dataverse);
  const planned = B.planOf(ruleOnly(), { kind: 'duplicateRule', key: 'email', solution: SOL, componentTypes: types.types });
  const [attempt] = h.ctx.begin([planned.plan]);
  const classify = B.createSetClassifier([{ token: attempt.token, planned }]);
  const artifact = B.artifactFor(planned);
  artifact.status = 'unpublished';
  const saved = await h.ctx.run({ attempts: [attempt], classify, deleteCode: B.DELETE_CODE, acceptResult: B.acceptResultFor(planned) }, async () => {
    await h.sdk.createArtifact('duplicateRule', artifact);
    return h.sdk.pushArtifact('duplicateRule', planned.rows[0].id);
  });
  assert.equal(saved.checked, true, 'the content was saved and acknowledged');
  const absent = (await B.observe(h.sdk.dataverse, planned)).members.filter((m) => m.state === 'absent');
  await h.ctx.run({ attempts: [attempt], classify, deleteCode: B.DELETE_CODE }, async () => {
    for (const m of absent) {
      const want = planned.plan.members.find((x) => x.id === m.id);
      await h.sdk.dataverse.post('/AddSolutionComponent', { ComponentId: m.id, ComponentType: want.componentType, SolutionUniqueName: SOL, AddRequiredComponents: false });
    }
  });
  if (settle) {
    const [settled] = h.ctx.settle([{ token: attempt.token, observation: await B.observe(h.sdk.dataverse, planned) }]);
    assert.equal(settled.verdict.code, 'create-completion-required');
  }
  const pending = h.store.readGroup('duplicateRule', 'email').pending;
  assert.equal(pending.acknowledgedRoot, true);
  assert.deepEqual(pending.rowProtocol.effects.filter((e) => e.kind === 'rule-state').map((e) => e.dispatched), [false], 'the publication never left');
  assert.equal(publishes(h.org.requests).length, 0);
  return { ruleId: planned.rows[0].id, token: attempt.token };
}

// #808: the guidance a stopped protected rule create carries when its first publication is not confirmed. `name` and `key`
// are given as the sentence quotes them (JSON string text).
const hintOf = (name, key, id) => `The first publication of duplicate detection rule ${name} (App Spec key ${key}, original id ${id}) has not been confirmed. `
  + 'The build does not send this publication again. Check that exact rule: if it reads Publishing, wait and rebuild; otherwise check its definition '
  + 'and conditions and, if they are what you intend, publish it in the environment\'s duplicate detection rules settings, then rebuild. '
  + 'Setting "status": "published" in the App Spec does not bypass this pending attempt.';
// Today's stops, which the guidance is appended to and never changes.
const stepStop = (code, key = 'email') => `1 configuration item not completed: duplicateRule ${key} (${code})`;
const completionStop = (h, key = 'email') => `duplicateRule ${key}: the managed duplicateRule "${key}" is not complete (missing rows, solution membership, rule state or a private input); `
  + 'complete it under the same ids, then run again. If it cannot be completed that way (a create an earlier plugin version left pending after the service refused it, say), '
  + 'stop tracking it instead: remove this item (and its deployment-settings entry) from the App Spec and run the build again with '
  + `${authorizeFlags([`retire:duplicateRule:${key}@${h.store.readGroup('duplicateRule', key).pending.token}`])} `
  + '(nothing is deleted or sent), then restore them and run again. If the attempt made a row at its derived id, that build stops with create-identity-conflict naming the row';
const unverifiedStop = (key = 'email') => `duplicateRule ${key}: the managed duplicateRule "${key}" could not be read completely; nothing is created or bound`;
const refusedPublish = { statusCode: 400, body: { error: { code: '0x80040216', message: 'publish failed' } } };
// A harness whose service refuses every publication; `before(row)` changes the rule's row first (its state, say), as the
// service's own publish job would have.
async function refusingPublish({ before } = {}) {
  let h = null;
  h = await harness({
    intercept: ({ method, path }) => {
      const m = method === 'POST' && /\/duplicaterules\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.PublishDuplicateRule$/.exec(path);
      if (!m) return undefined;
      if (before) before(h.org.sets.get('duplicaterules').get(m[1].replace(/^\{|\}$/g, '').toLowerCase()));
      return refusedPublish;
    },
  });
  return h;
}
const ruleRow = (h, id) => h.org.sets.get('duplicaterules').get(id);
const publishing = (row) => { row.statecode = 0; row.statuscode = 1; };
const unreadable = (row) => { delete row.statecode; delete row.statuscode; };

test('a saved rule create whose initial publication never left is published once by the rerun, then bound; nothing is sent again', async () => {
  const h = await harness();
  const { ruleId } = await savedUnpublishedRule(h, { settle: true });
  const later = reopen(h);
  const out = await pass(later, ruleOnly());
  assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
  assert.deepEqual(out.sent.map((r) => r.path.split('?')[0]), [`/duplicaterules(${ruleId})/Microsoft.Dynamics.CRM.PublishDuplicateRule`], 'only the owed publication, once');
  assert.equal(h.org.rows('duplicaterules').find((r) => r.duplicateruleid === ruleId).statecode, 1);
  assert.ok(committed(h, 'duplicateRule', 'email').records.some((r) => r.id === ruleId));
  const rerun = await pass(later, ruleOnly());
  assert.equal(rerun.halt, null);
  assert.deepEqual(rerun.sent, []);
});

test('an unsent rule publication whose conditions no persisted answer proves asks for their approval before anything is sent, then is sent once', async () => {
  const h = await harness();
  await savedUnpublishedRule(h, { settle: false });
  const asked = await pass(reopen(h), ruleOnly());
  assert.equal(asked.halt && asked.halt.code, 'create-ownership-required', asked.halt && asked.halt.message);
  assert.deepEqual(asked.sent, [], 'nothing is published before every row is proved this plugin\'s own');
  const quoted = /given after checking those rows are yours: (.*)\.$/.exec(asked.halt.message);
  assert.ok(quoted, asked.halt.message);
  const tokens = JSON.parse(`[${quoted[1]}]`);
  assert.ok(tokens.length && tokens.every((t) => t.startsWith('adopt:duplicateRuleCondition:')), tokens.join(' '));
  const approved = reopen(h, tokens);
  const out = await pass(approved, ruleOnly());
  assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
  assert.equal(publishes(out.sent).length, 1);
  assert.equal(out.sent.length, 1);
  assert.deepEqual((await pass(approved, ruleOnly())).sent, []);
});

test('the one send of an unsent rule publication is fenced: a refused publish stays owed and is never sent again', async () => {
  let refuse = true;
  const h = await harness({ intercept: ({ method, path }) => (refuse && method === 'POST' && /PublishDuplicateRule$/.test(path) ? { statusCode: 400, body: { error: { code: '0x80040216', message: 'publish failed' } } } : undefined) });
  const { ruleId } = await savedUnpublishedRule(h, { settle: true });
  const first = await pass(reopen(h), ruleOnly());
  assert.equal(first.halt && first.halt.code, 'configuration-incomplete', first.halt && first.halt.message);
  assert.match(first.halt.message, /duplicateRule email \(create-completion-required\)/);
  // The publication this build sent is not confirmed: the stop says which rule, at which id, and how to finish it (#808).
  assert.equal(first.halt.message, `${stepStop('create-completion-required')} (${hintOf('"Same email"', '"email"', ruleId)})`);
  assert.deepEqual(first.step.halt.items.map((p) => Object.keys(p)), [['kind', 'key', 'code']], 'the public halt item is unchanged');
  assert.deepEqual(first.step.outcome.unknown.map((f) => [f.code, f.id]), [['create-completion-required', ruleId]], 'the stop now carries the rule\'s original id');
  assert.equal(publishes(first.sent).length, 1, 'sent once');
  assert.deepEqual(h.store.readGroup('duplicateRule', 'email').pending.rowProtocol.effects.filter((e) => e.kind === 'rule-state').map((e) => e.dispatched), [true]);
  refuse = false;
  const again = await pass(reopen(h), ruleOnly());
  assert.equal(again.halt && again.halt.code, 'create-completion-required');
  assert.equal(again.halt.phase, 'preflight');
  assert.equal(again.halt.message, `${completionStop(h)} (${hintOf('"Same email"', '"email"', ruleId)})`);
  assert.deepEqual(again.sent, [], 'a publish that was sent is never replayed');
  // The maker publishes it under the same id; the next build binds it with nothing sent.
  await h.org.request({ url: `${h.org.origin}/api/data/v9.2/duplicaterules(${ruleId})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const done = await pass(reopen(h), ruleOnly());
  assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
  assert.deepEqual(done.sent, []);
});

test('only one claim may send an unsent rule publication: an older claim is refused at dispatch, and a dispatched one is never claimed again', async () => {
  const h = await harness();
  const { ruleId, token } = await savedUnpublishedRule(h, { settle: true });
  const older = h.store.claimUnsentRowEffect({ token, kind: 'rule-state', id: ruleId });
  const newer = h.store.claimUnsentRowEffect({ token, kind: 'rule-state', id: ruleId });
  assert.equal(newer.epoch, older.epoch + 1);
  assert.throws(() => h.store.markRowEffectDispatch({ token, epoch: older.epoch, kind: 'rule-state', id: ruleId }), (e) => e.code === 'managed-settlement-pending');
  h.store.markRowEffectDispatch({ token, epoch: newer.epoch, kind: 'rule-state', id: ruleId });
  assert.throws(() => h.store.claimUnsentRowEffect({ token, kind: 'rule-state', id: ruleId }), (e) => e.code === 'managed-settlement-pending');
  assert.throws(() => h.store.claimUnsentRowEffect({ token, kind: 'membership', id: ruleId }), (e) => e.code === 'managed-not-settled');
  const out = await pass(reopen(h), ruleOnly());
  assert.equal(out.halt && out.halt.code, 'create-completion-required');
  assert.deepEqual(out.sent, []);
});

// ---------------------------------------------------------------------------------------------
// #808: a protected rule create whose first publication is not confirmed names the rule and its original id, and says how
// to finish it. Wording only: the same requests, the same codes, the same store; a stop the build cannot prove is that
// case keeps today's text.

test('a first publication that is not confirmed names the rule and its original id, in the step stop and in every later preflight', async () => {
  const h = await refusingPublish();
  const first = await pass(h, configSpec());
  const pending = h.store.readGroup('duplicateRule', 'email').pending;
  const ruleId = pending.root.id;
  const hint = hintOf('"Same email"', '"email"', ruleId);
  assert.equal(first.halt && first.halt.message, `${stepStop('create-completion-required')} (${hint})`);
  assert.deepEqual(first.step.halt.items.map((p) => Object.keys(p)), [['kind', 'key', 'code']]);
  const sentPublishes = publishes(h.org.requests).length;

  // Unpublished: today's preflight stop, then the guidance.
  const again = await pass(h, configSpec(), overwriteCopy('duplicateRule', 'email'));
  assert.equal(again.halt && again.halt.message, `${completionStop(h)} (${hint})`);
  assert.deepEqual(again.sent, []);
  // Publishing (statecode 0, statuscode 1) and a status that cannot be read: the identity is unverified, and the same advice holds.
  publishing(ruleRow(h, ruleId));
  const busy = await pass(reopen(h), configSpec(), overwriteCopy('duplicateRule', 'email'));
  assert.equal(busy.halt && busy.halt.code, 'create-identity-unverified');
  assert.equal(busy.halt.message, `${unverifiedStop()} (${hint})`);
  unreadable(ruleRow(h, ruleId));
  const blind = await pass(reopen(h), configSpec(), overwriteCopy('duplicateRule', 'email'));
  assert.equal(blind.halt && blind.halt.message, `${unverifiedStop()} (${hint})`);
  assert.deepEqual([...busy.sent, ...blind.sent], []);
  // Writing "status": "published" does not send it: that declaration is not the one the pending attempt was prepared for.
  const asked = await pass(reopen(h), configSpec(rule({ status: 'published' })), overwriteCopy('duplicateRule', 'email'));
  assert.match(asked.halt && asked.halt.message, /has a pending attempt prepared for another declaration/);
  assert.equal(publishes(h.org.requests).length, sentPublishes, 'the publication is never sent again');

  // Published by the maker: the build binds it, with nothing sent and nothing to explain.
  ruleRow(h, ruleId).statecode = 1;
  ruleRow(h, ruleId).statuscode = 2;
  const done = await pass(reopen(h), configSpec(), overwriteCopy('duplicateRule', 'email'));
  assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
  assert.deepEqual(done.sent, []);
});

test('a first publication left Publishing, or whose status cannot be read, names the rule in the step stop', async () => {
  for (const [label, before] of [['publishing', publishing], ['unreadable', unreadable]]) {
    // eslint-disable-next-line no-await-in-loop
    const h = await refusingPublish({ before });
    // eslint-disable-next-line no-await-in-loop
    const out = await pass(h, configSpec());
    const ruleId = h.store.readGroup('duplicateRule', 'email').pending.root.id;
    assert.equal(out.halt && out.halt.message, `${stepStop('create-identity-unverified')} (${hintOf('"Same email"', '"email"', ruleId)})`, label);
  }
});

test('the guidance follows a rule stopped behind another item, and a step stop rebuilt for an unrecorded binding carries it once', async () => {
  const h = await refusingPublish();
  const failing = { lookup: async () => null, recordApplied: async () => { throw new Error('the manifest could not be written'); }, planAdoption: async () => ({ allowed: false, code: 'ADOPTION_REFUSED' }) };
  const first = await pass(h, configSpec(), { managed: failing });
  const ruleId = h.store.readGroup('duplicateRule', 'email').pending.root.id;
  const hint = hintOf('"Same email"', '"email"', ruleId);
  assert.match(first.halt.message, /CONFIGURATION_RECORD_UNCONFIRMED/);
  assert.ok(first.halt.message.includes(`duplicateRule email (create-completion-required) (${hint})`), first.halt.message);
  assert.equal(first.halt.message.split('The first publication').length, 2, 'once');
  // An unsupported edit leads the preflight stop; the rule follows it, with its guidance.
  const out = await pass(h, configSpec(api({ requestParameters: [{ ...API.requestParameters[0], type: 'string' }] })), overwriteCopy('duplicateRule', 'email'));
  assert.equal(out.halt && out.halt.code, 'configuration-edit-unsupported', out.halt && out.halt.message);
  assert.ok(out.halt.message.includes(` Also stopped: duplicateRule email (create-completion-required) (${hint}).`), out.halt.message);
});

test('a rule key and name are quoted losslessly in the guidance, however long or unusual', async () => {
  const key = `k"\\\u007f${'x'.repeat(400)}`;
  const name = 'Same "email"\t\u2028';
  const h = await refusingPublish();
  const spec = configSpec({ environmentVariables: [], customApis: [], duplicateDetectionRules: [{ ...RULE, key, name }] });
  const out = await pass(h, spec);
  const ruleId = h.store.readGroup('duplicateRule', key).pending.root.id;
  assert.equal(out.halt && out.halt.message, `${stepStop('create-completion-required', key)} (${hintOf('"Same \\"email\\"\\t\\u2028"', `"k\\"\\\\\\u007f${'x'.repeat(400)}"`, ruleId)})`);
});

test('the halt formatter is unchanged without guidance, and guidance that fails or is not text adds nothing', () => {
  const items = [{ kind: 'duplicateRule', key: 'email', code: 'create-completion-required' }, { kind: 'customApi', key: 'contoso_Calc', code: 'create-refused', serviceCode: '0x80040216' }];
  const today = configurationHaltMessage(items);
  for (const extra of [undefined, null, () => '', () => null, () => 42, () => { throw new Error('no'); }]) assert.equal(configurationHaltMessage(items, extra), today);
  assert.equal(configurationHaltMessage(items, (p) => (p.kind === 'duplicateRule' ? 'advice' : null)),
    today.replace('duplicateRule email (create-completion-required)', 'duplicateRule email (create-completion-required) (advice)'));
});

test('the guidance is given only for the hookup\'s own port, unchanged and in place: a replaced or wrapped port, another hookup or a raw helper keeps today\'s text', async () => {
  const h = await refusingPublish();
  await pass(h, configSpec());
  const ruleId = h.store.readGroup('duplicateRule', 'email').pending.root.id;
  const hint = hintOf('"Same email"', '"email"', ruleId);
  const today = stepStop('create-completion-required');
  // The step of a later build meets the pending create in resolve; a build runs it, so a step alone is enough here.
  const step = async (hookup, before) => {
    const runtime = createConfigurationRuntime({ spec: configSpec(), sdk: h.sdk, opts: { protectedConfiguration: hookup }, appUniqueName: 'contoso_configured' });
    if (before) before(runtime);
    const mark = h.org.requests.length;
    const out = await runtime.apply('data-model');
    assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), [], 'nothing is sent');
    assert.deepEqual(out.outcome.unknown.map((f) => [f.code, f.id]), [['create-completion-required', ruleId]]);
    return out.halt.message;
  };
  const own = reopen(h).protectedConfiguration;
  assert.equal(await step(own), `${today} (${hint})`, 'the hookup\'s own port');
  // ctx.creates replaced, by a copy or by a wrapper that throws its own error after the port's stop.
  assert.equal(await step(own, (rt) => { rt.ctx.creates = { ...rt.ctx.creates }; }), today);
  assert.equal(await step(own, (rt) => {
    const port = rt.ctx.creates;
    rt.ctx.creates = { ...port, resolve: async (q) => { try { return await port.resolve(q); } catch (e) { throw Object.assign(new Error('forged'), { code: e.code, kind: e.kind, key: e.key, id: ruleId }); } } };
  }), today);
  // The hookup's port with a method replaced in place.
  const inPlace = { ...own, port: (args) => { const port = own.port(args); const { resolve } = port; port.resolve = (q) => resolve(q); return port; } };
  assert.equal(await step(inPlace), today);
  // Another hookup's reader over the same store, and a reader answering for a port no hookup issued.
  assert.equal(await step({ ...own, publicationHint: reopen(h).protectedConfiguration.publicationHint }), today);
  assert.equal(await step({ ...own, port: (args) => P.protectedConfigurationPort({ ...args, store: h.store, ctx: own.ctx }) }), today);
  // A raw preflight's answer is no source either, even with the stop's own id.
  const args = { spec: configSpec(), dataverse: h.sdk.dataverse, solution: SOL, ctx: own.ctx, store: h.store };
  const raw = await P.preflightProtectedConfiguration(args);
  assert.equal(raw.halts.length, 1);
  assert.equal(own.publicationHint({ spec: args.spec, source: raw, kind: 'duplicateRule', key: 'email', code: raw.halts[0].code, guardId: raw.halts[0].id }), null);
});

test('a stand-in that puts the protected port or its resolver back before calling it, then throws its own stop, keeps today\'s text', async () => {
  // As refusingPublish, plus `tap`: run once at the next request the service sees, so during a step that has started.
  let tap = null;
  const h = await harness({
    intercept: ({ method, path }) => {
      if (tap) { const once = tap; tap = null; once(); }
      return method === 'POST' && /PublishDuplicateRule$/.test(path) ? refusedPublish : undefined;
    },
  });
  await pass(h, configSpec());
  const ruleId = h.store.readGroup('duplicateRule', 'email').pending.root.id;
  const hint = hintOf('"Same email"', '"email"', ruleId);
  const today = stepStop('create-completion-required');
  const canary = 'canary-0f3b9a-private-text';
  let forgedCount = 0;
  const forged = () => { forgedCount += 1; return Object.assign(new Error(canary), { code: 'create-completion-required', id: ruleId, key: 'another-key' }); };
  // `before` changes the runtime before the step; `during` changes it at the step's first request, after it has started.
  const step = async (before, { during } = {}) => {
    const runtime = createConfigurationRuntime({ spec: configSpec(), sdk: h.sdk, opts: { protectedConfiguration: reopen(h).protectedConfiguration }, appUniqueName: 'contoso_configured' });
    if (before) before(runtime);
    const mark = h.org.requests.length;
    if (during) tap = () => during(runtime);
    const out = await runtime.apply('data-model');
    assert.equal(tap, null, 'a change meant for the step was made during it');
    assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), [], 'nothing is sent');
    assert.ok(!JSON.stringify(out).includes(canary), 'the stand-in\'s text never reaches the result');
    assert.equal(out.halt && out.halt.code, 'configuration-incomplete');
    return out.halt.message;
  };
  // The resolver replaced in place by one that restores the original, calls it, and replaces its genuine stop.
  const selfRestoringResolver = (rt) => {
    const port = rt.ctx.creates;
    const original = port.resolve;
    port.resolve = async (q) => {
      if (q.kind !== 'duplicateRule') return original(q);
      port.resolve = original;
      try { await original(q); } catch { /* the genuine stop, replaced below */ }
      throw forged();
    };
  };
  // The same with the whole port: a stand-in that puts the protected port back in ctx.creates before calling it.
  const selfRestoringPort = (rt) => {
    const port = rt.ctx.creates;
    rt.ctx.creates = {
      ...port,
      resolve: async (q) => {
        if (q.kind !== 'duplicateRule') return port.resolve(q);
        rt.ctx.creates = port;
        try { await port.resolve(q); } catch { /* the genuine stop, replaced below */ }
        throw forged();
      },
    };
  };
  for (const change of [selfRestoringResolver, selfRestoringPort]) {
    const before = forgedCount;
    assert.equal(await step(change), today, `${change.name} before the step`);
    assert.equal(await step(null, { during: change }), today, `${change.name} during the step`);
    assert.equal(forgedCount, before + 2, `${change.name} threw its own stop each time`);
  }
  // The port's own path still explains its stop: untouched, and with its own port and resolver written back unchanged.
  assert.equal(await step(), `${today} (${hint})`);
  assert.equal(await step((rt) => {
    const port = rt.ctx.creates;
    rt.ctx.creates = port;
    port.resolve = port.resolve; // eslint-disable-line no-self-assign
  }), `${today} (${hint})`);
});

test('the guidance reader answers only for the stop it observed and the store record that proves it, and reads nothing from the service', async () => {
  const h = await refusingPublish();
  await pass(h, configSpec());
  const ruleId = h.store.readGroup('duplicateRule', 'email').pending.root.id;
  const hint = hintOf('"Same email"', '"email"', ruleId);
  // The reader sees the store through this proxy, so one record can be changed under it without touching the store.
  let tamper = null;
  const store = new Proxy(h.store, {
    get(target, prop) {
      if (prop === 'readGroup' && tamper) return (kind, key) => { const g = structuredClone(target.readGroup(kind, key)); tamper(g); return g; };
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const ctx = createManagedCreateContext({ store: h.store, notFoundCode: B.NOT_FOUND_CODE });
  const hookup = P.createProtectedConfiguration({ store, gate: h.gate, ctx, apiBase: `${h.org.origin}/api/data/v9.0` });
  const spec = configSpec();
  const result = await hookup.preflight({ spec, dataverse: h.sdk.dataverse, solution: SOL });
  const halt = result.halts.find((x) => x.kind === 'duplicateRule');
  assert.deepEqual([halt.code, halt.id], ['create-completion-required', ruleId], 'the qualified stop carries the original id');
  const ask = (over = {}) => hookup.publicationHint({ spec, source: result, kind: 'duplicateRule', key: 'email', code: halt.code, guardId: halt.id, ...over });
  const mark = h.org.requests.length;
  assert.equal(ask(), hint);
  for (const [label, over] of [
    ['no id', { guardId: undefined }], ['an id not normalized', { guardId: ruleId.toUpperCase() }], ['another id', { guardId: '00000000-0000-0000-0000-000000000001' }],
    ['another key', { key: 'other' }], ['another code', { code: 'create-ownership-required' }], ['another kind', { kind: 'customApi' }],
    ['another spec', { spec: configSpec() }], ['another source', { source: { halts: result.halts } }],
  ]) assert.equal(ask(over), null, label);
  const rs = (g) => g.pending.rowProtocol.effects.find((e) => e.kind === 'rule-state');
  for (const [label, change] of [
    ['a publication not dispatched', (g) => { rs(g).dispatched = false; }],
    ['no publication effect', (g) => { g.pending.rowProtocol.effects = g.pending.rowProtocol.effects.filter((e) => e.kind !== 'rule-state'); }],
    ['a committed group', (g) => { g.committed = { records: [] }; }],
    ['another attempt', (g) => { g.pending.token = '00000000-0000-4000-8000-000000000000'; }],
    ['another declaration', (g) => { g.pending.declarationSha256 = '0'.repeat(64); }],
    ['an edit', (g) => { g.pending.expected.baseObservation = {}; }],
    ['another root', (g) => { g.pending.root.id = '00000000-0000-0000-0000-000000000001'; }],
    ['no initial publication owed', (g) => { g.pending.rowProtocol.completion.ruleState = 'unpublished'; }],
  ]) {
    tamper = change;
    assert.equal(ask(), null, label);
    tamper = null;
  }
  // The declaration changed in place since the stop was observed.
  spec.duplicateDetectionRules[0].conditions[0].column = 'lastname';
  assert.equal(ask(), null, 'a changed declaration');
  spec.duplicateDetectionRules[0].conditions[0].column = 'emailaddress1';
  assert.equal(ask(), hint);
  assert.equal(h.org.requests.length, mark, 'the reader sends and reads nothing');
});

test('a pending rule whose row is gone, or whose conditions changed, keeps today\'s stop with no guidance', async () => {
  const h = await refusingPublish();
  await pass(h, configSpec());
  const ruleId = h.store.readGroup('duplicateRule', 'email').pending.root.id;
  const conditions = h.org.sets.get('duplicateruleconditions');
  const condition = [...conditions.values()].find((c) => String(c._regardingobjectid_value || '').toLowerCase() === ruleId);
  assert.ok(condition && condition.baseattributename === 'emailaddress1', 'the rule\'s condition row');
  condition.baseattributename = 'lastname';
  const changed = await pass(reopen(h), configSpec(), overwriteCopy('duplicateRule', 'email'));
  assert.ok(changed.halt, 'it stops');
  assert.ok(!changed.halt.message.includes('The first publication'), changed.halt.message);
  condition.baseattributename = 'emailaddress1';
  h.org.sets.get('duplicaterules').delete(ruleId);
  const gone = await pass(reopen(h), configSpec(), overwriteCopy('duplicateRule', 'email'));
  assert.equal(gone.halt && gone.halt.code, 'create-completion-required', gone.halt && gone.halt.message);
  assert.equal(gone.halt.message, completionStop(h), 'today\'s text');
  assert.deepEqual([...changed.sent, ...gone.sent], []);
});

test('removing the opt-in does not move protected items back to name lookup: the build stops before any request', async () => {
  const { configurationIdentity, ...plain } = configSpec();
  assert.equal(configurationIdentity, 'stable-v1');
  // Committed bindings.
  const h = await harness();
  await created(h);
  const mark = h.org.requests.length;
  const out = await pass(h, plain);
  assert.equal(out.halt && out.halt.code, 'create-identity-opt-in-required', out.halt && out.halt.message);
  assert.equal(out.halt.phase, 'preflight');
  assert.equal(out.halt.retry, RETRY.NEVER);
  assert.match(out.halt.message, /configurationIdentity "stable-v1"/);
  assert.match(out.halt.message, /No service changes were sent by this build/);
  assert.deepEqual(h.org.requests.slice(mark), [], 'not even a read');
  // A pending attempt is an obligation too.
  const p = await harness({ intercept: ({ method, path }) => (method === 'POST' && /PublishDuplicateRule$/.test(path) ? { statusCode: 400, body: { error: { code: '0x80040216', message: 'publish failed' } } } : undefined) });
  assert.ok((await pass(p, configSpec())).halt);
  assert.ok(p.store.readGroup('duplicateRule', 'email').pending);
  const pmark = p.org.requests.length;
  const pending = await pass(p, plain);
  assert.equal(pending.halt && pending.halt.code, 'create-identity-opt-in-required', pending.halt && pending.halt.message);
  assert.deepEqual(p.org.requests.slice(pmark), []);
  // An item the store holds nothing for is not held back: a spec that declares only another item builds as before.
  const other = await pass(h, { ...plain, environmentVariables: [{ schemaName: 'contoso_Other', type: 'string', defaultValue: 'x' }], customApis: [], duplicateDetectionRules: [] });
  assert.equal(other.halt, null, other.halt && `${other.halt.code}: ${other.halt.message}`);
});

// ---------------------------------------------------------------------------------------------
// Verify under the opt-in, as verify-model-app.js reads it: the workspace's binding store, read-only (managedManifestView, as
// readVerifyManifest answers it), names the one row each protected item is checked at.

const viewOf = (h) => managedManifestView(h.store.snapshot());
const definitions = (checks) => Object.fromEntries(checks.filter((c) => c.name === 'definition').map((c) => [`${c.kind} ${c.key}`, c.ok ? 'ok' : c.code]));
const writesSince = (h, mark) => h.org.requests.slice(mark).filter((r) => r.method !== 'GET');

test('verify under the opt-in reads every protected item at the id its binding holds, and a namesake never stands in for a deleted one', async () => {
  const h = await harness();
  await created(h);
  const read = readerFor(h.sdk, 'contoso_configured');
  let mark = h.org.requests.length;
  assert.deepEqual(definitions(await read.configuration(configSpec(), undefined, viewOf(h))),
    { 'environmentVariable contoso_ApiBase': 'ok', 'customApi contoso_Calc': 'ok', 'duplicateRule email': 'ok' });
  assert.deepEqual(writesSince(h, mark), [], 'verify sends nothing');
  // The bound variable is deleted outside the plugin, and an identical one made at another id.
  const id = committed(h, 'environmentVariable', 'contoso_apibase').records.find((r) => r.kind === 'environmentVariable').id;
  const res = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/environmentvariabledefinitions(${id})`, method: 'DELETE', headers: {} });
  assert.ok(res.statusCode < 300);
  await insertRow(h.org, 'environmentvariabledefinitions', VARIABLE_ROW);
  mark = h.org.requests.length;
  const { configurationIdentity, ...plain } = configSpec();
  assert.equal(configurationIdentity, 'stable-v1');
  assert.equal(definitions(await read.configuration(plain))['environmentVariable contoso_ApiBase'], 'ok', 'name lookup takes the namesake');
  const checks = await read.configuration(configSpec(), undefined, viewOf(h));
  assert.deepEqual(definitions(checks), { 'environmentVariable contoso_ApiBase': B.NOT_FOUND_CODE, 'customApi contoso_Calc': 'ok', 'duplicateRule email': 'ok' });
  assert.deepEqual(writesSince(h, mark), [], 'verify sends nothing');
});

test('verify under the opt-in never falls back to a name: no binding store, no binding or an unusable one fails, a pending one is named', async () => {
  const h = await harness();
  await created(h);
  const read = readerFor(h.sdk, 'contoso_configured');
  const all = (code) => ({ 'environmentVariable contoso_ApiBase': code, 'customApi contoso_Calc': code, 'duplicateRule email': code });
  assert.deepEqual(definitions(await read.configuration(configSpec(), undefined, undefined)), all('create-identity-unverified'), 'no binding store was read');
  assert.deepEqual(definitions(await read.configuration(configSpec(), undefined, managedManifestView(null))), all('create-identity-unverified'), 'no binding is held');
  const unusable = managedManifestView(null);
  unusable.invalid.push({ family: 'store', key: 'managed-bindings', reason: 'unreadable', code: 'managed-binding-store-unreadable' });
  assert.deepEqual(definitions(await read.configuration(configSpec(), undefined, unusable)), all('create-identity-unverified'), 'an unusable store proves nothing');
  const pending = viewOf(h);
  pending.groups = pending.groups.filter((g) => g.family !== 'customApi');
  pending.pending.push({ family: 'customApi', key: 'contoso_calc', code: 'managed-settlement-pending' });
  assert.equal(definitions(await read.configuration(configSpec(), undefined, pending))['customApi contoso_Calc'], 'managed-settlement-pending');
});

// ---------------------------------------------------------------------------------------------
// Verify pairs a protected rule's conditions at the ids its binding holds, as the build's plan does: criteria swapped between two
// bound condition rows is a change the build refuses (configuration-edit-unsupported), so verify must fail it too.

const TWO_CONDITIONS = [{ key: 'e', column: 'emailaddress1', match: 'exact' }, { key: 'l', column: 'lastname', match: 'exact' }];
const twoRules = () => configSpec(rule({ conditions: TWO_CONDITIONS }));
const conditionRow = (h, column) => h.org.rows('duplicateruleconditions').find((r) => r.baseattributename === column);
const patchRow = async (h, set, id, body) => {
  const res = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/${set}(${id})`, method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(res.statusCode < 300, `${set}: ${res.statusCode}`);
};
const verifyRule = (h, spec = twoRules(), view = viewOf(h)) => readerFor(h.sdk, 'contoso_configured').configuration(spec, undefined, view);
const ruleCheck = (checks) => checks.find((c) => c.kind === 'duplicateRule' && c.name === 'definition');
const setCriteria = (h, row, column) => patchRow(h, 'duplicateruleconditions', row.duplicateruleconditionid, { baseattributename: column, matchingattributename: column });
const assertBuildStops = async (h) => {
  const out = await pass(h, twoRules());
  assert.equal(out.halt && out.halt.code, 'configuration-edit-unsupported', out.halt && out.halt.message);
  assert.equal(out.halt.phase, 'preflight');
  assert.deepEqual(out.sent, [], 'nothing is sent');
};

test('verify fails a protected rule whose bound condition rows swapped their criteria, naming the conditions; the build refuses it too', async () => {
  const h = await harness();
  await created(h, twoRules());
  const e = conditionRow(h, 'emailaddress1');
  const l = conditionRow(h, 'lastname');
  await setCriteria(h, e, 'lastname');
  await setCriteria(h, l, 'emailaddress1');
  const mark = h.org.requests.length;
  const check = ruleCheck(await verifyRule(h));
  assert.equal(check.ok, false, 'the same rule the build refuses must not verify');
  assert.equal(check.code, 'DRIFT');
  assert.deepEqual(check.fields, ['/conditions', '/conditions/e', '/conditions/l']);
  assert.deepEqual(writesSince(h, mark), [], 'verify sends nothing');
  await assertBuildStops(h);
});

// The complete verify output for the swapped state without the opt-in, as the unchanged code produces it for this org: every kind's checks.
const PLAIN_SWAPPED_OUTPUT = [
  { kind: 'environmentVariable', key: 'contoso_ApiBase', name: 'definition', ok: true },
  { kind: 'customApi', key: 'contoso_Calc', name: 'definition', ok: true },
  { kind: 'customApi', key: 'contoso_Calc', name: 'implementation', ok: false, code: 'CUSTOM_API_IMPLEMENTATION_UNPROVEN' },
  { kind: 'duplicateRule', key: 'email', name: 'definition', ok: true },
  { kind: 'duplicateRule', key: 'email', name: 'publication', ok: true },
];
test('verify still passes an unchanged protected rule, and name lookup (no opt-in) passes a real swap exactly as before', async () => {
  const h = await harness();
  await created(h, twoRules());
  assert.deepEqual(ruleCheck(await verifyRule(h)), { kind: 'duplicateRule', key: 'email', name: 'definition', ok: true });
  // Both rows are taken before either is changed: the second lookup would otherwise find the first row again.
  const e = conditionRow(h, 'emailaddress1');
  const l = conditionRow(h, 'lastname');
  await setCriteria(h, e, 'lastname');
  await setCriteria(h, l, 'emailaddress1');
  assert.deepEqual([e, l].map((r) => r.baseattributename), ['lastname', 'emailaddress1'], 'the rows really are swapped');
  const { configurationIdentity, ...plain } = twoRules();
  assert.equal(configurationIdentity, 'stable-v1');
  assert.deepEqual(await verifyRule(h, plain), PLAIN_SWAPPED_OUTPUT, 'name lookup judges by content: the complete output is what it was before');
});

test('a protected rule whose bound condition was deleted and made again still fails verify as not found, and a real criteria change is still drift', async () => {
  const h = await harness();
  await created(h, twoRules());
  const e = conditionRow(h, 'emailaddress1');
  const ruleId = e._regardingobjectid_value;
  const gone = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/duplicateruleconditions(${e.duplicateruleconditionid})`, method: 'DELETE', headers: {} });
  assert.ok(gone.statusCode < 300);
  await insertRow(h.org, 'duplicateruleconditions', { baseattributename: 'emailaddress1', matchingattributename: 'emailaddress1', operatorcode: e.operatorcode, 'regardingobjectid@odata.bind': `/duplicaterules(${ruleId})` });
  const remade = ruleCheck(await verifyRule(h));
  assert.equal(remade.code, B.NOT_FOUND_CODE, 'a bound row is never replaced by a namesake');
  assert.equal(remade.fields, undefined);
  const h2 = await harness();
  await created(h2, twoRules());
  await setCriteria(h2, conditionRow(h2, 'lastname'), 'firstname');
  const changed = ruleCheck(await verifyRule(h2));
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'DRIFT');
  assert.ok(changed.fields.includes('/conditions') && changed.fields.includes('/conditions/l') && !changed.fields.includes('/conditions/e'), changed.fields.join(','));
  await assertBuildStops(h2);
});

// Verify and the build's preflight judge a bound protected rule by one function (judgeBoundShape + editVerdict), so for every state
// of the rule they must agree: verify passes exactly when the preflight halts nothing for it. Each state runs verify, then the
// preflight, on the same fake org and binding store.
const addRow = (h, column, over = {}) => {
  const sample = conditionRow(h, 'emailaddress1');
  return insertRow(h.org, 'duplicateruleconditions', {
    baseattributename: column, matchingattributename: column, operatorcode: sample.operatorcode, ignoreblankvalues: false,
    'regardingobjectid@odata.bind': `/duplicaterules(${sample._regardingobjectid_value})`, ...over,
  });
};
const SWAP = async (h) => { const e = conditionRow(h, 'emailaddress1'); const l = conditionRow(h, 'lastname'); await setCriteria(h, e, 'lastname'); await setCriteria(h, l, 'emailaddress1'); };
const withConditions = (conditions) => configSpec(rule({ conditions }));
const E = TWO_CONDITIONS[0];
const L = TWO_CONDITIONS[1];
const STATES = [
  { name: 'unchanged', pass: true },
  { name: 'reordered in the declaration', spec: () => withConditions([L, E]), pass: true },
  { name: 'a single condition', base: configSpec(), spec: () => configSpec(), pass: true },
  { name: 'swapped criteria', change: SWAP, pass: false, fields: ['/conditions', '/conditions/e', '/conditions/l'] },
  { name: 'a changed criterion', change: (h) => setCriteria(h, conditionRow(h, 'lastname'), 'firstname'), pass: false, fields: ['/conditions', '/conditions/l'] },
  { name: 'a renamed key', spec: () => withConditions([{ ...E, key: 'e2' }, L]), pass: false, fields: ['/conditions', '/conditions/e2'] },
  { name: 'a declared condition added', spec: () => withConditions([...TWO_CONDITIONS, { key: 'f', column: 'firstname', match: 'exact' }]), pass: false, fields: ['/conditions', '/conditions/f'] },
  { name: 'a declared condition removed', spec: () => withConditions([E]), pass: false, fields: ['/conditions'] },
  { name: 'an extra server row', change: (h) => addRow(h, 'firstname'), pass: false, fields: ['/conditions'] },
  { name: 'a hand-added duplicate of a bound condition declared under a new key', change: (h) => addRow(h, 'emailaddress1'), spec: () => withConditions([...TWO_CONDITIONS, { key: 'x', column: 'emailaddress1', match: 'exact' }]), pass: false, fields: ['/conditions', '/conditions/x'] },
  { name: 'conditions omitted over bound ones', spec: () => configSpec(rule({ conditions: undefined })), pass: false, fields: ['/conditions'] },
  { name: 'a rule field changed by hand', change: (h) => patchRow(h, 'duplicaterules', h.org.rows('duplicaterules')[0].duplicateruleid, { name: 'Renamed by hand' }), pass: false, fields: ['/name'] },
  { name: 'a changed name and swapped criteria', change: SWAP, spec: () => configSpec(rule({ name: 'Other name', conditions: TWO_CONDITIONS })), pass: false, fields: ['/name', '/conditions', '/conditions/e', '/conditions/l'] },
  { name: 'a changed name and a declared condition added', spec: () => configSpec(rule({ name: 'Other name', conditions: [...TWO_CONDITIONS, { key: 'f', column: 'firstname', match: 'exact' }] })), pass: false, fields: ['/name', '/conditions', '/conditions/f'] },
  { name: 'a changed name and a declared condition removed', spec: () => configSpec(rule({ name: 'Other name', conditions: [E] })), pass: false, fields: ['/name', '/conditions'] },
  { name: 'a hand-added row declared under two new keys (the comparison cannot pair them)', base: configSpec(), change: (h) => addRow(h, 'lastname'), spec: () => withConditions([E, { key: 'l', column: 'lastname', match: 'exact' }, { key: 'l2', column: 'lastname', match: 'exact' }]), pass: false, fields: ['/conditions', '/conditions/l', '/conditions/l2'] },
  { name: 'another matching table', spec: () => configSpec(rule({ matchingEntity: 'account', conditions: TWO_CONDITIONS })), pass: false, fields: ['/matchingEntity'] },
  { name: 'swapped criteria and a status change', change: SWAP, spec: () => configSpec(rule({ status: 'unpublished', conditions: TWO_CONDITIONS })), pass: false, fields: ['/conditions', '/conditions/e', '/conditions/l', '/status'] },
  { name: 'a bound row deleted', change: async (h) => { const row = conditionRow(h, 'lastname'); const res = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/duplicateruleconditions(${row.duplicateruleconditionid})`, method: 'DELETE', headers: {} }); assert.ok(res.statusCode < 300); }, pass: false, code: B.NOT_FOUND_CODE },
  { name: 'an unpublished bound rule without conditions', base: configSpec(rule({ status: 'unpublished', conditions: [] })), spec: () => configSpec(rule({ status: 'unpublished', conditions: [] })), pass: true },
];

async function agreeOn(state) {
  const h = await harness();
  await created(h, state.base || twoRules());
  if (state.change) await state.change(h);
  const spec = state.spec ? state.spec() : state.base || twoRules();
  const mark = h.org.requests.length;
  const check = ruleCheck(await verifyRule(h, spec));
  assert.deepEqual(writesSince(h, mark), [], `${state.name}: verify sends nothing`);
  const out = await pass(h, spec);
  const halted = out.halt !== null;
  assert.equal(check.ok === true, !halted, `${state.name}: verify ${check.ok ? 'passes' : `fails ${check.code}`}, the preflight ${halted ? `halts ${out.halt.code}` : 'does not halt'}`);
  assert.equal(check.ok === true, state.pass, state.name);
  if (state.fields) { assert.equal(check.code, 'DRIFT', `${state.name}: ${check.code}`); assert.deepEqual(check.fields, state.fields, state.name); }
  if (state.code) { assert.equal(check.code, state.code, state.name); assert.equal(out.halt.code, state.code, state.name); }
  if (halted) assert.deepEqual(out.sent, [], `${state.name}: a halted build sent nothing`);
}

test('verify and the build preflight agree on every state of a bound protected rule, and verify never writes', async () => {
  // Every state runs, so one failure does not hide the next.
  const failures = [];
  for (const state of STATES) {
    try { await agreeOn(state); } catch (error) { failures.push(String(error.message).split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 300)); }
  }
  assert.deepEqual(failures, [], 'every state agrees');
});

// ---------------------------------------------------------------------------------------------
// A row a maker made BEFORE the opt-in (here by a build without it, so at an id the service picked) is a namesake to the
// first protected create. It is adopted at its own id only under the exact `@<row id>` approvals the stop prints, and
// read-only: nothing is sent to adopt it, and it is never bound while anything about it differs from what the stop said.

const PK = { environmentvariabledefinitions: 'environmentvariabledefinitionid', customapis: 'customapiid', duplicaterules: 'duplicateruleid', customapirequestparameters: 'customapirequestparameterid' };
const apiOnly = (over) => configSpec({ environmentVariables: [], duplicateDetectionRules: [], ...(over ? api(over) : {}) });
const ADOPT_KINDS = [
  { kind: 'environmentVariable', key: 'contoso_apibase', set: 'environmentvariabledefinitions', spec: () => variableOnly(), children: 0 },
  { kind: 'customApi', key: 'contoso_calc', set: 'customapis', spec: () => apiOnly(), children: 2 },
];
const withoutOptIn = (spec) => { const { configurationIdentity, ...plain } = spec; return plain; };
// The maker's rows, made by a build without the opt-in: the plain path creates them by name.
async function madeBeforeOptIn(h, spec, opts = {}) {
  const out = await pass(h, withoutOptIn(spec), opts);
  assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
  return out;
}
const idIn = (h, set) => h.org.rows(set)[0][PK[set]];
// The approvals a stop printed, of every item it names: configuration-build.js quotes each one.
function printedApprovals(halt) {
  const all = [...(halt ? halt.message : '').matchAll(/given after checking those rows are yours: ((?:"(?:[^"\\]|\\.)*"(?:, )?)+)\./g)];
  return all.flatMap((m) => JSON.parse(`[${m[1]}]`));
}
// The stop a namesake gets today, before anything this change adds to it.
const namesakeStop = (kind, key, ids) => `${kind} ${key}: the ${kind} "${key}" has a namesake at another id (${ids}); a protected create never binds a namesake, and no service changes were sent by this build`;
function assertNothingHeld(h, kind, key, label) {
  const group = h.store.readGroup(kind, key);
  assert.equal(group.committed, null, `${label}: nothing is bound`);
  assert.equal(group.pending, null, `${label}: no attempt is left`);
}
const settingsOf = (spec, Value) => readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value }] }, spec);
async function removeMembership(h, objectId) {
  const member = h.org.rows('solutioncomponents').find((c) => c.objectid === objectId);
  const res = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/solutioncomponents(${member.solutioncomponentid})`, method: 'DELETE', headers: {} });
  assert.ok(res.statusCode < 300, `DELETE solutioncomponents: ${res.statusCode}`);
}
async function joinSolution(h, id, componentType) {
  const res = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/AddSolutionComponent`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ SolutionUniqueName: SOL, ComponentId: id, ComponentType: componentType, AddRequiredComponents: false }) });
  assert.ok(res.statusCode < 300, `AddSolutionComponent: ${res.statusCode}`);
}

test('a protected row made before the opt-in is adopted at its own id only under the exact approvals its stop prints, and nothing is sent', async () => {
  for (const { kind, key, set, spec, children } of ADOPT_KINDS) {
    const h = await harness();
    await madeBeforeOptIn(h, spec());
    const id = idIn(h, set);
    const stop = await pass(reopen(h), spec());
    assert.equal(stop.halt && stop.halt.code, 'create-identity-conflict', stop.halt && stop.halt.message);
    assert.equal(stop.halt.phase, 'preflight');
    assert.ok(stop.halt.message.startsWith(`${namesakeStop(kind, key, id)}. It can instead be adopted at its id ${id}, after checking that row is yours; the build would then change nothing in it.`), stop.halt.message);
    assert.deepEqual(stop.sent, [], kind);
    const tokens = printedApprovals(stop.halt);
    assert.equal(tokens[0], `adopt:${kind}:${key}@${id}`, kind);
    assert.equal(tokens.length, 1 + children, tokens.join(' '));
    for (const t of tokens.slice(1)) assert.match(t, /^adopt:[A-Za-z]+:[^@/]+\/[^@/]+@[0-9a-f-]{36}$/);
    // Nothing short of every exact approval adopts: not the root's alone, not the children's, not the plain token
    // (which still means the row at the derived id only).
    for (const partial of [tokens.slice(0, 1), tokens.slice(1), [`adopt:${kind}:${key}`]]) {
      if (!partial.length || (partial.length === tokens.length)) continue;
      const out = await pass(reopen(h, partial), spec());
      assert.equal(out.halt && out.halt.code, 'create-identity-conflict', `${kind} ${partial}`);
      assert.deepEqual(out.sent, [], `${kind} ${partial}`);
      assertNothingHeld(h, kind, key, `${kind} ${partial}`);
    }
    const done = await pass(reopen(h, tokens), spec());
    assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
    assert.deepEqual(done.sent, [], `${kind}: adopting sends nothing`);
    const group = committed(h, kind, key);
    assert.equal(group.records.length, 1 + children, kind);
    assert.ok(group.records.every((r) => r.origin === 'adopted'), kind);
    assert.equal(group.records.find((r) => r.kind === kind).id, id, kind);
    assert.equal(h.store.readGroup(kind, key).pending, null);
    assert.equal(h.org.rows(set).length, 1, `${kind}: nothing is made beside it`);
    const rerun = await pass(reopen(h), spec());
    assert.equal(rerun.halt, null, rerun.halt && `${rerun.halt.code}: ${rerun.halt.message}`);
    assert.deepEqual(rerun.sent, [], `${kind}: the next build sends nothing`);
  }
});

test('a namesake the build would then change prints the fields it would send, and its root approval lapses when they change', async () => {
  const h = await harness();
  await madeBeforeOptIn(h, apiOnly());
  const id = idIn(h, 'customapis');
  // Another protected item, created at its derived id: the adoption leaves its binding byte for byte.
  await created(h, variableOnly());
  const other = JSON.stringify(h.store.readGroup('environmentVariable', 'contoso_apibase'));
  const spec = configSpec({ duplicateDetectionRules: [], ...api({ description: 'Adds two numbers' }) });
  const stop = await pass(reopen(h), spec);
  assert.equal(stop.halt && stop.halt.code, 'create-identity-conflict', stop.halt && stop.halt.message);
  assert.ok(stop.halt.message.includes(`It can instead be adopted at its id ${id}, after checking that row is yours; the build would then change only these fields, /description.`), stop.halt.message);
  assert.deepEqual(stop.sent, []);
  const tokens = printedApprovals(stop.halt);
  const [root] = tokens;
  assert.match(root, new RegExp(`^adopt:customApi:contoso_calc@${id}\\+[0-9a-f]{16}$`));
  // The root approval without the digest of that list, or with another one, adopts nothing.
  for (const wrong of [root.replace(/\+.*$/, ''), root.replace(/\+.*$/, '+0123456789abcdef')]) {
    const out = await pass(reopen(h, [wrong, ...tokens.slice(1)]), spec);
    assert.equal(out.halt && out.halt.code, 'create-identity-conflict', wrong);
    assert.deepEqual(out.sent, [], wrong);
    assertNothingHeld(h, 'customApi', 'contoso_calc', wrong);
  }
  // The App Spec changed again after the stop: the build would now send another list, so the approvals given lapse.
  const more = configSpec({ duplicateDetectionRules: [], ...api({ description: 'Adds two numbers', displayName: 'Calculator' }) });
  const lapsed = await pass(reopen(h, tokens), more);
  assert.equal(lapsed.halt && lapsed.halt.code, 'create-identity-conflict', lapsed.halt && lapsed.halt.message);
  assert.ok(lapsed.halt.message.includes('only these fields, /description, /displayName.'), lapsed.halt.message);
  assert.notEqual(printedApprovals(lapsed.halt)[0], root);
  assert.deepEqual(lapsed.sent, []);
  assertNothingHeld(h, 'customApi', 'contoso_calc', 'lapsed');
  // Under the exact approvals: adopted read-only, then the printed edit is sent once through the bound path.
  const done = await pass(reopen(h, tokens), spec);
  assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
  assert.deepEqual(done.sent.map((r) => `${r.method} ${r.path.split('?')[0]}`), [`PATCH /customapis(${id})`]);
  assert.equal(h.org.rows('customapis')[0].description, 'Adds two numbers');
  assert.equal(JSON.stringify(h.store.readGroup('environmentVariable', 'contoso_apibase')), other, 'another item\'s binding is unchanged');
  const rerun = await pass(reopen(h), spec);
  assert.equal(rerun.halt, null);
  assert.deepEqual(rerun.sent, []);
});

test('a namesake that cannot be adopted says why after today\'s stop, and is never bound, approvals given or not', async () => {
  const CASES = [
    { name: 'outside the solution', kind: 'environmentVariable', key: 'contoso_apibase', set: 'environmentvariabledefinitions', spec: variableOnly(),
      make: async (h) => { await madeBeforeOptIn(h, variableOnly()); await removeMembership(h, idIn(h, 'environmentvariabledefinitions')); },
      reason: /is not in the solution ContosoSol; add it there first\.$/ },
    { name: 'a child the App Spec does not declare', kind: 'customApi', key: 'contoso_calc', set: 'customapis', spec: apiOnly(),
      make: (h) => madeBeforeOptIn(h, apiOnly({ requestParameters: [...API.requestParameters, { uniqueName: 'B', type: 'integer' }] })), reason: /removals are not supported\.$/ },
    { name: 'a name in another case', kind: 'environmentVariable', key: 'contoso_apibase', set: 'environmentvariabledefinitions',
      spec: configSpec({ customApis: [], duplicateDetectionRules: [], environmentVariables: [{ schemaName: 'contoso_APIBase', type: 'string', defaultValue: 'https://api.contoso.com' }] }),
      make: (h) => madeBeforeOptIn(h, variableOnly()), reason: /its schemaName differs from the App Spec's/ },
    { name: 'a value that differs', kind: 'environmentVariable', key: 'contoso_apibase', set: 'environmentvariabledefinitions', spec: variableOnly(),
      opts: { configurationBindings: settingsOf(variableOnly(), 'https://two.contoso.com') },
      make: (h) => madeBeforeOptIn(h, variableOnly(), { configurationBindings: settingsOf(variableOnly(), 'https://one.contoso.com') }), reason: /never writes a value after adopting\.$/ },
    { name: 'a first value', kind: 'environmentVariable', key: 'contoso_apibase', set: 'environmentvariabledefinitions', spec: variableOnly(),
      opts: { configurationBindings: settingsOf(variableOnly(), 'https://one.contoso.com') },
      make: (h) => madeBeforeOptIn(h, variableOnly()), reason: /would then write a first value to it/ },
  ];
  for (const c of CASES) {
    const h = await harness();
    await c.make(h);
    const id = idIn(h, c.set);
    const before = JSON.stringify(h.org.rows(c.set));
    for (const approvals of [[], [`adopt:${c.kind}:${c.key}@${id}`]]) {
      const out = await pass(reopen(h, approvals), c.spec, c.opts);
      assert.equal(out.halt && out.halt.code, 'create-identity-conflict', `${c.name}: ${out.halt && out.halt.message}`);
      assert.equal(out.halt.phase, 'preflight', c.name);
      const [head, tail] = out.halt.message.split(`. It cannot be adopted at its id ${id}: `);
      assert.equal(head, namesakeStop(c.kind, c.key, id), c.name);
      assert.match(tail || '', c.reason, `${c.name}: ${out.halt.message}`);
      assert.ok(!/exact approvals/.test(out.halt.message), `${c.name}: no approval is printed`);
      assert.deepEqual(out.sent, [], c.name);
      assertNothingHeld(h, c.kind, c.key, c.name);
    }
    assert.equal(JSON.stringify(h.org.rows(c.set)), before, `${c.name}: the row is untouched`);
  }
});

test('several namesakes keep today\'s stop byte for byte, and no namesake keeps today\'s requests', async () => {
  const h = await harness();
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const id = await insertRow(h.org, 'environmentvariabledefinitions', VARIABLE_ROW);
    await joinSolution(h, id, 380);
    ids.push(id);
  }
  const out = await pass(reopen(h, ids.map((id) => `adopt:environmentVariable:contoso_apibase@${id}`)), variableOnly());
  assert.equal(out.halt && out.halt.code, 'create-identity-conflict');
  const listed = /namesake at another id \(([^)]*)\)/.exec(out.halt.message)[1];
  assert.deepEqual(listed.split(', ').sort(), ids.slice().sort());
  assert.equal(out.halt.message, namesakeStop('environmentVariable', 'contoso_apibase', listed));
  assert.deepEqual(out.sent, []);
  assertNothingHeld(h, 'environmentVariable', 'contoso_apibase', 'several');
  // No namesake: the first create is exactly today's, an approval of the derived id included.
  const plain = await harness();
  const first = await pass(reopen(plain, ['adopt:environmentVariable:contoso_apibase']), variableOnly());
  assert.equal(first.halt, null, first.halt && first.halt.message);
  assert.deepEqual(first.sent.map((r) => `${r.method} ${r.path.split('(')[0].split('?')[0]}`), ['POST /environmentvariabledefinitions']);
  assert.equal(committed(plain, 'environmentVariable', 'contoso_apibase').records[0].origin, 'created');
});

test('a namesake that changes after its adoption began is not adopted: nothing is sent or bound, and the attempt is retired', async () => {
  const CASES = [
    // A declared field edited by hand: the build would now change it, a list the approvals were not given for.
    { name: 'a maker edit', kind: 'customApi', key: 'contoso_calc', set: 'customapis', spec: apiOnly({ description: 'Adds two numbers' }), change: (h, id) => patchRow(h, 'customapis', id, { description: 'Changed by hand' }) },
    { name: 'a membership removed', kind: 'customApi', key: 'contoso_calc', set: 'customapis', spec: apiOnly(), change: (h, id) => removeMembership(h, id) },
    { name: 'a variable edited', kind: 'environmentVariable', key: 'contoso_apibase', set: 'environmentvariabledefinitions', spec: variableOnly(), change: (h, id) => patchRow(h, 'environmentvariabledefinitions', id, { defaultvalue: 'https://other.contoso.com' }) },
  ];
  for (const c of CASES) {
    // The change lands in the riskiest window: after the attempt began and the store was captured, before the
    // acceptance — on the first service read the build makes once begin has run.
    let armed = false;
    let id = null;
    const own = new Set();
    const h = await harness({ intercept: async () => {
      if (!armed) return undefined;
      armed = false;
      const from = h.org.requests.length;
      await c.change(h, id);
      for (const r of h.org.requests.slice(from)) own.add(r);
      return undefined;
    } });
    await madeBeforeOptIn(h, c.spec);
    id = idIn(h, c.set);
    const tokens = printedApprovals((await pass(reopen(h), c.spec)).halt);
    const approved = reopen(h, tokens);
    const runtime = createConfigurationRuntime({ spec: c.spec, sdk: approved.sdk, opts: { protectedConfiguration: approved.protectedConfiguration }, appUniqueName: 'contoso_configured' });
    assert.deepEqual(await runtime.preflight(), { halts: [] }, `${c.name}: the preflight forecasts the adoption`);
    const begin = approved.ctx.begin;
    let began = 0;
    approved.ctx.begin = (plans) => { const out = begin(plans); began += 1; armed = true; return out; };
    const mark = h.org.requests.length;
    const step = await runtime.apply('data-model');
    assert.equal(began, 1, `${c.name}: the adoption began`);
    assert.equal(armed, false, `${c.name}: the change landed`);
    assert.deepEqual(step.halt && step.halt.items.map((i) => i.code), ['create-identity-conflict'], `${c.name}: ${JSON.stringify(step.halt && step.halt.items)}`);
    assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET' && !own.has(r)), [], `${c.name}: nothing is sent`);
    assertNothingHeld(h, c.kind, c.key, c.name);
    assert.deepEqual(h.store.snapshot().envelope.attempts, [], `${c.name}: the attempt is retired`);
    // The next build stops on what is there now: the approvals given for the earlier rows adopt nothing.
    const next = await pass(reopen(h, tokens), c.spec);
    assert.equal(next.halt && next.halt.code, 'create-identity-conflict', c.name);
    assert.deepEqual(next.sent, [], c.name);
    assertNothingHeld(h, c.kind, c.key, c.name);
  }
});

test('an approval given for a row that was then replaced, or whose child was, adopts nothing: the stop names the new rows; one for a row since deleted lets the item be created', async () => {
  // The root replaced: deleted and made again by name, at another id.
  const h = await harness();
  await madeBeforeOptIn(h, apiOnly());
  const tokens = printedApprovals((await pass(reopen(h), apiOnly())).halt);
  const old = idIn(h, 'customapis');
  const del = await h.org.request({ url: `${h.org.origin}/api/data/v9.2/customapis(${old})`, method: 'DELETE', headers: {} });
  assert.ok(del.statusCode < 300);
  await madeBeforeOptIn(h, apiOnly());
  const fresh = idIn(h, 'customapis');
  assert.notEqual(fresh, old);
  const out = await pass(reopen(h, tokens), apiOnly());
  assert.equal(out.halt && out.halt.code, 'create-identity-conflict', out.halt && out.halt.message);
  assert.equal(printedApprovals(out.halt)[0], `adopt:customApi:contoso_calc@${fresh}`);
  assert.deepEqual(out.sent, []);
  assertNothingHeld(h, 'customApi', 'contoso_calc', 'root replaced');

  // A child replaced: the same parameter made again under the same API, at another id, and put in the solution.
  const c = await harness();
  await madeBeforeOptIn(c, apiOnly());
  const childTokens = printedApprovals((await pass(reopen(c), apiOnly())).halt);
  const [param] = c.org.rows('customapirequestparameters');
  const member = c.org.rows('solutioncomponents').find((m) => m.objectid === param.customapirequestparameterid);
  const gone = await c.org.request({ url: `${c.org.origin}/api/data/v9.2/customapirequestparameters(${param.customapirequestparameterid})`, method: 'DELETE', headers: {} });
  assert.ok(gone.statusCode < 300);
  const copy = Object.fromEntries(Object.entries(param).filter(([k]) => !['customapirequestparameterid', '_customapiid_value', 'versionnumber'].includes(k) && !k.startsWith('@')));
  const made = await insertRow(c.org, 'customapirequestparameters', { ...copy, 'CustomAPIId@odata.bind': `/customapis(${param._customapiid_value})` });
  await joinSolution(c, made, member.componenttype);
  const again = await pass(reopen(c, childTokens), apiOnly());
  assert.equal(again.halt && again.halt.code, 'create-identity-conflict', again.halt && again.halt.message);
  assert.ok(printedApprovals(again.halt).some((t) => t.endsWith(`@${made}`)), again.halt.message);
  assert.deepEqual(again.sent, []);
  assertNothingHeld(c, 'customApi', 'contoso_calc', 'child replaced');

  // The namesake deleted after the stop: its approvals adopt nothing, and the item is created at its derived id, as the
  // preflight forecasts and as a build with no namesake does.
  const d = await harness();
  await madeBeforeOptIn(d, variableOnly());
  const varTokens = printedApprovals((await pass(reopen(d), variableOnly())).halt);
  const was = idIn(d, 'environmentvariabledefinitions');
  const dropped = await d.org.request({ url: `${d.org.origin}/api/data/v9.2/environmentvariabledefinitions(${was})`, method: 'DELETE', headers: {} });
  assert.ok(dropped.statusCode < 300);
  const created = await pass(reopen(d, varTokens), variableOnly());
  assert.equal(created.halt, null, created.halt && created.halt.message);
  assert.deepEqual(created.sent.map((r) => `${r.method} ${r.path.split('(')[0].split('?')[0]}`), ['POST /environmentvariabledefinitions']);
  const record = committed(d, 'environmentVariable', 'contoso_apibase').records[0];
  assert.equal(record.origin, 'created');
  assert.notEqual(record.id, was);
});

test('an adoption cut off after it began is retired and made again under its approvals, and is never sent as a create', async () => {
  for (const at of ['prepared', 'sending']) {
    const h = await harness();
    await madeBeforeOptIn(h, apiOnly());
    const id = idIn(h, 'customapis');
    const tokens = printedApprovals((await pass(reopen(h), apiOnly())).halt);
    // The process stops right after the attempt is written: before it is marked sending, or right after.
    const cut = reopen(h, tokens);
    if (at === 'prepared') {
      const mark = h.store.markAttemptSetSending;
      h.store.markAttemptSetSending = () => { h.store.markAttemptSetSending = mark; throw new Error('the process stopped'); };
    } else {
      const begin = cut.ctx.begin;
      cut.ctx.begin = (plans) => { begin(plans); throw new Error('the process stopped'); };
    }
    const crashed = await pass(cut, apiOnly());
    assert.ok(crashed.halt, at);
    assert.deepEqual(crashed.sent, [], at);
    const pending = h.store.readGroup('customApi', 'contoso_calc').pending;
    assert.equal(pending && pending.phase, at, at);
    assert.equal(committed(h, 'customApi', 'contoso_calc'), null, at);

    // A later build without the approvals stops as before, and the create path refuses the attempt outright.
    const asked = await pass(reopen(h), apiOnly());
    assert.equal(asked.halt && asked.halt.code, 'create-identity-conflict', `${at}: ${asked.halt && asked.halt.message}`);
    assert.deepEqual(asked.sent, [], at);
    const port = reopen(h).protectedConfiguration.port({ spec: apiOnly(), dataverse: h.sdk.dataverse, solution: SOL, bindings: undefined, sdk: h.sdk });
    const mark = h.org.requests.length;
    let refused = null;
    try { await port.run({ kind: 'customApi', key: 'contoso_Calc' }, async () => { throw new Error('never sent'); }); } catch (error) { refused = error; }
    assert.equal(refused && refused.code, 'create-identity-unverified', refused && refused.message);
    assert.match(refused.message, /pending adoption, which is never sent as a create/);
    assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), [], `${at}: run sends nothing`);

    // Under the approvals: the attempt is retired and the adoption made again, read-only.
    const done = await pass(reopen(h, tokens), apiOnly());
    assert.equal(done.halt, null, done.halt && `${at}: ${done.halt.code}: ${done.halt.message}`);
    assert.deepEqual(done.sent, [], at);
    const group = h.store.readGroup('customApi', 'contoso_calc');
    assert.equal(group.pending, null, at);
    assert.equal(group.committed.records.find((r) => r.kind === 'customApi').id, id, at);
    assert.equal(h.org.rows('customapis').length, 1, `${at}: nothing is created`);
  }
});
// ---------------------------------------------------------------------------------------------
// Adoption edges: what an approved adoption may and may not do, every item a stop prints approvals for, and the reads it costs.

const sentLines = (sent) => sent.map((r) => `${r.method} ${r.path}`);

test('an adopted variable keeps its private value, given or not, and nothing is sent', async () => {
  for (const withSettings of [true, false]) {
    const h = await harness();
    const spec = variableOnly();
    const opts = { configurationBindings: settingsOf(spec, 'https://one.contoso.com') };
    await madeBeforeOptIn(h, spec, opts);
    const given = withSettings ? opts : {};
    const stopped = await pass(reopen(h), spec, given);
    const tokens = printedApprovals(stopped.halt);
    assert.equal(tokens.length, 2, stopped.halt && stopped.halt.message);
    const out = await pass(reopen(h, tokens, spec), spec, given);
    assert.equal(out.halt, null, out.halt && out.halt.message);
    assert.deepEqual(sentLines(out.sent), [], `settings given: ${withSettings}`);
    assert.equal(committed(h, 'environmentVariable', 'contoso_apibase').records.length, 2);
  }
});

const DATA_SOURCE = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const dataSources = () => configSpec({
  customApis: [], duplicateDetectionRules: [],
  environmentVariables: [
    { schemaName: 'contoso_Parent', type: 'dataSource', connectorId: DATA_SOURCE, parameterKey: 'dataset' },
    { schemaName: 'contoso_Child', type: 'dataSource', connectorId: DATA_SOURCE, parameterKey: 'table', parentSchemaName: 'contoso_Parent' },
  ],
});

test('a data-source variable and its parent, both made before the opt-in, are adopted together, or the parent first and then the child', async () => {
  // Together: one stop prints both, and one build adopts both, the child against its parent's adopted row.
  {
    const h = await harness();
    const spec = dataSources();
    await madeBeforeOptIn(h, spec);
    const stopped = await pass(reopen(h), spec);
    const tokens = printedApprovals(stopped.halt);
    assert.equal(tokens.length, 2, stopped.halt && stopped.halt.message);
    const out = await pass(reopen(h, tokens, spec), spec);
    assert.equal(out.halt, null, out.halt && out.halt.message);
    assert.deepEqual(sentLines(out.sent), []);
    assert.ok(committed(h, 'environmentVariable', 'contoso_parent') && committed(h, 'environmentVariable', 'contoso_child'));
  }
  // The parent first: a later stop offers the child alone, against the parent's binding (not its derived id).
  {
    const h = await harness();
    const spec = dataSources();
    await madeBeforeOptIn(h, spec);
    const parentOnly = { ...spec, environmentVariables: spec.environmentVariables.slice(0, 1) };
    const parentStop = await pass(reopen(h), parentOnly);
    const parentAdopted = await pass(reopen(h, printedApprovals(parentStop.halt), spec), parentOnly);
    assert.equal(parentAdopted.halt, null, parentAdopted.halt && parentAdopted.halt.message);
    const childStop = await pass(reopen(h), spec);
    const tokens = printedApprovals(childStop.halt);
    assert.equal(tokens.length, 1, childStop.halt && childStop.halt.message);
    assert.match(tokens[0], /^adopt:environmentVariable:contoso_child@/);
    const out = await pass(reopen(h, tokens, spec), spec);
    assert.equal(out.halt, null, out.halt && out.halt.message);
    assert.deepEqual(sentLines(out.sent), []);
    assert.ok(committed(h, 'environmentVariable', 'contoso_child'));
  }
});

test('a request parameter added in the adoption build is created under its approvals', async () => {
  const h = await harness();
  await madeBeforeOptIn(h, apiOnly());
  const spec = apiOnly({ requestParameters: [...API.requestParameters, { uniqueName: 'B', type: 'string' }] });
  const stopped = await pass(reopen(h), spec);
  const tokens = printedApprovals(stopped.halt);
  assert.equal(tokens.length, 3, stopped.halt && stopped.halt.message);
  const out = await pass(reopen(h, tokens, spec), spec);
  assert.equal(out.halt, null, out.halt && out.halt.message);
  assert.ok(out.sent.some((r) => r.method === 'POST'), sentLines(out.sent).join(' '));
});

test('a maker edit made after the adoption is accepted stops the same build: nothing but the printed fields is ever sent', async () => {
  let armed = false;
  const own = new Set();
  let id;
  const h = await harness({ intercept: async () => {
    if (!armed) return undefined;
    armed = false;
    const mark = h.org.requests.length;
    await patchRow(h, 'customapis', id, { displayname: 'Unseen maker edit' });
    for (const r of h.org.requests.slice(mark)) own.add(r);
    return undefined;
  } });
  await madeBeforeOptIn(h, apiOnly({ displayName: 'Calculator' }));
  id = idIn(h, 'customapis');
  const spec = apiOnly({ displayName: 'Calculator', description: 'Adds numbers' });
  const stopped = await pass(reopen(h), spec);
  assert.match(stopped.halt.message, /only these fields, \/description\./);
  const approved = reopen(h, printedApprovals(stopped.halt), spec);
  const accept = approved.ctx.acceptReadOnly;
  approved.ctx.acceptReadOnly = (items) => { const out = accept(items); armed = true; return out; };
  const out = await pass(approved, spec);
  assert.equal(armed, false, 'the maker edit was made');
  assert.equal(out.halt && out.halt.code, 'configuration-incomplete', out.halt && out.halt.message);
  assert.match(out.halt.message, /customApi contoso_Calc \(create-identity-conflict\)/);
  // Refused, not unknown: the item's stop says nothing was sent for it.
  assert.deepEqual(out.step.outcome.refused.map((r) => `${r.kind}:${r.code}`), ['customApi:create-identity-conflict']);
  assert.deepEqual(out.step.outcome.unknown, []);
  assert.deepEqual(sentLines(out.sent.filter((r) => !own.has(r))), [], 'nothing is sent');
  assert.equal(h.org.rows('customapis')[0].displayname, 'Unseen maker edit');
  assert.notEqual(h.org.rows('customapis')[0].description, 'Adds numbers', 'the approved edit is not sent either');
  // A later build plans the item from the row as it is now, as an ordinary bound one: the App Spec's values are sent.
  const later = await pass(reopen(h), spec);
  assert.equal(later.halt, null, later.halt && later.halt.message);
  assert.deepEqual(later.sent.map((r) => `${r.method} ${r.path.split('?')[0]}`), [`PATCH /customapis(${id})`]);
  assert.equal(h.org.rows('customapis')[0].description, 'Adds numbers');
});

// A duplicate rule and its conditions are never adopted: a rule's namesake keeps the stop it had before adoption existed,
// byte for byte, after the same reads, and no approval, typed or raw, binds it or lets anything be sent. An adopted rule
// would be reconciled by the ordinary rule path, which neither holds an edit to the fields its stop printed nor keeps
// from publishing a rule a maker changed after the acceptance.
const anyId = (text) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
const RULE_STOP_READS = [
  "GET /EntityDefinitions(LogicalName='connectionreference')?$select=ObjectTypeCode",
  "GET /EntityDefinitions(LogicalName='customapi')?$select=ObjectTypeCode",
  "GET /EntityDefinitions(LogicalName='duplicaterule')?$select=ObjectTypeCode",
  "GET /EntityDefinitions(LogicalName='customapirequestparameter')?$select=ObjectTypeCode",
  "GET /EntityDefinitions(LogicalName='customapiresponseproperty')?$select=ObjectTypeCode",
  "GET /EntityDefinitions(LogicalName='duplicaterulecondition')?$select=ObjectTypeCode",
  'GET /duplicaterules(<id>)?$select=duplicateruleid,name,description,baseentityname,matchingentityname,iscasesensitive,excludeinactiverecords,statecode,statuscode',
  "GET /duplicaterules?$select=duplicateruleid,name&$filter=name eq 'Same email'",
  'GET /duplicateruleconditions?$filter=_regardingobjectid_value eq <id>&$select=duplicateruleconditionid,baseattributename,matchingattributename,operatorcode,operatorparam,ignoreblankvalues,_regardingobjectid_value',
];
const onlyRule = (over = {}) => configSpec({ environmentVariables: [], customApis: [], ...rule(over) });

test('a duplicate rule made before the opt-in keeps its stop byte for byte: no adoption is offered or taken, and nothing is sent', async () => {
  const CASES = [
    { name: 'published', spec: onlyRule() },
    { name: 'unpublished', spec: onlyRule({ status: 'unpublished' }) },
    { name: 'its description differs', before: onlyRule({ description: 'Original' }), spec: onlyRule({ description: 'Changed' }) },
  ];
  for (const c of CASES) {
    const h = await harness();
    await madeBeforeOptIn(h, c.before || c.spec);
    const id = idIn(h, 'duplicaterules');
    const condition = h.org.rows('duplicateruleconditions')[0].duplicateruleconditionid;
    const rows = () => JSON.stringify([h.org.rows('duplicaterules'), h.org.rows('duplicateruleconditions')]);
    const before = rows();
    const mark = h.org.requests.length;
    const stop = await pass(reopen(h), c.spec);
    assert.equal(stop.halt && stop.halt.code, 'create-identity-conflict', c.name);
    assert.equal(stop.halt.phase, 'preflight', c.name);
    assert.equal(stop.halt.message, namesakeStop('duplicateRule', 'email', id), c.name);
    assert.deepEqual(h.org.requests.slice(mark).map((r) => anyId(`${r.method} ${r.path}`)), RULE_STOP_READS, `${c.name}: the reads of 2.24.0`);
    // The approvals a plugin that adopted rules would print: the parser reads them whole, as 2.24.0 does, so they name no
    // declared item; given anyway, raw or in the typed spelling, they adopt nothing.
    const wouldBe = [`adopt:duplicateRule:email@${id}`, `adopt:duplicateRuleCondition:email/e@${condition}`];
    assert.deepEqual(configurationAuthorizationKeys(wouldBe, c.spec).problems.map((p) => p.code), ['CONFIGURATION_AUTHORIZATION_UNKNOWN_ITEM', 'CONFIGURATION_AUTHORIZATION_UNKNOWN_ITEM'], c.name);
    for (const approvals of [wouldBe, wouldBe.map((a) => a.replace(/^adopt:/, 'adopt-row:')), ['adopt:duplicateRule:email', 'adopt:duplicateRuleCondition:email/e']]) {
      const out = await pass(reopen(h, approvals, null), c.spec);
      assert.equal(out.halt && out.halt.message, namesakeStop('duplicateRule', 'email', id), `${c.name}: ${approvals}`);
      assert.deepEqual(out.sent, [], `${c.name}: ${approvals}`);
      assertNothingHeld(h, 'duplicateRule', 'email', `${c.name}: ${approvals}`);
    }
    assert.equal(rows(), before, `${c.name}: the rule is untouched`);
  }
});

test('a rule a maker edits during a build given the approvals a rule adoption would need is neither rewritten nor published', async () => {
  // Two windows: right after an acceptance, which a rule never reaches, and the build's first request.
  for (const status of ['published', 'unpublished']) for (const window of ['after acceptance', 'first request']) {
    const label = `${status}, ${window}`;
    let armed = false;
    let id;
    const own = new Set();
    const h = await harness({ intercept: async () => {
      if (!armed) return undefined;
      armed = false;
      const mark = h.org.requests.length;
      await patchRow(h, 'duplicaterules', id, { description: 'Unseen maker edit' });
      for (const r of h.org.requests.slice(mark)) own.add(r);
      return undefined;
    } });
    const spec = onlyRule({ description: 'Original', status });
    await madeBeforeOptIn(h, spec);
    id = idIn(h, 'duplicaterules');
    const condition = h.org.rows('duplicateruleconditions')[0].duplicateruleconditionid;
    const stopped = await pass(reopen(h), spec);
    const approvals = printedApprovals(stopped.halt);
    // The typed spellings an adoption would be matched in, given even though the stop printed none.
    const given = reopen(h, [...approvals, `adopt-row:duplicateRule:email@${id}`, `adopt-row:duplicateRuleCondition:email/e@${condition}`], approvals.length ? spec : null);
    const accept = given.ctx.acceptReadOnly;
    let accepted = 0;
    given.ctx.acceptReadOnly = (items) => { const out = accept(items); accepted += 1; if (window === 'after acceptance') armed = true; return out; };
    if (window === 'first request') armed = true;
    const out = await pass(given, spec);
    assert.deepEqual(sentLines(out.sent.filter((r) => !own.has(r))), [], `${label}: no PATCH and no PublishDuplicateRule`);
    assert.equal(accepted, 0, `${label}: a rule is never accepted as adopted`);
    assert.deepEqual(approvals, [], `${label}: the stop prints no approval`);
    assert.equal(out.halt && out.halt.code, 'create-identity-conflict', label);
    assert.equal(h.org.rows('duplicaterules')[0].description, window === 'first request' ? 'Unseen maker edit' : 'Original', label);
    assertNothingHeld(h, 'duplicateRule', 'email', label);
  }
});

test('a stop naming several adoptable namesakes shows each one\'s id and fields beside its approvals', async () => {
  const h = await harness();
  const before = apiOnly({ uniqueName: 'contoso_First', isFunction: false, requestParameters: [], responseProperties: [] });
  before.customApis.push({ uniqueName: 'contoso_Second', description: 'Maker text', isFunction: false, requestParameters: [], responseProperties: [] });
  await madeBeforeOptIn(h, before);
  const idOf = (name) => h.org.rows('customapis').find((r) => r.uniquename === name).customapiid;
  const spec = structuredClone(before);
  spec.customApis[1].description = 'Replacement';
  const stopped = await pass(reopen(h), spec);
  const message = stopped.halt.message;
  for (const [key, name, change] of [['contoso_first', 'contoso_First', 'nothing in it'], ['contoso_second', 'contoso_Second', 'only these fields, /description']]) {
    const id = idOf(name);
    assert.ok(message.includes(`Adopt customApi ${key} at its id ${id} (the build would then change ${change}) only under these exact approvals, given after checking those rows are yours: "adopt:customApi:${key}@${id}`), message);
  }
  assert.equal(printedApprovals(stopped.halt).length, 2);
  const out = await pass(reopen(h, printedApprovals(stopped.halt), spec), spec);
  assert.equal(out.halt, null, out.halt && out.halt.message);
});

test('the build\'s own error names every adoptable namesake with its id and fields, before anything is sent', async () => {
  const h = await harness();
  const before = apiOnly({ uniqueName: 'contoso_First', isFunction: false, requestParameters: [], responseProperties: [] });
  before.customApis.push({ uniqueName: 'contoso_Second', description: 'Maker text', isFunction: false, requestParameters: [], responseProperties: [] });
  await madeBeforeOptIn(h, before);
  const idOf = (name) => h.org.rows('customapis').find((r) => r.uniquename === name).customapiid;
  const spec = structuredClone(before);
  spec.customApis[1].description = 'Replacement';
  assert.deepEqual(validateAppSpec(spec).errors, []);
  const mark = h.org.requests.length;
  let caught;
  try {
    await runSdkBuild(spec, { sdk: h.sdk, apply: true, phases: STAGES.data, workspaceDir: makeTempDir('cfg-protected-ws-'), protectedConfiguration: reopen(h).protectedConfiguration, emit: () => {} });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught && caught.code, 'create-identity-conflict', caught && caught.message);
  for (const [key, name, change] of [['contoso_first', 'contoso_First', 'nothing in it'], ['contoso_second', 'contoso_Second', 'only these fields, /description']]) {
    const id = idOf(name);
    assert.ok(caught.message.includes(`Adopt customApi ${key} at its id ${id} (the build would then change ${change}) only under these exact approvals, given after checking those rows are yours: "adopt:customApi:${key}@${id}`), caught.message);
  }
  assert.deepEqual(h.org.requests.slice(mark).filter((r) => r.method !== 'GET'), [], 'zero service mutations');
});

test('a rule key that ends in what reads like a row id keeps its ordinary meaning, and a rule namesake is never offered', async () => {
  const h = await harness();
  const initial = onlyRule({ status: 'unpublished', conditions: [] });
  await madeBeforeOptIn(h, initial);
  const id = idIn(h, 'duplicaterules');
  const spec = structuredClone(initial);
  const secondKey = `email@${id}`;
  spec.duplicateDetectionRules.push({ key: secondKey, name: 'Another rule', entity: 'contact', status: 'unpublished', conditions: [] });
  const typed = `adopt:duplicateRule:${secondKey}`;
  const parsed = configurationAuthorizationKeys([typed], spec);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual([...parsed.rowApprovals], [typed], 'the plain approval of the rule keyed email@<id>, as in 2.24.0');
  const out = await pass(reopen(h, [...parsed.rowApprovals], null), spec);
  assert.equal(out.halt && out.halt.code, 'create-identity-conflict');
  assert.equal(out.halt.message, namesakeStop('duplicateRule', 'email', id));
  assert.deepEqual(out.sent, []);
  assert.equal(committed(h, 'duplicateRule', 'email'), null);
});
test('a failed continuation page of the membership or the children is never read as a complete adoption read', async () => {
  for (const set of ['solutioncomponents', 'customapirequestparameters']) {
    let active = false;
    let root;
    const h = await harness({ intercept: ({ method, path }) => {
      if (!active || method !== 'GET' || !path.startsWith(`/${set}?`)) return undefined;
      if (set !== 'solutioncomponents' && !path.includes(root) && !path.includes('$skiptoken=more')) return undefined;
      if (/\$skiptoken=/.test(path)) return { statusCode: 503, body: { error: { code: '0x80040216', message: 'busy' } } };
      return { statusCode: 200, body: { value: [], '@odata.nextLink': `${h.org.origin}/api/data/v9.0/${set}?$skiptoken=more` } };
    } });
    await madeBeforeOptIn(h, apiOnly());
    root = idIn(h, 'customapis');
    const tokens = printedApprovals((await pass(reopen(h), apiOnly())).halt);
    active = true;
    const out = await pass(reopen(h, tokens), apiOnly());
    assert.ok(out.halt, set);
    assert.deepEqual(sentLines(out.sent), [], set);
    assert.ok(h.org.requests.some((r) => r.path.includes('$skiptoken=more')), set);
    assertNothingHeld(h, 'customApi', 'contoso_calc', set);
  }
});

test('complete continuation pages supply the children and the membership of an adoption', async () => {
  let active = false;
  let root;
  let continued = 0;
  const h = await harness({ intercept: ({ method, path }) => {
    if (!active || method !== 'GET') return undefined;
    const set = path.startsWith('/solutioncomponents?') ? 'solutioncomponents'
      : path.startsWith('/customapirequestparameters?') && (path.includes(root) || path.includes('$skiptoken=more')) ? 'customapirequestparameters' : null;
    if (!set) return undefined;
    if (path.includes('$skiptoken=more')) { continued += 1; return { statusCode: 200, body: { value: h.org.rows(set) } }; }
    return { statusCode: 200, body: { value: [], '@odata.nextLink': `${h.org.origin}/api/data/v9.0/${set}?$skiptoken=more` } };
  } });
  await madeBeforeOptIn(h, apiOnly());
  root = idIn(h, 'customapis');
  const tokens = printedApprovals((await pass(reopen(h), apiOnly())).halt);
  active = true;
  const out = await pass(reopen(h, tokens), apiOnly());
  assert.equal(out.halt, null, out.halt && out.halt.message);
  assert.ok(continued > 2, `continued ${continued}`);
  assert.deepEqual(sentLines(out.sent), []);
});

test('a connection reference is adopted only with its matching private connection', async () => {
  const spec = configSpec({ environmentVariables: [], customApis: [], duplicateDetectionRules: [],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: DATA_SOURCE }] });
  const good = readDeploymentBindings({ ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-one' }] }, spec);
  const bad = readDeploymentBindings({ ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-two' }] }, spec);
  const h = await harness();
  const opts = { configurationBindings: good, connections: async () => [{ connectionId: 'conn-one', connectorId: DATA_SOURCE }] };
  await madeBeforeOptIn(h, spec, opts);
  const stop = await pass(reopen(h), spec, opts);
  const tokens = printedApprovals(stop.halt);
  assert.equal(tokens.length, 1, stop.halt && stop.halt.message);
  const refused = await pass(reopen(h, tokens, spec), spec, { ...opts, configurationBindings: bad });
  assert.ok(refused.halt);
  assert.deepEqual(sentLines(refused.sent), []);
  assertNothingHeld(h, 'connectionReference', 'contoso_sp', 'private connection mismatch');
  const accepted = await pass(reopen(h, tokens, spec), spec, opts);
  assert.equal(accepted.halt, null, accepted.halt && accepted.halt.message);
  assert.deepEqual(sentLines(accepted.sent), []);
});

test('a request parameter added while the adoption is captured is refused, and nothing is bound', async () => {
  let armed = false;
  let root;
  const h = await harness({ intercept: async () => {
    if (!armed) return undefined;
    armed = false;
    await insertRow(h.org, 'customapirequestparameters', { uniquename: 'MakerChild', name: 'MakerChild', type: 10, 'CustomAPIId@odata.bind': `/customapis(${root})` });
    return undefined;
  } });
  await madeBeforeOptIn(h, apiOnly());
  root = idIn(h, 'customapis');
  const approved = reopen(h, printedApprovals((await pass(reopen(h), apiOnly())).halt));
  const capture = approved.ctx.captureReadOnly;
  approved.ctx.captureReadOnly = (items) => { const out = capture(items); armed = true; return out; };
  const out = await pass(approved, apiOnly());
  assert.ok(out.halt);
  assertNothingHeld(h, 'customApi', 'contoso_calc', 'new child during adoption');
});

test('a read-only acceptance needs an attempt begun with its expected proof, never one only prepared', async () => {
  const h = await harness();
  const spec = apiOnly({ isFunction: false, requestParameters: [], responseProperties: [] });
  await madeBeforeOptIn(h, spec);
  const id = idIn(h, 'customapis');
  const approved = reopen(h, [`adopt:customApi:contoso_calc@${id}`]);
  const tokenOf = () => `adopt-row:customApi:contoso_calc@${id}`;
  const base = await B.readConfigurationRow(h.sdk.dataverse, 'customApi', id);
  const types = await B.readComponentTypes(h.sdk.dataverse);
  const planned = B.planOf(spec, { kind: 'customApi', key: 'contoso_Calc', solution: SOL, componentTypes: types.types, bases: new Map([[id, base]]), boundIdOf: () => id, asIs: true });
  const built = require('../lib/managed-create-context.js').buildRowPlan(planned.plan);
  const [unbegun] = h.store.prepareAttemptSet([built.prepare]);
  const [capture0] = approved.ctx.captureReadOnly([unbegun]);
  const observation0 = await B.observe(h.sdk.dataverse, planned);
  assert.throws(() => approved.ctx.acceptReadOnly([{ token: unbegun, capture: capture0, observation: observation0, declarationSha256: planned.plan.declarationSha256, approvalTokenOf: tokenOf }]),
    /not a plan of existing rows with a base observation/);
  h.store.retireUnsentAttempt({ token: unbegun, baseGeneration: null });
  const [begun] = approved.ctx.begin([planned.plan]);
  const [capture1] = approved.ctx.captureReadOnly([begun.token]);
  const observation1 = await B.observe(h.sdk.dataverse, planned);
  const [accepted] = approved.ctx.acceptReadOnly([{ token: begun.token, capture: capture1, observation: observation1, declarationSha256: planned.plan.declarationSha256, approvalTokenOf: tokenOf }]);
  assert.equal(accepted.verdict.action, 'commit');
  assert.equal(accepted.group.records[0].origin, 'adopted');
});

test('adoption analysis costs reads only for a single namesake under the opt-in', async () => {
  const gets = {};
  for (const roots of [0, 1, 2]) {
    const h = await harness();
    const spec = variableOnly();
    if (roots > 0) await madeBeforeOptIn(h, spec);
    if (roots === 2) await joinSolution(h, await insertRow(h.org, 'environmentvariabledefinitions', VARIABLE_ROW), 380);
    for (const optIn of [false, true]) {
      const runtime = createConfigurationRuntime({ spec: optIn ? spec : withoutOptIn(spec), sdk: h.sdk, opts: { protectedConfiguration: reopen(h).protectedConfiguration }, appUniqueName: 'contoso_configured' });
      const mark = h.org.requests.length;
      try { await runtime.preflight(); } catch { /* the namesake stops are judged elsewhere */ }
      const since = h.org.requests.slice(mark);
      assert.deepEqual(sentLines(since.filter((r) => r.method !== 'GET')), []);
      gets[`${roots}:${optIn ? 'opt-in' : 'plain'}`] = since.length;
    }
  }
  assert.deepEqual(gets, { '0:plain': 0, '0:opt-in': 8, '1:plain': 0, '1:opt-in': 18, '2:plain': 0, '2:opt-in': 8 });
});

// ---------------------------------------------------------------------------------------------
// After an adoption is accepted, the same build sends at most the fields its stop printed, for every kind that adopts: a
// maker edit made right after the acceptance, to a field outside that list, stops the item with nothing sent and the
// maker's value kept. A later build plans the item from the row as it is now, as an ordinary bound one.

async function editedAfterAcceptance({ before, spec, beforeOpts = {}, opts = {}, edit, expectList }) {
  let armed = false;
  const own = new Set();
  const h = await harness({ intercept: async () => {
    if (!armed) return undefined;
    armed = false;
    const mark = h.org.requests.length;
    await edit(h);
    for (const r of h.org.requests.slice(mark)) own.add(r);
    return undefined;
  } });
  await madeBeforeOptIn(h, before, beforeOpts);
  const stopped = await pass(reopen(h), spec, opts);
  assert.equal(stopped.halt && stopped.halt.code, 'create-identity-conflict', stopped.halt && stopped.halt.message);
  assert.ok(stopped.halt.message.includes(`the build would then change ${expectList}`), stopped.halt.message);
  const approved = reopen(h, printedApprovals(stopped.halt), spec);
  const accept = approved.ctx.acceptReadOnly;
  let accepted = 0;
  approved.ctx.acceptReadOnly = (items) => { const out = accept(items); accepted += 1; armed = true; return out; };
  const out = await pass(approved, spec, opts);
  assert.equal(accepted, 1, 'the adoption was accepted');
  assert.equal(armed, false, 'the maker edit was made');
  return { h, out, sent: out.sent.filter((r) => !own.has(r)) };
}
function assertItemStopped(out, sent, kind, code = 'create-identity-conflict') {
  assert.equal(out.halt && out.halt.code, 'configuration-incomplete', out.halt && out.halt.message);
  assert.deepEqual(out.step.outcome.refused.map((r) => `${r.kind}:${r.code}`), [`${kind}:${code}`]);
  assert.deepEqual(out.step.outcome.unknown, []);
  assert.deepEqual(sentLines(sent), [], 'nothing is sent');
}

test('an adopted environment variable edited by a maker right after the acceptance is not edited by the same build', async () => {
  const VAR = { schemaName: 'contoso_ApiBase', type: 'string', name: 'API base', description: 'Original', defaultValue: 'https://api.contoso.com' };
  const before = configSpec({ customApis: [], duplicateDetectionRules: [], environmentVariables: [VAR] });
  const spec = configSpec({ customApis: [], duplicateDetectionRules: [], environmentVariables: [{ ...VAR, defaultValue: 'https://new.contoso.com' }] });
  for (const [column, value] of [['description', 'Maker description'], ['displayname', 'Maker name']]) {
    const edit = (h) => patchRow(h, 'environmentvariabledefinitions', idIn(h, 'environmentvariabledefinitions'), { [column]: value });
    const { h, out, sent } = await editedAfterAcceptance({ before, spec, edit, expectList: 'only these fields, /defaultValue' });
    assertItemStopped(out, sent, 'environmentVariable');
    const [row] = h.org.rows('environmentvariabledefinitions');
    assert.equal(row[column], value, `${column}: the maker value is kept`);
    assert.equal(row.defaultvalue, 'https://api.contoso.com', `${column}: the approved edit is not sent either`);
    const later = await pass(reopen(h), spec);
    assert.equal(later.halt, null, later.halt && later.halt.message);
    assert.equal(h.org.rows('environmentvariabledefinitions')[0].defaultvalue, 'https://new.contoso.com');
  }
});

test('an adopted environment variable value changed by a maker right after the acceptance is not written back by the same build', async () => {
  const spec = variableOnly();
  const settings = { configurationBindings: settingsOf(spec, 'https://one.contoso.com') };
  const edit = (h) => patchRow(h, 'environmentvariablevalues', h.org.rows('environmentvariablevalues')[0].environmentvariablevalueid, { value: 'https://maker.contoso.com' });
  // Without the approval to replace a value, the build's own gate refuses writing the deployment settings' value back;
  // with it, the adoption's hold does: nothing beyond the printed list (here nothing) is sent in the adopting build.
  for (const [opts, code] of [[settings, 'DESTRUCTIVE_CHANGE_UNAUTHORIZED'], [{ ...settings, authorizedDestructive: new Set(['environmentVariableValue:contoso_apibase:value']) }, 'create-identity-conflict']]) {
    const { h, out, sent } = await editedAfterAcceptance({ before: spec, spec, beforeOpts: settings, opts, edit, expectList: 'nothing in it' });
    assertItemStopped(out, sent, 'environmentVariable', code);
    assert.equal(h.org.rows('environmentvariablevalues')[0].value, 'https://maker.contoso.com', `${code}: the maker value is kept`);
  }
});

test('an adopted connection reference edited by a maker right after the acceptance is not edited by the same build', async () => {
  const REF = { logicalName: 'contoso_sp', connectorId: DATA_SOURCE, name: 'SharePoint', description: 'Original' };
  const before = configSpec({ environmentVariables: [], customApis: [], duplicateDetectionRules: [], connectionReferences: [REF] });
  const spec = configSpec({ environmentVariables: [], customApis: [], duplicateDetectionRules: [], connectionReferences: [{ ...REF, description: 'Approved' }] });
  const settings = (s, more = {}) => ({ configurationBindings: readDeploymentBindings({ ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-one' }] }, s),
    connections: async () => [{ connectionId: 'conn-one', connectorId: DATA_SOURCE }, { connectionId: 'conn-two', connectorId: DATA_SOURCE }], ...more });
  // A connection the maker changed is one the build would replace: refused by the build's own gate without the approval
  // to replace it, and by the adoption's hold with it.
  let replace = null;
  for (const [column, value, code] of [['connectionreferencedisplayname', 'Maker name', 'create-identity-conflict'], ['connectionid', 'conn-two', 'DESTRUCTIVE_CHANGE_UNAUTHORIZED'], ['connectionid', 'conn-two', 'create-identity-conflict']]) {
    const approved = column === 'connectionid' && code === 'create-identity-conflict';
    const edit = (h) => patchRow(h, 'connectionreferences', h.org.rows('connectionreferences')[0].connectionreferenceid, { [column]: value });
    const { h, out, sent } = await editedAfterAcceptance({ before, spec, beforeOpts: settings(before), opts: settings(spec, approved ? { authorizedDestructive: new Set(replace) } : {}), edit, expectList: 'only these fields, /description' });
    assertItemStopped(out, sent, 'connectionReference', code);
    if (code === 'DESTRUCTIVE_CHANGE_UNAUTHORIZED') replace = out.step.outcome.refused[0].authorize;
    const [row] = h.org.rows('connectionreferences');
    assert.equal(row[column], value, `${column} ${code}: the maker value is kept`);
    assert.equal(row.description, 'Original', `${column} ${code}: the approved edit is not sent either`);
  }
  assert.ok(replace && replace.length, 'the replacement approval was named');
});

// ---------------------------------------------------------------------------------------------
// #847: a protected create the service refused before carrying it out (a 400 with a Dataverse error code: one operation,
// rolled back whole) leaves nothing behind, so it is released in the same run; one whose answer was lost (a 503) stays
// pending as before, and an App Spec that drops it settles it only under the exact `retire:` approval the build prints.
const KV = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/vault-sample/secrets/key-sample';
const secretSpec = () => configSpec({ customApis: [], duplicateDetectionRules: [], environmentVariables: [{ schemaName: 'contoso_Key', type: 'secret' }] });
const noConfig = () => configSpec({ customApis: [], duplicateDetectionRules: [], environmentVariables: [] });
const secretValue = () => ({ configurationBindings: readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_Key', Value: KV }] }, secretSpec()) });
const variableRows = (h) => [h.org.rows('environmentvariabledefinitions').length, h.org.rows('environmentvariablevalues').length];
const isVariableCreate = (r) => r.method === 'POST' && /^\/environmentvariable/.test(r.path);
// A later process with the maker's `--authorize retire:…` flags, read by the build's own parser against `spec`.
function retiring(h, flags, spec) {
  const read = configurationAuthorizationKeys(flags, spec);
  assert.deepEqual(read.problems, []);
  const ctx = createManagedCreateContext({ store: h.store, notFoundCode: B.NOT_FOUND_CODE });
  return { ...h, ctx, protectedConfiguration: P.createProtectedConfiguration({ store: h.store, gate: h.gate, ctx, apiBase: `${h.org.origin}/api/data/v9.0`, retirements: read.retire }) };
}
const retireFlagOf = (halt) => {
  const m = /--authorize '(retire:[^']+)'/.exec(halt.message);
  assert.ok(m, halt.message);
  return m[1];
};
async function refusedSecret() {
  let refuse = true;
  const h = await harness({ intercept: ({ method, path }) => (refuse && method === 'POST' && /^\/environmentvariable/.test(path)
    ? { statusCode: 400, body: { error: { code: '0x80072040', message: 'the Key Vault reference was refused' } } } : undefined) });
  const first = await pass(h, secretSpec(), secretValue());
  return { h, first, allow: () => { refuse = false; } };
}

test('a secret variable whose create the service refused stops with create-refused and leaves nothing pending: the rebuild with a value completes it', async () => {
  const { h, first, allow } = await refusedSecret();
  assert.equal(first.halt && first.halt.code, 'configuration-incomplete', first.halt && first.halt.message);
  assert.deepEqual(first.step.outcome.refused.map((r) => [r.kind, r.code, r.serviceCode]), [['environmentVariable', 'create-refused', '0x80072040']]);
  assert.deepEqual(first.step.outcome.unknown, []);
  assert.match(first.halt.message, /contoso_Key \(create-refused\) \(the service refused it \(0x80072040\): nothing was created or changed and nothing is left pending/);
  const group = h.store.readGroup('environmentVariable', 'contoso_key');
  assert.equal(group.pending, null, 'the attempt is released: no later build is held by it');
  assert.equal(group.committed, null);
  assert.deepEqual(variableRows(h), [0, 0]);
  // No secret reference is written to the store or shown to the maker.
  assert.ok(!fs.readFileSync(h.store.file, 'utf8').includes('vault-sample'), 'the store holds no Key Vault reference');
  assert.ok(!first.halt.message.includes('vault-sample'));

  allow();
  const done = await pass(reopen(h), secretSpec(), secretValue());
  assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
  assert.equal(done.sent.filter((r) => r.method === 'POST' && r.path.startsWith('/environmentvariabledefinitions')).length, 1, 'created once');
  assert.deepEqual(variableRows(h), [1, 1]);
  assert.ok(committed(h, 'environmentVariable', 'contoso_key'));
  const rerun = await pass(reopen(h), secretSpec(), secretValue());
  assert.equal(rerun.halt, null);
  assert.deepEqual(rerun.sent, []);
});

test('a secret variable whose create the service refused no longer holds a build whose App Spec drops it', async () => {
  const { h, first } = await refusedSecret();
  assert.ok(first.halt);
  const out = await pass(reopen(h), noConfig());
  assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
  assert.deepEqual(out.sent, []);
  assert.deepEqual(variableRows(h), [0, 0]);
});

// #847: the real SDK sends a variable with a value as two requests — the definition, then the value on its own — so the
// service can take the definition and refuse only the value (a Key Vault reference this environment cannot read). The
// value is then the one thing still owed: a corrected rebuild sends only it, once, and never the definition again.
const VALUE_REFUSAL = { statusCode: 400, body: { error: { code: '0x80072040', message: 'the Key Vault reference was refused' } } };
const isValuePost = (r) => r.method === 'POST' && r.path.split('?')[0] === '/environmentvariablevalues';
const isDefinitionPost = (r) => r.method === 'POST' && r.path.split('?')[0] === '/environmentvariabledefinitions';
async function valueRefusedSecret({ spec = secretSpec(), settings = secretValue() } = {}) {
  let refuse = true;
  const h = await harness({ intercept: (req) => (refuse && isValuePost(req) ? VALUE_REFUSAL : undefined) });
  const first = await pass(h, spec, settings);
  return { h, first, allow: () => { refuse = false; }, refuseAgain: () => { refuse = true; } };
}
const valueRefusedLine = (token, code = '0x80072040') => `1 configuration item not completed: environmentVariable contoso_Key (create-value-refused) (the service refused the value request (${code}) before it started; `
  + 'the variable is still pending and its definition may remain at the original id. This build does not recreate or delete the definition. '
  + 'Correct its value in the deployment settings (for a secret, use a Key Vault secret reference this environment can read), keep its App Spec definition unchanged, and build again. '
  + 'After fresh checks and any required ownership approval, only the missing value can be sent. To stop tracking this attempt instead, remove the variable from the App Spec and its entry '
  + `from deployment settings, then run the build with --apply --authorize 'retire:environmentVariable:contoso_key@${token}'. No row is deleted by retirement; restoring the declaration `
  + 'while its derived id is occupied stops with create-identity-conflict)';

test('a secret variable whose value request alone the service refused stops with create-value-refused; the corrected rebuild sends only the value, once', async () => {
  const { h, first, allow } = await valueRefusedSecret();
  const pending = h.store.readGroup('environmentVariable', 'contoso_key').pending;
  assert.ok(pending, 'the definition was sent: the attempt stays pending');
  assert.equal(first.halt && first.halt.code, 'configuration-incomplete', first.halt && first.halt.message);
  assert.equal(first.halt.message, valueRefusedLine(pending.token));
  assert.deepEqual(first.step.outcome.refused, []);
  assert.deepEqual(variableRows(h), [1, 0], 'the definition landed, the value did not');
  assert.ok(!fs.readFileSync(h.store.file, 'utf8').includes('vault-sample'), 'the store holds no Key Vault reference');
  assert.ok(!JSON.stringify(first.step.outcome).includes('vault-sample'));

  allow();
  // The failed push left the workspace copy as the SDK wrote it: replacing it stays the maker's approval.
  const done = await pass(reopen(h), secretSpec(), { ...secretValue(), ...overwriteCopy('environmentVariable', 'contoso_key') });
  assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
  assert.deepEqual(done.sent.filter(isDefinitionPost), [], 'the definition is never sent again');
  assert.equal(done.sent.filter(isValuePost).length, 1, 'only the value, once');
  assert.deepEqual(variableRows(h), [1, 1]);
  const bound = committed(h, 'environmentVariable', 'contoso_key');
  assert.ok(bound);
  assert.equal(bound.records[0].id, pending.root.id, 'at the original definition id');
  const rerun = await pass(reopen(h), secretSpec(), secretValue());
  assert.equal(rerun.halt, null);
  assert.deepEqual(rerun.sent, []);
});

const valueBuild = (h, approvals = [], settings = secretValue()) => pass(reopen(h, approvals), secretSpec(), { ...settings, ...overwriteCopy('environmentVariable', 'contoso_key') });
const epochOf = (h) => h.store.readGroup('environmentVariable', 'contoso_key').pending.sendWindow.epoch;

test('a variable value the service refuses again is sent once per build under a new claim, the definition never; the corrected build completes it', async () => {
  const { h, first, allow } = await valueRefusedSecret();
  const { token } = h.store.readGroup('environmentVariable', 'contoso_key').pending;
  assert.equal(first.halt.message, valueRefusedLine(token));
  const before = epochOf(h);
  const again = await valueBuild(h);
  assert.equal(again.halt && again.halt.message, valueRefusedLine(token), again.halt && again.halt.message);
  assert.deepEqual(again.sent.filter(isDefinitionPost), []);
  assert.equal(again.sent.filter(isValuePost).length, 1, 'one value request, no loop');
  assert.ok(epochOf(h) > before, 'the value was claimed under a new epoch');
  assert.equal(h.store.readGroup('environmentVariable', 'contoso_key').pending.token, token, 'the same attempt');
  assert.deepEqual(variableRows(h), [1, 0]);

  allow();
  const done = await valueBuild(h);
  assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
  assert.deepEqual(done.sent.filter(isVariableCreate).map((r) => r.path.split('?')[0]), ['/environmentvariablevalues']);
  assert.deepEqual(variableRows(h), [1, 1]);
  assert.ok(committed(h, 'environmentVariable', 'contoso_key'));
});

test('a refused variable value is not sent while its deployment-settings value is missing; the attempt and its definition stay', async () => {
  const { h } = await valueRefusedSecret();
  const { token } = h.store.readGroup('environmentVariable', 'contoso_key').pending;
  const out = await pass(reopen(h), secretSpec(), overwriteCopy('environmentVariable', 'contoso_key'));
  assert.ok(out.halt);
  assert.ok(out.halt.message.includes('still owes its original value row. Supply its value in deployment settings, keep its App Spec definition unchanged, and build again. No value request was sent for this item'), out.halt.message);
  assert.deepEqual(out.sent.filter(isVariableCreate), []);
  assert.equal(h.store.readGroup('environmentVariable', 'contoso_key').pending.token, token);
  assert.deepEqual(variableRows(h), [1, 0]);
});

test('a refused variable value retires under the token its stop prints: nothing deleted or sent, and the restored declaration stops on the definition', async () => {
  const { h, first } = await valueRefusedSecret();
  const flag = retireFlagOf(first.halt);
  const { token } = h.store.readGroup('environmentVariable', 'contoso_key').pending;
  assert.equal(flag, `retire:environmentVariable:contoso_key@${token}`);
  const other = await pass(retiring(h, [flag.replace(/@.*$/, '@00000000-0000-4000-8000-000000000009')], noConfig()), noConfig());
  assert.equal(other.halt && other.halt.code, 'managed-settlement-pending', other.halt && other.halt.message);
  const out = await pass(retiring(h, [flag], noConfig()), noConfig());
  assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
  assert.deepEqual(out.sent, [], 'nothing is deleted or sent');
  assert.equal(h.store.readGroup('environmentVariable', 'contoso_key').pending, null);
  assert.deepEqual(variableRows(h), [1, 0]);
  const back = await pass(reopen(h), secretSpec(), secretValue());
  assert.equal(back.halt && back.halt.code, 'create-identity-conflict', back.halt && back.halt.message);
  assert.deepEqual(back.sent, []);
});

// A definition whose answer was lost: its value was never sent, but no answer proves this attempt made the definition, so
// the value waits for the maker's ordinary approval of that definition (the namesake @<id> form does not stand in for it).
async function lostDefinition({ land = true } = {}) {
  let org = null;
  let lose = true;
  const h = await harness({ intercept: async (req) => {
    if (!lose || !isDefinitionPost(req)) return undefined;
    lose = false;
    if (land) await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    return { statusCode: 503, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
  } });
  org = h.org;
  const first = await pass(h, secretSpec(), secretValue());
  assert.ok(first.halt);
  assert.equal(first.sent.filter(isValuePost).length, 0, 'the value was never reached');
  return h;
}

test('a variable whose definition answer was lost sends its never-sent value only after the maker approves the landed definition', async () => {
  const h = await lostDefinition();
  assert.deepEqual(variableRows(h), [1, 0]);
  const { root } = h.store.readGroup('environmentVariable', 'contoso_key').pending;
  const held = await valueBuild(h);
  assert.equal(held.halt && held.halt.code, 'create-ownership-required', held.halt && held.halt.message);
  assert.ok(held.halt.message.includes(`the saved definition of environmentVariable "contoso_key" at ${root.id} matches the pending create, but no recorded answer proves this attempt created it.`), held.halt.message);
  assert.ok(held.halt.message.includes('adopt:environmentVariable:contoso_key'), held.halt.message);
  assert.deepEqual(held.sent.filter(isVariableCreate), []);
  const namesake = await valueBuild(h, [`adopt:environmentVariable:contoso_key@${root.id}`]);
  assert.ok(namesake.halt, 'the namesake approval does not stand in');
  assert.deepEqual(namesake.sent.filter(isVariableCreate), []);

  const done = await valueBuild(h, ['adopt:environmentVariable:contoso_key']);
  assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
  assert.deepEqual(done.sent.filter(isVariableCreate).map((r) => r.path.split('?')[0]), ['/environmentvariablevalues']);
  assert.deepEqual(variableRows(h), [1, 1]);
  assert.equal(committed(h, 'environmentVariable', 'contoso_key').records[0].id, root.id);
});

test('a variable whose definition answer was lost and did not land sends nothing', async () => {
  const h = await lostDefinition({ land: false });
  assert.deepEqual(variableRows(h), [0, 0]);
  const out = await valueBuild(h, ['adopt:environmentVariable:contoso_key']);
  assert.ok(out.halt);
  assert.deepEqual(out.sent.filter(isVariableCreate), []);
  assert.ok(h.store.readGroup('environmentVariable', 'contoso_key').pending);
});

test('a variable value whose answer was lost may have been sent: it is never claimed or sent again, landed or not', async () => {
  for (const land of [true, false]) {
    let org = null;
    let lose = true;
    const h = await harness({ intercept: async (req) => {
      if (!lose || !isValuePost(req)) return undefined;
      lose = false;
      if (land) await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
      return { statusCode: 503, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
    } });
    org = h.org;
    const first = await pass(h, secretSpec(), secretValue());
    assert.ok(first.halt);
    assert.ok(!first.halt.message.includes('create-value-refused'), first.halt.message);
    const pending = h.store.readGroup('environmentVariable', 'contoso_key').pending;
    const value = pending.rowProtocol.rows.find((r) => r.parentId !== null);
    assert.equal(value.dispatched, true, `land=${land}: the value stays possibly sent`);
    const again = await valueBuild(h, ['adopt:environmentVariable:contoso_key']);
    assert.ok(again.halt, `land=${land}`);
    assert.deepEqual(again.sent.filter(isVariableCreate), [], `land=${land}: nothing is sent again`);
    assert.deepEqual(variableRows(h), [1, land ? 1 : 0]);
  }
});

// The store's claim of the one unsent value, over the record a real refused value request left: it re-checks the record
// under its lease and moves only the epoch; the context claims an attempt once per process.
function valueClaimOf(h, ctx = reopen(h).ctx) {
  const pending = h.store.readGroup('environmentVariable', 'contoso_key').pending;
  const value = pending.rowProtocol.rows.find((r) => r.parentId !== null);
  const [capture] = ctx.captureReadOnly([pending.token]);
  return { ctx, pending, args: { token: pending.token, id: value.id, parentId: value.parentId, capture, declarationSha256: pending.declarationSha256 } };
}
const storeCode = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('the store claims a refused variable value only as recorded, and the claim moves only the epoch', async () => {
  const { h } = await valueRefusedSecret();
  const { pending, args } = valueClaimOf(h);
  assert.equal(pending.acknowledgedRoot, true, 'the run that saw the definition acknowledged receipted it');
  assert.equal(storeCode(() => h.store.claimUnsentValueRow({ ...args, declarationSha256: 'f'.repeat(64) })), 'managed-binding-generation-conflict');
  assert.equal(storeCode(() => h.store.claimUnsentValueRow({ ...args, id: pending.root.id })), 'managed-create-request-mismatch');
  assert.equal(storeCode(() => h.store.claimUnsentValueRow({ ...args, parentId: '00000000-0000-4000-8000-000000000009' })), 'managed-create-request-mismatch');
  assert.equal(storeCode(() => h.store.claimUnsentValueRow({ ...args, capture: { ...args.capture, digest: 'x' } })), 'managed-binding-generation-conflict');
  assert.equal(epochOf(h), pending.sendWindow.epoch, 'a refused claim writes nothing');

  const { epoch } = h.store.claimUnsentValueRow(args);
  assert.equal(epoch, pending.sendWindow.epoch + 1);
  const after = h.store.readGroup('environmentVariable', 'contoso_key').pending;
  assert.deepEqual(after.rowProtocol.rows, pending.rowProtocol.rows, 'no row flag changes');
  assert.equal(after.acknowledgedRoot, true);
  assert.equal(after.token, pending.token);
  assert.equal(storeCode(() => h.store.claimUnsentValueRow(args)), 'managed-binding-generation-conflict', 'the old capture is stale after the claim');
});

test('the store refuses a value claim over a definition its own answer never acknowledged unless the maker approved it', async () => {
  const h = await lostDefinition();
  const { pending, args } = valueClaimOf(h);
  assert.notEqual(pending.acknowledgedRoot, true, 'a matching read never receipts the definition');
  assert.equal(storeCode(() => h.store.claimUnsentValueRow(args)), 'managed-settlement-pending');
  assert.equal(epochOf(h), pending.sendWindow.epoch);
  assert.equal(h.store.claimUnsentValueRow({ ...args, rootApproved: true }).epoch, pending.sendWindow.epoch + 1);
  // A context without the approval refuses; one with it claims, once.
  assert.equal(storeCode(() => valueClaimOf(h).ctx.claimValue(pending.token, valueClaimOf(h).args)), 'managed-settlement-pending');
  const approvedCtx = reopen(h, ['adopt:environmentVariable:contoso_key']).ctx;
  const claim = valueClaimOf(h, approvedCtx);
  assert.equal(approvedCtx.claimValue(pending.token, claim.args).epoch, pending.sendWindow.epoch + 2);
  const second = valueClaimOf(h, approvedCtx);
  assert.equal(storeCode(() => approvedCtx.claimValue(pending.token, second.args)), 'managed-settlement-pending', 'one claim per attempt per process');
  assert.equal(epochOf(h), pending.sendWindow.epoch + 2);
});

test('a later process never receipts a variable definition from a matching read alone', async () => {
  const h = await lostDefinition();
  const { pending } = valueClaimOf(h);
  const ctx = reopen(h).ctx;
  assert.equal(ctx.receiptPartialVariableRoot({ token: pending.token, epoch: pending.sendWindow.epoch, observation: { rows: [{ kind: 'environmentVariable', key: 'contoso_key', id: pending.root.id, state: 'present', parentId: null, projectionSha256: pending.rowProtocol.rows.find((r) => r.parentId === null).expectedSha256 }] }, declarationSha256: pending.declarationSha256 }), false);
  assert.notEqual(h.store.readGroup('environmentVariable', 'contoso_key').pending.acknowledgedRoot, true);
});

// A later build in a process of its own: a fresh binding store over the same file, a fresh send-once gate and SDK (so no
// workspace copy and no answer carry over), and a fresh context with the maker's exact approvals. `M` is the plugin runtime
// it runs: this release's, or the release before it (helpers/downgrade-release.js) for the downgrade cases.
const CURRENT = { openManagedBindings, createDeferredManagedCreateGate, createAzHttpClient, configurationSendOnce, createMakerSdk, createNodeWorkspaceStorage, createManagedCreateContext, B, P, readDeploymentBindings, createConfigurationRuntime };
async function laterProcess(h, approvals = [], M = CURRENT) {
  const store = M.openManagedBindings({ workspaceDir: path.dirname(h.store.file), environment: h.org.origin, appUniqueName: 'contoso_configured', solutionUniqueName: SOL });
  const gate = M.createDeferredManagedCreateGate();
  gate.bind(store);
  const httpClient = M.createAzHttpClient(h.org.origin, { getToken: () => 'test-token-0123456789abcdef', request: h.org.request, sleep: async () => {}, sendOnce: M.configurationSendOnce, workflowEffectGate: gate });
  const sdk = M.createMakerSdk({ workspaceStorage: M.createNodeWorkspaceStorage(makeTempDir('cfg-protected-sdk-')), instanceUrl: h.org.origin, httpClient, solutionUniqueName: SOL });
  await sdk.initWorkspace();
  const ctx = M.createManagedCreateContext({ store, approvals, notFoundCode: M.B.NOT_FOUND_CODE });
  return { org: h.org, sdk, store, gate, ctx, runtime: M === CURRENT ? null : M, protectedConfiguration: M.P.createProtectedConfiguration({ store, gate, ctx, apiBase: `${h.org.origin}/api/data/v9.0` }) };
}
const variableGroup = (h) => {
  h.store.refresh();
  return h.store.readGroup('environmentVariable', 'contoso_key');
};
const valueRowOf = (pending) => pending.rowProtocol.rows.find((r) => r.parentId !== null);
const variableSettings = (spec, value, M = CURRENT) => ({ configurationBindings: M.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_Key', Value: value }] }, spec) });
const variablePosts = (out) => out.sent.filter(isVariableCreate).map((r) => r.path.split('?')[0]);
const LOST_ANSWER = { statusCode: 503, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
const VALUE_APPROVAL = 'adopt:environmentVariableValue:contoso_key/value';
const said = (out) => `${out.halt ? `${out.halt.code}: ${out.halt.message}` : ''} ${JSON.stringify(out.step && out.step.outcome)}`;

// #847: the definition this run's own answer acknowledged is proved by a fresh exact read and receipted whenever its value
// request did not complete — not only when the service refused it. A value whose answer was lost may have been sent, so
// it is still never sent again, and adopting it is the maker's approval of the value alone.
test('a variable value whose answer was lost after its definition was acknowledged: a later build needs only the value approval, and sends nothing', async () => {
  let org = null;
  let lose = true;
  const h = await harness({ intercept: async (req) => {
    if (!lose || !isValuePost(req)) return undefined;
    lose = false;
    await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    return LOST_ANSWER;
  } });
  org = h.org;
  const first = await pass(h, secretSpec(), secretValue());
  assert.ok(first.halt);
  assert.ok(!said(first).includes('create-value-refused'), said(first));
  const pending = variableGroup(h).pending;
  assert.equal(pending.acknowledgedRoot, true, 'the definition its own answer acknowledged is receipted');
  assert.equal(valueRowOf(pending).dispatched, true, 'the value stays possibly sent');
  assert.deepEqual(variableRows(h), [1, 1]);

  const held = await pass(await laterProcess(h), secretSpec(), secretValue());
  assert.ok(held.halt);
  assert.ok(said(held).includes(VALUE_APPROVAL), said(held));
  assert.ok(!said(held).includes('adopt:environmentVariable:contoso_key\''), 'no approval of the definition is asked for');
  assert.deepEqual(variablePosts(held), []);

  const done = await pass(await laterProcess(h, [VALUE_APPROVAL]), secretSpec(), secretValue());
  assert.equal(done.halt, null, said(done));
  assert.deepEqual(variablePosts(done), [], 'nothing is sent again');
  assert.equal(variableGroup(h).committed.records[0].id, pending.root.id, 'bound at the original definition id');
  assert.deepEqual(variableRows(h), [1, 1]);
});

// #847: a definition changed between its acknowledged create and the read after its value was refused is a positive
// contradiction: the build stops create-identity-conflict, never with the hint that corrected settings complete it, and
// nothing is receipted. A read that cannot be completed is neither: the refusal stands, unproved.
test('a variable definition changed before its refused value was read back stops create-identity-conflict; an unreadable read keeps the refusal, unreceipted', async () => {
  let h = null;
  h = await harness({ intercept: (req) => {
    if (!isValuePost(req)) return undefined;
    h.org.rows('environmentvariabledefinitions')[0].description = 'Changed by another maker';
    return VALUE_REFUSAL;
  } });
  const first = await pass(h, secretSpec(), secretValue());
  assert.ok(first.halt);
  assert.ok(said(first).includes('(create-identity-conflict)'), said(first));
  assert.ok(!said(first).includes('create-value-refused'), said(first));
  assert.notEqual(variableGroup(h).pending.acknowledgedRoot, true, 'a contradicted definition is never receipted');
  const later = await pass(await laterProcess(h), secretSpec(), secretValue());
  assert.equal(later.halt && later.halt.code, 'create-identity-conflict', said(later));
  assert.deepEqual(variablePosts(later), []);

  let unreadable = false;
  const u = await harness({ intercept: (req) => {
    if (isValuePost(req)) {
      unreadable = true;
      return VALUE_REFUSAL;
    }
    return unreadable && req.method === 'GET' && req.path.startsWith('/environmentvariablevalues?')
      ? { statusCode: 403, body: { error: { code: '0x80040220', message: 'the caller cannot read the value rows' } } } : undefined;
  } });
  const refused = await pass(u, secretSpec(), secretValue());
  const { token, acknowledgedRoot } = variableGroup(u).pending;
  assert.equal(refused.halt && refused.halt.message, valueRefusedLine(token), said(refused));
  assert.notEqual(acknowledgedRoot, true, 'an unreadable read receipts nothing');
});

// A value request the value-only writer sent whose answer proves nothing: it may have been sent, so it is marked so before
// the request leaves, never re-sent by the transport, and never sent again by a later build — whatever the maker approves.
test('a value-only completion whose answer is ambiguous is sent once and never again', async () => {
  const raw = (statusCode, body, headers = {}) => ({ raw: { statusCode, headers: { 'content-type': 'application/json; odata.metadata=minimal', ...headers }, body } });
  const answers = [
    ['lost answer, the value landed', LOST_ANSWER, true],
    ['5xx', LOST_ANSWER, false],
    ['429', raw(429, JSON.stringify({ error: { code: '0x80072322', message: 'busy' } }), { 'retry-after': '1' }), false],
    ['timeout', { raw: { error: 'write ETIMEDOUT 10.0.0.1:443', code: 'ETIMEDOUT' } }, false],
    ['malformed 2xx', raw(201, '{"environmentvariablevalueid":'), false],
    ['2xx with another id', { statusCode: 201, body: { environmentvariablevalueid: '11111111-2222-4333-8444-555555555555' } }, false],
  ];
  for (const [label, answer, land] of answers) {
    let mode = 'refuse';
    let landing = false;
    let sends = 0;
    let org = null;
    const h = await harness({ intercept: async (req) => {
      if (landing || !isValuePost(req)) return undefined;
      sends += 1;
      if (mode === 'pass') return undefined;
      if (mode === 'refuse') return VALUE_REFUSAL;
      mode = 'pass';
      if (land) {
        // The fake service applies the request it is about to lose the answer to; that is not a send of the client's.
        landing = true;
        await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
        landing = false;
      }
      return answer;
    } });
    org = h.org;
    await pass(h, secretSpec(), secretValue());
    mode = 'ambiguous';
    sends = 0;
    const out = await pass(await laterProcess(h), secretSpec(), secretValue());
    assert.ok(out.halt, label);
    assert.ok(!said(out).includes('create-value-refused'), `${label}: ${said(out)}`);
    assert.equal(sends, 1, `${label}: once, never re-sent by the transport`);
    assert.deepEqual(variableRows(h), [1, land ? 1 : 0], label);
    assert.equal(valueRowOf(variableGroup(h).pending).dispatched, true, `${label}: possibly sent`);
    for (const approvals of [[], ['adopt:environmentVariable:contoso_key', VALUE_APPROVAL]]) {
      const again = await pass(await laterProcess(h, approvals), secretSpec(), secretValue());
      assert.deepEqual(variablePosts(again), [], `${label}: never sent again (${approvals})`);
      // Only a value that landed as sent can be adopted, and only under the value's own approval.
      assert.equal(!again.halt, land && approvals.length > 0, `${label} (${approvals}): ${said(again)}`);
    }
  }
});

// Two later processes complete the same refused value at once: the store's claim admits one, so one request leaves.
test('two later builds completing one refused variable value send it once', async () => {
  const { h, allow } = await valueRefusedSecret();
  allow();
  const [a, b] = [await laterProcess(h), await laterProcess(h)];
  const mark = h.org.requests.length;
  const outs = await Promise.all([pass(a, secretSpec(), secretValue()), pass(b, secretSpec(), secretValue())]);
  assert.equal(h.org.requests.slice(mark).filter(isValuePost).length, 1, outs.map(said).join(' | '));
  assert.equal(outs.filter((o) => o.halt === null).length >= 1, true, outs.map(said).join(' | '));
  assert.deepEqual(variableRows(h), [1, 1]);
  assert.ok(variableGroup(h).committed);
});

// A process that stops at the durable seal (the value's possibly-sent mark): before it, nothing left and a later build
// sends the value; after it, nothing left either, but the mark holds and the value is never sent.
test('a value-only completion stopped at its seal: before it the value is sent later, after it never', async () => {
  for (const after of [false, true]) {
    const { h, allow } = await valueRefusedSecret();
    allow();
    const n = await laterProcess(h);
    const seal = n.store.sealRowDispatch;
    n.store.sealRowDispatch = (args) => {
      if (after) seal(args);
      throw Object.assign(new Error('the process stopped at the seal'), { code: 'managed-binding-write-failed' });
    };
    const out = await pass(n, secretSpec(), secretValue());
    assert.ok(out.halt, `after=${after}`);
    assert.deepEqual(variablePosts(out), [], `after=${after}: nothing left`);
    assert.equal(valueRowOf(variableGroup(h).pending).dispatched, after);
    const again = await pass(await laterProcess(h), secretSpec(), secretValue());
    assert.deepEqual(variablePosts(again), after ? [] : ['/environmentvariablevalues'], `after=${after}: ${said(again)}`);
    assert.equal(again.halt === null, !after, `after=${after}: ${said(again)}`);
  }
});

// The same completion for a plain (non-secret) variable whose value the service refused.
test('a string variable whose value alone the service refused completes in a later build with only its value, then sends nothing', async () => {
  const spec = configSpec({ customApis: [], duplicateDetectionRules: [], environmentVariables: [{ schemaName: 'contoso_Key', type: 'string' }] });
  let refuse = true;
  const h = await harness({ intercept: (req) => (refuse && isValuePost(req) ? VALUE_REFUSAL : undefined) });
  const first = await pass(h, spec, variableSettings(spec, 'first-value'));
  const { token, root } = variableGroup(h).pending;
  assert.equal(first.halt && first.halt.message, valueRefusedLine(token), said(first));
  refuse = false;
  const done = await pass(await laterProcess(h), spec, variableSettings(spec, 'corrected-value'));
  assert.equal(done.halt, null, said(done));
  assert.deepEqual(variablePosts(done), ['/environmentvariablevalues']);
  assert.equal(h.org.rows('environmentvariablevalues')[0].value, 'corrected-value');
  assert.equal(variableGroup(h).committed.records[0].id, root.id);
  const rerun = await pass(await laterProcess(h), spec, variableSettings(spec, 'corrected-value'));
  assert.equal(rerun.halt, null, said(rerun));
  assert.deepEqual(rerun.sent, []);
});

// The release before this one, run unchanged over each record this release's #847 path writes (a value refused, claimed,
// sealed, sent and acknowledged but not settled, and completed): it sends nothing it should not — it never sends the value
// or the definition again — and only the completed record builds.
const DOWNGRADE_SKIP = skipWithoutDowngrade();
test('the release before this one reads every variable value record this one writes and sends nothing again', { skip: DOWNGRADE_SKIP }, async () => {
  const OLD = {};
  for (const [file, names] of [
    ['lib/managed-bindings.js', ['openManagedBindings']], ['lib/managed-create-transport.js', ['createDeferredManagedCreateGate']],
    ['lib/sdk-http-client.js', ['createAzHttpClient']], ['lib/configuration-transport.js', ['configurationSendOnce']],
    ['lib/maker-sdk.js', ['createMakerSdk', 'createNodeWorkspaceStorage']], ['lib/managed-create-context.js', ['createManagedCreateContext']],
    ['lib/configuration-artifacts.js', ['readDeploymentBindings']], ['lib/configuration-build.js', ['createConfigurationRuntime']],
  ]) {
    const m = requireDowngrade(file);
    for (const name of names) OLD[name] = m[name];
  }
  OLD.B = requireDowngrade('lib/configuration-create-bindings.js');
  OLD.P = requireDowngrade('lib/configuration-protected.js');
  assert.notEqual(OLD.P, P, 'the release runs its own modules');
  for (const cut of ['refused', 'claimed', 'sealed', 'acknowledged-pending', 'committed']) {
    const { h, allow } = await valueRefusedSecret();
    allow();
    if (cut !== 'refused') {
      const n = await laterProcess(h);
      if (cut === 'claimed') {
        const p = variableGroup(h).pending;
        const v = valueRowOf(p);
        n.ctx.claimValue(p.token, { id: v.id, parentId: v.parentId, capture: n.ctx.captureReadOnly([p.token])[0], declarationSha256: p.declarationSha256 });
      } else {
        if (cut === 'sealed') {
          const seal = n.store.sealRowDispatch;
          n.store.sealRowDispatch = (args) => {
            seal(args);
            throw Object.assign(new Error('the process stopped after the seal'), { code: 'managed-binding-write-failed' });
          };
        }
        if (cut === 'acknowledged-pending') n.ctx.settle = () => { throw Object.assign(new Error('the process stopped before settling'), { code: 'managed-binding-write-failed' }); };
        await pass(n, secretSpec(), secretValue());
      }
    }
    const rows = variableRows(h);
    const out = await pass(await laterProcess(h, [], OLD), secretSpec(), variableSettings(secretSpec(), KV, OLD));
    assert.deepEqual(variablePosts(out), [], `${cut}: ${said(out)}`);
    assert.deepEqual(variableRows(h), rows, cut);
    assert.equal(out.halt === null, cut === 'committed', `${cut}: ${said(out)}`);
  }
});

test('a secret variable whose create answer was lost stays pending: never sent again, and dropped only under its exact retire approval', async () => {
  let org = null;
  let lose = true;
  const h = await harness({ intercept: async (req) => {
    if (!lose || !isVariableCreate(req)) return undefined;
    lose = false;
    await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    return { statusCode: 503, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
  } });
  org = h.org;
  const first = await pass(h, secretSpec(), secretValue());
  assert.ok(first.halt);
  assert.deepEqual(first.step.outcome.refused, [], 'a lost answer is never read as a refusal');
  assert.ok(h.store.readGroup('environmentVariable', 'contoso_key').pending, 'the outcome is unknown: the attempt stays');
  const landed = variableRows(h);
  assert.equal(landed[0], 1, 'the definition landed');
  const again = await pass(reopen(h), secretSpec(), { ...secretValue(), ...overwriteCopy('environmentVariable', 'contoso_key') });
  assert.ok(again.halt);
  assert.deepEqual(again.sent.filter(isVariableCreate), [], 'the create is not sent again');

  // Dropped from the App Spec: the build stops, names the exact approval, and sends nothing.
  const dropped = await pass(reopen(h), noConfig());
  assert.equal(dropped.halt && dropped.halt.code, 'managed-settlement-pending', dropped.halt && dropped.halt.message);
  assert.deepEqual(dropped.sent, []);
  const flag = retireFlagOf(dropped.halt);
  assert.match(flag, /^retire:environmentVariable:contoso_key@[0-9a-f-]{36}$/);
  // An approval for another attempt of the same item retires nothing.
  const other = await pass(retiring(h, [flag.replace(/@.*$/, '@00000000-0000-4000-8000-000000000009')], noConfig()), noConfig());
  assert.equal(other.halt && other.halt.code, 'managed-settlement-pending');
  assert.ok(h.store.readGroup('environmentVariable', 'contoso_key').pending);

  const warned = [];
  const out = await pass(retiring(h, [flag], noConfig()), noConfig(), { warn: (m) => warned.push(m) });
  assert.equal(out.halt, null, out.halt && `${out.halt.code}: ${out.halt.message}`);
  assert.deepEqual(out.sent, [], 'nothing is deleted or sent');
  assert.equal(h.store.readGroup('environmentVariable', 'contoso_key').pending, null);
  assert.deepEqual(variableRows(h), landed, 'the rows it may have created stay');
  assert.ok(warned.some((m) => /no longer tracks the unfinished attempt for environmentVariable contoso_key.*as approved/.test(m)), warned.join('\n'));

  // Declared again, the item is an unbound create whose derived id is taken: it stops, and nothing is created twice.
  const back = await pass(reopen(h), secretSpec(), secretValue());
  assert.equal(back.halt && back.halt.code, 'create-identity-conflict', back.halt && back.halt.message);
  assert.equal(back.halt.phase, 'preflight');
  assert.deepEqual(back.sent, []);
  assert.deepEqual(variableRows(h), landed);
});

// A create the service refused under 2.26.0, which recorded no refusal (no notStarted count): the attempt is pending in
// phase "sending" and only its own ids can complete it, so corrected settings alone still stop the build. The stop names
// the supported way out, with the exact approval: remove the item, run with the approval (nothing deleted or sent), restore
// it. The stores were written by the 2.26.0 modules (fixtures/managed-bindings-2.26-refused-secret.json says how).
const LEGACY = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'managed-bindings-2.26-refused-secret.json'), 'utf8'));
async function legacyRefused(which) {
  const seed = LEGACY[which];
  const h = await harness({ storeSeed: seed.store });
  for (const row of seed.landed) {
    const put = await h.org.request({ url: `${h.org.origin}/api/data/v9.0${row.path}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'MSCRM.SolutionUniqueName': SOL }, body: JSON.stringify(row.body) });
    assert.ok(put.statusCode < 300, String(put.statusCode));
  }
  const token = seed.store.attempts[0].token;
  assert.equal(h.store.readGroup('environmentVariable', 'contoso_key').pending.token, token, 'the 2.26.0 store is read as written');
  return { h, token, flag: `retire:environmentVariable:contoso_key@${token}` };
}
function assertLegacyStop(out, flag) {
  assert.equal(out.halt && out.halt.code, 'create-completion-required', out.halt && out.halt.message);
  assert.equal(out.halt.phase, 'preflight');
  assert.deepEqual(out.sent, [], 'corrected settings alone send nothing for it');
  assert.match(out.halt.message, /remove this item \(and its deployment-settings entry\) from the App Spec/);
  assert.ok(out.halt.message.includes(`--authorize '${flag}'`), out.halt.message);
  assert.match(out.halt.message, /then restore them and run again/);
  assert.ok(!out.halt.message.includes('vault-sample'));
}

test('a secret create a 2.26.0 build left pending after the service refused it stops with the way out; removing it, retiring it and restoring it creates it once', async () => {
  const { h, flag } = await legacyRefused('refused');
  assertLegacyStop(await pass(reopen(h), secretSpec(), secretValue()), flag);

  const retired = await pass(retiring(h, [flag], noConfig()), noConfig());
  assert.equal(retired.halt, null, retired.halt && `${retired.halt.code}: ${retired.halt.message}`);
  assert.deepEqual(retired.sent, [], 'nothing is deleted or sent');
  assert.equal(h.store.readGroup('environmentVariable', 'contoso_key').pending, null);

  const restored = await pass(reopen(h), secretSpec(), secretValue());
  assert.equal(restored.halt, null, restored.halt && `${restored.halt.code}: ${restored.halt.message}`);
  assert.equal(restored.sent.filter((r) => r.method === 'POST' && r.path.startsWith('/environmentvariabledefinitions')).length, 1, 'created once');
  assert.deepEqual(variableRows(h), [1, 1]);
  assert.equal(committed(h, 'environmentVariable', 'contoso_key').records[0].id, LEGACY.refused.store.attempts[0].root.id, 'at the same derived id');
  assert.deepEqual((await pass(reopen(h), secretSpec(), secretValue())).sent, []);
});

test('a 2.26.0 pending secret create whose definition row landed: after the retirement the restored item stops on that row, and deleting it lets the build create the item', async () => {
  const { h, flag } = await legacyRefused('valueRefused');
  assert.deepEqual(variableRows(h), [1, 0]);
  assertLegacyStop(await pass(reopen(h), secretSpec(), secretValue()), flag);

  const retired = await pass(retiring(h, [flag], noConfig()), noConfig());
  assert.equal(retired.halt, null, retired.halt && `${retired.halt.code}: ${retired.halt.message}`);
  assert.deepEqual(retired.sent, []);
  assert.deepEqual(variableRows(h), [1, 0], 'the row it made stays');

  const id = LEGACY.valueRefused.store.attempts[0].root.id;
  const back = await pass(reopen(h), secretSpec(), secretValue());
  assert.equal(back.halt && back.halt.code, 'create-identity-conflict', back.halt && back.halt.message);
  assert.equal(back.halt.phase, 'preflight');
  assert.deepEqual(back.sent, []);
  assert.ok(back.halt.message.includes(id), back.halt.message);
  assert.match(back.halt.message, /delete that row in the environment, then run again/);

  const gone = await h.org.request({ url: `${h.org.origin}/api/data/v9.0/environmentvariabledefinitions(${id})`, method: 'DELETE', headers: {} });
  assert.ok(gone.statusCode < 300, String(gone.statusCode));
  const done = await pass(reopen(h), secretSpec(), secretValue());
  assert.equal(done.halt, null, done.halt && `${done.halt.code}: ${done.halt.message}`);
  assert.deepEqual(variableRows(h), [1, 1]);
  assert.equal(committed(h, 'environmentVariable', 'contoso_key').records[0].id, id);
});

test('the retire approval is read only for an item the App Spec no longer declares, and only in its exact shape', () => {
  const flag = 'retire:environmentVariable:contoso_key@3dedb827-fb3f-4577-a6a2-ec73e634807e';
  const ok = configurationAuthorizationKeys([flag], noConfig());
  assert.deepEqual(ok.problems, []);
  assert.deepEqual([...ok.retire], ['environmentVariable\u0000contoso_key\u00003dedb827-fb3f-4577-a6a2-ec73e634807e']);
  const declared = configurationAuthorizationKeys([flag], secretSpec());
  assert.deepEqual(declared.problems.map((p) => p.code), ['CONFIGURATION_RETIRE_DECLARED']);
  assert.equal(declared.retire.size, 0);
  for (const bad of ['retire:environmentVariable:contoso_key', 'retire:environmentVariable:contoso_key@not-a-token', 'retire:form:main@3dedb827-fb3f-4577-a6a2-ec73e634807e', 'retire::@3dedb827-fb3f-4577-a6a2-ec73e634807e']) {
    const read = configurationAuthorizationKeys([bad], noConfig());
    assert.deepEqual(read.problems.map((p) => p.code), ['CONFIGURATION_RETIRE_INVALID'], bad);
    assert.equal(read.retire.size, 0, bad);
  }
});

// The same refusal for every other protected kind: released in the same run, and the corrected App Spec creates it once.
test('a plain variable, a connection reference, a Custom API and a rule whose create the service refused are released and created once by the rebuild', async () => {
  const REF = { logicalName: 'contoso_sp', connectorId: DATA_SOURCE, name: 'SharePoint' };
  const refSettings = (s) => ({ configurationBindings: readDeploymentBindings({ ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-one' }] }, s),
    connections: async () => [{ connectionId: 'conn-one', connectorId: DATA_SOURCE }] });
  const only = (over) => configSpec({ environmentVariables: [], customApis: [], duplicateDetectionRules: [], ...over });
  const cases = [
    ['environmentVariable', 'contoso_apibase', 'environmentvariabledefinitions', only({ environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', defaultValue: 'https://api.contoso.com' }] }), () => ({})],
    ['connectionReference', 'contoso_sp', 'connectionreferences', only({ connectionReferences: [REF] }), refSettings],
    ['customApi', 'contoso_calc', 'customapis', only({ customApis: [API] }), () => ({})],
    ['duplicateRule', 'email', 'duplicaterules', only({ duplicateDetectionRules: [RULE] }), () => ({})],
  ];
  for (const [kind, key, table, spec, settings] of cases) {
    let refuse = true;
    const h = await harness({ intercept: ({ method, path }) => (refuse && method === 'POST' && path.split('?')[0] === `/${table}`
      ? { statusCode: 400, body: { error: { code: '0x80040265', message: 'refused' } } } : undefined) });
    const first = await pass(h, spec, settings(spec));
    assert.equal(first.halt && first.halt.code, 'configuration-incomplete', `${kind}: ${first.halt && first.halt.message}`);
    assert.deepEqual(first.step.outcome.refused.map((r) => [r.kind, r.code]), [[kind, 'create-refused']], kind);
    assert.equal(h.store.readGroup(kind, key).pending, null, `${kind}: released`);
    assert.equal(h.org.rows(table).length, 0, kind);
    // Dropped, it holds nothing; declared again, it is created once.
    assert.equal((await pass(reopen(h), noConfig())).halt, null, `${kind}: dropping it is not held`);
    refuse = false;
    const done = await pass(reopen(h), spec, settings(spec));
    assert.equal(done.halt, null, `${kind}: ${done.halt && `${done.halt.code}: ${done.halt.message}`}`);
    assert.equal(h.org.rows(table).length, 1, `${kind}: created once`);
    assert.ok(committed(h, kind, key), kind);
  }
});
test('the sweep lets go of an undeclared attempt the store proves never sent, with no approval; one that may have been sent stays', () => {
  const R = require('./helpers/managed-rows.js');
  const sealed = [
    { kind: 'customApi', key: R.API_KEY, id: R.API, sentFields: ['uniquename'], sentSha256: R.H('7') },
    { kind: 'customApiRequestParameter', key: R.REQ_KEY, id: R.REQ, sentFields: ['uniquename'], sentSha256: R.H('8') },
  ];
  const held = (store) => {
    const [token] = store.prepareAttemptSet([R.apiPlan()]);
    return store.markAttemptSetSending([{ token, expected: R.apiExpected() }], { claim: 'first', observed: true })[0];
  };
  const prepared = R.open(makeTempDir('cfg-sweep-'));
  prepared.prepareAttemptSet([R.apiPlan()]);
  assert.deepEqual(P.pendingSweep({ spec: noConfig(), store: prepared }), { halts: [], retired: [{ kind: 'customApi', key: R.API_KEY, how: 'unsent' }] });
  assert.equal(prepared.readGroup('customApi', R.API_KEY).pending, null);

  // Its one request refused unstarted, and the run stopped before it released the attempt.
  const refused = R.open(makeTempDir('cfg-sweep-'));
  const r = held(refused);
  refused.sealRowDispatch({ ...r, rows: sealed });
  refused.noteRowsNotStarted({ ...r, rows: sealed });
  assert.deepEqual(P.pendingSweep({ spec: noConfig(), store: refused }), { halts: [], retired: [{ kind: 'customApi', key: R.API_KEY, how: 'not-started' }] });
  assert.equal(refused.readGroup('customApi', R.API_KEY).pending, null);

  const sent = R.open(makeTempDir('cfg-sweep-'));
  const s = held(sent);
  sent.sealRowDispatch({ ...s, rows: sealed });
  const { halts, retired } = P.pendingSweep({ spec: noConfig(), store: sent });
  assert.deepEqual(retired, []);
  assert.deepEqual(halts.map((x) => [x.code, x.authorize]), [['managed-settlement-pending', [`retire:customApi:${R.API_KEY}@${s.token}`]]]);
  assert.ok(sent.readGroup('customApi', R.API_KEY).pending, 'kept until approved');
  // The approval names that attempt; under it the store stops tracking it.
  assert.deepEqual(P.pendingSweep({ spec: noConfig(), store: sent, retirements: [`customApi\u0000${R.API_KEY}\u0000${s.token}`] }), { halts: [], retired: [{ kind: 'customApi', key: R.API_KEY, how: 'approved' }] });
  assert.equal(sent.readGroup('customApi', R.API_KEY).pending, null);
});