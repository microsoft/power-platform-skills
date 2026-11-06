'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const runner = path.join(ROOT, 'run-pcf.js');

function run(args, options = {}) {
  const r = spawnSync(process.execPath, [runner, ...args], { cwd: path.join(ROOT, '..', '..', '..'), encoding: 'utf8', ...options });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('runner: --tier smoke runs the eight-case smoke subset and emits TAP v13', () => {
  const { code, stdout, stderr } = run(['--tier', 'smoke']);
  assert.equal(code, 0, `stderr:\n${stderr}\nstdout:\n${stdout}`);
  assert.match(stdout, /^TAP version 13/m);
  assert.match(stdout, /1\.\.8/);
  assert.match(stdout, /# fixtures 8 \(pass 8, fail 0\)/);
});

test('runner: exits non-zero when a contract expectation is deliberately broken', () => {
  const source = path.join(ROOT, 'evals.json');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-eval-broken-'));
  try {
    const copy = path.join(tmpRoot, 'evals.json');
    const data = JSON.parse(fs.readFileSync(source, 'utf8'));
    data.evals[0].expect.presentCodes = ['PCF_INTENT_THIS_CODE_DOES_NOT_EXIST'];
    fs.writeFileSync(copy, JSON.stringify(data, null, 2));
    const { code, stdout } = run(['--tier', 'smoke', '--evals', copy]);
    assert.equal(code, 1, `stdout:\n${stdout}`);
    assert.match(stdout, /PCF_INTENT_THIS_CODE_DOES_NOT_EXIST/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
