'use strict';

// The configuration kinds (environment variables, connection references, Custom APIs, duplicate-detection rules) and
// solution.version, end to end: buildModelApp -> runSdkBuild -> the configuration runtime (lib/configuration-build.js)
// -> the REAL maker-SDK bundle -> the strict in-memory org (tests/helpers/fake-config-org.js), which answers only the
// requests it models and lists every other one in `unexpected`. The build's own create port is the plain pass-through
// (lib/creates-passthrough.js); every build runs with the stable-id create modules made unloadable, so a request for
// one fails the test (tests/helpers/no-stable-create-modules.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { withoutStableCreateModules } = require('./helpers/no-stable-create-modules.js');
const { configurationSendOnce } = require('../lib/configuration-transport.js');
const { readDeploymentBindings } = require('../lib/configuration-artifacts.js');
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
  const silent = await harness({ intercept: ({ method, path: p, body }) => (method === 'POST' && p === '/AddSolutionComponent' && body && body.ComponentType === 45
    ? { statusCode: 200, body: { id: '00000000-0000-0000-0000-000000000045' } } : undefined) });
  const unproven = await build(silent, spec, { opts: { configurationBindings: bindingsFor(spec) } });
  assert.ok(unproven.thrown, 'the build halted');
  assert.equal(unproven.thrown.code, 'configuration-incomplete');
  assert.match(unproven.thrown.message, /duplicateRuleCondition email\|e \(SOLUTION_MEMBERSHIP_UNKNOWN\)/);
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
const commandOrg = () => createConfigOrg({
  tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }],
  solution: { uniqueName: 'ContosoSol', version: '1.0.0.0', prefix: 'contoso' },
});

// `--allow-destructive` skips the read-only collision check, whose reads (app modules, forms) this org does not model; nothing here deletes.
function runCommand(spec, { org = commandOrg(), apply = true, appDir = path.join(makeTempDir('config-command-'), 'app'), argv = ['--stage', 'data', '--allow-destructive'] } = {}) {
  const { loadCli } = require('./helpers/cli-harness.js');
  const fs = require('node:fs');
  const realHttp = require('../lib/sdk-http-client.js');
  const realMakerSdk = require('../lib/maker-sdk.js');
  fs.mkdirSync(appDir, { recursive: true });
  const specPath = path.join(appDir, 'app-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const sdks = [];
  const scripts = path.join(__dirname, '..');
  const authCli = loadCli(path.join(scripts, 'lib', 'dataverse-auth.js'));
  const cli = loadCli(path.join(scripts, 'build-model-app.js'), {
    argv: ['--env', org.origin, '--spec', `@${specPath}`, ...(apply ? ['--apply'] : []), '--non-interactive', ...argv],
    env: { PATH: path.dirname(process.execPath), POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    requires: {
      './lib/dataverse-auth.js': { ...authCli.exports, preflightAuth: async () => ({ ok: true }) },
      './lib/entity-provision.js': { ...require('../lib/entity-provision.js'), resolveAuthoringLanguage: async () => 1033 },
      './lib/sdk-http-client.js': {
        ...realHttp,
        createAzHttpClient: (env, o = {}) => realHttp.createAzHttpClient(env, { ...o, getToken: () => 'test-token-0123456789abcdef', request: (req) => org.request(req), sleep: async () => {} }),
      },
      './lib/maker-sdk.js': {
        ...realMakerSdk,
        createMakerSdk: (o) => {
          const sdk = realMakerSdk.createMakerSdk(o);
          const seen = { scoped: !!o.solutionUniqueName, inits: 0, requestsAtInit: [] };
          const init = sdk.initWorkspace.bind(sdk);
          sdk.initWorkspace = async () => {
            seen.inits += 1;
            const before = org.requests.length;
            await init();
            seen.requestsAtInit.push(org.requests.length - before);
          };
          sdks.push(seen);
          return sdk;
        },
      },
      './lib/genpage-sdk.js': { ...require('../lib/genpage-sdk.js'), makeGenpageSdk: () => ({ dispose: async () => ({ left: [] }) }) },
      './lib/telemetry/skill-completed.js': { ...require('../lib/telemetry/skill-completed.js'), emitSkillCompleted: async () => {} },
    },
  });
  return (async () => {
    let exitCode;
    let thrown;
    try {
      await cli.main();
    } catch (e) {
      if (e && e.exitCode !== undefined) exitCode = e.exitCode;
      else thrown = e;
    }
    let payload;
    try { payload = JSON.parse(authCli.stdoutText()); } catch { payload = undefined; }
    return { org, appDir, sdks, exitCode, thrown, payload, stderr: [...cli.stderr, ...authCli.stderr].join('') };
  })();
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