'use strict';
// scripts/list-dataverse-operations.js as a process: the exit status, the bytes on stdout and stderr, and what it reached — nothing.
//
// The command offers the reviewed catalogue (lib/dataverse-operations.js) and checks nothing in an environment, so it takes no environment and
// must not read a token, start a process or open a connection (helpers/no-service-preload.js records any attempt, and a load of
// lib/dataverse-auth.js). The gate is checked first (exit 3 wins over a bad argument), then the arguments (exit 1, usage), then the catalogue
// (exit 1, one fixed line, when it cannot be read or is not exactly the reviewed pair — a widened catalogue is the producer's failure, not an offer).
// A failure writes nothing on stdout. Each exit makes its streams blocking before it writes: on Linux and macOS a pipe's writes are queued, and the
// process ends right after them (helpers/queued-stdio-preload.js, helpers/write-order-preload.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const SCRIPTS = path.join(__dirname, '..');
const SCRIPT = path.join(SCRIPTS, 'list-dataverse-operations.js');
const NO_SERVICE = path.join(__dirname, 'helpers', 'no-service-preload.js');
const FAKE = path.join(__dirname, 'helpers', 'fake-dataverse-operations-preload.js');
const QUEUED = path.join(__dirname, 'helpers', 'queued-stdio-preload.js');
const ORDER = path.join(__dirname, 'helpers', 'write-order-preload.js');

// The success body, as the command prints it: these keys, in this order, and nothing else.
const EXPECTED = {
  ok: true,
  catalogueVersion: 1,
  verification: {
    mode: 'catalogue-only',
    environment: 'not-checked',
    runtime: 'not-checked',
    privileges: 'not-checked',
  },
  operations: [
    {
      name: 'WhoAmI',
      displayName: 'Current Dataverse identity',
      isFunction: true,
      bindingType: 'Global',
      parameters: [],
      parameterKinds: {},
      response: {
        typeName: 'Microsoft.Dynamics.CRM.WhoAmIResponse',
        properties: {
          BusinessUnitId: 'Edm.Guid',
          UserId: 'Edm.Guid',
          OrganizationId: 'Edm.Guid',
        },
      },
      outputPrivacy: 'identity',
      invocation: 'user-triggered',
      requiresExplicitSelection: true,
    },
    {
      name: 'RetrieveVersion',
      displayName: 'Dataverse server version',
      isFunction: true,
      bindingType: 'Global',
      parameters: [],
      parameterKinds: {},
      response: {
        typeName: 'Microsoft.Dynamics.CRM.RetrieveVersionResponse',
        properties: { Version: 'Edm.String' },
      },
      outputPrivacy: 'service-version',
      invocation: 'user-triggered',
      requiresExplicitSelection: true,
    },
  ],
};
const GATE_LINE = 'Dataverse built-in operation authoring is disabled (feature flag "dataverse-operations" is OFF). '
  + 'Set GENPAGE_ENABLE_DATAVERSE_OPERATIONS=1 to offer WhoAmI and RetrieveVersion. '
  + 'Existing bindings are preserved; runtime governance and user privileges still apply.';
const USAGE_LINE = 'Usage: node scripts/list-dataverse-operations.js';
const CATALOGUE_LINE = 'The built-in operation catalogue could not be read. No built-in operations were offered.';

const scratch = makeTempDir('dv-ops-list-');
let runs = 0;

// The environment of a run: the test's own, without the gate's override or the retired custom-api variable (so the committed default applies
// unless a case sets one).
function baseEnv(env) {
  const out = { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' };
  delete out.GENPAGE_ENABLE_DATAVERSE_OPERATIONS;
  delete out.GENPAGE_ENABLE_CUSTOM_API;
  delete out.FAKE_DV_OPERATIONS;
  return { ...out, ...env };
}

// Runs the command under the no-service probe: { status, stdout, stderr, attempts }.
function run(args = [], { env = {}, preloads = [] } = {}) {
  const log = path.join(scratch, `attempts-${runs += 1}.json`);
  const result = spawnSync(process.execPath, [...[NO_SERVICE, ...preloads].flatMap((p) => ['--require', p]), SCRIPT, ...args], {
    encoding: 'utf8',
    env: baseEnv({ ...env, NO_SERVICE_LOG: log }),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    attempts: fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : null,
  };
}

const ON = { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1' };

test('enabled: the whole serialized catalogue — both operations, their response types, privacy, trigger and selection, every not-checked label — and nothing reached', () => {
  const ran = run([], { env: ON });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  assert.equal(ran.stdout, `${JSON.stringify(EXPECTED)}\n`);
  assert.deepStrictEqual(JSON.parse(ran.stdout), EXPECTED);
  assert.deepStrictEqual(ran.attempts, [], 'no token, no request, no process, and the auth module is not even loaded');
  // Schema only: no identity value, no server version, no environment, nothing that reads as checked.
  assert.doesNotMatch(ran.stdout, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
  assert.doesNotMatch(ran.stdout, /\d+\.\d+\.\d+/);
  assert.doesNotMatch(ran.stdout, /"eligible"|"available"|https?:|envUrl|"verified"/);
});

test('disabled — the shipped default — exits 3 with nothing on stdout and the one gate line on stderr, and the gate wins over any argument', () => {
  for (const [args, env] of [
    [[], {}],
    [[], { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '0' }],
    [[], { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: 'maybe' }],
    [['https://contoso.crm.dynamics.com'], {}],
    [['--env', 'https://contoso.crm.dynamics.com'], {}],
    [['--help'], {}],
    [[], { GENPAGE_ENABLE_CUSTOM_API: '1' }],
  ]) {
    const ran = run(args, { env });
    const label = JSON.stringify({ args, env });
    assert.equal(ran.status, 3, label);
    assert.equal(ran.stdout, '', label);
    assert.equal(ran.stderr, `${GATE_LINE}\n`, label);
    assert.deepStrictEqual(ran.attempts, [], label);
  }
  // Off wins over a catalogue that could not be read too: nothing is loaded before the gate.
  const broken = run([], { env: { FAKE_DV_OPERATIONS: 'unloadable' }, preloads: [FAKE] });
  assert.equal(broken.status, 3);
  assert.equal(broken.stderr, `${GATE_LINE}\n`);
});

test('enabled with any argument exits 1 with the usage line and nothing on stdout — this command takes no environment and no option', () => {
  for (const args of [['https://contoso.crm.dynamics.com'], ['--env', 'https://contoso.crm.dynamics.com'], ['--entities', 'account'], ['--help'], ['WhoAmI'], ['']]) {
    const ran = run(args, { env: ON });
    assert.equal(ran.status, 1, JSON.stringify(args));
    assert.equal(ran.stdout, '', JSON.stringify(args));
    assert.equal(ran.stderr, `${USAGE_LINE}\n`, JSON.stringify(args));
    assert.deepStrictEqual(ran.attempts, [], JSON.stringify(args));
  }
});

test('a catalogue that cannot be read, or is not exactly the reviewed pair, offers nothing: exit 1, nothing on stdout, one fixed line', () => {
  for (const mode of [
    'unloadable', 'throws', 'missing', 'widened', 'reordered', 'renamed', 'action', 'bound', 'inputs', 'declared', 'on-load', 'unselected',
    'unverified', 'checked', 'revised', 'eligible', 'no-response', 'empty', 'not-an-object',
  ]) {
    const ran = run([], { env: { ...ON, FAKE_DV_OPERATIONS: mode }, preloads: [FAKE] });
    assert.equal(ran.status, 1, `${mode}: ${ran.stderr}`);
    assert.equal(ran.stdout, '', `${mode}: no partial or widened list`);
    assert.equal(ran.stderr, `${CATALOGUE_LINE}\n`, mode);
    assert.deepStrictEqual(ran.attempts, [], mode);
  }
});

// Custom API support has no flag any more, and the variable of the retired custom-api flag is no switch for this listing either way: it lists
// with the gate ON whatever that variable says, and stays closed with the gate OFF (the case above sets it to 1).
test('the retired custom-api variable leaves the listing as it is', () => {
  for (const value of ['0', '1']) {
    const ran = run([], { env: { ...ON, GENPAGE_ENABLE_CUSTOM_API: value } });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, `${JSON.stringify(EXPECTED)}\n`);
  }
});

test('over the kind of pipe Linux and macOS give a script, every exit makes its streams blocking before its first write, and the text arrives whole', () => {
  for (const [label, args, env, preloads, status, stream, text] of [
    ['success', [], ON, [], 0, 3, `${JSON.stringify(EXPECTED)}\n`],
    ['gate', [], {}, [], 3, 4, `${GATE_LINE}\n`],
    ['usage', ['extra'], ON, [], 1, 4, `${USAGE_LINE}\n`],
    ['catalogue', [], { ...ON, FAKE_DV_OPERATIONS: 'widened' }, [FAKE], 1, 4, `${CATALOGUE_LINE}\n`],
  ]) {
    const record = path.join(scratch, `order-${runs += 1}.json`);
    const result = spawnSync(process.execPath, [...[QUEUED, ...preloads, ORDER].flatMap((p) => ['--require', p]), SCRIPT, ...args], {
      env: baseEnv({ ...env, WRITE_ORDER_FILE: record }),
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    assert.equal(result.status, status, `${label}: ${String(result.output[4])}`);
    const out = { 3: String(result.output[3]), 4: String(result.output[4]) };
    assert.equal(out[stream], text, label);
    assert.equal(out[stream === 3 ? 4 : 3], '', `${label}: the other stream stays empty`);
    const { events } = JSON.parse(fs.readFileSync(record, 'utf8'));
    for (const name of ['stdout', 'stderr']) {
      const firstWrite = events.indexOf(`write ${name}`);
      if (firstWrite === -1) continue;
      const blocking = events.indexOf(`blocking ${name}`);
      assert.ok(blocking !== -1 && blocking < firstWrite, `${label}: ${name} made blocking before its first write (${events.join(', ')})`);
    }
    assert.ok(events.some((event) => event.startsWith('write ')), `${label}: it wrote`);
  }
});
