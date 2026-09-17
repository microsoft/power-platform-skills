'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main } = require('../../skills/style-site/scripts/check-style-contrast');
const script = path.resolve(__dirname, '../../skills/style-site/scripts/check-style-contrast.js');

test('contrast CLI checks a supplied pair without a site, plan, browser or output file', () => {
  const args = ['--foreground', '#ffffff', '--background', '#111827', '--fontSize', '16', '--fontWeight', '400'];
  const pass = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).evidence, 'supplied-color-pair-only');
  args[1] = '#222222';
  const fail = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).status, 'fail');
});

test('missing metrics and unresolved colors fail with explicit errors', () => {
  assert.throws(() => main([]), /Usage/);
  assert.throws(() => main(['--foreground', 'var(--text)', '--background', '#fff', '--fontSize', '16', '--fontWeight', '400']), /concrete/);
});
