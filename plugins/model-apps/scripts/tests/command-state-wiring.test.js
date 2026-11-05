'use strict';
// How commandStates[] reaches the parts of a build around its writer: the changed-only snapshot diff and classifier (a states-only change is a
// full build, never debt and never a no-op), verification (each entry is checked, and a reader that cannot read command rows fails it), the
// spec document, the --authorize parser and the CLI's refusal of an apply that cannot apply them. A spec without commandStates is unchanged.

const test = require('node:test');
const assert = require('node:assert');
const { diffPhases, PHASE_SLICES, stableStringify } = require('../lib/phase-diff.js');
const { classifyChanges } = require('../lib/classify-changes.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { renderAppSpecDoc } = require('../lib/app-spec-doc.js');
const { buildModelApp, authorizationKeys } = require('../build-model-app.js');
const { commandStateApprovalKey, commandTablePublishApprovalKey } = require('../lib/command-state-contract.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const ROW = '11111111-1111-4111-8111-111111111111';
const ROW2 = '22222222-2222-4222-8222-222222222222';
const state = (rowId, extra = {}) => ({ entity: 'new_x', location: 'MainTab', scope: 'table', rowId, hidden: true, ...extra });
const spec = (commandStates) => ({
  schemaVersion: 2,
  minimumPluginVersion: '2.24.0',
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  app: { name: 'A', uniqueName: 'new_a' },
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_x' }] }] }] },
  entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
  commands: [],
  ...(commandStates ? { commandStates } : {}),
});

test('the commands slice includes command states only when some are declared, in row-id order', () => {
  assert.strictEqual(stableStringify(PHASE_SLICES.commands(spec())), stableStringify(spec().commands), 'no states: the slice is exactly as before');
  assert.strictEqual(stableStringify(PHASE_SLICES.commands(spec([]))), stableStringify(spec().commands));
  const a = spec([state(ROW2), state(ROW)]);
  const b = spec([state(ROW), state(ROW2)]);
  assert.deepStrictEqual(diffPhases(a, b), [], 'their order means nothing');
  assert.ok(diffPhases(spec([state(ROW, { hidden: false })]), spec([state(ROW)])).includes('commands'));
  assert.ok(diffPhases(spec([state(ROW)]), spec()).includes('commands'));
});

test('a command-state-only change is a full build with no debt: added, changed and no longer declared', () => {
  for (const [cur, prior, words] of [
    [spec([state(ROW)]), spec(), 'added'],
    [spec([state(ROW, { disabled: true })]), spec([state(ROW)]), 'changed'],
    [spec(), spec([state(ROW.toUpperCase())]), 'no longer declared'],
  ]) {
    const r = classifyChanges(cur, prior);
    assert.strictEqual(r.verdict, 'full', words);
    assert.deepStrictEqual(r.debt, [], words);
    assert.ok(r.fullReasons.some((x) => x.includes(`row '${ROW}' ${words}`)), `${words}: ${JSON.stringify(r.fullReasons)}`);
  }
  assert.strictEqual(classifyChanges(spec([state(ROW2), state(ROW)]), spec([state(ROW), state(ROW2)])).verdict, 'noop');
});

test('verify checks each declared entry; a reader that cannot read command rows, or a read that fails, fails every one', async () => {
  const base = { findTable: async () => ({ logicalName: 'new_x' }), findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '<SiteMap/>' };
  const s = { ...spec([state(ROW), state(ROW2, { disabled: true })]), appShell: { areas: [] } };
  const kind = (r) => r.checks.filter((c) => c.kind === 'command-state').map((c) => [c.name, c.present]);
  const none = await verifySpec(s, base);
  assert.deepStrictEqual(kind(none), [[`new_x MainTab row ${ROW}`, false], [`new_x MainTab row ${ROW2}`, false]]);
  assert.strictEqual(none.ok, false);
  const thrown = await verifySpec(s, { ...base, commandStates: async () => { throw new Error('offline'); } });
  assert.deepStrictEqual(kind(thrown).map((c) => c[1]), [false, false]);
  const seen = [];
  const read = await verifySpec(s, { ...base, commandStates: async (given) => { seen.push(given); return [{ name: 'one', present: true, detail: 'hidden true' }, { name: 'two', present: false, detail: 'disabled is false, declared true' }]; } });
  assert.deepStrictEqual(kind(read), [['one', true], ['two', false]]);
  assert.strictEqual(seen.length, 1);
  const plain = await verifySpec({ ...spec(), appShell: { areas: [] } }, { ...base, commandStates: async () => { throw new Error('never called'); } });
  assert.deepStrictEqual(kind(plain), [], 'no states: no command-state check');
});

test('the spec document lists the declared states, with an omitted flag as unchanged, and says nothing when there are none', () => {
  const doc = renderAppSpecDoc(spec([{ entity: 'New_X', location: 'HomeTab', scope: 'table', rowId: ROW, disabled: false }]));
  assert.match(doc, /### Existing command buttons shown or hidden/);
  assert.match(doc, new RegExp(`\\| \`${ROW}\` \\| new_x \\| HomeTab \\| table \\| unchanged \\| no \\|`));
  assert.doesNotMatch(renderAppSpecDoc(spec()), /Existing command buttons/);
});

test('--authorize claims the command-state tokens for the declared rows and tables, and refuses one that names nothing declared', () => {
  const s = spec([state(ROW)]);
  const ids = { origin: 'https://contoso.crm.dynamics.com', appId: ROW2, tableId: ROW2, entity: 'new_x' };
  const row = commandStateApprovalKey({ ...ids, location: 0, rowId: ROW, ifMatch: 'W/"1"', desired: { hidden: true } });
  const table = commandTablePublishApprovalKey(ids);
  const ok = authorizationKeys(['--env', 'https://x', '--authorize', row, `--authorize=${table}`, '--apply'], s);
  assert.strictEqual(ok.error, null);
  assert.deepStrictEqual([[...ok.commandStateRows], [...ok.commandStateTables], [...ok.keys]], [[row], [table], []]);
  const bad = authorizationKeys(['--authorize', row.replace(ROW, ROW2)], s);
  assert.match(bad.error, /names a command row that no commandStates entry declares/);
  const plain = authorizationKeys(['--env', 'https://x'], spec());
  assert.deepStrictEqual([plain.commandStateRows.size, plain.commandStateTables.size, plain.error], [0, 0, null]);
});

test('an apply that cannot apply command states is refused before the build runs; a dry run and a spec without them are not', async () => {
  const runs = [];
  const runBuild = async (s, o) => { runs.push(o); return { ok: true, dryRun: !o.apply, created: {} }; };
  const quiet = { log: () => {}, warn: () => {} };
  for (const [opts, code] of [[{ apply: true }, 'command-state-publish-required'], [{ apply: true, publish: true, changedOnly: { fastApply: true } }, 'command-state-phase-unsupported']]) {
    const r = await buildModelApp(spec([state(ROW)]), { ...opts, workspaceDir: makeTempDir('cs-mode-') }, { runBuild, ...quiet });
    assert.strictEqual(r.ok, false, code);
    assert.ok(r.errors[0].startsWith(`${code}: `), r.errors[0]);
  }
  const keyed = await buildModelApp({ ...spec([state(ROW)]), commands: [{ key: 'go', entity: 'new_x', label: 'Go', library: 'new_go.js', function: 'Ns.go' }], webResources: [{ name: 'new_go.js', type: 'js', content: 'var Ns = {};' }] }, { apply: true, publish: true, workspaceDir: makeTempDir('cs-mode-') }, { runBuild, ...quiet });
  assert.ok(keyed.errors[0].startsWith('command-state-keyed-unsupported: '));
  assert.strictEqual(runs.length, 0, 'nothing ran');
  await buildModelApp(spec([state(ROW)]), { workspaceDir: makeTempDir('cs-mode-') }, { runBuild, ...quiet });
  assert.strictEqual(runs.length, 1, 'a dry run plans them');
  await buildModelApp(spec(), { apply: true, workspaceDir: makeTempDir('cs-mode-') }, { runBuild, ...quiet });
  assert.strictEqual(runs.length, 2, 'no command states: the build runs as before');
});

test('the wrapper refuses an invalid commandStates too, and the engine refuses it when the wrapper only warns', async () => {
  const { runSdkBuild } = require('../lib/sdk-build.js');
  const quiet = { log: () => {}, warn: () => {} };
  for (const [what, value, code] of [['app scope', [state(ROW, { scope: 'app' })], 'command-state-app-scope-unverified'], ['null', null, 'command-state-spec-invalid']]) {
    const bad = { ...spec(), commandStates: value };
    const runs = [];
    const stub = async (s, o) => { runs.push(o); return { ok: true, dryRun: !o.apply, created: {} }; };
    const deployed = await buildModelApp(bad, { apply: true, publish: true, workspaceDir: makeTempDir('cs-spec-') }, { runBuild: stub, ...quiet });
    assert.strictEqual(deployed.ok, false, what);
    assert.ok(deployed.errors.some((e) => e.startsWith(`${code}: `)), `${what}: ${deployed.errors.join(' | ')}`);
    assert.strictEqual(runs.length, 0, `${what}: nothing ran`);
    // A structural profile leaves these findings as warnings, so the spec reaches the engine, which must refuse it before any request.
    let outcome;
    try {
      outcome = await buildModelApp(bad, { profile: 'structural', workspaceDir: makeTempDir('cs-spec-') }, { runBuild: (s, o) => runSdkBuild(s, o), ...quiet });
    } catch (e) {
      outcome = { thrown: e };
    }
    const said = outcome.thrown ? `${outcome.thrown.code}: ${outcome.thrown.message}` : (outcome.errors || []).join(' | ');
    assert.ok(outcome.thrown ? outcome.thrown.code === code : outcome.ok === false && said.includes(code), `${what} (structural): ${said}`);
  }
});

test('the build\'s inline verify reads command rows with the client makeSdk made, as standalone verify does', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { inlineVerifyReader } = require('../build-model-app.js');
  const { createCommandStateOrg, commandRow, ORIGIN } = require('./helpers/command-state-org.js');
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
  const { commandStateSendOnce } = require('../lib/command-state-transport.js');
  const T = 'new_ticket';
  const MD = '44444444-4444-4444-8444-444444444444';
  const org = createCommandStateOrg({ tables: { [T]: { metadataId: MD } }, rows: [commandRow(ROW, T, MD, { hidden: true })] });
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'offline-token', request: org.request, sleep: async () => {}, sendOnce: commandStateSendOnce });
  const provisionSdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('cs-inline-')), instanceUrl: ORIGIN, httpClient: client });
  await provisionSdk.initWorkspace();
  const declared = {
    ...spec([{ entity: T, location: 'MainTab', scope: 'table', rowId: ROW, hidden: true }]),
    app: { name: 'Support', uniqueName: 'contoso_Support' },
    entities: [{ schemaName: T, primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
  };
  // The shape makeSdk returns: the reader is given all of it, so nothing it carries can be left out at the call site.
  const reader = inlineVerifyReader({ sdk: provisionSdk, provisionSdk, isolatedReader: null, commandStateClient: client }, declared, { workspaceDir: makeTempDir('cs-inline-') });
  assert.strictEqual(typeof reader.commandStates, 'function', 'the inline reader can read command rows');
  const only = { ...declared, entities: [], app: {}, appShell: { areas: [] } };
  const r = await verifySpec(only, { sitemapXml: async () => '<SiteMap/>', commandStates: () => reader.commandStates(declared) });
  const checks = r.checks.filter((c) => c.kind === 'command-state');
  assert.strictEqual(checks.length, 1);
  assert.strictEqual(checks[0].present, true, JSON.stringify(checks[0]));
  // The build's verify hands the reader the whole makeSdk result, not a list of its fields, and builds no reader any other way.
  const source = fs.readFileSync(path.join(__dirname, '..', 'build-model-app.js'), 'utf8');
  assert.match(source, /const made = await makeSdk\(/);
  assert.match(source, /verifySpec\(s, inlineVerifyReader\(made, s, /);
  assert.strictEqual(source.split('readerFor(').length - 1, 1, 'readerFor is called only inside inlineVerifyReader');
});