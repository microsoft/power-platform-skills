'use strict';
// Protected configuration (`configurationIdentity: "stable-v1"`): the opt-in, the whole-plan read-only preflight that stops an
// unsupported edit before the build changes anything, and the build-side hookup of the configuration create driver.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { validateAppSpec, CONFIGURATION_IDENTITY_MIN_VERSION } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { configurationSendOnce } = require('../lib/configuration-transport.js');
const { createDeferredManagedCreateGate } = require('../lib/managed-create-transport.js');
const { createManagedCreateContext } = require('../lib/managed-create-context.js');
const { openManagedBindings, managedManifestView } = require('../lib/managed-bindings.js');
const { readerFor } = require('../verify-model-app.js');
const { createConfigurationRuntime } = require('../lib/configuration-build.js');
const { readDeploymentBindings } = require('../lib/configuration-artifacts.js');
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
    // The 2.23.0 floor the opt-in asks for is a lint warning; this plugin is older than the release that ships it.
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

async function harness({ hookup = true, intercept } = {}) {
  const org = createConfigOrg({ tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }], solution: { uniqueName: SOL, version: '1.0.0.0', prefix: 'contoso' }, ...(intercept ? { intercept } : {}) });
  const gate = createDeferredManagedCreateGate();
  const httpClient = createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request: org.request, sleep: async () => {}, sendOnce: configurationSendOnce, workflowEffectGate: gate });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('cfg-protected-sdk-')), instanceUrl: org.origin, httpClient, solutionUniqueName: SOL });
  await sdk.initWorkspace();
  const store = openManagedBindings({ workspaceDir: makeTempDir('cfg-protected-store-'), environment: org.origin, appUniqueName: 'contoso_configured', solutionUniqueName: SOL });
  gate.bind(store);
  const ctx = createManagedCreateContext({ store, notFoundCode: B.NOT_FOUND_CODE });
  const protectedConfiguration = hookup ? P.createProtectedConfiguration({ store, gate, ctx, apiBase: `${org.origin}/api/data/v9.0` }) : undefined;
  return { org, sdk, store, gate, ctx, protectedConfiguration };
}
// A later process over the same binding store: a fresh managed create context (none of the earlier answers), with the
// maker's exact approvals.
function reopen(h, approvals = []) {
  const ctx = createManagedCreateContext({ store: h.store, approvals, notFoundCode: B.NOT_FOUND_CODE });
  return { ...h, ctx, protectedConfiguration: P.createProtectedConfiguration({ store: h.store, gate: h.gate, ctx, apiBase: `${h.org.origin}/api/data/v9.0` }) };
}
// One configuration pass as the build runs it: the preflight, then the data-model step. Answers what it sent.
async function pass(h, spec, opts = {}) {
  const mark = h.org.requests.length;
  const runtime = createConfigurationRuntime({ spec, sdk: h.sdk, opts: { protectedConfiguration: h.protectedConfiguration, ...opts }, appUniqueName: 'contoso_configured' });
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

  // The rerun proves the rows and the owed state at the same ids, and does not publish again.
  const again = await pass(h, configSpec());
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
  // The service applies the create, and its answer is lost on the way back.
  const h = await harness({ intercept: async (req) => {
    if (!lose || req.method !== 'POST' || req.path.split('?')[0] !== '/duplicaterules') return undefined;
    lose = false;
    await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    return { statusCode: 400, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
  } });
  org = h.org;
  const first = await pass(h, configSpec());
  assert.ok(first.halt, 'the outcome is unknown');
  const ruleId = h.store.readGroup('duplicateRule', 'email').pending.root.id;
  const writes = () => h.org.requests.filter((r) => r.method !== 'GET').length;

  const again = await pass(reopen(h), configSpec());
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
  assert.equal(out.halt && out.halt.code, 'configuration-incomplete', out.halt && out.halt.message);
  assert.deepEqual(out.step.halt.items, [{ kind: 'environmentVariable', key: 'contoso_ApiBase', code: 'create-identity-conflict' }]);
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
  assert.equal(out.halt && out.halt.code, 'configuration-incomplete', out.halt && out.halt.message);
  assert.deepEqual(out.step.halt.items, [{ kind: 'environmentVariable', key: 'contoso_ApiBase', code: 'create-identity-unverified' }]);
  assert.ok(h.org.requests.some((r) => /\$skiptoken=/.test(r.path)), 'the continuation was followed');
  assert.deepEqual(out.sent, [], 'nothing is sent');
  assert.deepEqual(h.org.rows('environmentvariabledefinitions'), []);
  assert.equal(h.store.readGroup('environmentVariable', 'contoso_apibase').committed, null);
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
  const again = await pass(reopen(h), edited);
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
  for (let i = 0; i < 2; i += 1) {
    const again = await pass(reopen(h), edited);
    assert.ok(again.halt, 'an edit that may have been sent is never replayed');
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