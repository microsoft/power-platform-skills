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
  assert.match(stdout, /# Subtest: 3-assets-dashboard/);
  assert.match(stdout, /# Subtest: 4-hardening/);
  assert.match(stdout, /# fixtures 4 \(pass 4, fail 0\)/);
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

// --- argument validation ---------------------------------------------------------------------
// `argv[++i]` yields `undefined` for a trailing flag, and an undefined value is falsy — so a
// value-less `--tier`/`--fixtures` silently fell through to "no filter" / "the built-in fixtures".
// That is worse than an error: the run reports PASS for a scope the caller never asked for. Same
// class as the plugin CLI fix in 2.4.0 ("a value-less flag no longer passes the usage guard").

test('runner: a value-less --fixtures is rejected, not silently defaulted to the built-in fixtures', () => {
  const { code, stderr } = run(['--fixtures']);
  assert.equal(code, 2, 'a missing value must be a usage error');
  assert.match(stderr, /--fixtures/, 'the message names the offending flag');
});

test('runner: a value-less --tier is rejected, not silently treated as "no tier filter"', () => {
  const { code, stderr } = run(['--tier']);
  assert.equal(code, 2);
  assert.match(stderr, /--tier/);
});

test('runner: a value-less --eval is rejected', () => {
  const { code, stderr } = run(['--eval']);
  assert.equal(code, 2);
  assert.match(stderr, /--eval/);
});

test('runner: a flag consumed as another flag\'s value is rejected', () => {
  // `--tier --eval 1` used to set tier="--eval" and then silently match no tier.
  const { code, stderr } = run(['--tier', '--eval', '1']);
  assert.equal(code, 2);
  assert.match(stderr, /--tier/);
});

test('runner: a non-integer --eval is rejected instead of being truncated', () => {
  // parseInt('1.5', 10) === 1, so `--eval 1.5` silently graded fixture 1 and reported PASS.
  for (const bad of ['1.5', 'abc', '', '-1']) {
    const { code, stderr } = run(['--eval', bad]);
    assert.equal(code, 2, `--eval ${JSON.stringify(bad)} must be rejected`);
    assert.match(stderr, /--eval/, `--eval ${JSON.stringify(bad)} message names the flag`);
  }
});

test('runner: an unknown --tier value is rejected with the valid choices', () => {
  // A typo previously matched nothing and produced "no fixtures matched the filter", which blames
  // the fixtures rather than the argument.
  const { code, stderr } = run(['--tier', 'smoek']);
  assert.equal(code, 2);
  assert.match(stderr, /smoke/, 'the message lists the valid tiers');
});

test('runner: valid arguments still work (the guard does not over-reject)', () => {
  const smoke = run(['--tier', 'smoke']);
  assert.equal(smoke.code, 0, `stdout:\n${smoke.stdout}`);
  const one = run(['--eval', '1']);
  assert.equal(one.code, 0);
});

// --- fixture loading -------------------------------------------------------------------------

test('runner: a malformed fixture names the FIXTURE, not just the JSON position', () => {
  // The bare `JSON.parse` reported "Expected double-quoted property name ... at position 25" with
  // no indication of WHICH fixture, so a corpus run gave the operator nothing to act on.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-eval-bad-'));
  try {
    fs.mkdirSync(path.join(root, '7-broken-json'), { recursive: true });
    fs.writeFileSync(path.join(root, '7-broken-json', 'app-spec.json'), '{ "app": { "name": "x" },, }');
    const { code, stderr } = run(['--fixtures', root]);
    assert.equal(code, 2);
    assert.match(stderr, /7-broken-json/, 'the failing fixture is named');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner: a UTF-8 BOM does not break a fixture', () => {
  // Editors on Windows write a BOM by default; `JSON.parse` rejects the leading \uFEFF, which
  // failed the whole run for a file that is otherwise valid JSON.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-eval-bom-'));
  try {
    const dir = path.join(root, '1-bom');
    fs.mkdirSync(dir, { recursive: true });
    const spec = {
      solution: { uniqueName: 'S', publisherPrefix: 'new' },
      app: { name: 'X' },
      entities: [{ schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] }],
      appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_customer', title: 'C' }] }] }] },
    };
    fs.writeFileSync(path.join(dir, 'app-spec.json'), '\uFEFF' + JSON.stringify(spec));
    const { code, stderr } = run(['--fixtures', root, '--eval', '1']);
    assert.notEqual(code, 2, `a BOM must not be a runner error; stderr:\n${stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner: a fixture whose spec is not a JSON object is rejected by name', () => {
  // `null`, `[]` and `"str"` all parse fine and were accepted as specs, so the failure surfaced
  // later as an opaque stage-facts error instead of "this fixture is not an App Spec".
  for (const body of ['null', '[]', '"nope"', '42']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-eval-shape-'));
    try {
      fs.mkdirSync(path.join(root, '1-notobject'), { recursive: true });
      fs.writeFileSync(path.join(root, '1-notobject', 'app-spec.json'), body);
      const { code, stderr } = run(['--fixtures', root]);
      assert.equal(code, 2, `body ${body} must be a runner error`);
      assert.match(stderr, /1-notobject/, `body ${body} must name the fixture`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
