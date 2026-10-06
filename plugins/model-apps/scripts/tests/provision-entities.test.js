'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { provisionEntities } = require(path.join(__dirname, '..', 'provision-entities.js'));
const { loadCli } = require('./helpers/cli-harness.js');
const { validateFlagsFromParsed, realAuth } = require('./helpers/fake-auth.js');

const input = { solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
  entities: [{ schemaName: 'cr_candidate', displayName: 'Candidate', pluralName: 'Candidates', primaryAttribute: { schemaName: 'cr_name' },
    columns: [{ schemaName: 'cr_status', type: 'Choice', options: ['Applied', 'Hired'] }] }], relationships: [] };

function mockDeps() {
  const calls = [];
  const sdk = {
    queryRecords: async () => [{ solutionid: 's' }], createPublisher: async () => ({ id: 'p' }), createSolution: async () => ({ id: 's' }),
    createTable: async (o) => { calls.push('createTable'); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }; },
    updateTable: async () => { calls.push('updateTable'); return {}; },
    createColumn: async (l, o) => { calls.push('createColumn'); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
    createGlobalOptionSet: async () => ({ metadataId: 'g' }), insertStatusValue: async () => 1, createAlternateKey: async () => ({}),
    createCustomerColumn: async (l, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }),
    createRecordsBulk: async (e, rows) => rows.map((_, i) => `${e}-${i}`),
    createRelationship: async (o) => ({ schemaName: o.schemaName, metadataId: `rel-${o.schemaName}` }),
  };
  const provision = { findTables: async () => [], findColumns: async () => [], fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }), queryRecords: async () => [{ solutionid: 's' }] };
  return { sdk, provision, calls };
}

test('dry-run validates + plans, no SDK writes', async () => {
  const d = mockDeps();
  const r = await provisionEntities(input, { apply: false }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(d.calls.length, 0);
});

test('apply provisions and returns resolved names', async () => {
  const d = mockDeps();
  const r = await provisionEntities(input, { apply: true }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(r.ok, true);
  assert.ok(d.calls.includes('createTable'));
  assert.strictEqual(r.entities[0].logicalName, 'cr_candidate');
  assert.strictEqual(r.entities[0].entitySetName, 'cr_candidates');
  assert.strictEqual(r.entities[0].metadataId, 'tbl-cr_candidate', 'entity metadataId surfaced');
  assert.ok(r.columns.length > 0, 'columns returned');
  assert.strictEqual(r.columns[0].logicalName, 'cr_status', 'column logicalName is real SDK value');
  assert.strictEqual(r.columns[0].metadataId, 'col-cr_status', 'column metadataId surfaced');
});

test('rejects an invalid input before any write', async () => {
  const d = mockDeps();
  const r = await provisionEntities({ solution: { uniqueName: 'Default' }, entities: [] }, { apply: true }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(d.calls.length, 0);
});

test('quick-create: the enable step is planned AND counted so [n/total] never drifts', async () => {
  // The provision-entities CLI has its OWN plan/count separate from sdk-build's planFor; both must
  // account for the quick-create step the shared provisionDataModel executes. This CLI input has no
  // forms[], so quickCreateEnabledFor fires only on an explicit entities[].quickCreate === true.
  const qcInput = {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, quickCreate: true, columns: [] }],
    relationships: [],
  };
  // dry-run: the plan lists the enable step
  const dry = await provisionEntities(qcInput, { apply: false }, mockDeps());
  assert.ok(dry.plan.some((p) => /enable quick create on cr_candidate/.test(p)), 'dry-run plan includes the quick-create step');

  // apply: capture the [n/total] stream and prove n never exceeds total (count matches the executor)
  const d = mockDeps();
  const events = [];
  await provisionEntities(qcInput, { apply: true }, { sdk: d.sdk, provision: d.provision, emit: (e) => events.push(e) });
  assert.ok(d.calls.includes('updateTable'), 'the quick-create updateTable step ran');
  const total = events[0] && events[0].total;
  assert.ok(events.every((e) => e.n <= e.total), `no step emits n > total (total=${total})`);
  assert.ok(events.some((e) => /enable quick create/.test(e.label || '')), 'the quick-create step is narrated');
});

test('no quick-create step is planned/counted without the flag (regression guard)', async () => {
  const dry = await provisionEntities(input, { apply: false }, mockDeps());
  assert.ok(!dry.plan.some((p) => /enable quick create/.test(p)), 'no quick-create step without the opt-in');
});

test('dry-run plan includes non-trivial provision steps and skips non-actions', async () => {
  const rich = {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    globalChoices: [{ name: 'cr_priority', options: ['Low', 'High'] }],
    entities: [
      {
        schemaName: 'cr_parent',
        displayName: 'Parent',
        primaryAttribute: { schemaName: 'cr_name' },
        columns: [
          { schemaName: 'cr_priority', type: 'Choice', globalChoice: 'cr_priority' },
          { schemaName: 'cr_childid', type: 'Lookup' },
        ],
        statusReasons: [{ label: 'Archived', state: 'Inactive' }],
        alternateKeys: [{ schemaName: 'cr_parent_key', columns: ['cr_name'] }],
      },
      { schemaName: 'cr_child', displayName: 'Child', primaryAttribute: { schemaName: 'cr_name' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', schemaName: 'cr_parent_children', referenced: 'cr_parent', referencing: 'cr_child', lookup: { schemaName: 'cr_parentid' } },
      { type: 'ManyToMany', schemaName: 'cr_parent_child_nn', entity1: 'cr_parent', entity2: 'cr_child' },
    ],
    sampleData: { cr_parent: [{ cr_name: 'A' }, { cr_name: 'B' }], cr_child: [] },
  };

  const dry = await provisionEntities(rich, { apply: false, sampleData: true }, mockDeps());

  assert.deepStrictEqual(dry.plan, [
    'solution Default',
    'global choice cr_priority',
    'table cr_parent',
    'column cr_parent.cr_priority (Choice)',
    'status reason cr_parent: Archived',
    'alt key cr_parent.cr_parent_key',
    'table cr_child',
    'relationship 1:N cr_parent->cr_child',
    'relationship N:N cr_parent<->cr_child',
    '2 record(s) -> cr_parent',
  ]);
});

test('apply surfaces fallback metadata for existing columns and relationships', async () => {
  const existingInput = {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [
      { schemaName: 'cr_parent', displayName: 'Parent', primaryAttribute: { schemaName: 'cr_name' }, columns: [{ schemaName: 'cr_code', type: 'Text' }] },
      { schemaName: 'cr_child', displayName: 'Child', primaryAttribute: { schemaName: 'cr_name' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', schemaName: 'cr_parent_children', referenced: 'cr_parent', referencing: 'cr_child', lookup: { schemaName: 'cr_parentid' } },
      { type: 'ManyToMany', schemaName: 'cr_parent_child_nn', entity1: 'cr_parent', entity2: 'cr_child' },
    ],
  };
  const d = mockDeps();
  d.provision.findTables = async (schemaName) => [{ logicalName: schemaName.toLowerCase(), entitySetName: `${schemaName.toLowerCase()}s` }];
  d.provision.findColumns = async () => [{ logicalName: 'cr_code' }];
  d.provision.fetchEntityMetadata = async (logical) => ({
    logicalName: logical,
    entitySetName: `${logical}s`,
    relationships: [
      { schemaName: 'cr_parent_children' },
      { schemaName: 'cr_parent_child_nn' },
    ],
  });

  const r = await provisionEntities(existingInput, { apply: true }, { sdk: d.sdk, provision: d.provision });

  assert.deepStrictEqual(r.columns, [{ table: 'cr_parent', schemaName: 'cr_code', logicalName: 'cr_code' }]);
  assert.deepStrictEqual(r.relationships, [
    { kind: '1n', schemaName: 'cr_parent_children' },
    { kind: 'nn', schemaName: 'cr_parent_child_nn' },
  ]);
  assert.ok(!d.calls.includes('createColumn'), 'existing columns are not recreated');
});

test('apply seeds requested sample data and returns created record ids', async () => {
  const seedInput = {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{
      schemaName: 'cr_parent',
      displayName: 'Parent',
      primaryAttribute: { schemaName: 'cr_name' },
      columns: [],
      alternateKeys: [{ schemaName: 'cr_parent_key', columns: ['cr_name'] }],
    }],
    relationships: [],
    sampleData: { cr_parent: [{ cr_name: 'A' }, { cr_name: 'B' }] },
  };
  const d = mockDeps();
  let seedGroup;
  d.sdk.seedRecordGraph = async (groups) => {
    [seedGroup] = groups;
    return { createdIds: { cr_parent: ['id-a', 'id-b'] } };
  };

  const r = await provisionEntities(seedInput, { apply: true, sampleData: true }, { sdk: d.sdk, provision: d.provision });

  assert.strictEqual(seedGroup.matchOn, 'cr_name', 'a single-column alternate key makes sample seeding idempotent');
  assert.deepStrictEqual(r.records, { cr_parent: ['id-a', 'id-b'] });
});

// #447: this CLI is the genpage create flow's data-model path, so it must resolve the organization's
// base language exactly as build-model-app.js does. It builds its own `spec` object from `input`,
// which is easy to leave a field out of -- and because resolveLanguageCode degrades to 1033 rather
// than throwing, a dropped field is invisible until a non-English org fails on a DateTime column.
test('provision-entities resolves the org base language for labels (#447)', async () => {
  const d = mockDeps();
  d.provision.queryRecords = async (set) => (set === 'organization' ? [{ languagecode: 1031 }] : [{ solutionid: 's' }]);
  const seen = [];
  d.sdk.createColumn = async (l, o) => { seen.push(o); return { logicalName: o.schemaName.toLowerCase(), metadataId: 'c' }; };
  const r = await provisionEntities(input, { apply: true }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(r.ok, true);
  assert.ok(seen.length > 0, 'a column was created');
  assert.strictEqual(seen[0].languageCode, 1031, 'the org language reached the column create');
});

test('provision-entities honors an explicit language override and an input languageCode', async () => {
  const d = mockDeps();
  d.provision.queryRecords = async (set) => (set === 'organization' ? [{ languagecode: 1031 }] : [{ solutionid: 's' }]);
  const seen = [];
  d.sdk.createColumn = async (l, o) => { seen.push(o); return { logicalName: o.schemaName.toLowerCase(), metadataId: 'c' }; };
  await provisionEntities(input, { apply: true, languageCode: 3082 }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(seen[0].languageCode, 3082, 'opts.languageCode wins over the org base language');

  const seen2 = [];
  const d2 = mockDeps();
  d2.provision.queryRecords = async (set) => (set === 'organization' ? [{ languagecode: 1031 }] : [{ solutionid: 's' }]);
  d2.sdk.createColumn = async (l, o) => { seen2.push(o); return { logicalName: o.schemaName.toLowerCase(), metadataId: 'c' }; };
  await provisionEntities({ ...input, languageCode: 1036 }, { apply: true }, { sdk: d2.sdk, provision: d2.provision });
  assert.strictEqual(seen2[0].languageCode, 1036, 'input.languageCode is carried into the spec, not dropped');
});

test('provision-entities surfaces a language fallback through deps.warn', async () => {
  // Without this the genpage path would fall back to 1033 in silence and the user would see only an
  // opaque Dataverse 400 later -- the build path would explain itself and this one would not.
  const d = mockDeps();
  d.provision.queryRecords = async (set) => {
    if (set === 'organization') throw new Error('org read blocked');
    return [{ solutionid: 's' }];
  };
  const warnings = [];
  const r = await provisionEntities(input, { apply: true }, { sdk: d.sdk, provision: d.provision, warn: (m) => warnings.push(m) });
  assert.strictEqual(r.ok, true, 'a failed language read must not fail provisioning');
  assert.ok(
    warnings.some((w) => /base language/i.test(w) && /--language-code/.test(w)),
    'the fallback must reach deps.warn; got: ' + JSON.stringify(warnings)
  );
});

// makeSdk/main are otherwise never called: the tests above inject mockDeps into provisionEntities().
// emitResult() ends the process, so a cleanup that runs in a finally the printer never returns to
// leaks both throwaway workspaces. The stub throws where the real printer exits, and only after both
// directories are gone. validateFlagsFromParsed cannot see an unknown flag (parseArgs drops it), so
// the real checker runs first; the rebuilt-argv check still guards the success-path `known` list.
const PROVISION_SCRIPT = path.join(__dirname, '..', 'provision-entities.js');
const PROVISION_ENV = 'https://contoso.crm.dynamics.com';

function cliProvisionInput() {
  return {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{
      schemaName: 'cr_candidate',
      displayName: 'Candidate',
      pluralName: 'Candidates',
      primaryAttribute: { schemaName: 'cr_name' },
      columns: [{ schemaName: 'cr_status', type: 'Choice', options: ['Applied', 'Hired'] }],
    }],
    relationships: [],
    sampleData: { cr_candidate: [{ cr_name: 'Ada' }, { cr_name: 'Grace' }] },
  };
}

function provisionHarness({ initThrows = null, constructThrows = null, provisioned = [1033, 3082, 1036], onEmit = null } = {}) {
  const d = mockDeps();
  const seen = { envs: [], http: [], cols: [], order: [], removed: [], storages: [], solution: undefined, emitted: null };
  d.sdk.seedRecordGraph = async () => ({ createdIds: { cr_candidate: ['rec-0', 'rec-1'] } });
  d.sdk.createColumn = async (_logical, column) => {
    d.calls.push('createColumn');
    seen.cols.push(column);
    return { logicalName: column.schemaName.toLowerCase(), metadataId: `col-${column.schemaName}` };
  };
  d.provision.queryRecords = async (set) => (set === 'organization' ? [{ languagecode: 1033 }] : [{ solutionid: 's' }]);
  const requires = {
    'node:fs': {
      mkdtempSync: (prefix) => {
        const dir = prefix + String(seen.storages.length);
        seen.storages.push(dir);
        seen.order.push('mkdtemp');
        return dir;
      },
      rmSync: (dir, opts) => {
        seen.order.push('rm');
        seen.removed.push({ dir, opts });
      },
    },
    './lib/sdk-http-client.js': {
      createAzHttpClient: (env) => {
        seen.http.push(env);
        return { env };
      },
    },
    './vendor/cds-maker-sdk.cjs': {
      createNodeWorkspaceStorage: (root) => ({ root }),
      createMakerSdk: (opts) => {
        seen.envs.push(opts.instanceUrl);
        if (opts.solutionUniqueName) seen.solution = opts.solutionUniqueName;
        if (constructThrows) throw new Error(constructThrows);
        const base = opts.solutionUniqueName ? d.sdk : d.provision;
        return Object.assign({}, base, {
          initWorkspace: async () => { if (initThrows) throw new Error(initThrows); },
        });
      },
    },
    './lib/dataverse-auth.js': {
      parseArgs: realAuth.parseArgs,
      validateFlags: (passed, contract) => {
        const direct = realAuth.validateFlags(passed, contract);
        if (direct) return direct;
        return validateFlagsFromParsed(() => realAuth.parseArgs(passed).flags)(passed, contract);
      },
      readAliasedFlag: realAuth.readAliasedFlag,
      readJsonArg: realAuth.readJsonArg,
      readProvisionedLanguages: async () => provisioned,
      emitResult: (ok, payload) => {
        seen.order.push('emit');
        if (seen.removed.length < 2) throw new Error(`emit before workspace cleanup (removed ${seen.removed.length})`);
        seen.emitted = { ok, payload };
        if (onEmit) return onEmit(ok, payload);
        const err = new Error(`process.exit(${ok ? 0 : 1})`);
        err.exitCode = ok ? 0 : 1;
        throw err;
      },
    },
  };
  return { d, seen, requires };
}

function assertCleanedBeforeEmit(seen) {
  assert.deepStrictEqual(seen.removed.map((r) => r.dir), seen.storages, 'both workspaces makeSdk created are the ones removed');
  assert.ok(seen.removed.every((r) => r.opts && r.opts.recursive === true && r.opts.force === true));
  const emitAt = seen.order.lastIndexOf('emit');
  assert.ok(emitAt > 1, 'emit ran');
  assert.ok(seen.order.slice(0, emitAt).filter((step) => step === 'rm').length >= 2, 'cleanup ran before the emitter exited: ' + seen.order.join(','));
}

test('CLI provisions the requested input and cleans its workspace before emit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-cli-'));
  const inputFile = path.join(dir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify(cliProvisionInput()));
  const inputArg = '@' + inputFile;

  async function viaLoadCli(argv, opts) {
    const h = provisionHarness(opts);
    const cli = loadCli(PROVISION_SCRIPT, { argv, requires: h.requires });
    let exitErr = null;
    try { await cli.main(); } catch (err) { exitErr = err; }
    return { ...h, exitErr, stderr: cli.stderrText(), stdout: cli.stdoutText() };
  }

  // The entry `main().catch(emitResult)` only arms when the file is the process main. loadCli cannot
  // set that, so thrown init/provision failures are driven through the same compile with require.main
  // pointed at the module — otherwise a deleted catch would still look green.
  function viaEntry(argv, opts) {
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const h = provisionHarness({ ...opts, onEmit: () => finish() });
    const source = fs.readFileSync(PROVISION_SCRIPT, 'utf8');
    const mod = { exports: {} };
    const stderr = [];
    const customRequire = (id) => {
      if (Object.prototype.hasOwnProperty.call(h.requires, id)) return h.requires[id];
      const noExt = id.replace(/\.js$/, '');
      if (Object.prototype.hasOwnProperty.call(h.requires, noExt)) return h.requires[noExt];
      if (id.startsWith('.')) return require(path.resolve(path.dirname(PROVISION_SCRIPT), id));
      return require(id);
    };
    customRequire.main = mod;
    const sandboxProcess = {
      argv: ['node', PROVISION_SCRIPT, ...argv],
      env: {},
      platform: process.platform,
      execPath: process.execPath,
      exit: (code) => { h.seen.exitCode = code; finish(); },
      stdout: { write: () => true },
      stderr: { write: (s) => { stderr.push(String(s)); return true; } },
    };
    const fn = vm.compileFunction(source, ['require', 'module', 'exports', 'process'], { filename: PROVISION_SCRIPT });
    fn(customRequire, mod, mod.exports, sandboxProcess);
    return done.then(() => ({ ...h, stderr: stderr.join('') }));
  }

  try {
    const dry = await viaLoadCli(['--env', PROVISION_ENV, '--input', inputArg, '--sample-data']);
    assert.strictEqual(dry.exitErr && dry.exitErr.exitCode, 0);
    assert.strictEqual(dry.seen.emitted.ok, true);
    assert.strictEqual(dry.seen.emitted.payload.dryRun, true);
    assert.ok(dry.seen.emitted.payload.plan.includes('table cr_candidate'));
    assert.ok(dry.seen.emitted.payload.plan.includes('2 record(s) -> cr_candidate'));
    assert.deepStrictEqual(dry.d.calls, [], 'dry-run must not write');
    assert.ok(dry.seen.envs.every((env) => env === PROVISION_ENV));
    assert.deepStrictEqual(dry.seen.http, [PROVISION_ENV]);
    assertCleanedBeforeEmit(dry.seen);

    const applied = await viaLoadCli(['--env', PROVISION_ENV, '--input', inputArg, '--apply', '--sample-data', '--language-code', '3082']);
    assert.strictEqual(applied.exitErr && applied.exitErr.exitCode, 0, applied.stderr);
    const body = applied.seen.emitted.payload;
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.entities[0].logicalName, 'cr_candidate');
    assert.strictEqual(body.entities[0].entitySetName, 'cr_candidates');
    assert.strictEqual(body.entities[0].metadataId, 'tbl-cr_candidate');
    assert.strictEqual(body.columns[0].logicalName, 'cr_status');
    assert.strictEqual(body.columns[0].metadataId, 'col-cr_status');
    assert.deepStrictEqual(body.records, { cr_candidate: ['rec-0', 'rec-1'] });
    assert.strictEqual(applied.seen.cols[0].languageCode, 3082, '--language-code must reach the column create');
    assert.strictEqual(applied.seen.solution, 'Default');
    assert.ok(applied.d.calls.includes('createTable'));
    assert.ok(applied.seen.envs.every((env) => env === PROVISION_ENV));
    assertCleanedBeforeEmit(applied.seen);

    const camel = await viaLoadCli(['--env', PROVISION_ENV, '--input', inputArg, '--apply', '--languageCode', '1036']);
    assert.strictEqual(camel.exitErr && camel.exitErr.exitCode, 0, camel.stderr);
    assert.strictEqual(camel.seen.cols[0].languageCode, 1036, '--languageCode is the same flag, not a dropped alias');

    const badInput = path.join(dir, 'bad.json');
    fs.writeFileSync(badInput, JSON.stringify({ solution: { uniqueName: 'Default' }, entities: [], relationships: [] }));
    const refused = await viaLoadCli(['--env', PROVISION_ENV, '--input', '@' + badInput, '--apply']);
    assert.strictEqual(refused.exitErr && refused.exitErr.exitCode, 1);
    assert.strictEqual(refused.seen.emitted.ok, false);
    assert.ok(refused.seen.emitted.payload.errors.some((e) => /publisherPrefix/i.test(e)));
    assert.deepStrictEqual(refused.d.calls, [], 'a refused input must not write');
    assertCleanedBeforeEmit(refused.seen);

    const badLcid = await viaLoadCli(['--env', PROVISION_ENV, '--input', inputArg, '--language-code', '1O33']);
    assert.strictEqual(badLcid.exitErr && badLcid.exitErr.exitCode, 1);
    assert.match(badLcid.stderr, /--language-code \/ --languageCode must be digits only/);
    assert.match(badLcid.stderr, /got '1O33'/);
    assert.deepStrictEqual(badLcid.seen.storages, [], 'an invalid LCID exits before makeSdk');
    assert.strictEqual(badLcid.seen.emitted, null);

    const unknown = await viaLoadCli(['--env', PROVISION_ENV, '--bogus', 'x', '--input', inputArg]);
    assert.strictEqual(unknown.exitErr && unknown.exitErr.exitCode, 1);
    assert.match(unknown.stderr, /unknown flag\(s\): --bogus/);
    assert.deepStrictEqual(unknown.seen.storages, []);
    assert.deepStrictEqual(unknown.d.calls, []);

    const initFailed = await viaEntry(['--env', PROVISION_ENV, '--input', inputArg, '--apply'], { initThrows: 'workspace init failed' });
    assert.strictEqual(initFailed.seen.emitted.ok, false);
    assert.match(initFailed.seen.emitted.payload.message, /workspace init failed/);
    assert.deepStrictEqual(initFailed.d.calls, []);
    assert.ok(initFailed.seen.envs.includes(PROVISION_ENV));
    assertCleanedBeforeEmit(initFailed.seen);

    const constructFailed = await viaEntry(['--env', PROVISION_ENV, '--input', inputArg, '--apply'], { constructThrows: 'bundle missing' });
    assert.strictEqual(constructFailed.seen.emitted.ok, false);
    assert.match(constructFailed.seen.emitted.payload.message, /bundle missing/);
    assert.deepStrictEqual(constructFailed.d.calls, []);
    assertCleanedBeforeEmit(constructFailed.seen);

    const unprovisioned = await viaEntry(
      ['--env', PROVISION_ENV, '--input', inputArg, '--apply', '--language-code', '3082'],
      { provisioned: [1033] }
    );
    assert.strictEqual(unprovisioned.seen.emitted.ok, false);
    assert.match(unprovisioned.seen.emitted.payload.message, /3082 is not provisioned/);
    assert.ok(!unprovisioned.d.calls.includes('createTable'), 'an unprovisioned language must not write tables');
    assertCleanedBeforeEmit(unprovisioned.seen);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
