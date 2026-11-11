'use strict';
// No environment-variable value, default, value schema, secret reference or connection id at rest in any SDK workspace (#846, #847):
// the SDK's copies of those two kinds live in memory (lib/workspace-configuration-memory.js, applied to every SDK lib/maker-sdk.js
// makes). Proved at the storage boundary with synthetic canaries — every value the build is given is a unique marker — by scanning
// every workspace file the build command made: at the moment each configuration request is sent, after a successful build with its
// own --verify (which reads every item back into the app folder's durable workspace), after a refused create, after a halt, after
// a process killed between two steps, and after a direct build of a connection reference. The only files allowed to hold a canary
// are the maker's own inputs: the App Spec (which declares the defaults and the value schema) and the settings file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { runCommand } = require('./helpers/configuration-command.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { keepSensitiveConfigurationInMemory } = require('../lib/workspace-configuration-memory.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { configurationSendOnce } = require('../lib/configuration-transport.js');
const { readDeploymentBindings } = require('../lib/configuration-artifacts.js');
const { buildModelApp } = require('../build-model-app.js');
const { STAGES } = require('../lib/stages.js');

const SOLUTION = 'ContosoSol';
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const CANARY = {
  value: 'canary-value-4c1d',
  siteValue: 'canary-site-3a9d',
  default: 'canary-default-8e2f',
  jsonDefault: 'canary-jsondefault-2b70',
  schema: 'canary-schema-5e1b',
  vault: 'canaryvault7d',
  connection: 'canary-conn-6f3e',
};
const KEY_VAULT = `/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/${CANARY.vault}/secrets/apikey`;
const VARIABLES = [
  { schemaName: 'contoso_ApiBase', type: 'string', name: 'API base', defaultValue: `https://${CANARY.default}.contoso.example`, isRequired: true },
  { schemaName: 'contoso_Shape', type: 'json', defaultValue: `{"k":"${CANARY.jsonDefault}"}`, valueSchema: `{"type":"object","title":"${CANARY.schema}"}` },
  { schemaName: 'contoso_ApiKey', type: 'secret' },
  { schemaName: 'contoso_Site', type: 'dataSource', connectorId: SP, parameterKey: 'dataset' },
];
const SETTINGS = {
  EnvironmentVariables: [
    { SchemaName: 'contoso_ApiBase', Value: `https://${CANARY.value}.contoso.example` },
    { SchemaName: 'contoso_ApiKey', Value: KEY_VAULT },
    { SchemaName: 'contoso_Site', Value: `https://${CANARY.siteValue}.sharepoint.example/sites/a` },
  ],
};
const specOf = (extra = {}) => ({
  minimumPluginVersion: '2.25.0',
  solution: { uniqueName: SOLUTION, displayName: 'Contoso Sol', publisherPrefix: 'contoso' },
  app: { name: 'Config Probe', uniqueName: 'contoso_configprobe' },
  schemaVersion: 2,
  entities: [],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Links', subAreas: [{ url: 'https://contoso.example/help', title: 'Help' }] }] }] },
  environmentVariables: VARIABLES,
  ...extra,
});
const PROTECTED = { configurationIdentity: 'stable-v1' };
// The maker's own inputs, which hold what the maker wrote there: the App Spec declares the defaults and the value schema.
const INPUTS = new Set(['app-spec.json', 'settings.json']);
const CONFIGURATION_WRITE = /^\/(environmentvariable|connectionreference)/i;

const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
// Every file under `dirs` (an input excepted) that holds a canary, as `<file>: <canary names>`.
function canariesIn(dirs) {
  const found = [];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      if (INPUTS.has(path.basename(file))) continue;
      let text;
      try { text = fs.readFileSync(file, 'latin1'); } catch { continue; }
      const hits = Object.entries(CANARY).filter(([, c]) => text.includes(c)).map(([k]) => k);
      if (hits.length) found.push(`${path.relative(dir, file)}: ${hits.join(',')}`);
    }
  }
  return found;
}

function settingsFile(settings = SETTINGS) {
  const file = path.join(makeTempDir('ws-cfg-settings-'), 'settings.json');
  fs.writeFileSync(file, JSON.stringify(settings));
  return file;
}

// The build command over the strict org with the canary settings; every SDK workspace folder it makes is collected, and each
// configuration write is preceded by a scan of all of them (`atSend`).
async function command(spec, { org, appDir = path.join(makeTempDir('ws-cfg-'), 'app'), argv = [], settings = SETTINGS, refuse } = {}) {
  const dirs = [];
  const atSend = [];
  const scan = () => canariesIn([...dirs, appDir]);
  org = org || createConfigOrg({
    solution: { uniqueName: SOLUTION, version: '1.0.0.0', prefix: 'contoso' },
    intercept: (req) => {
      if (req.method === 'GET' || !CONFIGURATION_WRITE.test(req.path)) return undefined;
      atSend.push(...scan().map((hit) => `${req.method} ${req.path.split('?')[0]} -> ${hit}`));
      return refuse ? refuse(req) : undefined;
    },
  });
  const out = await runCommand(spec, {
    org, appDir, onStorage: (dir) => dirs.push(dir),
    argv: ['--stage', 'data', '--allow-destructive', '--deployment-settings', settingsFile(settings), ...argv],
  });
  return { ...out, org, appDir, dirs, atSend, scan };
}

test('a protected build with --verify leaves no value, default, schema or secret reference in any workspace file, at any send or after it', async () => {
  const out = await command(specOf(PROTECTED), { argv: ['--verify'] });
  assert.equal(out.thrown, undefined, out.thrown && out.thrown.message);
  assert.ok(!out.exitCode, out.stderr.slice(-900));
  assert.ok(out.org.rows('environmentvariablevalues').length >= 3, 'the values were sent');
  assert.match(out.stderr, /verify/i);
  assert.ok(out.dirs.some((d) => path.resolve(d).startsWith(path.resolve(out.appDir))), 'the durable workspace was opened');
  assert.deepEqual(out.atSend, [], 'no canary in a workspace file when a configuration request is sent');
  assert.deepEqual(out.scan(), [], 'no canary in a workspace file after the build and its verify');
  // The rebuild over the same app folder makes the same decision as before: nothing to write, verify reading every item back.
  const mark = out.org.requests.length;
  const again = await command(specOf(PROTECTED), { org: out.org, appDir: out.appDir, argv: ['--verify'] });
  assert.equal(again.thrown, undefined, again.thrown && again.thrown.message);
  assert.ok(!again.exitCode, again.stderr.slice(-900));
  assert.deepEqual(out.org.writes(mark), [], 'an unchanged rebuild writes nothing');
  assert.deepEqual(again.scan(), []);
  assert.deepEqual(out.org.unexpected, []);
});

test('a protected secret create the service refuses leaves no reference in any workspace file, at the send or after the halt', async () => {
  const out = await command(specOf({ ...PROTECTED, environmentVariables: [{ schemaName: 'contoso_ApiKey', type: 'secret' }] }), {
    settings: { EnvironmentVariables: [{ SchemaName: 'contoso_ApiKey', Value: KEY_VAULT }] },
    refuse: (req) => (req.method === 'POST' && req.path.split('?')[0] === '/environmentvariabledefinitions'
      ? { statusCode: 400, body: { error: { code: '0x80072040', message: 'the value is not a usable secret reference' } } } : undefined),
  });
  assert.ok(out.thrown && /create-refused/.test(out.thrown.message), out.thrown ? out.thrown.message : out.stderr.slice(-900));
  assert.ok(out.atSend.length === 0, `no copy at the send: ${out.atSend}`);
  assert.deepEqual(out.scan(), []);
  assert.ok(!JSON.stringify([out.payload, out.stderr, String(out.thrown && out.thrown.message)]).includes(CANARY.vault));
});

test('an unprotected build halted after its values were sent leaves none of them in any workspace file', async () => {
  // The secret's value write fails: the step halts after the other variables and their values were written.
  const out = await command(specOf(), {
    refuse: (req) => (req.method === 'POST' && req.path.split('?')[0] === '/environmentvariablevalues' && JSON.stringify(req.body || {}).includes(CANARY.vault)
      ? { statusCode: 500, body: { error: { code: '0x80040216', message: 'An unexpected error occurred.' } } } : undefined),
  });
  assert.ok(out.thrown || out.exitCode, 'the build halted');
  assert.ok(out.org.rows('environmentvariabledefinitions').length >= 1, 'something was written before the halt');
  assert.deepEqual(out.atSend, []);
  assert.deepEqual(out.scan(), []);
});

test('copies an earlier version left in the app folder\u2019s workspace are removed by an apply and never read; a dry run leaves the folder as it is', async () => {
  const appDir = path.join(makeTempDir('ws-cfg-legacy-'), 'app');
  const ws = path.join(appDir, '.maker-workspace');
  const stale = {
    'environment-variables/00000000-0000-4000-8000-0000000000aa.json': { id: '00000000-0000-4000-8000-0000000000aa', currentValue: { value: KEY_VAULT } },
    '.metadata/environment-variables/00000000-0000-4000-8000-0000000000aa.meta.json': { snapshot: { defaultValue: CANARY.default } },
    'connection-references/00000000-0000-4000-8000-0000000000bb.json': { connectionId: CANARY.connection },
    '.metadata/connection-references/00000000-0000-4000-8000-0000000000bb.meta.json': { snapshot: { connectionId: CANARY.connection } },
  };
  const plant = () => {
    for (const [rel, body] of Object.entries(stale)) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), JSON.stringify(body));
    }
  };
  // The first apply binds the folder to the environment; the copies are planted after it, as an earlier version's verify left them.
  const first = await command(specOf(PROTECTED), { appDir });
  assert.equal(first.thrown, undefined, first.thrown && first.thrown.message);
  plant();
  const before = canariesIn([ws]).sort();
  assert.equal(before.length, 4);
  const dry = await runCommand(specOf(PROTECTED), { org: first.org, appDir, apply: false, argv: ['--stage', 'data', '--allow-destructive'] });
  assert.ok(!dry.exitCode, dry.stderr.slice(-900));
  assert.deepEqual(canariesIn([ws]).sort(), before, 'a dry run writes nothing to the app folder');
  const mark = first.org.requests.length;
  const again = await command(specOf(PROTECTED), { org: first.org, appDir, argv: ['--verify'] });
  assert.equal(again.thrown, undefined, again.thrown && again.thrown.message);
  assert.deepEqual(first.org.writes(mark), [], 'the stale copies changed no decision');
  assert.deepEqual(canariesIn([ws]), [], 'the apply removed them');
});

test('a direct build of a connection reference and variables keeps the connection id and every value out of the SDK workspace', async () => {
  const org = createConfigOrg({ solution: { uniqueName: SOLUTION, version: '1.0.0.0', prefix: 'contoso' } });
  const atSend = [];
  const sdkDir = makeTempDir('ws-cfg-direct-sdk-');
  const request = async (req) => {
    if (String(req.method).toUpperCase() !== 'GET' && /\/(environmentvariable|connectionreference)/i.test(String(req.url))) atSend.push(...canariesIn([sdkDir]));
    return org.request(req);
  };
  const httpClient = createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request, sleep: async () => {}, sendOnce: (m, u) => configurationSendOnce(m, u) });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(sdkDir), instanceUrl: org.origin, httpClient, solutionUniqueName: SOLUTION });
  await sdk.initWorkspace();
  const spec = specOf({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] });
  const bindings = readDeploymentBindings({ ...SETTINGS, ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: CANARY.connection }] }, spec);
  assert.deepEqual(bindings.errors, []);
  const r = await buildModelApp(spec, { apply: true, env: org.origin, phases: STAGES.data, workspaceDir: makeTempDir('ws-cfg-direct-ws-'), retryDelayMs: 0, configurationBindings: bindings },
    { sdk, log: () => {}, warn: () => {}, connections: async () => [{ connectionId: CANARY.connection, connectorId: SP }] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(org.rows('connectionreferences')[0].connectionid, CANARY.connection, 'the connection was bound');
  // The SDK still reads its in-run copy back: the server's connection id is what fetchArtifact answers.
  const [ref] = org.rows('connectionreferences');
  assert.equal((await sdk.fetchArtifact('connectionReference', ref.connectionreferenceid, { overwrite: true })).connectionId, CANARY.connection);
  assert.deepEqual(atSend, []);
  assert.deepEqual(canariesIn([sdkDir]), []);
});

// The build command in a separate OS process, killed (SIGKILL: no cleanup runs) while its first configuration create is on the wire.
// Its throwaway SDK workspace is made under the test's own temporary folder (TEMP/TMP), which is scanned after the process is gone.
test('a build process killed while a configuration create is on the wire leaves no canary in any file it made', async () => {
  const root = makeTempDir('ws-cfg-crash-');
  const appDir = path.join(root, 'app');
  const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' };
  delete env.NODE_TEST_CONTEXT;
  const org = createConfigOrg({ solution: { uniqueName: SOLUTION, version: '1.0.0.0', prefix: 'contoso' } });
  fs.mkdirSync(appDir, { recursive: true });
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify(SETTINGS));
  const atKill = await new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'helpers', 'configuration-command-child.js'), [], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
    let found = null;
    child.on('message', async (m) => {
      if (!m.request) return;
      const at = String(m.req.url).replace(/^https:\/\/[^/]+\/api\/data\/v9\.\d/, '');
      if (found === null && String(m.req.method).toUpperCase() === 'POST' && /^\/environmentvariablevalues/i.test(at)) {
        found = canariesIn([root]);
        child.kill('SIGKILL');
        return;
      }
      try { child.send({ reply: m.request, answer: await org.request(m.req) }); } catch { /* the child is gone */ }
    });
    child.on('error', reject);
    child.on('exit', () => (found === null ? reject(new Error('the process ended before its first value was sent')) : resolve(found)));
    child.send({ start: { origin: org.origin, spec: specOf(PROTECTED), appDir, argv: ['--stage', 'data', '--allow-destructive', '--deployment-settings', settings] } });
  });
  assert.ok(org.rows('environmentvariabledefinitions').length >= 1, 'a definition was created before the kill');
  assert.deepEqual(atKill, [], 'no canary in any file while the value create was on the wire');
  assert.deepEqual(canariesIn([root]), [], 'none in any file the killed process left behind');
});

// The overlay itself, over a real file-system storage.
test('the overlay keeps the two sensitive kinds in memory and every other key on disk, and removes stale copies only at the first mutation', async () => {
  const dir = makeTempDir('ws-cfg-unit-');
  const storage = createNodeWorkspaceStorage(dir);
  fs.mkdirSync(path.join(dir, 'environment-variables'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'environment-variables', 'old.json'), 'stale');
  const o = keepSensitiveConfigurationInMemory(storage);
  assert.ok(o instanceof storage.constructor, 'instanceof holds');
  assert.equal(o.getRoot(), dir);
  assert.equal(o.pathFor(['views', 'v.json']), storage.pathFor(['views', 'v.json']));
  assert.equal(await o.readText(['environment-variables', 'old.json']), null, 'a stale copy is never read');
  assert.equal(await o.exists(['environment-variables', 'old.json']), false);
  assert.ok(fs.existsSync(path.join(dir, 'environment-variables', 'old.json')), 'reads remove nothing');
  await o.writeTextAtomic(['environment-variables', 'a.json'], 'A');
  await o.writeTextAtomic(['.metadata', 'connection-references', 'b.meta.json'], 'B');
  await o.writeTextAtomic(['views', 'v.json'], 'V');
  assert.ok(!fs.existsSync(path.join(dir, 'environment-variables')), 'the first mutation removed the stale copies');
  assert.equal(await o.readText(['environment-variables', 'a.json']), 'A');
  assert.equal(await o.exists(['.metadata', 'connection-references', 'b.meta.json']), true);
  assert.equal(fs.readFileSync(path.join(dir, 'views', 'v.json'), 'utf8'), 'V', 'another kind stays on disk');
  assert.deepEqual(walk(dir).map((f) => path.relative(dir, f)), [path.join('views', 'v.json')]);
  await o.deleteByPrefix(['.metadata']);
  assert.equal(await o.readText(['.metadata', 'connection-references', 'b.meta.json']), null);
  await o.deleteFile(['environment-variables', 'a.json']);
  assert.equal(await o.readText(['environment-variables', 'a.json']), null);
  // A second wrapper (the next process) starts with nothing.
  await o.writeTextAtomic(['environment-variables', 'c.json'], 'C');
  assert.equal(await keepSensitiveConfigurationInMemory(storage).readText(['environment-variables', 'c.json']), null);
});
