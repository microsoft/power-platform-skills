const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'skills', 'scan-code', 'scripts', 'check-tools.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('check-tools.js --help exits 0 and prints usage', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /check-tools\.js/);
});

test('check-tools.js reports both tools unavailable when neither is on PATH', (t) => {
  // Point PATH at an empty dir so opengrep/trivy cannot be resolved; the interpreter
  // itself is launched via process.execPath so it still runs. ComSpec/SystemRoot are
  // inherited (spread) so cmd.exe is still found on Windows.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-tools-'));
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));

  const res = run([], { PATH: emptyDir, Path: emptyDir });
  assert.equal(res.status, 1, `stderr: ${res.stderr}`);

  const out = JSON.parse(res.stdout);
  for (const tool of ['opengrep', 'trivy']) {
    assert.equal(out[tool].available, false, `${tool} should be unavailable`);
    assert.equal(out[tool].version, null);
    assert.ok(typeof out[tool].error === 'string' && out[tool].error.length > 0);
  }
});
