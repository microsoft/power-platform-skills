'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const libPath = path.join(__dirname, '..', 'lib', 'feature-flags.js');
const lib = require(libPath);
const {
  isEnabled,
  isCustomApiEnabled,
  customApiDisabledMessage,
  envVarName,
  parseBool,
  exitIfCustomApiDisabled,
  describe,
  validateFlags,
  KNOWN_FLAGS,
  FLAGS,
} = lib;

// --- Committed defaults and fail-closed fallback ---------------------------

test('connectors flag is retired and unknown fail-closed', () => {
  const json = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'feature-flags.json'), 'utf8')
  );
  assert.equal(Object.prototype.hasOwnProperty.call(json, 'connectors'), false);
  assert.equal(KNOWN_FLAGS.includes('connectors'), false);
  assert.equal(isEnabled('connectors', { env: { GENPAGE_ENABLE_CONNECTORS: '1' } }), false);
  assert.match(validateFlags({ connectors: true })[0], /unknown flag/i);
  const lib = require(libPath);
  for (const removed of ['isConnectorsEnabled', 'exitIfConnectorsDisabled', 'connectorsDisabledMessage']) {
    assert.equal(lib[removed], undefined, `${removed} must stay removed now that connectors have no flag`);
  }
});
test('custom-api flag is ON by default without changing the generic fail-closed fallback', () => {
  assert.equal(isEnabled('custom-api', { env: {} }), true);
  assert.equal(isCustomApiEnabled({ env: {} }), true);
  for (const flags of [{}, { 'custom-api': false }, { 'custom-api': 'true' }]) {
    assert.equal(isEnabled('custom-api', { env: {}, flags }), false);
  }
});

test('an explicit custom-api opt-out overrides the committed enabled default', () => {
  assert.equal(isEnabled('custom-api', { env: { GENPAGE_ENABLE_CUSTOM_API: '0' } }), false);
  assert.equal(isCustomApiEnabled({ env: { GENPAGE_ENABLE_CUSTOM_API: '0' } }), false);
});

test('custom-telemetry flag is OFF by default (no env override)', () => {
  // custom-telemetry has no helper of its own (it gates code generation, not scripts), so
  // the generic probe is the contract the skill markdown actually calls.
  assert.equal(isEnabled('custom-telemetry', { env: {} }), false);
});

test('unknown flags are OFF (fail-closed)', () => {
  assert.equal(isEnabled('does-not-exist', { env: {} }), false);
});

test('missing/invalid flags file is treated as all-OFF', () => {
  assert.equal(
    isEnabled('custom-api', { env: {}, flagsPath: path.join(__dirname, 'no-such-flags.json') }),
    false
  );
});

// --- Env override precedence (env wins over committed config) ----------------

test('env var enables a flag that is false in config', () => {
  assert.equal(
    isEnabled('custom-api', { env: { GENPAGE_ENABLE_CUSTOM_API: '1' }, flags: { 'custom-api': false } }),
    true
  );
});

test('env var OFF overrides config true', () => {
  assert.equal(
    isEnabled('custom-api', { env: { GENPAGE_ENABLE_CUSTOM_API: '0' }, flags: { 'custom-api': true } }),
    false
  );
});

test('unrecognized env value defers to config', () => {
  assert.equal(
    isEnabled('custom-api', { env: { GENPAGE_ENABLE_CUSTOM_API: 'maybe' }, flags: { 'custom-api': true } }),
    true
  );
});

test('config true enables when env is unset', () => {
  assert.equal(isEnabled('custom-api', { env: {}, flags: { 'custom-api': true } }), true);
});

// --- Helpers ----------------------------------------------------------------

test('envVarName maps flag names to GENPAGE_ENABLE_<FLAG>', () => {
  assert.equal(envVarName('custom-api'), 'GENPAGE_ENABLE_CUSTOM_API');
  assert.equal(envVarName('multi-word flag'), 'GENPAGE_ENABLE_MULTI_WORD_FLAG');
});

test('parseBool recognizes common truthy/falsey tokens, defers otherwise', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) assert.equal(parseBool(v), true, `truthy: ${v}`);
  for (const v of ['0', 'false', 'no', 'off', 'OFF']) assert.equal(parseBool(v), false, `falsey: ${v}`);
  for (const v of [undefined, null, '', '   ', 'maybe']) assert.equal(parseBool(v), null, `defer: ${String(v)}`);
});

test('customApiDisabledMessage explains how to enable', () => {
  const m = customApiDisabledMessage();
  assert.match(m, /GENPAGE_ENABLE_CUSTOM_API/);
  assert.match(m, /feature-flags\.json/);
});

test('the Custom API catalog and disabled guidance describe the enabled default and opt-out', () => {
  assert.match(FLAGS['custom-api'].summary, /enabled by default/i);
  assert.match(customApiDisabledMessage(), /GENPAGE_ENABLE_CUSTOM_API=0/);
  assert.doesNotMatch(customApiDisabledMessage(), /once the dependencies are released/);
});

// --- Committed config keeps each feature's own default ---------------------

test('committed feature-flags.json ships custom-api: true', () => {
  const json = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'feature-flags.json'), 'utf8')
  );
  assert.equal(json['custom-api'], true);
});

test('committed feature-flags.json ships custom-telemetry: false', () => {
  const json = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'feature-flags.json'), 'utf8')
  );
  assert.equal(json['custom-telemetry'], false);
});

// --- CLI probe (deterministic gate for the skill markdown) ------------------

test('CLI prints "disabled" and exits 1 for an explicit opt-out', () => {
  const res = spawnSync(process.execPath, [libPath, 'custom-api'], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CUSTOM_API: '0' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /disabled/);
});

test('CLI prints "enabled" and exits 0 without an environment override', () => {
  const env = { ...process.env };
  delete env.GENPAGE_ENABLE_CUSTOM_API;
  const res = spawnSync(process.execPath, [libPath, 'custom-api'], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'enabled');
});

test('CLI prints "enabled" and exits 0 when env override ON', () => {
  const res = spawnSync(process.execPath, [libPath, 'custom-api'], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CUSTOM_API: '1' },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /enabled/);
});

test('CLI without a flag name exits 2 with usage', () => {
  const res = spawnSync(process.execPath, [libPath], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Usage:/);
});

// --- exitIfCustomApiDisabled (DRY gate helper) -------------------------------

test('exitIfCustomApiDisabled exits 3 and writes the message when OFF', () => {
  let exitCode = null;
  let written = '';
  exitIfCustomApiDisabled({
    env: { GENPAGE_ENABLE_CUSTOM_API: '0' },
    exit: (c) => { exitCode = c; },
    write: (s) => { written += s; },
  });
  assert.equal(exitCode, 3);
  assert.match(written, /disabled/i);
});

test('exitIfCustomApiDisabled is a no-op when ON', () => {
  let exitCalled = false;
  exitIfCustomApiDisabled({
    env: { GENPAGE_ENABLE_CUSTOM_API: '1' },
    exit: () => { exitCalled = true; },
    write: () => {},
  });
  assert.equal(exitCalled, false);
});

// --- known-flag registry + describe() + validation --------------------------

test('KNOWN_FLAGS includes custom-api', () => {
  assert.ok(KNOWN_FLAGS.includes('custom-api'));
});

test('KNOWN_FLAGS includes custom-telemetry', () => {
  assert.ok(KNOWN_FLAGS.includes('custom-telemetry'));
});

test('describe reports effective state and source per known flag', () => {
  const envOn = describe({ env: { GENPAGE_ENABLE_CUSTOM_API: '1' }, flags: { 'custom-api': false } });
  const c1 = envOn.find((f) => f.flag === 'custom-api');
  assert.equal(c1.enabled, true);
  assert.equal(c1.source, 'env');

  const fileOn = describe({ env: {}, flags: { 'custom-api': true } });
  const c2 = fileOn.find((f) => f.flag === 'custom-api');
  assert.equal(c2.enabled, true);
  assert.equal(c2.source, 'file');

  const dflt = describe({ env: {}, flags: {} });
  const c3 = dflt.find((f) => f.flag === 'custom-api');
  assert.equal(c3.enabled, false);
  assert.equal(c3.source, 'default');
});

test('validateFlags warns on unknown keys and non-boolean values, ignores _comment', () => {
  assert.deepEqual(validateFlags({ 'custom-api': false, _comment: 'x' }), []);
  assert.match(validateFlags({ 'custom-apy': true })[0], /unknown flag/i);
  assert.match(validateFlags({ 'custom-api': 'yes' })[0], /boolean/i);
});

// --- flag catalog: status tracking for experimental / in-progress features --

test('FLAGS catalog documents custom-api with a status and summary', () => {
  assert.ok(FLAGS['custom-api'], 'custom-api flag should be in the catalog');
  assert.ok(['experimental', 'in-progress', 'ga'].includes(FLAGS['custom-api'].status));
  assert.match(FLAGS['custom-api'].summary, /custom api|action|function|plug-?in/i);
  assert.ok(FLAGS['custom-api'].dependencies, 'should document what it depends on');
  assert.match(FLAGS['custom-api'].enableEnv, /GENPAGE_ENABLE_CUSTOM_API/);
});

test('KNOWN_FLAGS is derived from the FLAGS catalog', () => {
  assert.deepEqual(KNOWN_FLAGS, Object.keys(FLAGS));
});

test('describe includes the status for each known flag', () => {
  const d = describe({ env: {}, flags: {} });
  const c = d.find((f) => f.flag === 'custom-api');
  assert.equal(c.status, FLAGS['custom-api'].status);
});

// --- dataverse-operations: its own default-OFF gate, independent of custom-api ------------------

const DATAVERSE_OPERATIONS_LINE = 'Dataverse built-in operation authoring is disabled (feature flag "dataverse-operations" is OFF). '
  + 'Set GENPAGE_ENABLE_DATAVERSE_OPERATIONS=1 to offer WhoAmI and RetrieveVersion. '
  + 'Existing bindings are preserved; runtime governance and user privileges still apply.';

test('dataverse-operations is a registered flag: its env override turns it on, and custom-api keeps its own state', () => {
  // An unregistered flag ignores its env var (isEnabled fails closed for unknown names), so registration is what this pins.
  assert.equal(isEnabled('dataverse-operations', { env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1' } }), true);
  assert.ok(KNOWN_FLAGS.includes('dataverse-operations'));
  assert.equal(FLAGS['dataverse-operations'].status, 'experimental');
  assert.equal(FLAGS['dataverse-operations'].enableEnv, 'GENPAGE_ENABLE_DATAVERSE_OPERATIONS=1');
  assert.match(FLAGS['dataverse-operations'].summary, /WhoAmI/);
  assert.match(FLAGS['dataverse-operations'].summary, /RetrieveVersion/);
  assert.equal(envVarName('dataverse-operations'), 'GENPAGE_ENABLE_DATAVERSE_OPERATIONS');
  // The two gates are independent in both directions.
  assert.equal(isEnabled('custom-api', { env: {} }), true);
  assert.equal(isEnabled('custom-api', { env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1' } }), true);
  assert.equal(isEnabled('custom-api', { env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1', GENPAGE_ENABLE_CUSTOM_API: '0' } }), false);
  assert.equal(isEnabled('dataverse-operations', { env: { GENPAGE_ENABLE_CUSTOM_API: '1' } }), false);
  assert.equal(isEnabled('dataverse-operations', { env: { GENPAGE_ENABLE_CUSTOM_API: '0', GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1' } }), true);
});

test('dataverse-operations ships OFF; an unset, blank or unrecognized env value defers to the file, which is not a forced false', () => {
  const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'feature-flags.json'), 'utf8'));
  assert.equal(json['dataverse-operations'], false);
  assert.deepEqual(validateFlags(json), []);
  assert.equal(isEnabled('dataverse-operations', { env: {} }), false);
  for (const value of [undefined, '', '   ', 'maybe', 'enable']) {
    const env = value === undefined ? {} : { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: value };
    assert.equal(isEnabled('dataverse-operations', { env, flags: {} }), false, `${JSON.stringify(value)} over a file without the flag`);
    assert.equal(isEnabled('dataverse-operations', { env, flags: { 'dataverse-operations': true } }), true, `${JSON.stringify(value)} defers to a file that says true`);
  }
  for (const value of ['0', 'false', 'NO', ' off ']) {
    assert.equal(isEnabled('dataverse-operations', { env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: value }, flags: { 'dataverse-operations': true } }), false, value);
  }
  for (const value of ['1', 'true', 'YES', ' on ']) {
    assert.equal(isEnabled('dataverse-operations', { env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: value }, flags: {} }), true, value);
  }
  assert.equal(isEnabled('dataverse-operations', { env: {}, flags: { 'dataverse-operations': 'true' } }), false, 'only a boolean true in the file turns it on');
  assert.equal(isEnabled('dataverse-operations', { env: {}, flagsPath: path.join(__dirname, 'no-such-flags.json') }), false, 'a missing file stays off');
  const listed = describe({ env: {}, flags: {} }).find((f) => f.flag === 'dataverse-operations');
  assert.deepEqual(listed, { flag: 'dataverse-operations', enabled: false, source: 'default', status: 'experimental' });
});

test('the dataverse-operations helpers print the one byte-stable gate line, exit 3, and never touch custom-api', () => {
  assert.equal(lib.dataverseOperationsDisabledMessage(), DATAVERSE_OPERATIONS_LINE);
  assert.equal(lib.isDataverseOperationsEnabled({ env: {} }), false);
  assert.equal(lib.isDataverseOperationsEnabled({ env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: 'on' } }), true);
  let exitCode = null;
  let written = '';
  lib.exitIfDataverseOperationsDisabled({ env: {}, flags: {}, exit: (c) => { exitCode = c; }, write: (s) => { written += s; } });
  assert.equal(exitCode, 3);
  assert.equal(written, `${DATAVERSE_OPERATIONS_LINE}\n`);
  let touched = false;
  lib.exitIfDataverseOperationsDisabled({ env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1' }, exit: () => { touched = true; }, write: () => { touched = true; } });
  assert.equal(touched, false, 'ON is a no-op');
  assert.equal(isCustomApiEnabled({ env: {} }), true, 'probing the new gate leaves custom-api as it was');
  assert.doesNotMatch(customApiDisabledMessage(), /dataverse-operations|WhoAmI/);
});

test('CLI probe: dataverse-operations prints "disabled" and exits 1 by default, "enabled" and 0 with the override; usage stays exit 2', () => {
  const env = { ...process.env };
  delete env.GENPAGE_ENABLE_DATAVERSE_OPERATIONS;
  const off = spawnSync(process.execPath, [libPath, 'dataverse-operations'], { encoding: 'utf8', env });
  assert.equal(off.status, 1, off.stderr);
  assert.equal(off.stdout, 'disabled\n');
  const on = spawnSync(process.execPath, [libPath, 'dataverse-operations'], { encoding: 'utf8', env: { ...env, GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1' } });
  assert.equal(on.status, 0, on.stderr);
  assert.equal(on.stdout, 'enabled\n');
  const usage = spawnSync(process.execPath, [libPath], { encoding: 'utf8', env });
  assert.equal(usage.status, 2);
});
