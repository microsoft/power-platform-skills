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
const { fork, spawn } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { runCommand } = require('./helpers/configuration-command.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { keepSensitiveConfigurationInMemory } = require('../lib/workspace-configuration-memory.js');
const { hasUnsyncedEdits } = require('../lib/unsynced-edits.js');
// The SDK as an earlier plugin version made it: the bundle with no overlay, so its copies land on disk (as 2.26's verify left them).
const bundle = require('../vendor/cds-maker-sdk.cjs');
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

// Copies an earlier plugin version left: its verify fetched each configuration item into the app folder's workspace with the SDK
// as it made it (no overlay), so the artifact and its last-synced snapshot are files. Answers that SDK and the ids it fetched.
const LEGACY_CODE = 'WORKSPACE_LEGACY_CONFIGURATION_COPY';
const httpOf = (org) => createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request: (req) => org.request(req), sleep: async () => {} });
async function earlierVersionFetched(org, ws) {
  const sdk = bundle.createMakerSdk({ workspaceStorage: bundle.createNodeWorkspaceStorage(ws), instanceUrl: org.origin, httpClient: httpOf(org) });
  await sdk.initWorkspace();
  const ids = org.rows('environmentvariabledefinitions').map((r) => r.environmentvariabledefinitionid);
  for (const id of ids) await sdk.fetchArtifact('environmentVariable', id, { overwrite: true });
  return { sdk, ids };
}
// Every file under the two sensitive folders (and their metadata folders) of `ws`, relative path → bytes (hex).
function sensitiveFiles(ws) {
  const out = {};
  for (const rel of ['environment-variables', 'connection-references', '.metadata/environment-variables', '.metadata/connection-references']) {
    for (const file of walk(path.join(ws, rel))) out[path.relative(ws, file).split(path.sep).join('/')] = fs.readFileSync(file).toString('hex');
  }
  return out;
}
// What this process writes to its real stderr while `fn` runs (lib/maker-sdk.js warns there, outside the CLI harness's own stderr).
async function withStderr(fn) {
  const write = process.stderr.write;
  const got = [];
  process.stderr.write = function capture(chunk) { got.push(String(chunk)); return true; };
  try {
    const result = await fn();
    return { result, text: got.join('') };
  } finally {
    process.stderr.write = write;
  }
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

// The copies an earlier version's verify left (real SDK files: each artifact and its snapshot). They are proven to be what
// the environment last held, so they are not read and change no decision; they are neither rewritten nor deleted (this version
// never deletes a file it did not write); the build says, once and without any of their content, which folders hold them.
test('copies an earlier version\u2019s verify left in the app folder\u2019s workspace are never read or deleted: an ordinary apply makes the same decisions, keeps them byte for byte and warns once naming their folders, never their content', async () => {
  const appDir = path.join(makeTempDir('ws-cfg-legacy-'), 'app');
  const ws = path.join(appDir, '.maker-workspace');
  const first = await command(specOf(PROTECTED), { appDir });
  assert.equal(first.thrown, undefined, first.thrown && first.thrown.message);
  await earlierVersionFetched(first.org, ws);
  const before = sensitiveFiles(ws);
  assert.ok(Object.keys(before).length >= 8, Object.keys(before).join(' '));
  assert.ok(canariesIn([ws]).length > 0, 'the earlier version wrote values to disk');
  const mark = first.org.requests.length;
  const runs = await withStderr(async () => {
    const dry = await runCommand(specOf(PROTECTED), { org: first.org, appDir, apply: false, argv: ['--stage', 'data', '--allow-destructive'] });
    assert.ok(!dry.exitCode, dry.stderr.slice(-900));
    assert.deepEqual(sensitiveFiles(ws), before, 'a dry run leaves the folder as it is');
    const again = await command(specOf(PROTECTED), { org: first.org, appDir });
    assert.equal(again.thrown, undefined, again.thrown && again.thrown.message);
    assert.ok(!again.exitCode, again.stderr.slice(-900));
    return again;
  });
  assert.deepEqual(first.org.writes(mark), [], 'the copies changed no decision: an unchanged rebuild writes nothing');
  assert.deepEqual(sensitiveFiles(ws), before, 'an ordinary apply neither rewrites nor deletes them');
  const warnings = runs.text.split('\n').filter((l) => l.includes('still holds environment-variable or connection-reference copies'));
  assert.equal(warnings.length, 1, runs.text.slice(-1500));
  assert.ok(warnings[0].includes(ws), warnings[0]);
  assert.match(warnings[0], /environment-variables, \.metadata\/environment-variables/);
  assert.ok(!Object.values(CANARY).some((c) => runs.text.includes(c)), 'the warning quotes no content');
  // Its verify reads every item back over them: still the same decisions, and still the same files.
  const verified = await command(specOf(PROTECTED), { org: first.org, appDir, argv: ['--verify'] });
  assert.equal(verified.thrown, undefined, verified.thrown && verified.thrown.message);
  assert.ok(!verified.exitCode, verified.stderr.slice(-900));
  assert.deepEqual(first.org.writes(mark), []);
  assert.deepEqual(sensitiveFiles(ws), before);
  assert.deepEqual(first.org.unexpected, []);
});

// An edit an earlier version's SDK made and never sent. The SDK used to report it as a change; hiding it would read as clean.
test('a draft an earlier version left is never hidden or deleted: the SDK\u2019s first touch of it is refused, naming its files and quoting none of its content, and the run goes on once the maker removes it', async () => {
  const DRAFT = 'canary-draft-91c4';
  const first = await command(specOf());
  assert.equal(first.thrown, undefined, first.thrown && first.thrown.message);
  const ws = makeTempDir('ws-cfg-draft-');
  const earlier = await earlierVersionFetched(first.org, ws);
  const [draftId, otherId] = earlier.ids;
  await earlier.sdk.updateElement('environmentVariable', draftId, '/defaultValue', DRAFT);
  assert.equal(await hasUnsyncedEdits(earlier.sdk, 'environmentVariable', draftId), true, 'the earlier version reports the draft');
  fs.rmSync(path.join(ws, 'environment-variables', `${otherId}.json`));
  fs.rmSync(path.join(ws, '.metadata', 'environment-variables', `${otherId}.meta.json`));
  const before = sensitiveFiles(ws);

  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(ws), instanceUrl: first.org.origin, httpClient: httpOf(first.org) });
  await sdk.initWorkspace();
  assert.equal(await hasUnsyncedEdits(sdk, 'environmentVariable', draftId), true, 'the draft still reads as a change, never as clean');
  const refused = await sdk.diffArtifact('environmentVariable', draftId).then(() => null, (e) => e);
  assert.ok(refused, 'the first touch of the draft is refused');
  assert.equal(refused.code, LEGACY_CODE, refused.message);
  assert.ok(refused.message.includes(path.join(ws, 'environment-variables', `${draftId}.json`)), refused.message);
  assert.match(refused.message, /differs from its last-synced snapshot/);
  assert.ok(!refused.message.includes(DRAFT) && !Object.values(CANARY).some((c) => refused.message.includes(c)), 'no content is quoted');
  await assert.rejects(sdk.fetchArtifact('environmentVariable', draftId, { overwrite: true }), { code: LEGACY_CODE }, 'not even an overwrite replaces it');
  // Another item is untouched by it: fetched into memory, and the draft is still there byte for byte.
  assert.equal((await sdk.fetchArtifact('environmentVariable', otherId, { overwrite: true })).id, otherId);
  assert.deepEqual(sensitiveFiles(ws), before, 'nothing on disk was deleted or rewritten');
  // The maker removes the two files (after moving the change to the App Spec): the run goes on, with nothing left on disk.
  fs.rmSync(path.join(ws, 'environment-variables', `${draftId}.json`));
  fs.rmSync(path.join(ws, '.metadata', 'environment-variables', `${draftId}.meta.json`));
  assert.equal((await sdk.fetchArtifact('environmentVariable', draftId, { overwrite: true })).id, draftId);
  assert.deepEqual((await sdk.diffArtifact('environmentVariable', draftId)).changes, []);
  // Only the maker's deletion removed anything: the other clean copies are still there byte for byte, and nothing was written.
  const kept = { ...before };
  delete kept[`environment-variables/${draftId}.json`];
  delete kept[`.metadata/environment-variables/${draftId}.meta.json`];
  assert.deepEqual(sensitiveFiles(ws), kept);
});

// Through the command: the build's own verify meets such a draft in the app folder.
test('a build whose verify meets a draft an earlier version left stops with the refusal and keeps the draft; once the maker deletes it, the rebuild verifies', async () => {
  const appDir = path.join(makeTempDir('ws-cfg-draft-cli-'), 'app');
  const ws = path.join(appDir, '.maker-workspace');
  const first = await command(specOf(PROTECTED), { appDir });
  assert.equal(first.thrown, undefined, first.thrown && first.thrown.message);
  const earlier = await earlierVersionFetched(first.org, ws);
  const id = first.org.rows('environmentvariabledefinitions').find((r) => r.schemaname === 'contoso_ApiBase').environmentvariabledefinitionid;
  await earlier.sdk.updateElement('environmentVariable', id, '/defaultValue', 'canary-draft-0d2e');
  const before = sensitiveFiles(ws);
  const mark = first.org.requests.length;
  const stopped = await command(specOf(PROTECTED), { org: first.org, appDir, argv: ['--verify'] });
  const said = `${stopped.thrown ? stopped.thrown.message : ''}\n${stopped.stderr}\n${JSON.stringify(stopped.payload || {})}`;
  assert.ok(stopped.thrown || stopped.exitCode, 'the build does not pass over the draft');
  assert.ok(said.includes(LEGACY_CODE) || said.includes('an earlier plugin version wrote'), said.slice(-1500));
  assert.ok(!said.includes('canary-draft-0d2e'));
  assert.deepEqual(first.org.writes(mark), [], 'nothing was sent');
  assert.deepEqual(sensitiveFiles(ws), before, 'the draft is kept');
  fs.rmSync(path.join(ws, 'environment-variables', `${id}.json`));
  fs.rmSync(path.join(ws, '.metadata', 'environment-variables', `${id}.meta.json`));
  const again = await command(specOf(PROTECTED), { org: first.org, appDir, argv: ['--verify'] });
  assert.equal(again.thrown, undefined, again.thrown && again.thrown.message);
  assert.ok(!again.exitCode, again.stderr.slice(-900));
  assert.deepEqual(first.org.writes(mark), []);
});

// A --workspace: the build's configuration step works in its own throwaway workspace, so a draft an earlier
// version left in a --workspace is never read by it: an ordinary apply keeps it byte for byte (it used to be removed at the
// first write) and the build names its folder in the warning, never its content.
test('a build over a --workspace holding a draft an earlier version left keeps the draft byte for byte, sends nothing and names its folder', async () => {
  const ws = makeTempDir('ws-cfg-draft-ws-');
  const first = await command(specOf(PROTECTED), { argv: ['--workspace', ws] });
  assert.equal(first.thrown, undefined, first.thrown && first.thrown.message);
  const earlier = await earlierVersionFetched(first.org, ws);
  const id = first.org.rows('environmentvariabledefinitions').find((r) => r.schemaname === 'contoso_ApiBase').environmentvariabledefinitionid;
  await earlier.sdk.updateElement('environmentVariable', id, '/defaultValue', 'canary-draft-5be1');
  const before = sensitiveFiles(ws);
  const mark = first.org.requests.length;
  const run = await withStderr(() => command(specOf(PROTECTED), { org: first.org, argv: ['--workspace', ws] }));
  const again = run.result;
  assert.equal(again.thrown, undefined, again.thrown && again.thrown.message);
  assert.ok(!again.exitCode, again.stderr.slice(-900));
  assert.deepEqual(first.org.writes(mark), [], 'nothing was sent');
  assert.deepEqual(sensitiveFiles(ws), before, 'the draft is kept');
  assert.ok(run.text.includes('still holds environment-variable or connection-reference copies') && run.text.includes(ws), run.text.slice(-1500));
  assert.ok(!run.text.includes('canary-draft-5be1') && !Object.values(CANARY).some((c) => run.text.includes(c)), 'the warning quotes no content');
});

// A caller-supplied workspace is no proof that everything under it is the plugin's.
test('a file of the maker\u2019s own in a sensitive folder of a --workspace with no manifest is kept by a build', async () => {
  const ws = makeTempDir('ws-cfg-notes-');
  const note = path.join(ws, 'environment-variables', 'author-notes.txt');
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, 'notes of the maker\'s own');
  const out = await command(specOf(PROTECTED), { argv: ['--workspace', ws] });
  assert.equal(out.thrown, undefined, out.thrown && out.thrown.message);
  assert.ok(!out.exitCode, out.stderr.slice(-900));
  assert.ok(out.dirs.some((d) => path.resolve(d) === path.resolve(ws)), 'the build opened that workspace');
  assert.equal(fs.readFileSync(note, 'utf8'), 'notes of the maker\'s own');
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
test('the overlay keeps the two sensitive kinds in memory and every other key on disk, and deletes on disk only what the SDK asks', async () => {
  const dir = makeTempDir('ws-cfg-unit-');
  const storage = createNodeWorkspaceStorage(dir);
  const deletes = [];
  const deleteFile = storage.deleteFile.bind(storage);
  const deleteByPrefix = storage.deleteByPrefix.bind(storage);
  storage.deleteFile = (key) => { deletes.push(['file', key.join('/')]); return deleteFile(key); };
  storage.deleteByPrefix = (prefix) => { deletes.push(['prefix', prefix.join('/')]); return deleteByPrefix(prefix); };
  const o = keepSensitiveConfigurationInMemory(storage);
  assert.ok(o instanceof storage.constructor, 'instanceof holds');
  assert.equal(o.getRoot(), dir);
  assert.equal(o.pathFor(['views', 'v.json']), storage.pathFor(['views', 'v.json']));
  await o.writeTextAtomic(['environment-variables', 'a.json'], 'A');
  await o.writeTextAtomic(['.metadata', 'connection-references', 'b.meta.json'], 'B');
  await o.writeTextAtomic(['views', 'v.json'], 'V');
  assert.deepEqual(deletes, [], 'a write deletes nothing');
  assert.equal(await o.readText(['environment-variables', 'a.json']), 'A');
  assert.equal(await o.exists(['.metadata', 'connection-references', 'b.meta.json']), true);
  assert.equal(fs.readFileSync(path.join(dir, 'views', 'v.json'), 'utf8'), 'V', 'another kind stays on disk');
  assert.deepEqual(walk(dir).map((f) => path.relative(dir, f)), [path.join('views', 'v.json')]);
  await o.deleteByPrefix(['.metadata']);
  assert.equal(await o.readText(['.metadata', 'connection-references', 'b.meta.json']), null);
  await o.deleteFile(['environment-variables', 'a.json']);
  assert.equal(await o.readText(['environment-variables', 'a.json']), null);
  assert.deepEqual(deletes, [['prefix', '.metadata'], ['file', 'environment-variables/a.json']], 'only what the SDK asked');
  // A second wrapper (the next process) starts with nothing.
  await o.writeTextAtomic(['environment-variables', 'c.json'], 'C');
  assert.equal(await keepSensitiveConfigurationInMemory(storage).readText(['environment-variables', 'c.json']), null);
});

// A copy that cannot be read is not proven clean, so it is refused (never hidden, never recorded as checked), nothing is
// deleted, and the next access after the obstruction is gone checks it again and goes on.
const CLEAN = { id: 'e1', defaultValue: CANARY.default };
function plantCleanPair(dir, id = 'e1') {
  fs.mkdirSync(path.join(dir, 'environment-variables'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.metadata', 'environment-variables'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'environment-variables', `${id}.json`), JSON.stringify(CLEAN));
  fs.writeFileSync(path.join(dir, '.metadata', 'environment-variables', `${id}.meta.json`), JSON.stringify({ etag: 'W/"1"', snapshot: CLEAN }));
}

test('a copy an earlier version left that cannot be read is refused rather than hidden, nothing is deleted, and a retry once it can be read goes on', async () => {
  const dir = makeTempDir('ws-cfg-denied-');
  plantCleanPair(dir);
  const before = sensitiveFiles(dir);
  const storage = createNodeWorkspaceStorage(dir);
  let denied = true;
  const reads = [];
  const deletes = [];
  const readText = storage.readText.bind(storage);
  storage.readText = async (key) => {
    reads.push(key.join('/'));
    if (denied && key[key.length - 1].startsWith('e1.')) throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' });
    return readText(key);
  };
  storage.deleteFile = async (key) => { deletes.push(key.join('/')); };
  storage.deleteByPrefix = async (prefix) => { deletes.push(prefix.join('/')); };
  const o = keepSensitiveConfigurationInMemory(storage);
  for (const touch of [() => o.readText(['environment-variables', 'e1.json']), () => o.exists(['environment-variables', 'e1.json']), () => o.writeTextAtomic(['.metadata', 'environment-variables', 'e1.meta.json'], '{}')]) {
    const err = await touch().then(() => null, (e) => e);
    assert.ok(err, 'refused, not hidden');
    assert.equal(err.code, LEGACY_CODE);
    assert.match(err.message, /could not be read \(EPERM/);
    assert.ok(!err.message.includes(CANARY.default));
  }
  // An unrelated write goes on, and nothing is deleted on the way.
  await o.writeTextAtomic(['views', 'v.json'], 'V');
  await o.writeTextAtomic(['environment-variables', 'e2.json'], '{}');
  assert.deepEqual(deletes, []);
  assert.deepEqual(sensitiveFiles(dir), before);
  // The obstruction is removed: the refusal was not remembered, the copy is checked again, proven clean and from then on not read.
  denied = false;
  const readsBefore = reads.length;
  assert.equal(await o.readText(['environment-variables', 'e1.json']), null);
  assert.ok(reads.length > readsBefore, 'checked again');
  assert.equal(await o.exists(['environment-variables', 'e1.json']), false);
  assert.deepEqual(deletes, []);
  assert.deepEqual(sensitiveFiles(dir), before);
});

// The same on a real Windows lock: another program (a child PowerShell) holds the copy open with no sharing (FileShare.None).
// The child's whole life is bounded, so a misbehaving holder can never hang the suite: it must report the lock within
// HOLDER_READY_MS and exit within HOLDER_EXIT_MS of its release, or it is killed and the test fails with the reason. Its end is
// captured from the moment it is spawned: a holder that ends on its own after reporting the lock has already emitted `exit`, so
// a listener added only when the test releases it would wait for an event that is gone.
const HOLDER_READY_MS = 60000;
const HOLDER_EXIT_MS = 15000;
function withinMs(promise, ms, message) {
  let timer;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
async function holdLocked(file) {
  const quoted = file.replace(/'/g, "''");
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$f = [System.IO.File]::Open('${quoted}', 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()`],
  { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  // A release written after the holder has gone fails with EPIPE on its stdin; `ended` already records that it has gone.
  ps.stdin.on('error', () => {});
  const ended = new Promise((resolve) => {
    ps.once('exit', (code, signal) => resolve(`exit ${code === null ? signal : code}`));
    ps.once('error', (error) => resolve(`spawn error: ${error.message}`));
  });
  const stop = async () => {
    if (ps.exitCode === null && ps.signalCode === null) ps.kill();
    await withinMs(ended, HOLDER_EXIT_MS, 'the lock holder did not end after it was killed').catch(() => {});
  };
  let out = '';
  const locked = new Promise((resolve, reject) => {
    ps.stdout.on('data', (d) => { out += d; if (out.includes('locked')) resolve(); });
    ended.then((how) => reject(new Error(`the lock holder ended before it held the file (${how})`)));
  });
  try {
    await withinMs(locked, HOLDER_READY_MS, `the lock holder did not report the lock within ${HOLDER_READY_MS} ms`);
  } catch (error) {
    await stop();
    throw error;
  }
  let releasing = null;
  const release = () => releasing || (releasing = (async () => {
    if (!ps.stdin.destroyed && !ps.stdin.writableEnded) ps.stdin.end('\n');
    try {
      await withinMs(ended, HOLDER_EXIT_MS, `the lock holder did not exit within ${HOLDER_EXIT_MS} ms of its release`);
    } catch (error) {
      await stop();
      throw error;
    }
  })());
  release.pid = ps.pid;
  release.ended = ended;
  return release;
}

test('the lock holder releases cleanly even when it ended on its own after holding the file (Windows)', { skip: process.platform !== 'win32' && 'a FileShare.None lock is a Windows file-system feature' }, async () => {
  const dir = makeTempDir('ws-cfg-holder-');
  const file = path.join(dir, 'held.json');
  fs.writeFileSync(file, '{}');
  const release = await holdLocked(file);
  process.kill(release.pid);
  // The holder's exit has been delivered before the test releases it: the release must still settle, and settle once.
  await release.ended;
  await withinMs(release(), HOLDER_EXIT_MS + 5000, 'the release of a holder that had already ended did not settle');
  await release();
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});

test('a copy locked by another program is refused while locked and checked again once released (Windows)', { skip: process.platform !== 'win32' && 'a FileShare.None lock is a Windows file-system feature' }, async () => {
  const dir = makeTempDir('ws-cfg-locked-');
  plantCleanPair(dir);
  const before = sensitiveFiles(dir);
  const o = keepSensitiveConfigurationInMemory(createNodeWorkspaceStorage(dir), { refuse: (code, message) => new bundle.SdkError(code, message) });
  const release = await holdLocked(path.join(dir, 'environment-variables', 'e1.json'));
  let err;
  try {
    err = await o.readText(['environment-variables', 'e1.json']).then(() => null, (e) => e);
    await o.writeTextAtomic(['views', 'v.json'], 'V');
  } finally {
    await release();
  }
  assert.ok(err, 'refused while locked');
  assert.equal(err.code, LEGACY_CODE);
  assert.ok(err instanceof bundle.SdkError);
  assert.match(err.message, /could not be read/);
  assert.deepEqual(sensitiveFiles(dir), before, 'nothing deleted');
  assert.equal(await o.readText(['environment-variables', 'e1.json']), null, 'released: checked again and proven clean');
  assert.deepEqual(sensitiveFiles(dir), before);
});
