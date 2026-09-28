const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'skills', 'scan-code', 'scripts', 'run-trivy.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('run-trivy.js --help exits 0 and prints usage', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /run-trivy\.js/);
});

test('run-trivy.js exits 1 with usage when --projectRoot is missing', () => {
  // No args: the script rejects before ever invoking the external trivy binary,
  // so this is safe without trivy installed.
  const res = run([]);
  assert.equal(res.status, 1, `stderr: ${res.stderr}`);
  assert.match(res.stderr, /--projectRoot/);
});
