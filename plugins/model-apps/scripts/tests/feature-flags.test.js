'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const libPath = path.join(__dirname, '..', 'lib', 'feature-flags.js');
const {
  isEnabled,
  isConnectorsEnabled,
  connectorsDisabledMessage,
  envVarName,
  parseBool,
  exitIfConnectorsDisabled,
  describe,
  validateFlags,
  KNOWN_FLAGS,
  FLAGS,
} = require(libPath);

// --- Default OFF (fail-closed) ---------------------------------------------

test('connectors flag is OFF by default (no env override)', () => {
  // Empty env → falls through to the committed feature-flags.json, which ships false.
  assert.equal(isConnectorsEnabled({ env: {} }), false);
});

test('unknown flags are OFF (fail-closed)', () => {
  assert.equal(isEnabled('does-not-exist', { env: {} }), false);
});

test('missing/invalid flags file is treated as all-OFF', () => {
  assert.equal(
    isEnabled('connectors', { env: {}, flagsPath: path.join(__dirname, 'no-such-flags.json') }),
    false
  );
});

// --- Env override precedence (env wins over committed config) ----------------

test('env var enables a flag that is false in config', () => {
  assert.equal(
    isEnabled('connectors', { env: { GENPAGE_ENABLE_CONNECTORS: '1' }, flags: { connectors: false } }),
    true
  );
});

test('env var OFF overrides config true', () => {
  assert.equal(
    isEnabled('connectors', { env: { GENPAGE_ENABLE_CONNECTORS: '0' }, flags: { connectors: true } }),
    false
  );
});

test('unrecognized env value defers to config', () => {
  assert.equal(
    isEnabled('connectors', { env: { GENPAGE_ENABLE_CONNECTORS: 'maybe' }, flags: { connectors: true } }),
    true
  );
});

test('config true enables when env is unset', () => {
  assert.equal(isEnabled('connectors', { env: {}, flags: { connectors: true } }), true);
});

// --- Helpers ----------------------------------------------------------------

test('envVarName maps flag names to GENPAGE_ENABLE_<FLAG>', () => {
  assert.equal(envVarName('connectors'), 'GENPAGE_ENABLE_CONNECTORS');
  assert.equal(envVarName('multi-word flag'), 'GENPAGE_ENABLE_MULTI_WORD_FLAG');
});

test('parseBool recognizes common truthy/falsey tokens, defers otherwise', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) assert.equal(parseBool(v), true, `truthy: ${v}`);
  for (const v of ['0', 'false', 'no', 'off', 'OFF']) assert.equal(parseBool(v), false, `falsey: ${v}`);
  for (const v of [undefined, null, '', '   ', 'maybe']) assert.equal(parseBool(v), null, `defer: ${String(v)}`);
});

test('connectorsDisabledMessage explains how to enable', () => {
  const m = connectorsDisabledMessage();
  assert.match(m, /GENPAGE_ENABLE_CONNECTORS/);
  assert.match(m, /feature-flags\.json/);
});

// --- Committed config actually ships OFF ------------------------------------

test('committed feature-flags.json ships connectors: false', () => {
  const json = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'feature-flags.json'), 'utf8')
  );
  assert.equal(json.connectors, false);
});

// --- CLI probe (deterministic gate for the skill markdown) ------------------

test('CLI prints "disabled" and exits 1 when OFF', () => {
  const res = spawnSync(process.execPath, [libPath, 'connectors'], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CONNECTORS: '' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /disabled/);
});

test('CLI prints "enabled" and exits 0 when env override ON', () => {
  const res = spawnSync(process.execPath, [libPath, 'connectors'], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CONNECTORS: '1' },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /enabled/);
});

test('CLI without a flag name exits 2 with usage', () => {
  const res = spawnSync(process.execPath, [libPath], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Usage:/);
});

// --- exitIfConnectorsDisabled (DRY gate helper) -----------------------------

test('exitIfConnectorsDisabled exits 3 and writes the message when OFF', () => {
  let exitCode = null;
  let written = '';
  exitIfConnectorsDisabled({
    env: {},
    exit: (c) => { exitCode = c; },
    write: (s) => { written += s; },
  });
  assert.equal(exitCode, 3);
  assert.match(written, /disabled/i);
});

test('exitIfConnectorsDisabled is a no-op when ON', () => {
  let exitCalled = false;
  exitIfConnectorsDisabled({
    env: { GENPAGE_ENABLE_CONNECTORS: '1' },
    exit: () => { exitCalled = true; },
    write: () => {},
  });
  assert.equal(exitCalled, false);
});

// --- known-flag registry + describe() + validation --------------------------

test('KNOWN_FLAGS includes connectors', () => {
  assert.ok(KNOWN_FLAGS.includes('connectors'));
});

test('describe reports effective state and source per known flag', () => {
  const envOn = describe({ env: { GENPAGE_ENABLE_CONNECTORS: '1' }, flags: { connectors: false } });
  const c1 = envOn.find((f) => f.flag === 'connectors');
  assert.equal(c1.enabled, true);
  assert.equal(c1.source, 'env');

  const fileOn = describe({ env: {}, flags: { connectors: true } });
  const c2 = fileOn.find((f) => f.flag === 'connectors');
  assert.equal(c2.enabled, true);
  assert.equal(c2.source, 'file');

  const dflt = describe({ env: {}, flags: {} });
  const c3 = dflt.find((f) => f.flag === 'connectors');
  assert.equal(c3.enabled, false);
  assert.equal(c3.source, 'default');
});

test('validateFlags warns on unknown keys and non-boolean values, ignores _comment', () => {
  assert.deepEqual(validateFlags({ connectors: false, _comment: 'x' }), []);
  assert.match(validateFlags({ conectors: true })[0], /unknown flag/i);
  assert.match(validateFlags({ connectors: 'yes' })[0], /boolean/i);
});

// --- flag catalog: status tracking for experimental / in-progress features --

test('FLAGS catalog documents connectors with a status and summary', () => {
  assert.ok(FLAGS.connectors, 'connectors flag should be in the catalog');
  assert.ok(['experimental', 'in-progress', 'ga'].includes(FLAGS.connectors.status));
  assert.match(FLAGS.connectors.summary, /connector/i);
  assert.ok(FLAGS.connectors.dependencies, 'should document what it depends on');
});

test('KNOWN_FLAGS is derived from the FLAGS catalog', () => {
  assert.deepEqual(KNOWN_FLAGS, Object.keys(FLAGS));
});

test('describe includes the status for each known flag', () => {
  const d = describe({ env: {}, flags: {} });
  const c = d.find((f) => f.flag === 'connectors');
  assert.equal(c.status, FLAGS.connectors.status);
});
