'use strict';

// Guards the unattended-mode rule. `/app-builder` and `/genpage` both branch on it, and the
// failure it prevents is silent in both directions: guess "attended" under Copilot autopilot or
// Claude auto-accept and the run stalls on a prompt nobody can see; guess "unattended" in a real
// session and the user's questions are skipped and answered by default without being asked.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  envTruthy,
  resolveInteractionMode,
  NONINTERACTIVE_ENV,
} = require('../lib/interaction-mode.js');

const CLI = path.join(__dirname, '..', 'resolve-interaction-mode.js');

test('envTruthy: only 1/true (case-insensitive) count as set', () => {
  for (const v of ['1', 'true', 'TRUE', ' True ']) assert.strictEqual(envTruthy(v), true, v);
  for (const v of ['0', 'false', 'yes', '', null, undefined]) assert.strictEqual(envTruthy(v), false, String(v));
});

// Defaulting to attended is the deliberate choice: a stall is reported, a skipped question is not.
test('with no flag and no env var the run is treated as attended', () => {
  const mode = resolveInteractionMode({ argv: [], env: {} });
  assert.strictEqual(mode.interactive, true);
  assert.match(mode.reason, /default/);
});

test('--non-interactive marks the run unattended', () => {
  const mode = resolveInteractionMode({ argv: ['--non-interactive'], env: {} });
  assert.strictEqual(mode.interactive, false);
  assert.match(mode.reason, /--non-interactive/);
});

test('the env var marks the run unattended without any flag', () => {
  const mode = resolveInteractionMode({ argv: [], env: { [NONINTERACTIVE_ENV]: '1' } });
  assert.strictEqual(mode.interactive, false);
  assert.match(mode.reason, new RegExp(NONINTERACTIVE_ENV));
});

// A non-truthy value must not be read as "set" — `...=0` is how someone turns it OFF, and
// treating it as unattended would silently suppress every prompt in an attended session.
test('a falsy env value leaves the run attended', () => {
  for (const v of ['0', 'false', '']) {
    assert.strictEqual(resolveInteractionMode({ argv: [], env: { [NONINTERACTIVE_ENV]: v } }).interactive, true, v);
  }
});

test('the flag is reported in preference to the env var when both point the same way', () => {
  const mode = resolveInteractionMode({ argv: ['--non-interactive'], env: { [NONINTERACTIVE_ENV]: '1' } });
  assert.strictEqual(mode.interactive, false);
  assert.match(mode.reason, /--non-interactive/, 'the more specific signal should be the reported reason');
});

// The reason travels into workflow-log.md, so it has to be a stable, human-readable string
// rather than a boolean a reader has to decode.
test('every resolved mode carries a non-empty reason', () => {
  const cases = [
    { argv: [], env: {} },
    { argv: ['--non-interactive'], env: {} },
    { argv: [], env: { [NONINTERACTIVE_ENV]: 'true' } },
  ];
  for (const c of cases) {
    const mode = resolveInteractionMode(c);
    assert.ok(typeof mode.reason === 'string' && mode.reason.length > 0, JSON.stringify(c));
  }
});

test('resolveInteractionMode tolerates being called with nothing', () => {
  const mode = resolveInteractionMode();
  assert.strictEqual(typeof mode.interactive, 'boolean');
});

// The CLI is what the skill actually runs, so its contract is asserted end to end: one JSON
// line on stdout and exit 0 even when the answer is "no user".
test('the CLI emits one JSON line and exits 0 when unattended', () => {
  const res = spawnSync(process.execPath, [CLI], {
    encoding: 'utf8',
    env: { ...process.env, [NONINTERACTIVE_ENV]: '1' },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.strictEqual(lines.length, 1, res.stdout);
  const out = JSON.parse(lines[0]);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.interactive, false);
});

test('the CLI reports attended when nothing marks the run unattended', () => {
  const env = { ...process.env };
  delete env[NONINTERACTIVE_ENV];
  const res = spawnSync(process.execPath, [CLI], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(JSON.parse(res.stdout.trim()).interactive, true);
});

test('the CLI honours the flag', () => {
  const env = { ...process.env };
  delete env[NONINTERACTIVE_ENV];
  const res = spawnSync(process.execPath, [CLI, '--non-interactive'], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(JSON.parse(res.stdout.trim()).interactive, false);
});
