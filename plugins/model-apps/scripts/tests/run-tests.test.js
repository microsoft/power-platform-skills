'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginTestFiles, sdkTestSpec, summarize } = require('../run-tests.js');

test('pluginTestFiles discovers every *.test.js as a scripts/tests path, sorted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtests-'));
  fs.writeFileSync(path.join(dir, 'b.test.js'), '');
  fs.writeFileSync(path.join(dir, 'a.test.js'), '');
  fs.writeFileSync(path.join(dir, 'notatest.js'), '');
  const files = pluginTestFiles(dir);
  assert.deepStrictEqual(files, [path.join('scripts', 'tests', 'a.test.js'), path.join('scripts', 'tests', 'b.test.js')]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pluginTestFiles covers the real tests directory (all 18+ suites)', () => {
  const files = pluginTestFiles(path.join(__dirname));
  assert.ok(files.length >= 18, `expected the full suite, got ${files.length}`);
  assert.ok(files.every((f) => f.endsWith('.test.js')));
});

test('sdkTestSpec resolves the package dir and reports presence', () => {
  const spec = sdkTestSpec('D:/nope', 'D:/also-nope');
  assert.ok(spec.pkgDir.endsWith(path.join('packages', 'cds-maker-sdk')));
  assert.strictEqual(spec.pkgExists, false);
  assert.strictEqual(spec.node20Exists, false);
});

test('summarize reports a skipped suite as SKIP and keeps the run green', () => {
  const { lines, exitCode } = summarize([
    { name: 'plugin node:test', ok: true },
    { name: 'cds-maker-sdk Jest', ok: true, skipped: 'no Node 20 (set NODE20_BIN)' },
  ]);
  assert.strictEqual(exitCode, 0, 'a missing SDK prerequisite must not fail the run');
  assert.ok(lines.some((l) => /SKIP\s+cds-maker-sdk Jest \(no Node 20 \(set NODE20_BIN\)\)/.test(l)));
  assert.ok(lines.some((l) => /PASS\s+plugin node:test/.test(l)));
});

test('summarize fails the run when any non-skipped suite failed', () => {
  const { lines, exitCode } = summarize([
    { name: 'plugin node:test', ok: false },
    { name: 'cds-maker-sdk Jest', ok: true },
  ]);
  assert.strictEqual(exitCode, 1);
  assert.ok(lines.some((l) => /FAIL\s+plugin node:test/.test(l)));
});
