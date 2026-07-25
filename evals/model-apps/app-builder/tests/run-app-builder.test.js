'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const runner = path.join(__dirname, '..', 'run-app-builder.js');

function run(args) {
  const r = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('runner: real fixtures all pass and emit TAP v13', () => {
  const { code, stdout } = run([]);
  assert.equal(code, 0, `expected exit 0; stdout:\n${stdout}`);
  assert.match(stdout, /^TAP version 13/m);
  assert.match(stdout, /# Subtest: 1-support-desk/);
  assert.match(stdout, /# Subtest: 2-orders-multipage/);
  assert.match(stdout, /# fixtures 2 \(pass 2, fail 0\)/);
});

test('runner: --eval selects one fixture; --tier smoke filters', () => {
  const one = run(['--eval', '1']);
  assert.equal(one.code, 0, `--eval 1 stdout:\n${one.stdout}`);
  assert.match(one.stdout, /1\.\.1/);

  const smoke = run(['--tier', 'smoke']);
  assert.equal(smoke.code, 0);
  assert.match(smoke.stdout, /# Subtest: 1-support-desk/);
  assert.doesNotMatch(smoke.stdout, /# Subtest: 2-orders-multipage/);
});

// Negative test: a fixture whose data model contradicts the eval expect block MUST fail (exit 1).
// This proves the assertion can detect incorrect specs — not just that correct specs pass.
test('runner: a fixture whose data model contradicts the eval expect fails (exit 1)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-eval-'));
  try {
    const dir = path.join(root, '1-broken');
    fs.mkdirSync(dir, { recursive: true });
    // eval id 1 expects tables new_customer/new_ticket/new_comment — provide only new_customer
    // so the "expected tables" assertion fails and proves the harness catches regressions.
    fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify({
      solution: { uniqueName: 'S', publisherPrefix: 'new' },
      app: { name: 'X' },
      entities: [{ schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] }],
      appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_customer', title: 'C' }] }] }] },
    }));
    const { code, stdout } = run(['--fixtures', root, '--eval', '1']);
    assert.equal(code, 1, `expected exit 1; stdout:\n${stdout}`);
    assert.match(stdout, /not ok \d+ - data: schema-facts provision exactly the expected tables/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner: exits 2 when the fixtures dir is missing', () => {
  const { code, stderr } = run(['--fixtures', path.join(os.tmpdir(), 'does-not-exist-ab-eval-xyz')]);
  assert.equal(code, 2);
  assert.match(stderr, /Fixtures directory does not exist/);
});
