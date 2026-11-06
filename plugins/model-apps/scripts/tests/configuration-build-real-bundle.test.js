'use strict';

// The configuration kinds (environment variables, connection references, Custom APIs, duplicate-detection rules) and
// solution.version, end to end: buildModelApp -> runSdkBuild -> the configuration runtime (lib/configuration-build.js)
// -> the REAL maker-SDK bundle -> the strict in-memory org (tests/helpers/fake-config-org.js), which answers only the
// requests it models and lists every other one in `unexpected`. The build's own create port is the plain pass-through
// (lib/creates-passthrough.js); every build of a spec without `configurationIdentity` runs with the stable-id create
// modules made unloadable, so a request for one fails the test (tests/helpers/no-stable-create-modules.js).
//
// The `protected configuration through the build command` tests opt in (`configurationIdentity: "stable-v1"`) and run
// the production command (main) with the real bundle: the command makes the managed create gate itself, and one app
// directory carries the binding store from one run to the next, as the maker's workspace does between processes.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { runCommand: runCommandIn } = require('./helpers/configuration-command.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { withoutStableCreateModules } = require('./helpers/no-stable-create-modules.js');
const { configurationSendOnce } = require('../lib/configuration-transport.js');
const { readDeploymentBindings } = require('../lib/configuration-artifacts.js');
const { openManagedBindings } = require('../lib/managed-bindings.js');
const { buildModelApp, isTransientHalt, authorizationKeys } = require('../build-model-app.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { STAGES } = require('../lib/stages.js');
const { RETRY } = require('../lib/retry-policy.js');

const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const SQL = '/providers/Microsoft.PowerApps/apis/shared_sql';
const SECRET = 'S3cr3t-Value-0f-The-Probe';
const KV = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/contoso-kv/secrets/apikey';
// The request paths of the configuration tables and of the solution's version write; a spec without the fields sends none.
const CONFIGURATION_PATH = /^\/(environmentvariable|connectionreference|customapi|duplicaterule|AddSolutionComponent|EntityDefinitions\(LogicalName='(environmentvariable|connectionreference|customapi|duplicaterule))/i;

const CONFIGURATION_FIELDS = {
  environmentVariables: [
    { schemaName: 'contoso_ApiBase', type: 'string', defaultValue: 'https://api.contoso.com' },
    { schemaName: 'contoso_ApiKey', type: 'secret' },
  ],
  connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
  customApis: [{ uniqueName: 'contoso_Calc', isFunction: true,
    requestParameters: [{ uniqueName: 'A', type: 'integer' }], responseProperties: [{ uniqueName: 'R', type: 'string' }] }],
  duplicateDetectionRules: [{ key: 'email', name: 'Contacts with same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] }],
};

function makeSpec({ configuration = true } = {}) {
  return {
    minimumPluginVersion: '2.21.0',
    solution: { uniqueName: 'ContosoSol', displayName: 'Contoso Sol', publisherPrefix: 'contoso', ...(configuration ? { version: '1.2.0.0' } : {}) },
    app: { name: 'Config Probe', uniqueName: 'contoso_configprobe' },
    schemaVersion: 2,
    entities: [],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Links', subAreas: [{ url: 'https://contoso.example/help', title: 'Help' }] }] }] },
    ...(configuration ? CONFIGURATION_FIELDS : {}),
  };
}

// Per-environment settings in the `pac solution create-settings` shape: a planted secret and a Key Vault reference as values.
const bindingsFor = (spec) => {
  const b = readDeploymentBindings({
    EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: SECRET }, { SchemaName: 'contoso_ApiKey', Value: KV }],
    ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-1' }],
  }, spec);
  assert.deepEqual(b.errors, []);
  return b;
};

// `lose(request)` -> true commits the request in the org and then answers it 503, as a gateway that dropped the answer does.
// The client composes the send-once rule as build-model-app.js makes its own (the translation-export half answers false here).
async function harness({ lose, ...orgOptions } = {}) {
  const org = createConfigOrg({
    tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }],
    solution: { uniqueName: 'ContosoSol', version: '1.0.0.0', prefix: 'contoso' },
    ...orgOptions,
  });
  const request = async (req) => {
    const answer = await org.request(req);
    const where = String(req.url).replace(/^https:\/\/[^/]+\/api\/data\/v9\.\d/, '');
    if (lose && lose({ method: String(req.method).toUpperCase(), path: where })) {
      return { statusCode: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80040216', message: 'Service unavailable' } }) };
    }
    return answer;
  };
  const httpClient = createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request, sleep: async () => {}, sendOnce: (m, u) => configurationSendOnce(m, u) });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('config-build-sdk-')), instanceUrl: org.origin, httpClient, solutionUniqueName: 'ContosoSol' });
  await sdk.initWorkspace();
  return { org, sdk };
}

const proven = async () => [{ connectionId: 'conn-1', connectorId: SP }];

// One CLI-shaped build of the data stage through buildModelApp; the build's create port is its default (the plain pass-through).
async function build(h, spec, { opts = {}, deps = {} } = {}) {
  const logs = [];
  const warns = [];
  const mark = h.org.requests.length;
  let r;
  let thrown;
  const { requested } = await withoutStableCreateModules(async () => {
    try {
      r = await buildModelApp(spec, { apply: true, env: h.org.origin, phases: STAGES.data, workspaceDir: makeTempDir('config-build-ws-'), retryDelayMs: 0, ...opts },
        { sdk: h.sdk, log: (l) => logs.push(String(l)), warn: (w) => warns.push(String(w)), connections: proven, ...deps });
    } catch (err) {
      thrown = err;
    }
  });
  assert.deepEqual(requested, [], 'no stable-id create module is loaded');
  return { r, thrown, logs, warns, writes: h.org.writes(mark), requests: h.org.requests.slice(mark) };
}

test('a build sets the solution version and creates every configuration kind; the same spec again sends no write', async () => {
  const h = await harness();
  const spec = makeSpec();
  const first = await build(h, spec, { opts: { configurationBindings: bindingsFor(spec) } });
  if (first.thrown) throw first.thrown;
  assert.equal(first.r.ok, true, JSON.stringify(first.r.errors));
  assert.deepEqual(h.org.unexpected, [], 'every request is one the org models');
  assert.equal(h.org.rows('solutions').find((s) => s.uniquename === 'ContosoSol').version, '1.2.0.0');
  const counts = Object.fromEntries(['environmentvariabledefinitions', 'environmentvariablevalues', 'connectionreferences', 'customapis',
    'customapirequestparameters', 'customapiresponseproperties', 'duplicaterules', 'duplicateruleconditions'].map((t) => [t, h.org.rows(t).length]));
  assert.deepEqual(Object.values(counts), [2, 2, 1, 1, 1, 1, 1, 1], JSON.stringify(counts));
  assert.equal(h.org.rows('connectionreferences')[0].connectionid, 'conn-1');
  // The settings file's values never reach the result or anything printed.
  assert.ok(!JSON.stringify(first.r).includes(SECRET), 'the result carries no setting value');
  assert.ok(![...first.logs, ...first.warns].join('\n').includes(SECRET), 'nothing printed carries a setting value');

  const again = await build(h, spec, { opts: { configurationBindings: bindingsFor(spec) } });
  if (again.thrown) throw again.thrown;
  assert.equal(again.r.ok, true, JSON.stringify(again.r.errors));
  assert.deepEqual(again.writes, [], 'an unchanged rerun writes nothing');
  assert.deepEqual(h.org.unexpected, []);
});

test('a lost create answer stops the configuration step as unknown: the items before it are kept, it is sent once and the build is not retried', async () => {
  let posts = 0;
  const lose = ({ method, path: p }) => method === 'POST' && /^\/customapis\b/.test(p) && ++posts >= 1;
  const h = await harness({ lose });
  const spec = makeSpec();
  let runs = 0;
  const counting = async (...a) => { runs += 1; return runSdkBuild(...a); };
  const out = await build(h, spec, { opts: { configurationBindings: bindingsFor(spec), maxRetries: 3 }, deps: { runBuild: counting } });
  assert.ok(out.thrown, 'the build halted');
  assert.equal(out.thrown.code, 'configuration-incomplete');
  assert.equal(runs, 1, 'the whole-build retry did not run the phases again');
  assert.equal(posts, 1, 'the create whose answer was lost was sent once');
  assert.equal(h.org.rows('environmentvariabledefinitions').length, 2, 'the items before the unknown one were made');
  assert.equal(h.org.rows('connectionreferences').length, 1);
  assert.ok(!`${out.thrown.message} ${JSON.stringify(out.thrown)}`.includes(SECRET));

  // The halt itself: never retried, and not one of the texts the CLI treats as transient.
  posts = 0;
  const h2 = await harness({ lose });
  let caught;
  const { requested } = await withoutStableCreateModules(async () => {
    try {
      await runSdkBuild(spec, { sdk: h2.sdk, apply: true, phases: STAGES.data, workspaceDir: makeTempDir('config-build-ws-'), configurationBindings: bindingsFor(spec), connections: proven, emit: () => {} });
    } catch (e) { caught = e; }
  });
  assert.deepEqual(requested, []);
  assert.ok(caught, 'runSdkBuild throws the halt');
  assert.equal(caught.code, 'configuration-incomplete');
  assert.equal(caught.phase, 'data-model');
  assert.equal(caught.retry, RETRY.NEVER);
  assert.equal(isTransientHalt(caught, { spec }), false);
});

test('a connection the settings name must be proven by the connection list: none listed, or one of another connector, halts the step', async () => {
  for (const connections of [async () => [], async () => [{ connectionId: 'conn-1', connectorId: SQL }]]) {
    const h = await harness();
    const spec = makeSpec();
    const out = await build(h, spec, { opts: { configurationBindings: bindingsFor(spec) }, deps: { connections } });
    assert.ok(out.thrown, 'the build halted');
    assert.equal(out.thrown.code, 'configuration-incomplete');
    assert.match(out.thrown.message, /1 configuration item not completed: connectionReference contoso_sp \(CONNECTION_REFERENCE_UNBOUND\)$/);
    assert.ok(!out.thrown.message.includes(SECRET));
  }
});

// A refusal that needs consent prints the exact flag the CLI accepts, and passing that flag settles it. The halt names the key and
// field only: never the value being cleared.
test('a configuration change that needs consent halts with its exact --authorize flag, and that flag lets the next build apply it', async () => {
  const h = await harness();
  const spec = makeSpec({ configuration: false });
  spec.environmentVariables = [{ schemaName: 'contoso_Mode', type: 'string', defaultValue: 'enabled' }];
  const first = await build(h, spec);
  if (first.thrown) throw first.thrown;
  assert.equal(first.r.ok, true, JSON.stringify(first.r.errors));

  const cleared = structuredClone(spec);
  cleared.environmentVariables[0].defaultValue = null;
  const refused = await build(h, cleared);
  assert.equal(refused.thrown && refused.thrown.code, 'configuration-incomplete');
  assert.deepEqual(refused.writes, []);
  assert.match(refused.thrown.message, /1 configuration item not completed: environmentVariable contoso_Mode \(DESTRUCTIVE_CHANGE_UNAUTHORIZED\) \(approve with --authorize environmentVariable:contoso_mode:defaultValue\)$/);
  assert.ok(!/enabled/.test([refused.thrown.message, ...refused.logs, ...refused.warns].join('\n')), 'the halt never prints the value');

  const printed = /--authorize (\S+)\)$/.exec(refused.thrown.message)[1];
  const parsed = authorizationKeys(['--authorize', printed], cleared);
  assert.equal(parsed.error, null);
  const approved = await build(h, cleared, { opts: { authorizedDestructive: parsed.keys } });
  if (approved.thrown) throw approved.thrown;
  assert.equal(approved.r.ok, true, JSON.stringify(approved.r.errors));
  assert.equal(approved.writes.length, 1, JSON.stringify(approved.writes));
  assert.match(approved.writes[0], /^PATCH \/environmentvariabledefinitions\(/);
  assert.deepEqual(h.org.unexpected, []);
});

test('a configuration row the build cannot record as managed, and a child the solution add does not prove, stop the step as unknown', async () => {
  // A recorder that cannot keep a record: the item is reported unconfirmed, never assumed managed.
  const h = await harness();
  const spec = makeSpec();
  const refusing = { recordApplied: async () => { throw new Error('store unavailable'); } };
  const out = await build(h, spec, { opts: { configurationBindings: bindingsFor(spec) }, deps: { managed: refusing } });
  assert.ok(out.thrown, 'the build halted');
  assert.equal(out.thrown.code, 'configuration-incomplete');
  assert.match(out.thrown.message, /\(CONFIGURATION_RECORD_UNCONFIRMED\)/);
  assert.ok(!out.thrown.message.includes('store unavailable'), 'the recorder\u2019s own text is not quoted');

  // An add the platform answers without making the condition a member is no proof of membership.
  const silent = await harness({ intercept: ({ method, path: p, body }) => (method === 'POST' && p === '/AddSolutionComponent' && body && body.ComponentType === 4416
    ? { statusCode: 200, body: { id: '00000000-0000-0000-0000-000000000045' } } : undefined) });
  const unproven = await build(silent, spec, { opts: { configurationBindings: bindingsFor(spec) } });
  assert.ok(unproven.thrown, 'the build halted');
  assert.equal(unproven.thrown.code, 'configuration-incomplete');
  assert.match(unproven.thrown.message, /duplicateRuleCondition email\|e \(SOLUTION_MEMBERSHIP_UNKNOWN\)/);
});

// A current environment refuses the documented duplicate-rule types: AddSolutionComponent with 45 answers
//   400 {"error":{"code":"0x80040216","message":"Invalid component type provided 45"}}
// and the solution lists the rule and its condition under the duplicaterule and duplicaterulecondition tables' ObjectTypeCodes (the
// fake answers 4414 and 4416). The build reads those types and settles both; a type it cannot read is never guessed.
const RULE_ONLY = () => ({ ...makeSpec({ configuration: false }), duplicateDetectionRules: CONFIGURATION_FIELDS.duplicateDetectionRules });
const adds = (requests) => requests.filter((r) => r.method === 'POST' && r.path === '/AddSolutionComponent').map((r) => r.body.ComponentType);
const ruleWrites = (writes) => writes.filter((w) => /duplicaterule|AddSolutionComponent/i.test(w));
const membershipKeys = (h) => new Set(h.org.rows('solutioncomponents').map((m) => `${m.componenttype}:${m.objectid}`));

test('a duplicate rule and its condition settle in the build solution under the types the platform lists, never under 44 or 45', async () => {
  const h = await harness();
  const first = await build(h, RULE_ONLY());
  if (first.thrown) throw first.thrown;
  assert.equal(first.r.ok, true, JSON.stringify(first.r.errors));
  assert.deepEqual(h.org.unexpected, []);
  const read = first.requests.filter((r) => r.method === 'GET' && /^\/EntityDefinitions\(LogicalName='duplicaterule/.test(String(r.path))).map((r) => String(r.path));
  // A new rule's types are read before it is written: the rule's, then its conditions'. Each is read once.
  assert.deepEqual(read, ["/EntityDefinitions(LogicalName='duplicaterule')?$select=ObjectTypeCode", "/EntityDefinitions(LogicalName='duplicaterulecondition')?$select=ObjectTypeCode"]);
  const firstRuleWrite = first.requests.findIndex((r) => r.method !== 'GET' && /^\/duplicaterule/.test(String(r.path)));
  assert.ok(first.requests.findIndex((r) => String(r.path).startsWith("/EntityDefinitions(LogicalName='duplicaterulecondition')")) < firstRuleWrite);
  // The rule rides in on its create header; the condition the compound create left out is added under its table's type.
  assert.deepEqual(adds(first.requests), [4416]);
  const members = membershipKeys(h);
  assert.ok(members.has(`4414:${h.org.rows('duplicaterules')[0].duplicateruleid}`));
  assert.ok(members.has(`4416:${h.org.rows('duplicateruleconditions')[0].duplicateruleconditionid}`));
  const again = await build(h, RULE_ONLY());
  if (again.thrown) throw again.thrown;
  assert.equal(again.r.ok, true, JSON.stringify(again.r.errors));
  assert.deepEqual(again.writes, [], 'an unchanged rerun writes nothing');

  // A solution that still lists them under the classic types holds the same components (the SDK's own solution reader folds 44 and
  // 45 so): proof, and no add.
  for (const row of h.org.sets.get('solutioncomponents').values()) {
    if (row.componenttype === 4414) row.componenttype = 44;
    if (row.componenttype === 4416) row.componenttype = 45;
  }
  const classic = await build(h, RULE_ONLY());
  if (classic.thrown) throw classic.thrown;
  assert.equal(classic.r.ok, true, JSON.stringify(classic.r.errors));
  assert.deepEqual(classic.writes, []);
  assert.deepEqual(h.org.unexpected, []);
});

test('a duplicate-rule component type the build cannot read is never guessed: the item is unknown and nothing is added for it', async () => {
  const unreadable = await harness({ intercept: ({ method, path: p }) => (method === 'GET' && p.startsWith("/EntityDefinitions(LogicalName='duplicaterulecondition')")
    ? { statusCode: 500, body: { error: { code: '0x80040216', message: 'unavailable' } } } : undefined) });
  const out = await build(unreadable, RULE_ONLY());
  assert.ok(out.thrown, 'the build halted');
  assert.equal(out.thrown.code, 'configuration-incomplete');
  assert.match(out.thrown.message, /duplicateRuleCondition email\|e \(SOLUTION_COMPONENT_TYPE_UNREADABLE\)/);
  assert.deepEqual(adds(out.requests), []);
  // The type is read before the rule is written, so the rule is not created or published either.
  assert.deepEqual(ruleWrites(out.writes), []);
  assert.equal(unreadable.org.rows('duplicaterules').length, 0);
});

test('a new duplicate rule whose own component type the build cannot read stops the step before any write: not created, published or added', async () => {
  const unreadable = await harness({ intercept: ({ method, path: p }) => (method === 'GET' && p.startsWith("/EntityDefinitions(LogicalName='duplicaterule')")
    ? { statusCode: 500, body: { error: { code: '0x80040216', message: 'unavailable' } } } : undefined) });
  const out = await build(unreadable, RULE_ONLY());
  assert.ok(out.thrown, 'the build halted');
  assert.equal(out.thrown.code, 'configuration-incomplete');
  assert.deepEqual(adds(out.requests), [], 'no component is added before the rule type is known');
  assert.match(out.thrown.message, /duplicateRule email \(SOLUTION_COMPONENT_TYPE_UNREADABLE\)/);
  assert.ok(!/SOLUTION_MEMBERSHIP_UNKNOWN/.test(out.thrown.message), out.thrown.message);
  assert.deepEqual(ruleWrites(out.writes), []);
  assert.equal(unreadable.org.rows('duplicaterules').length, 0);
});

// A reused rule the edit adds a condition to: the update creates the condition in the same push, so the condition's type is read
// before that push, whatever the rule's status. Unreadable, it stops the step with no write: the rule keeps its one condition.
// A rule that exists but is not yet in the build solution (reused or adopted from elsewhere) would be added to it before the update,
// so the type is read before that add too: the solution is not changed either.
for (const status of ['unpublished', 'published']) for (const unjoined of [false, true]) {
  test(`a duplicate rule (${status}${unjoined ? ', not yet in the build solution' : ''}) an edit adds a condition to reads the condition type before the update: unreadable, nothing is written`, async () => {
    let fail = false;
    const h = await harness({ intercept: ({ method, path: p }) => (fail && method === 'GET' && p.startsWith("/EntityDefinitions(LogicalName='duplicaterulecondition')")
      ? { statusCode: 500, body: { error: { code: '0x80040216', message: 'unavailable' } } } : undefined) });
    const spec = { ...RULE_ONLY(), duplicateDetectionRules: CONFIGURATION_FIELDS.duplicateDetectionRules.map((r) => ({ ...r, status })) };
    const first = await build(h, spec);
    if (first.thrown) throw first.thrown;
    assert.equal(h.org.rows('duplicaterules')[0].statecode, status === 'published' ? 1 : 0);
    if (unjoined) h.org.sets.get('solutioncomponents').clear();
    const members = h.org.rows('solutioncomponents').length;
    fail = true;
    const edited = { ...spec, duplicateDetectionRules: spec.duplicateDetectionRules.map((r) => ({ ...r, conditions: [...r.conditions, { key: 'l', column: 'lastname', match: 'exact' }] })) };
    const out = await build(h, edited);
    assert.ok(out.thrown, 'the build halted');
    assert.equal(out.thrown.code, 'configuration-incomplete');
    assert.deepEqual(out.writes, [], 'nothing is written before the new condition\u2019s type is known');
    assert.equal(h.org.rows('solutioncomponents').length, members, 'the solution is not changed');
    assert.equal(h.org.rows('duplicateruleconditions').length, 1, 'the rule keeps its one condition');
    assert.match(out.thrown.message, /duplicateRuleCondition email\|l \(SOLUTION_COMPONENT_TYPE_UNREADABLE\)/);
    assert.ok(!/SOLUTION_MEMBERSHIP_UNKNOWN/.test(out.thrown.message), out.thrown.message);
    assert.equal(h.org.rows('duplicaterules')[0].statecode, status === 'published' ? 1 : 0);
    assert.deepEqual(h.org.unexpected, []);
  });
}

// The publish job fails after its request was accepted, as one does on an environment whose async host has not yet seen a
// table created moments earlier: PublishDuplicateRule answers 200 and its asyncoperation ends Failed (statecode 3, statuscode 31).
const PUBLISH_JOB = '00000000-0000-4000-8000-0000000000f1';
const failingPublish = async (enabled = () => true) => {
  const h = await harness({ intercept: ({ method, path: p }) => (enabled() && method === 'POST' && /\/Microsoft\.Dynamics\.CRM\.PublishDuplicateRule$/.test(p)
    ? { statusCode: 200, body: { asyncoperationid: PUBLISH_JOB } } : undefined) });
  h.org.sets.get('asyncoperations').set(PUBLISH_JOB, { asyncoperationid: PUBLISH_JOB, statecode: 3, statuscode: 31, operationtype: 7, name: 'Publish duplicate rule',
    message: 'The entity was not found in the MetadataCache.' });
  return h;
};
const PUBLISH_HINT = '(saved, but its publication did not complete: publish the rule in the environment\'s duplicate detection rules settings, '
  + 'or set "status": "published" on it in the App Spec and build again; a build without "status" keeps it unpublished)';

test('a duplicate rule saved but not published says how to finish it; a rebuild without status keeps it unpublished, one with status publishes it', async () => {
  let failPublish = true;
  const h = await failingPublish(() => failPublish);
  const first = await build(h, RULE_ONLY());
  assert.ok(first.thrown, 'the build halted');
  assert.equal(first.thrown.code, 'configuration-incomplete');
  assert.equal(first.thrown.message, `data-model failed: 1 configuration item not completed: duplicateRule email (DUPLICATE_RULE_PUBLISH_FAILED) ${PUBLISH_HINT}`);
  assert.equal(h.org.rows('duplicaterules')[0].statecode, 0, 'the rule is saved and unpublished');

  // The documented rule holds: a rule whose spec omits status keeps the status it has, so a rebuild reports it unchanged.
  const again = await build(h, RULE_ONLY());
  if (again.thrown) throw again.thrown;
  assert.deepEqual(again.writes, []);
  assert.equal(h.org.rows('duplicaterules')[0].statecode, 0);

  // The hint's second way: status "published" on the rule publishes it on the next build.
  failPublish = false;
  const published = { ...RULE_ONLY(), duplicateDetectionRules: CONFIGURATION_FIELDS.duplicateDetectionRules.map((r) => ({ ...r, status: 'published' })) };
  const fixed = await build(h, published);
  if (fixed.thrown) throw fixed.thrown;
  assert.equal(fixed.r.ok, true, JSON.stringify(fixed.r.errors));
  assert.equal(h.org.rows('duplicaterules')[0].statecode, 1);
  assert.deepEqual(h.org.unexpected, []);
});

// The hint is carried by a marker on the halt item that is not one of its fields: a caller that reads or serializes the items
// still sees {kind, key, code}. The configuration runtime rebuilds the message from the same items when recording what the step
// made fails (configuration-build.js), and the hint stays in that message too. One run covers both: the step's own halt items
// are the ones the rebuilt halt carries. (Each failed publish costs the SDK's full publish wait, so this is one build, not two.)
test('the publication hint leaves the halt item {kind, key, code} and survives the message a failed record rebuilds', async () => {
  const { createConfigurationRuntime } = require('../lib/configuration-build.js');
  const h = await failingPublish();
  const records = [];
  const managed = { recordApplied: async (rec) => { records.push(rec.kind); throw new Error('store unavailable'); } };
  const runtime = createConfigurationRuntime({ spec: RULE_ONLY(), sdk: h.sdk, opts: { managed }, appUniqueName: 'contoso_hintpin' });
  const step = await runtime.apply('data-model');
  assert.equal(step.halt.code, 'configuration-incomplete');
  const pending = step.halt.items.find((p) => p.code === 'DUPLICATE_RULE_PUBLISH_FAILED');
  assert.ok(pending, JSON.stringify(step.halt.items));
  assert.deepEqual(Object.keys(pending), ['kind', 'key', 'code']);
  assert.equal(JSON.stringify(pending), '{"kind":"duplicateRule","key":"email","code":"DUPLICATE_RULE_PUBLISH_FAILED"}');
  const marker = Object.getOwnPropertySymbols(pending);
  assert.equal(marker.length, 1);
  assert.equal(Object.getOwnPropertyDescriptor(pending, marker[0]).enumerable, false);
  // The record failed, so this message is the runtime's rebuild of the step's halt, with the unconfirmed record added.
  assert.ok(records.length > 0, 'the runtime tried to record what the step made');
  assert.ok(step.halt.items.some((p) => p.code === 'CONFIGURATION_RECORD_UNCONFIRMED'), JSON.stringify(step.halt.items));
  assert.match(step.halt.message, /\(CONFIGURATION_RECORD_UNCONFIRMED\)/);
  assert.ok(step.halt.message.includes(`duplicateRule email (DUPLICATE_RULE_PUBLISH_FAILED) ${PUBLISH_HINT}`), step.halt.message);
  assert.ok(!step.halt.message.includes('store unavailable'));
  assert.throws(() => runtime.throwIfIncomplete(step), (e) => e.code === 'configuration-incomplete' && e.message.includes(PUBLISH_HINT));
  assert.deepEqual(h.org.unexpected, []);
});

test('the other configuration kinds keep their component types and read no duplicate-rule metadata', async () => {
  const h = await harness();
  const spec = makeSpec();
  delete spec.duplicateDetectionRules;
  const out = await build(h, spec, { opts: { configurationBindings: bindingsFor(spec) } });
  if (out.thrown) throw out.thrown;
  assert.equal(out.r.ok, true, JSON.stringify(out.r.errors));
  assert.ok(!out.requests.some((r) => /duplicaterule/i.test(String(r.path))), 'no duplicate-rule request');
  assert.deepEqual(adds(out.requests).sort((a, b) => a - b), [10134, 10135]);
  const types = [...membershipKeys(h)].map((k) => Number(k.split(':')[0])).sort((a, b) => a - b);
  assert.deepEqual(types, [380, 380, 10132, 10133, 10134, 10135]);
  assert.deepEqual(h.org.unexpected, []);
});

test('a spec without the configuration fields sends no configuration request and its result has no configuration entry', async () => {
  const h = await harness();
  const spec = makeSpec({ configuration: false });
  const out = await build(h, spec);
  if (out.thrown) throw out.thrown;
  assert.equal(out.r.ok, true, JSON.stringify(out.r.errors));
  assert.deepEqual(out.requests.filter((r) => CONFIGURATION_PATH.test(String(r.path))).map((r) => `${r.method} ${r.path}`), []);
  assert.ok(!out.requests.some((r) => r.method === 'PATCH' && /^\/solutions\(/.test(String(r.path))), 'the solution\u2019s version is not written');
  const result = out.r.result || out.r;
  assert.ok(!('configuration' in (result.created || {})), 'no configuration entry');
  assert.ok(!('configurationVersion' in result));
  assert.deepEqual(h.org.unexpected, []);
});

// The build COMMAND (build-model-app.js main), with the SDK it makes itself (makeSdk over the real bundle): the tests above hand the
// engine an SDK they prepared, so they never meet the solution-scoped instance the command builds. Only what reaches outside the process
// is a double: the transport (the strict org above, behind the plugin's own az-token client), the identity check, the language read, the
// page backend and telemetry. Each SDK the command makes is watched for `initWorkspace`, which reads and writes local files only.
const commandOrg = (extra = {}) => createConfigOrg({
  ...extra,
  tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }],
  solution: { uniqueName: 'ContosoSol', version: '1.0.0.0', prefix: 'contoso' },
});

// One invocation of the command (helpers/configuration-command.js) over `org` and the app folder `appDir`, a new one of each by default.
function runCommand(spec, { org = commandOrg(), appDir = path.join(makeTempDir('config-command-'), 'app'), ...options } = {}) {
  return runCommandIn(spec, { org, appDir, ...options });
}

test('the build command creates a declared environment variable through the SDK it makes itself, and prepares that SDK\u2019s workspace without a request', async () => {
  const spec = makeSpec();
  // A connection reference's binding is proven through the Power Apps service, which this command reaches outside the process.
  delete spec.connectionReferences;
  delete spec.duplicateDetectionRules;
  const { result: out, requested } = await withoutStableCreateModules(() => runCommand(spec));
  assert.deepEqual(requested, [], 'no stable-id create module is loaded');
  assert.equal(out.thrown && out.thrown.message, undefined, 'the build did not halt');
  assert.ok(!/WORKSPACE_NOT_INITIALIZED/.test(`${out.stderr} ${JSON.stringify(out.payload)}`), `no workspace halt: ${out.stderr.slice(-600)}`);
  assert.equal(out.exitCode, 0, out.stderr.slice(-600));
  assert.deepEqual(out.org.rows('environmentvariabledefinitions').map((r) => r.schemaname).sort(), ['contoso_ApiBase', 'contoso_ApiKey']);
  assert.equal(out.org.rows('customapis').length, 1);
  const scoped = out.sdks.filter((s) => s.scoped);
  assert.equal(scoped.length, 1, 'one solution-scoped SDK');
  assert.equal(scoped[0].inits, 1, 'its workspace is prepared once');
  assert.deepEqual(scoped[0].requestsAtInit, [0], 'preparing it sends nothing');
  assert.deepEqual(out.org.unexpected, []);

  // The same command again, in the same app folder: the throwaway workspace is new, and each item is read back from the server.
  const mark = out.org.requests.length;
  const again = (await withoutStableCreateModules(() => runCommand(spec, { org: out.org, appDir: out.appDir }))).result;
  assert.equal(again.thrown && again.thrown.message, undefined, 'the rerun did not halt');
  assert.equal(again.exitCode, 0, again.stderr.slice(-600));
  assert.deepEqual(out.org.writes(mark), [], 'an unchanged rerun writes nothing');
  assert.deepEqual(out.org.unexpected, []);
});

test('the build command\u2019s dry run of a spec with configuration items plans them without a workspace halt', async () => {
  const spec = makeSpec();
  delete spec.connectionReferences;
  delete spec.duplicateDetectionRules;
  const { result: out } = await withoutStableCreateModules(() => runCommand(spec, { apply: false, argv: ['--stage', 'data'] }));
  assert.equal(out.thrown && out.thrown.message, undefined, 'the dry run did not halt');
  assert.ok(!/WORKSPACE_NOT_INITIALIZED/.test(`${out.stderr} ${JSON.stringify(out.payload)}`), out.stderr.slice(-600));
  assert.equal(out.exitCode, 0, out.stderr.slice(-600));
  assert.deepEqual(out.org.writes(0), [], 'a dry run writes nothing');
  assert.deepEqual(out.org.unexpected, []);
});

test('the build command leaves the solution-scoped SDK\u2019s workspace unprepared for a spec without configuration items', async () => {
  const { result: out, requested } = await withoutStableCreateModules(() => runCommand(makeSpec({ configuration: false })));
  assert.deepEqual(requested, []);
  if (out.thrown) throw out.thrown;
  assert.equal(out.exitCode, 0, out.stderr.slice(-600));
  const scoped = out.sdks.filter((s) => s.scoped);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].inits, 0, 'nothing is prepared that the spec does not use');
  assert.deepEqual(out.org.requests.filter((r) => CONFIGURATION_PATH.test(String(r.path))).map((r) => `${r.method} ${r.path}`), []);
  assert.deepEqual(out.org.unexpected, []);
});

// Protected configuration identities (configurationIdentity "stable-v1") through the build COMMAND: the deferred managed-create gate
// the command makes for them, bound to the app folder's binding store, and the configuration hookup the engine builds over both. Each
// runCommand is a new invocation (a new gate, context, SDK and throwaway SDK workspace) over the same app folder, so the binding store
// carries over between them as it does between processes; the org lives on. Nothing here reaches outside the process.
const PROTECTED_ROWS = ['environmentvariabledefinitions', 'customapis', 'customapirequestparameters', 'customapiresponseproperties', 'duplicaterules', 'duplicateruleconditions'];
const PROTECTED_MODULE = /(^|[\\/])(managed-create-(transport|context|batch)|configuration-protected|configuration-create-bindings)(\.js)?$/;
function protectedSpec(over = {}) {
  const spec = { ...makeSpec(), configurationIdentity: 'stable-v1', ...over };
  // A connection reference's binding is proven through the Power Apps service, which this command reaches outside the process.
  delete spec.connectionReferences;
  return spec;
}
const rowCounts = (org) => Object.fromEntries(PROTECTED_ROWS.map((set) => [set, org.rows(set).length]));
// The root creates (a Custom API's and a rule's children ride in their root's body): `org.writes` lists `METHOD path` without the query.
const rootCreates = (org, since = 0) => org.writes(since).filter((w) => /^POST \/(environmentvariabledefinitions|environmentvariablevalues|customapis|duplicaterules)$/.test(w));
const runAgain = (spec, base, argv) => runCommand(spec, { org: base.org, appDir: base.appDir, ...(argv ? { argv } : {}) });
const DATA = ['--stage', 'data', '--allow-destructive'];
const authorize = (tokens) => tokens.flatMap((t) => ['--authorize', t]);
// Every module the run asked for by a protected name, cached or not (Module.prototype.require sees both).
async function protectedModulesLoadedBy(fn) {
  const Module = require('node:module');
  const requested = [];
  const original = Module.prototype.require;
  Module.prototype.require = function recordProtected(id) {
    if (typeof id === 'string' && PROTECTED_MODULE.test(id)) requested.push(id);
    return original.apply(this, arguments);
  };
  try {
    return { result: await fn(), requested };
  } finally {
    Module.prototype.require = original;
  }
}

test('protected configuration through the build command: every root and child create carries its derived id, the ids are bound, and a later run sends no create', async () => {
  const out = await runCommand(protectedSpec());
  assert.equal(out.thrown && out.thrown.message, undefined, 'the build did not halt');
  assert.equal(out.exitCode, 0, out.stderr.slice(-600));
  const bound = out.payload.created.configuration.managedBindings;
  assert.deepEqual(bound.map((b) => `${b.kind}:${b.key}:${b.origin}`).sort(),
    ['customApi:contoso_Calc:created', 'duplicateRule:email:created', 'environmentVariable:contoso_ApiBase:created', 'environmentVariable:contoso_ApiKey:created']);
  const of = (kind, key) => bound.find((b) => b.kind === kind && b.key === key);
  const posted = (set) => out.org.requests.filter((r) => r.method === 'POST' && String(r.path).split('?')[0] === `/${set}`).map((r) => r.body);
  assert.deepEqual(posted('environmentvariabledefinitions').map((b) => b.environmentvariabledefinitionid).sort(),
    [of('environmentVariable', 'contoso_ApiBase').id, of('environmentVariable', 'contoso_ApiKey').id].sort());
  const [api] = posted('customapis');
  assert.equal(api.customapiid, of('customApi', 'contoso_Calc').id);
  assert.equal(api.CustomAPIRequestParameters[0].customapirequestparameterid, of('customApi', 'contoso_Calc').childIds['request:a']);
  assert.equal(api.CustomAPIResponseProperties[0].customapiresponsepropertyid, of('customApi', 'contoso_Calc').childIds['response:r']);
  const [rule] = posted('duplicaterules');
  assert.equal(rule.duplicateruleid, of('duplicateRule', 'email').id);
  assert.equal(rule.DuplicateRule_DuplicateRuleConditions[0].duplicateruleconditionid, of('duplicateRule', 'email').childIds.e);
  // The rows are where the bindings say.
  assert.equal(out.org.rows('customapis')[0].customapiid, api.customapiid);
  assert.equal(out.org.rows('duplicaterules')[0].duplicateruleid, rule.duplicateruleid);
  // The ids are derived, not minted: the same App Spec on another org at the same address gets the same ones.
  const elsewhere = await runCommand(protectedSpec());
  assert.deepEqual(elsewhere.payload.created.configuration.managedBindings.map((b) => b.id), bound.map((b) => b.id));

  const mark = out.org.requests.length;
  const again = await runAgain(protectedSpec(), out);
  assert.equal(again.thrown && again.thrown.message, undefined, 'the rerun did not halt');
  assert.equal(again.exitCode, 0, again.stderr.slice(-600));
  assert.deepEqual(out.org.writes(mark), [], 'an unchanged rerun writes nothing');
  assert.deepEqual(rowCounts(out.org), { environmentvariabledefinitions: 2, customapis: 1, customapirequestparameters: 1, customapiresponseproperties: 1, duplicaterules: 1, duplicateruleconditions: 1 });
  assert.deepEqual(out.org.unexpected, []);
});

test('protected configuration through the build command: a create whose answer was lost is never sent again, and its rows are bound only under their exact approvals', async () => {
  let org = null;
  let sends = 0;
  let replaying = false;
  // The service applies the Custom API's first create, and its answer is lost on the way back (a gateway's 503). `sends` counts the
  // creates the build sent; the intercept's own replay of that one request into the org is not one of them.
  org = commandOrg({ intercept: async (req) => {
    if (replaying || req.method !== 'POST' || req.path.split('?')[0] !== '/customapis') return undefined;
    sends += 1;
    if (sends > 1) return undefined;
    replaying = true;
    try {
      await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    } finally {
      replaying = false;
    }
    return { statusCode: 503, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
  } });
  const first = await runCommand(protectedSpec(), { org });
  assert.match(String(first.thrown && first.thrown.message), /customApi contoso_Calc \(create-outcome-unknown\)/);
  assert.equal(sends, 1, 'sent once, never re-sent on the 503');
  assert.deepEqual(rowCounts(org), { environmentvariabledefinitions: 2, customapis: 1, customapirequestparameters: 1, customapiresponseproperties: 1, duplicaterules: 0, duplicateruleconditions: 0 });

  // A fresh invocation never creates it again: the row has no proof yet, so it must first be completed under the same ids.
  let mark = org.requests.length;
  const rerun = await runAgain(protectedSpec(), first);
  assert.equal(rerun.thrown && rerun.thrown.code, 'create-completion-required', rerun.thrown && rerun.thrown.message);
  assert.deepEqual(org.writes(mark), []);

  // The maker completes it (its children's solution membership), as the stop asks.
  const store = openManagedBindings({ workspaceDir: path.join(first.appDir, '.maker-workspace'), environment: org.origin, appUniqueName: 'contoso_configprobe', solutionUniqueName: 'ContosoSol' });
  const inSolution = new Set(org.rows('solutioncomponents').map((c) => c.objectid));
  for (const m of store.readGroup('customApi', 'contoso_calc').pending.rowProtocol.completion.members) {
    if (inSolution.has(m.id)) continue;
    await org.request({ url: `${org.origin}/api/data/v9.2/AddSolutionComponent`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ SolutionUniqueName: 'ContosoSol', ComponentId: m.id, ComponentType: m.componentType, AddRequiredComponents: false }) });
  }

  // No answer proved those rows this build's own: the next run asks for each row's exact approval and sends nothing.
  mark = org.requests.length;
  const asked = await runAgain(protectedSpec(), first);
  assert.equal(asked.thrown && asked.thrown.code, 'create-ownership-required', asked.thrown && asked.thrown.message);
  assert.deepEqual(org.writes(mark), []);
  const quoted = /given after checking those rows are yours: (.*)\.$/.exec(asked.thrown.message);
  assert.ok(quoted, asked.thrown.message);
  const tokens = JSON.parse(`[${quoted[1]}]`);
  assert.deepEqual(tokens.slice().sort(), ['adopt:customApi:contoso_calc', 'adopt:customApiRequestParameter:contoso_calc/request%3Aa', 'adopt:customApiResponseProperty:contoso_calc/response%3Ar']);

  // A root's approval does not cover its children, and a mistyped or unprotected token is refused before anything is read.
  mark = org.requests.length;
  const partial = await runAgain(protectedSpec(), first, [...DATA, ...authorize(['adopt:customApi:contoso_Calc'])]);
  assert.equal(partial.thrown && partial.thrown.code, 'create-ownership-required');
  assert.deepEqual(org.writes(mark), []);
  const typo = await runAgain(protectedSpec(), first, [...DATA, ...authorize(['adopt:customApiRequestParameter:contoso_calc/request%3Ab'])]);
  assert.equal(typo.exitCode, 1, typo.stderr.slice(-600));
  assert.match(`${typo.stderr} ${JSON.stringify(typo.payload)}`, /adopt:customApiRequestParameter:contoso_calc\/request%3Ab/);
  assert.deepEqual(org.writes(mark), []);

  // The printed approvals, typed in the App Spec's own case, bind those rows: nothing is created again; the rule left behind is made.
  const typed = tokens.map((t) => t.replace('contoso_calc', 'contoso_Calc'));
  const done = await runAgain(protectedSpec(), first, [...DATA, ...authorize(typed)]);
  assert.equal(done.thrown && done.thrown.message, undefined, 'the approved run did not halt');
  assert.equal(done.exitCode, 0, done.stderr.slice(-600));
  assert.equal(sends, 1, 'the Custom API is never sent again');
  assert.deepEqual(rootCreates(org, mark), ['POST /duplicaterules']);
  assert.deepEqual(rowCounts(org), { environmentvariabledefinitions: 2, customapis: 1, customapirequestparameters: 1, customapiresponseproperties: 1, duplicaterules: 1, duplicateruleconditions: 1 });
  // The approved rows are this build's now, in the binding store, at the ids they were created with.
  const reread = openManagedBindings({ workspaceDir: path.join(first.appDir, '.maker-workspace'), environment: org.origin, appUniqueName: 'contoso_configprobe', solutionUniqueName: 'ContosoSol' });
  const group = reread.readGroup('customApi', 'contoso_calc');
  assert.equal(group.pending, null);
  assert.deepEqual(group.committed.records.map((r) => r.id).sort(), [org.rows('customapis')[0].customapiid, org.rows('customapirequestparameters')[0].customapirequestparameterid, org.rows('customapiresponseproperties')[0].customapiresponsepropertyid].sort());
  assert.deepEqual(org.unexpected, []);
});

test('protected configuration through the build command: a later phase\u2019s transient failure runs the whole build again and the configuration rows stay where they are', async () => {
  let refused = 0;
  // The sample data's first create meets a customization lock, which the build retries whole; the second succeeds.
  const org = commandOrg({ intercept: ({ method, path: p }) => {
    if (/^\/EntityDefinitions\(LogicalName='contact'\)\/Attributes/.test(p)) return { statusCode: 200, body: { value: [] } };
    if (method !== 'POST' || !/^\/contacts\//.test(p)) return undefined;
    refused += 1;
    return refused === 1
      ? { statusCode: 400, body: { error: { code: '0x80071151', message: 'CustomizationLockException: another operation is running, try again later' } } }
      : { statusCode: 200, body: { Ids: ['11111111-2222-3333-4444-555555555555'] } };
  } });
  const spec = protectedSpec({ entities: [{ schemaName: 'contact', displayName: 'Contact', existing: true, primaryAttribute: { schemaName: 'fullname', displayName: 'Full Name' } }], sampleData: { contact: [{ lastname: 'Probe' }] } });
  const out = await runCommand(spec, { org, argv: [...DATA, '--sample-data'] });
  assert.equal(out.thrown && out.thrown.message, undefined, out.stderr.slice(-900));
  assert.equal(out.exitCode, 0, out.stderr.slice(-900));
  assert.match(out.stderr, /transient error in sample-data — retrying \(attempt 1\/3\)/);
  assert.equal(refused, 2, 'the sample data was sent by two attempts');
  // The second attempt found every configuration row at its bound id: one create each, over both attempts.
  assert.deepEqual(rootCreates(org).sort(), ['POST /customapis', 'POST /duplicaterules', 'POST /environmentvariabledefinitions', 'POST /environmentvariabledefinitions']);
  assert.equal(org.writes().filter((w) => /PublishDuplicateRule$/.test(w)).length, 1, 'the rule is published once');
  assert.deepEqual(rowCounts(org), { environmentvariabledefinitions: 2, customapis: 1, customapirequestparameters: 1, customapiresponseproperties: 1, duplicaterules: 1, duplicateruleconditions: 1 });
  // The second attempt changed nothing: it found each row at the id the first one bound.
  const outcome = out.payload.created.configuration;
  assert.deepEqual(outcome.saved, []);
  assert.deepEqual(outcome.unchanged.map((u) => u.id).sort(), [...org.rows('environmentvariabledefinitions').map((r) => r.environmentvariabledefinitionid), org.rows('customapis')[0].customapiid, org.rows('duplicaterules')[0].duplicateruleid].sort());
});

test('protected configuration through the build command: an edit needs its exact field approval, and a field the approval does not name stays refused', async () => {
  const out = await runCommand(protectedSpec());
  assert.equal(out.exitCode, 0, out.stderr.slice(-600));
  const edited = protectedSpec({ customApis: [{ ...CONFIGURATION_FIELDS.customApis[0], isPrivate: true }] });
  let mark = out.org.requests.length;
  for (const argv of [DATA, [...DATA, ...authorize(['customApi:contoso_Calc:executePrivilegeName'])]]) {
    const refused = await runAgain(edited, out, argv);
    assert.match(String(refused.thrown && refused.thrown.message), /customApi contoso_Calc \(DESTRUCTIVE_CHANGE_UNAUTHORIZED\) \(approve with --authorize customApi:contoso_calc:isPrivate\)/);
    assert.deepEqual(out.org.writes(mark), []);
  }
  const id = out.org.rows('customapis')[0].customapiid;
  const done = await runAgain(edited, out, [...DATA, ...authorize(['customApi:contoso_Calc:isPrivate'])]);
  assert.equal(done.exitCode, 0, done.stderr.slice(-600));
  assert.deepEqual(out.org.writes(mark), [`PATCH /customapis(${id})`], 'the one approved field, at the bound id');
  assert.equal(out.org.rows('customapis')[0].isprivate, true);
  mark = out.org.requests.length;
  assert.equal((await runAgain(edited, out)).exitCode, 0);
  assert.deepEqual(out.org.writes(mark), []);
  assert.deepEqual(out.org.unexpected, []);
});

test('protected configuration through the build command: removing the opt-in, a missing bound row or an unreadable store stops the build before any write, whatever it selects', async () => {
  const out = await runCommand(protectedSpec());
  assert.equal(out.exitCode, 0, out.stderr.slice(-600));
  const withoutOptIn = protectedSpec();
  delete withoutOptIn.configurationIdentity;
  // The version change would be the build's first write; it is not sent.
  withoutOptIn.solution = { ...withoutOptIn.solution, version: '1.3.0.0' };
  let mark = out.org.requests.length;
  for (const argv of [DATA, ['--changed-only', '--allow-destructive']]) {
    const stopped = await runAgain(withoutOptIn, out, argv);
    assert.equal(stopped.thrown && stopped.thrown.code, 'create-identity-opt-in-required', `${argv.join(' ')}: ${stopped.thrown && stopped.thrown.message}`);
    assert.match(stopped.thrown.message, /restore configurationIdentity "stable-v1"/);
    assert.deepEqual(out.org.writes(mark), [], argv.join(' '));
  }

  // A bound row deleted outside the plugin is not replaced by a namesake.
  const id = out.org.rows('customapis')[0].customapiid;
  await out.org.request({ url: `${out.org.origin}/api/data/v9.2/customapis(${id})`, method: 'DELETE', headers: {} });
  mark = out.org.requests.length;
  const gone = await runAgain(protectedSpec({ solution: withoutOptIn.solution }), out);
  assert.match(String(gone.thrown && gone.thrown.message), /the bound customApi of customApi "contoso_calc" \(.*\) is gone; it is not replaced by a namesake/);
  assert.deepEqual(out.org.writes(mark), []);
  assert.equal(out.org.rows('customapis').length, 0);

  // A binding store the build cannot read stops it, with or without the opt-in.
  const fs = require('node:fs');
  const ws = path.join(out.appDir, '.maker-workspace');
  const files = fs.readdirSync(ws).filter((f) => f.startsWith('managed-bindings.'));
  assert.equal(files.length, 1);
  fs.writeFileSync(path.join(ws, files[0]), '{');
  for (const spec of [protectedSpec(), withoutOptIn]) {
    const unreadable = await runAgain(spec, out);
    assert.equal(unreadable.thrown && unreadable.thrown.code, 'managed-binding-store-unreadable', unreadable.thrown && unreadable.thrown.message);
    assert.deepEqual(out.org.writes(mark), []);
  }
  assert.deepEqual(out.org.unexpected, []);
});

test('protected configuration through the build command: an App Spec that dropped an unfinished item still stops on it, whatever it selects', async () => {
  let org = null;
  let lose = true;
  org = commandOrg({ intercept: async (req) => {
    if (!lose || req.method !== 'POST' || req.path.split('?')[0] !== '/customapis') return undefined;
    lose = false;
    await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    return { statusCode: 503, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
  } });
  const first = await runCommand(protectedSpec(), { org });
  assert.match(String(first.thrown && first.thrown.message), /create-outcome-unknown/);
  // Neither the opt-in nor any configuration item is left, and the version would be the first write.
  const dropped = { ...makeSpec({ configuration: false }), solution: { ...makeSpec().solution, version: '1.3.0.0' } };
  const mark = org.requests.length;
  for (const argv of [DATA, ['--changed-only', '--allow-destructive']]) {
    const stopped = await runAgain(dropped, first, argv);
    assert.ok(stopped.thrown, `${argv.join(' ')}: the build stopped`);
    assert.match(stopped.thrown.message, /customApi/, stopped.thrown.message);
    assert.equal(stopped.thrown.phase, 'preflight', stopped.thrown.message);
    assert.deepEqual(org.writes(mark), [], argv.join(' '));
  }
  assert.deepEqual(org.unexpected, []);
});

// A --changed-only apply over an ELIGIBLE snapshot that says nothing changed: the envelope the production writer leaves after an eligible
// apply of `spec` (lib/apply-snapshot.js, written by lib/apply-snapshot-store.js), with the live identity that matches it. Without
// protected configuration this is the flow's no-op, which sends nothing and calls no engine. `calls.n` counts the flow's identity lookups.
const liveIdentityOf = (org) => ({ orgId: '11111111-2222-4333-8444-555555555555', envUrl: org.origin, appUniqueName: 'contoso_configprobe', appId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
function seedEligibleSnapshot(appDir, spec, live) {
  const snap = require('../lib/apply-snapshot.js');
  const baseline = snap.makeEnvelope(live);
  baseline.priorSpec = require('../lib/content-hash.js').annotateContentHashes(spec, () => null);
  snap.markEligible(baseline);
  require('../lib/apply-snapshot-store.js').writeSnapshotAtomic(path.join(appDir, '.maker-workspace'), baseline);
}
const CHANGED_ONLY = ['--changed-only', '--allow-destructive'];
function changedOnlyAgain(spec, base, { argv = CHANGED_ONLY, calls } = {}) {
  const liveIdentity = () => {
    if (calls) calls.n += 1;
    return liveIdentityOf(base.org);
  };
  return runCommand(spec, { org: base.org, appDir: base.appDir, argv, liveIdentity });
}

const NOOP_BYPASS = [
  ['an unreadable binding store', 'managed-binding-store-unreadable', (out) => {
    const fs = require('node:fs');
    const ws = path.join(out.appDir, '.maker-workspace');
    fs.writeFileSync(path.join(ws, fs.readdirSync(ws).find((f) => f.startsWith('managed-bindings.'))), '{');
  }],
  ['the opt-in removed', 'create-identity-opt-in-required', (out, next) => { delete next.configurationIdentity; }],
  ['a bound row deleted', 'configuration-row-not-found', (out) => { out.org.sets.get('customapis').clear(); }],
  ['an edit the protected path refuses', 'configuration-edit-unsupported', (out, next) => { next.duplicateDetectionRules[0].name = 'Changed rule label'; }],
];
for (const [variant, code, change] of NOOP_BYPASS) {
  test(`protected configuration through the build command: a changed-only apply whose snapshot says nothing changed still stops on ${variant}, before any write`, async () => {
    const spec = protectedSpec();
    const out = await runCommand(spec);
    assert.equal(out.exitCode, 0, out.stderr.slice(-600));
    seedEligibleSnapshot(out.appDir, spec, liveIdentityOf(out.org));
    const next = structuredClone(spec);
    change(out, next);
    const mark = out.org.requests.length;
    const calls = { n: 0 };
    const stopped = await changedOnlyAgain(next, out, { calls });
    assert.equal(stopped.thrown && stopped.thrown.code, code, `${stopped.thrown && stopped.thrown.message} ${JSON.stringify(stopped.payload)}`);
    assert.notEqual(stopped.payload && stopped.payload.noop, true, 'never the no-op success');
    assert.deepEqual(out.org.writes(mark), []);
    // The command took no changed-only decision at all: the flow (and its identity lookup) never ran.
    assert.equal(calls.n, 0, 'the changed-only flow was not entered');
    assert.match(stopped.stderr, /changed-only: FULL — protected configuration is in play/);
    assert.deepEqual(out.org.unexpected, []);
  });
}

// The fake org models the configuration endpoints only, so a whole build, which a protected --changed-only apply is, ends at the first
// phase past them: the web-resources phase's read of the webresource table (a 404 here). Reaching it proves the apply ran whole, past
// every configuration step, instead of the flow's no-op.
const reachedWebResources = (r) => /EntityDefinitions\(LogicalName='webresource'\)/.test(String(r.thrown && r.thrown.message));
test('protected configuration through the build command: a changed-only apply runs the whole build, so an approved edit is applied and the rerun sends nothing', async () => {
  const spec = protectedSpec();
  const out = await runCommand(spec);
  assert.equal(out.exitCode, 0, out.stderr.slice(-600));
  seedEligibleSnapshot(out.appDir, spec, liveIdentityOf(out.org));
  // Nothing changed: still the whole build (its checks run), which finds every configuration row as declared and writes nothing.
  let mark = out.org.requests.length;
  const unchanged = await changedOnlyAgain(spec, out);
  assert.ok(reachedWebResources(unchanged), `${unchanged.thrown && unchanged.thrown.message} ${JSON.stringify(unchanged.payload)}`);
  assert.match(unchanged.stderr, /changed-only: FULL — protected configuration is in play/);
  assert.deepEqual(out.org.writes(mark), []);
  // An edit is refused without its approval and applied, at the bound id, with it.
  const edited = protectedSpec({ customApis: [{ ...CONFIGURATION_FIELDS.customApis[0], isPrivate: true }] });
  const refused = await changedOnlyAgain(edited, out);
  assert.match(String(refused.thrown && refused.thrown.message), /approve with --authorize customApi:contoso_calc:isPrivate/);
  assert.deepEqual(out.org.writes(mark), []);
  const id = out.org.rows('customapis')[0].customapiid;
  const done = await changedOnlyAgain(edited, out, { argv: [...CHANGED_ONLY, ...authorize(['customApi:contoso_Calc:isPrivate'])] });
  assert.ok(reachedWebResources(done), done.thrown && done.thrown.message);
  assert.deepEqual(out.org.writes(mark), [`PATCH /customapis(${id})`]);
  assert.equal(out.org.rows('customapis')[0].isprivate, true);
  mark = out.org.requests.length;
  const again = await changedOnlyAgain(edited, out);
  assert.ok(reachedWebResources(again), again.thrown && again.thrown.message);
  assert.deepEqual(out.org.writes(mark), []);
  assert.deepEqual(out.org.unexpected, []);
});

// Every way an apply can narrow itself still meets the protected checks before its first write, or is refused before it: none of them is an
// exit that reports success over a pending obligation. The whole build, --stage data and --changed-only stop on the obligation; every other
// phase range is refused by the apply's partial-range guard before anything is sent; a dry run plans and sends nothing.
test('protected configuration through the build command: no phase selection, changed-only or dry run gets past a pending obligation', async () => {
  const out = await runCommand(protectedSpec());
  assert.equal(out.exitCode, 0, out.stderr.slice(-600));
  seedEligibleSnapshot(out.appDir, protectedSpec(), liveIdentityOf(out.org));
  out.org.sets.get('customapis').clear();
  const mark = out.org.requests.length;
  // --changed-only first, while the snapshot still says nothing changed (a stopped build marks it ineligible).
  for (const argv of [CHANGED_ONLY, ['--allow-destructive'], DATA]) {
    const stopped = await changedOnlyAgain(protectedSpec(), out, { argv });
    assert.equal(stopped.thrown && stopped.thrown.code, 'configuration-row-not-found', `${argv.join(' ')}: ${stopped.thrown && stopped.thrown.message}`);
    assert.deepEqual(out.org.writes(mark), [], argv.join(' '));
  }
  const ranges = [['--stage', 'ui'], ['--stage', 'app'], ['--stage', 'publish'], ['--only', 'pages'], ['--skip', 'data-model'], ['--only', 'sample-data', '--sample-data'], ['--from', 'views']];
  for (const range of ranges) {
    const refused = await changedOnlyAgain(protectedSpec(), out, { argv: [...range, '--allow-destructive'] });
    assert.equal(refused.exitCode, 1, `${range.join(' ')}: ${refused.thrown && refused.thrown.message}`);
    assert.equal(refused.payload && refused.payload.ok, false, range.join(' '));
    assert.match(String(refused.payload.errors), /refusing to apply a partial phase range/, range.join(' '));
    assert.deepEqual(out.org.writes(mark), [], range.join(' '));
  }
  await runCommand(protectedSpec(), { org: out.org, appDir: out.appDir, apply: false, argv: ['--stage', 'data'] });
  assert.deepEqual(out.org.writes(mark), [], 'a dry run sends nothing');
  assert.deepEqual(out.org.unexpected, []);
});

test('a build without the opt-in and without stored configuration rows loads no protected module and sends what it always sent', async () => {
  const spec = makeSpec();
  delete spec.connectionReferences;
  const { result: out, requested } = await protectedModulesLoadedBy(() => runCommand(spec));
  assert.deepEqual(requested, [], 'no protected configuration module is loaded');
  assert.equal(out.exitCode, 0, out.stderr.slice(-600));
  // The plain path: the server mints each id (no id in the create's body).
  const [api] = out.org.requests.filter((r) => r.method === 'POST' && String(r.path).split('?')[0] === '/customapis').map((r) => r.body);
  // The plain path: the ids are minted at random (version 4), not derived from the item (the protected path's name-based version 5).
  const saved = out.payload.created.configuration.saved;
  assert.equal(saved.length, 4);
  for (const s of saved) assert.match(s.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4/, `${s.kind} ${s.key}`);
  assert.ok(!/configurationIdentity|managed-create|adopt:/.test(out.stderr));
  const again = await protectedModulesLoadedBy(() => runAgain(spec, out));
  assert.deepEqual(again.requested, []);
  assert.equal(again.result.exitCode, 0);
  assert.deepEqual(out.org.unexpected, []);

  // Its changed-only apply over an eligible snapshot that says nothing changed is still the flow's no-op: no engine, no request, no
  // protected module. A configuration item changed since that snapshot is a full build, never that no-op (lib/phase-diff.js).
  seedEligibleSnapshot(out.appDir, spec, liveIdentityOf(out.org));
  const mark = out.org.requests.length;
  const calls = { n: 0 };
  const noop = await protectedModulesLoadedBy(() => changedOnlyAgain(spec, out, { calls }));
  assert.deepEqual(noop.requested, []);
  assert.equal(noop.result.exitCode, 0, noop.result.thrown && noop.result.thrown.message);
  assert.equal(noop.result.payload.noop, true);
  assert.equal(calls.n, 1, 'the flow decided');
  assert.equal(out.org.requests.length, mark, 'nothing was sent');
  const edited = { ...spec, customApis: [{ ...spec.customApis[0], displayName: 'Calculate again' }] };
  const full = await protectedModulesLoadedBy(() => changedOnlyAgain(edited, out));
  assert.deepEqual(full.requested, []);
  assert.notEqual(full.result.payload && full.result.payload.noop, true, 'a configuration edit is never the no-op');
  assert.match(full.result.stderr, /changed-only: FULL — full build — data-model: changed/);
  assert.deepEqual(out.org.unexpected, []);
});

// The build command in separate OS processes over one app folder (helpers/configuration-command-child.js): only what reached the disk
// (the binding store under the app folder) carries a build's state to the next, never anything a process held in memory. The service is
// the strict org in this process, which every child reaches over its IPC channel. Each child's temporary folder (TEMP/TMP) is this test's
// own folder, so the throwaway SDK workspace each command makes is made there and must be gone when the command ends.
function processCommands() {
  const root = makeTempDir('config-process-');
  const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' };
  delete env.NODE_TEST_CONTEXT;
  const pids = [];
  let runs = 0;
  const command = (org, spec, { argv } = {}) => new Promise((resolve, reject) => {
    const n = ++runs;
    const logFile = path.join(root, `child-${n}.log`);
    const log = fs.openSync(logFile, 'w');
    const child = fork(path.join(__dirname, 'helpers', 'configuration-command-child.js'), [], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', log, log, 'ipc'] });
    let result;
    child.on('message', async (m) => {
      if (m.request) {
        try {
          child.send({ reply: m.request, answer: await org.request(m.req) });
        } catch (e) {
          child.kill();
          reject(e);
        }
      } else if (m.result) {
        result = m.result;
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      fs.closeSync(log);
      if (code !== 0 || !result) return reject(new Error(`command ${n} exited ${code}: ${fs.readFileSync(logFile, 'utf8').slice(-1500)}`));
      pids.push(result.pid);
      assert.ok(result.workspaceDirs.length > 0 && result.workspacesRemoved, `command ${n} removed the throwaway SDK workspace it made: ${result.workspaceDirs}`);
      assert.ok(result.workspaceDirs.every((dir) => path.resolve(dir).startsWith(path.resolve(root))), `command ${n} made its SDK workspace in the test's folder`);
      resolve(result);
    });
    child.send({ start: { origin: org.origin, spec, appDir: path.join(root, 'app'), argv } });
  });
  return { root, appDir: path.join(root, 'app'), pids, command };
}

test('protected configuration in fresh processes: a whole-build retry keeps every id, and a later process reopening the folder sends nothing', async () => {
  const p = processCommands();
  let refused = 0;
  const org = commandOrg({ intercept: ({ method, path: at }) => {
    if (/^\/EntityDefinitions\(LogicalName='contact'\)\/Attributes/.test(at)) return { statusCode: 200, body: { value: [] } };
    if (method !== 'POST' || !/^\/contacts\//.test(at)) return undefined;
    refused += 1;
    return refused === 1
      ? { statusCode: 400, body: { error: { code: '0x80071151', message: 'CustomizationLockException: another operation is running, try again later' } } }
      : { statusCode: 200, body: { Ids: ['11111111-2222-3333-4444-555555555555'] } };
  } });
  const spec = protectedSpec({ entities: [{ schemaName: 'contact', displayName: 'Contact', existing: true, primaryAttribute: { schemaName: 'fullname', displayName: 'Full Name' } }], sampleData: { contact: [{ lastname: 'Probe' }] } });
  const first = await p.command(org, spec, { argv: [...DATA, '--sample-data'] });
  assert.equal(first.thrown, null, first.stderr.slice(-900));
  assert.equal(first.exitCode, 0, first.stderr.slice(-900));
  assert.match(first.stderr, /transient error in sample-data — retrying \(attempt 1\/3\)/);
  assert.equal(refused, 2, 'the sample data was sent by two attempts');
  // Both attempts used the same ids: one create per root, at the id the binding store holds.
  assert.deepEqual(rootCreates(org).sort(), ['POST /customapis', 'POST /duplicaterules', 'POST /environmentvariabledefinitions', 'POST /environmentvariabledefinitions']);
  // The retried attempt is the one reported: it found every row unchanged at the id the first attempt created it with.
  const bound = first.payload.created.configuration.unchanged;
  assert.equal(bound.length, 4, JSON.stringify(first.payload.created.configuration));
  const idOf = (kind, key) => bound.find((b) => b.kind === kind && b.key === key).id;
  assert.equal(org.rows('customapis')[0].customapiid, idOf('customApi', 'contoso_Calc'));
  assert.equal(org.rows('duplicaterules')[0].duplicateruleid, idOf('duplicateRule', 'email'));
  const ids = PROTECTED_ROWS.map((set) => org.rows(set).map((r) => JSON.stringify(r)).sort());

  const mark = org.requests.length;
  const again = await p.command(org, spec);
  assert.equal(again.thrown, null, again.thrown && again.thrown.message);
  assert.equal(again.exitCode, 0, again.stderr.slice(-900));
  assert.deepEqual(org.writes(mark), [], 'the reopened folder found every row at its bound id');
  assert.deepEqual(PROTECTED_ROWS.map((set) => org.rows(set).map((r) => JSON.stringify(r)).sort()), ids);
  assert.equal(new Set(p.pids).size, 2, 'two OS processes');
  assert.ok(!p.pids.includes(process.pid));
  assert.deepEqual(org.unexpected, []);
});

test('protected configuration in fresh processes: a create whose answer was lost is completed, approved and bound across four processes, and sent once', async () => {
  const p = processCommands();
  let org = null;
  let sends = 0;
  let replaying = false;
  org = commandOrg({ intercept: async (req) => {
    if (replaying || req.method !== 'POST' || req.path.split('?')[0] !== '/customapis') return undefined;
    sends += 1;
    if (sends > 1) return undefined;
    replaying = true;
    try {
      await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    } finally {
      replaying = false;
    }
    return { statusCode: 503, body: { error: { code: '0x80040216', message: 'the answer was lost' } } };
  } });
  const first = await p.command(org, protectedSpec());
  assert.match(String(first.thrown && first.thrown.message), /customApi contoso_Calc \(create-outcome-unknown\)/);
  assert.equal(sends, 1);

  let mark = org.requests.length;
  const blocked = await p.command(org, protectedSpec());
  assert.equal(blocked.thrown && blocked.thrown.code, 'create-completion-required', blocked.thrown && blocked.thrown.message);
  assert.deepEqual(org.writes(mark), []);

  // The maker completes the row's solution membership, reading the members the earlier process stored on disk.
  const store = openManagedBindings({ workspaceDir: path.join(p.appDir, '.maker-workspace'), environment: org.origin, appUniqueName: 'contoso_configprobe', solutionUniqueName: 'ContosoSol' });
  const inSolution = new Set(org.rows('solutioncomponents').map((c) => c.objectid));
  for (const m of store.readGroup('customApi', 'contoso_calc').pending.rowProtocol.completion.members) {
    if (inSolution.has(m.id)) continue;
    await org.request({ url: `${org.origin}/api/data/v9.2/AddSolutionComponent`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ SolutionUniqueName: 'ContosoSol', ComponentId: m.id, ComponentType: m.componentType, AddRequiredComponents: false }) });
  }

  mark = org.requests.length;
  const asked = await p.command(org, protectedSpec());
  assert.equal(asked.thrown && asked.thrown.code, 'create-ownership-required', asked.thrown && asked.thrown.message);
  assert.deepEqual(org.writes(mark), []);
  const tokens = JSON.parse(`[${/given after checking those rows are yours: (.*)\.$/.exec(asked.thrown.message)[1]}]`);
  assert.equal(tokens.length, 3);

  const done = await p.command(org, protectedSpec(), { argv: [...DATA, ...authorize(tokens)] });
  assert.equal(done.thrown, null, done.thrown && done.thrown.message);
  assert.equal(done.exitCode, 0, done.stderr.slice(-900));
  assert.equal(sends, 1, 'the Custom API was sent once, by the first process');
  assert.equal(org.rows('customapis').length, 1);
  assert.equal(new Set(p.pids).size, 4, 'four OS processes');
  assert.deepEqual(org.unexpected, []);
});

// A protected Custom API whose implementation (a plug-in type) was registered outside the plugin, as an App Spec cannot declare
// one (configuration-artifacts.js refuses `pluginTypeId`). The build never writes the implementation; a bound row keeps the exact
// plug-in type its fresh read found, and the edit is proved only while the row still holds that one.
const PLUGIN_TYPE = '00000000-0000-4000-8000-0000000000aa';
const OTHER_PLUGIN_TYPE = '00000000-0000-4000-8000-0000000000bb';
function apiSpec(over = {}) {
  return { ...makeSpec({ configuration: false }), solution: makeSpec().solution, configurationIdentity: 'stable-v1',
    customApis: [structuredClone(CONFIGURATION_FIELDS.customApis[0])], ...over };
}
const withApi = (spec, change) => ({ ...spec, customApis: [{ ...spec.customApis[0], ...change }] });
const withRequest = (spec, uniqueName) => withApi(spec, { requestParameters: [...spec.customApis[0].requestParameters, { uniqueName, type: 'integer' }] });
function apiGroup(base) {
  const store = openManagedBindings({ workspaceDir: path.join(base.appDir, '.maker-workspace'), environment: base.org.origin, appUniqueName: 'contoso_configprobe', solutionUniqueName: 'ContosoSol' });
  const group = store.readGroup('customApi', 'contoso_calc');
  return { committed: !!group.committed, pending: !!group.pending };
}
function succeeded(out, what) {
  assert.equal(out.thrown && out.thrown.message, undefined, what);
  assert.equal(out.exitCode, 0, `${what}: ${out.stderr.slice(-900)}`);
}
// No write since `mark` names the implementation, in any shape (a lookup column or a bind).
const writesImplementation = (org, mark) => org.requests.slice(mark).some((r) => r.method !== 'GET' && /plugintype/i.test(JSON.stringify(r.body || {})));

test('protected configuration through the build command: a Custom API with a registered implementation takes a supported root edit, keeps that implementation, and the rerun sends nothing', async () => {
  const spec = apiSpec();
  const out = await runCommand(spec);
  succeeded(out, 'the create');
  const api = out.org.rows('customapis')[0];
  api._plugintypeid_value = PLUGIN_TYPE;
  let mark = out.org.requests.length;
  succeeded(await runAgain(spec, out), 'an unchanged build over the implemented API');
  assert.deepEqual(out.org.writes(mark), []);

  const edited = withApi(spec, { displayName: 'Calculator' });
  mark = out.org.requests.length;
  succeeded(await runAgain(edited, out), 'the root edit');
  assert.deepEqual(out.org.writes(mark), [`PATCH /customapis(${api.customapiid})`]);
  assert.equal(api.displayname, 'Calculator');
  assert.equal(api._plugintypeid_value, PLUGIN_TYPE, 'the implementation is kept');
  assert.equal(writesImplementation(out.org, mark), false, 'the implementation is never written');
  assert.deepEqual(apiGroup(out), { committed: true, pending: false });

  // A new process over the same folder: the edit is bound, so nothing is sent again.
  mark = out.org.requests.length;
  succeeded(await runAgain(edited, out), 'the rerun');
  assert.deepEqual(out.org.writes(mark), []);
  assert.deepEqual(out.org.unexpected, []);
});

test('protected configuration through the build command: a Custom API with a registered implementation takes a new-child edit and keeps that implementation', async () => {
  const spec = apiSpec();
  const out = await runCommand(spec);
  succeeded(out, 'the create');
  const api = out.org.rows('customapis')[0];
  api._plugintypeid_value = PLUGIN_TYPE;
  const edited = withRequest(spec, 'B');
  let mark = out.org.requests.length;
  succeeded(await runAgain(edited, out), 'the new-child edit');
  assert.deepEqual(out.org.writes(mark), ['POST /customapirequestparameters', 'POST /AddSolutionComponent']);
  assert.deepEqual(out.org.rows('customapirequestparameters').map((r) => r.uniquename).sort(), ['A', 'B']);
  assert.equal(api._plugintypeid_value, PLUGIN_TYPE);
  assert.equal(writesImplementation(out.org, mark), false);
  assert.deepEqual(apiGroup(out), { committed: true, pending: false });
  mark = out.org.requests.length;
  succeeded(await runAgain(edited, out), 'the rerun');
  assert.deepEqual(out.org.writes(mark), []);
  assert.deepEqual(out.org.unexpected, []);
});

test('protected configuration through the build command: an implementation replaced or removed while an edit is written is refused, and the next build sends nothing for it', async () => {
  for (const [what, during] of [['replaced', OTHER_PLUGIN_TYPE], ['removed', null]]) {
    let hook = null;
    const org = commandOrg({ intercept: (req) => (hook ? hook(req) : undefined) });
    const spec = apiSpec();
    const out = await runCommand(spec, { org });
    succeeded(out, `${what}: the create`);
    const api = org.rows('customapis')[0];
    api._plugintypeid_value = PLUGIN_TYPE;
    // Someone else changes the registration as the edit's PATCH lands: the row the edit leaves is not the one it planned.
    hook = (req) => {
      if (req.method === 'PATCH' && /^\/customapis\(/.test(req.path)) api._plugintypeid_value = during;
      return undefined;
    };
    const edited = withApi(spec, { displayName: 'Calculator' });
    let mark = org.requests.length;
    const changed = await runAgain(edited, out);
    assert.notEqual(changed.exitCode, 0, what);
    assert.match(String(changed.thrown && changed.thrown.message), /create-identity-conflict/, what);
    assert.deepEqual(org.writes(mark), [`PATCH /customapis(${api.customapiid})`], `${what}: sent once`);
    assert.deepEqual(apiGroup(out), { committed: true, pending: true }, `${what}: the edit stays pending`);
    hook = null;
    mark = org.requests.length;
    const again = await runAgain(edited, out);
    assert.equal(again.thrown && again.thrown.code, 'create-identity-conflict', `${what}: ${again.thrown && again.thrown.message}`);
    assert.deepEqual(org.writes(mark), [], `${what}: nothing is sent again`);
    assert.equal(api._plugintypeid_value, during, `${what}: the implementation is left as it was changed`);
    assert.deepEqual(org.unexpected, []);
  }
});

test('protected configuration through the build command: a first create that reads back with an implementation is still not proved', async () => {
  let org = null;
  // The plug-in type appears on the row right after the create lands, before the build reads it back.
  org = commandOrg({ intercept: (req) => {
    const row = org.rows('customapis')[0];
    if (row && req.method === 'GET') row._plugintypeid_value = PLUGIN_TYPE;
    return undefined;
  } });
  const out = await runCommand(apiSpec(), { org });
  assert.match(String(out.thrown && out.thrown.message), /create-identity-conflict/);
  assert.deepEqual(rootCreates(org), ['POST /customapis']);
  assert.deepEqual(apiGroup(out), { committed: false, pending: true });
  assert.deepEqual(org.unexpected, []);
});

test('protected configuration through the build command: the same root edit of an API without an implementation, and of an implemented API without the opt-in, is applied', async () => {
  for (const protectedMode of [true, false]) {
    const spec = apiSpec();
    if (!protectedMode) delete spec.configurationIdentity;
    const out = await runCommand(spec);
    succeeded(out, `opt-in ${protectedMode}: the create`);
    const api = out.org.rows('customapis')[0];
    if (!protectedMode) api._plugintypeid_value = PLUGIN_TYPE;
    const mark = out.org.requests.length;
    succeeded(await runAgain(withApi(spec, { displayName: 'Calculator' }), out), `opt-in ${protectedMode}: the root edit`);
    assert.deepEqual(out.org.writes(mark), [`PATCH /customapis(${api.customapiid})`]);
    assert.equal(api.displayname, 'Calculator');
    assert.equal(api._plugintypeid_value ?? null, protectedMode ? null : PLUGIN_TYPE);
    assert.deepEqual(out.org.unexpected, []);
  }
});

// A protected item with no binding yet is a first create at its derived ids. Its exact-id read and its complete namesake query run
// in the build's read-only preflight, so a create that cannot be made stops the build before its first write (here the solution
// version PATCH), not after it.
test('protected configuration through the build command: a first create whose namesake or derived id is taken stops before the first write', async () => {
  const versioned = (spec) => ({ ...spec, solution: { ...spec.solution, version: '1.3.0.0' } });
  const solutionVersion = (org) => org.rows('solutions').find((s) => s.uniquename === 'ContosoSol').version;

  // Opting in over an API the build made without the opt-in: a namesake at another id.
  const plain = apiSpec();
  delete plain.configurationIdentity;
  const made = await runCommand(plain);
  succeeded(made, 'the ordinary create');
  for (const argv of [undefined, DATA, CHANGED_ONLY]) {
    const mark = made.org.requests.length;
    const stopped = await runCommand(versioned(apiSpec()), { org: made.org, appDir: made.appDir, ...(argv ? { argv } : {}) });
    const label = argv ? argv.join(' ') : 'default';
    assert.equal(stopped.thrown && stopped.thrown.code, 'create-identity-conflict', `${label}: ${stopped.thrown && stopped.thrown.message}`);
    assert.equal(stopped.thrown.phase, 'preflight', label);
    assert.match(stopped.thrown.message, /customApi contoso_calc/, label);
    assert.notEqual(stopped.exitCode, 0, label);
    assert.deepEqual(made.org.writes(mark), [], `${label}: nothing is written`);
  }
  assert.equal(solutionVersion(made.org), '1.2.0.0');
  assert.deepEqual(made.org.unexpected, []);

  // The derived id taken by a row no binding of this folder holds (the same App Spec built from another folder).
  const first = await runCommand(apiSpec());
  succeeded(first, 'the protected create');
  const elsewhere = path.join(makeTempDir('config-command-'), 'app');
  const mark = first.org.requests.length;
  const taken = await runCommand(versioned(apiSpec()), { org: first.org, appDir: elsewhere });
  assert.equal(taken.thrown && taken.thrown.code, 'create-identity-conflict', taken.thrown && taken.thrown.message);
  assert.equal(taken.thrown.phase, 'preflight');
  assert.deepEqual(first.org.writes(mark), []);
  assert.equal(solutionVersion(first.org), '1.2.0.0');
  assert.deepEqual(first.org.unexpected, []);
});

test('protected configuration through the build command: a first create whose namesake query cannot be completed stops before the first write', async () => {
  let failing = false;
  const org = commandOrg({ intercept: (req) => (failing && req.method === 'GET' && /^\/customapis\?/.test(req.path) && /\$filter=uniquename/.test(decodeURIComponent(req.path))
    ? { statusCode: 500, body: { error: { code: '0x80040216', message: 'unavailable' } } } : undefined) });
  const solutionVersion = () => org.rows('solutions').find((s) => s.uniquename === 'ContosoSol').version;
  const base = await runCommand({ ...makeSpec({ configuration: false }), solution: makeSpec().solution }, { org });
  succeeded(base, 'the solution');
  failing = true;
  const mark = org.requests.length;
  const stopped = await runCommand(apiSpec({ solution: { ...makeSpec().solution, version: '1.3.0.0' } }), { org, appDir: base.appDir });
  assert.equal(stopped.thrown && stopped.thrown.code, 'create-identity-unverified', stopped.thrown && stopped.thrown.message);
  assert.equal(stopped.thrown.phase, 'preflight');
  assert.deepEqual(org.writes(mark), []);
  assert.equal(solutionVersion(), '1.2.0.0');
  assert.equal(org.rows('customapis').length, 0);
  assert.deepEqual(org.unexpected, []);
});

// Two answers a live environment gives that a protected build must take as they are (fake-config-org.js liveRowShape): the platform
// stores its create default in a connection reference's `promptingbehavior` (0) although the create never sends it, and answers a
// duplicate rule without `@odata.etag`.
const liveOrg = () => commandOrg({ liveRowShape: true });
const noUnexpectedError = (out, what) => assert.ok(!/UNEXPECTED_ERROR/.test(`${out.stderr} ${out.stdout || ''} ${JSON.stringify(out.payload || null)}`), `${what}: ${out.stderr.slice(-900)}`);

test('protected configuration through the build command: a connection reference the platform fills with its create default is created, bound and rebuilt with no write', async () => {
  const spec = { ...makeSpec({ configuration: false }), solution: makeSpec().solution, configurationIdentity: 'stable-v1',
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] };
  const org = liveOrg();
  const out = await runCommand(spec, { org });
  succeeded(out, 'the create');
  noUnexpectedError(out, 'the create');
  const [row] = org.rows('connectionreferences');
  assert.equal(row.promptingbehavior, 0, 'the platform filled its create default');
  assert.deepEqual(out.payload.created.configuration.managedBindings.map((b) => `${b.kind}:${b.key}:${b.origin}:${b.id}`),
    [`connectionReference:contoso_sp:created:${row.connectionreferenceid}`]);
  assert.ok(!org.requests.some((r) => r.method !== 'GET' && /promptingbehavior/i.test(JSON.stringify(r.body || {}))), 'the column is never sent');
  const mark = org.requests.length;
  succeeded(await runAgain(spec, out), 'the unchanged rebuild');
  assert.deepEqual(org.writes(mark), []);
  assert.deepEqual(org.unexpected, []);

  // Any other value there, found as the create is read back, was put by someone else: the row is not proved the build's.
  let other = null;
  other = commandOrg({ liveRowShape: true, intercept: (req) => {
    const made = other.rows('connectionreferences')[0];
    if (made && req.method === 'GET') made.promptingbehavior = 1;
    return undefined;
  } });
  const stopped = await runCommand(spec, { org: other });
  assert.notEqual(stopped.exitCode, 0);
  assert.match(String(stopped.thrown && stopped.thrown.message), /connectionReference contoso_sp \(create-identity-conflict\)/);
  assert.deepEqual(other.unexpected, []);
});

test('protected configuration through the build command: a duplicate rule answered without a row version is created, verified and rebuilt with no write, and a change to it is unsupported', async () => {
  const spec = { ...makeSpec({ configuration: false }), solution: makeSpec().solution, configurationIdentity: 'stable-v1',
    duplicateDetectionRules: structuredClone(CONFIGURATION_FIELDS.duplicateDetectionRules) };
  const org = liveOrg();
  const out = await runCommand(spec, { org, argv: [...DATA, '--verify'] });
  succeeded(out, 'the create');
  noUnexpectedError(out, 'the create');
  assert.doesNotMatch(out.stderr, /✗ configuration/, out.stderr.slice(-900));
  assert.match(out.stderr, /✓ verify PASS/, 'the build verified the rule');
  const [rule] = org.rows('duplicaterules');
  assert.deepEqual([rule.statecode, rule.statuscode], [1, 2], 'published once');
  let mark = org.requests.length;
  const again = await runAgain(spec, out);
  succeeded(again, 'the unchanged rebuild');
  noUnexpectedError(again, 'the unchanged rebuild');
  assert.deepEqual(org.writes(mark), [], 'never published again');
  // The build's own verify checks the bound rule at its id, through the same plan, and finds it as made.
  mark = org.requests.length;
  const verified = await runAgain(spec, out, [...DATA, '--verify']);
  succeeded(verified, 'the verified rebuild');
  noUnexpectedError(verified, 'the verified rebuild');
  assert.doesNotMatch(verified.stderr, /✗ configuration/, verified.stderr.slice(-900));
  assert.match(verified.stderr, /✓ verify PASS/);
  assert.deepEqual(org.writes(mark), []);

  for (const [what, change] of [
    ['a field', (s) => { s.duplicateDetectionRules[0].name = 'Contacts with the same email'; }],
    ['a condition', (s) => { s.duplicateDetectionRules[0].conditions[0].match = 'firstCharacters'; s.duplicateDetectionRules[0].conditions[0].characters = 3; }],
  ]) {
    const edited = structuredClone(spec);
    change(edited);
    mark = org.requests.length;
    const refused = await runAgain(edited, out);
    assert.equal(refused.thrown && refused.thrown.code, 'configuration-edit-unsupported', `${what}: ${refused.thrown && refused.thrown.message}`);
    assert.equal(refused.thrown.phase, 'preflight', what);
    assert.deepEqual(org.writes(mark), [], what);
  }
  assert.deepEqual(org.unexpected, []);
});

// A Custom API label edit is refused by the SDK before anything is sent when the environment has more than one language. The
// refused edit leaves nothing pending, so the build that follows — the earlier declaration, another edit or the same one — is
// judged on its own.
test('protected configuration through the build command: a label edit refused before any send leaves nothing pending, so the next declaration is built', async () => {
  const org = commandOrg({ languages: [1033, 1036] });
  const spec = apiSpec();
  const out = await runCommand(spec, { org });
  succeeded(out, 'the create');
  const labelled = withApi(spec, { requestParameters: [{ ...spec.customApis[0].requestParameters[0], displayName: 'Alpha' }] });
  const refused = async (what) => {
    const mark = org.requests.length;
    const r = await runAgain(labelled, out);
    assert.notEqual(r.exitCode, 0, what);
    assert.match(String(r.thrown && r.thrown.message), /CUSTOM_API_LABELS_UNSUPPORTED/, `${what}: ${r.thrown && r.thrown.message}`);
    assert.doesNotMatch(String(r.thrown && r.thrown.message), /another declaration/, what);
    assert.deepEqual(org.writes(mark), [], `${what}: nothing is sent`);
    assert.deepEqual(apiGroup(out), { committed: true, pending: false }, `${what}: nothing is left pending`);
  };
  await refused('the label edit');

  let mark = org.requests.length;
  succeeded(await runAgain(spec, out), 'the earlier declaration');
  assert.deepEqual(org.writes(mark), []);

  await refused('the label edit again');
  const extended = withRequest(spec, 'B');
  mark = org.requests.length;
  succeeded(await runAgain(extended, out), 'another declaration');
  assert.deepEqual(org.writes(mark), ['POST /customapirequestparameters', 'POST /AddSolutionComponent']);
  assert.deepEqual(apiGroup(out), { committed: true, pending: false });
  assert.equal(org.rows('customapirequestparameters').find((p) => p.uniquename === 'A').displayname, 'A', 'the refused label was never written');
  assert.deepEqual(org.unexpected, []);
});

// A maker may change a bound reference's prompting behaviour in the portal. The build never writes that column, and an
// edit of the row is planned over the value its fresh base read found there: the edit completes and keeps it, a rerun
// sends nothing, and a value changed again while the edit is written leaves the edit unfinished, never proved.
test('protected configuration through the build command: a bound connection reference whose prompting behaviour was changed outside the plugin takes a supported edit and keeps that value', async () => {
  const spec = { ...makeSpec({ configuration: false }), solution: makeSpec().solution, configurationIdentity: 'stable-v1',
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] };
  const pending = (out) => {
    const store = openManagedBindings({ workspaceDir: path.join(out.appDir, '.maker-workspace'), environment: out.org.origin,
      appUniqueName: spec.app.uniqueName, solutionUniqueName: 'ContosoSol' });
    return !!store.readGroup('connectionReference', 'contoso_sp').pending;
  };
  const named = (name) => ({ ...spec, connectionReferences: [{ ...spec.connectionReferences[0], name }] });

  const out = await runCommand(spec, { org: liveOrg() });
  succeeded(out, 'the create');
  const [row] = out.org.rows('connectionreferences');
  row.promptingbehavior = 1;
  let mark = out.org.requests.length;
  succeeded(await runAgain(spec, out), 'the unchanged rebuild');
  assert.deepEqual(out.org.writes(mark), []);

  mark = out.org.requests.length;
  succeeded(await runAgain(named('Reviewed reference'), out), 'the name edit');
  assert.equal(out.org.writes(mark).length, 1, JSON.stringify(out.org.writes(mark)));
  assert.equal(row.connectionreferencedisplayname, 'Reviewed reference');
  assert.equal(row.promptingbehavior, 1, 'the value set outside the plugin is kept');
  assert.equal(pending(out), false, 'the edit is complete');
  assert.ok(!out.org.requests.slice(mark).some((r) => r.method !== 'GET' && /promptingbehavior/i.test(JSON.stringify(r.body || {}))), 'the column is never sent');
  mark = out.org.requests.length;
  succeeded(await runAgain(named('Reviewed reference'), out), 'the rerun');
  assert.deepEqual(out.org.writes(mark), []);
  // Back at the platform default, an edit is planned over that state as well.
  row.promptingbehavior = null;
  mark = out.org.requests.length;
  succeeded(await runAgain(named('Third name'), out), 'the edit over an empty value');
  assert.equal(out.org.writes(mark).length, 1);
  assert.equal(pending(out), false);
  assert.deepEqual(out.org.unexpected, []);

  // Changed again while the edit is written: the read-back does not hold what the edit was planned over.
  let drifted = null;
  drifted = commandOrg({ liveRowShape: true, intercept: (req) => {
    if (req.method === 'PATCH' && /^\/connectionreferences\(/.test(req.path)) drifted.rows('connectionreferences')[0].promptingbehavior = 2;
    return undefined;
  } });
  const made = await runCommand(spec, { org: drifted });
  succeeded(made, 'the second create');
  drifted.rows('connectionreferences')[0].promptingbehavior = 1;
  const stopped = await runAgain(named('Reviewed reference'), made);
  assert.notEqual(stopped.exitCode, 0);
  assert.match(String(stopped.thrown && stopped.thrown.message), /connectionReference contoso_sp \(create-identity-conflict\)/);
  assert.equal(pending(made), true, 'the edit is not proved');
  mark = drifted.requests.length;
  const next = await runAgain(named('Reviewed reference'), made);
  assert.notEqual(next.exitCode, 0);
  assert.deepEqual(drifted.writes(mark), [], 'the next build sends nothing for it');
  assert.deepEqual(drifted.unexpected, []);
});