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
