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

// --- CI workflow scoping ---------------------------------------------------------------------
// The plugin's workflow must stay scoped to THIS plugin. A widened path filter would spend CI on
// every unrelated PR, and (worse) make an unrelated plugin's red build look like a model-apps
// failure. This is a text assertion rather than a YAML parse because the repo ships no YAML
// dependency and the properties that matter are all line-level.
const WORKFLOW = path.resolve(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'model-apps-script-tests.yml');

test('the model-apps CI workflow triggers ONLY on model-apps paths', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  // The `paths:` block ends at the first non-list line (the blank line before `jobs:`).
  //   paths:
  //       - "plugins/model-apps/**"
  //       # a comment is allowed between entries
  //       - "evals/model-apps/**"
  const block = wf.slice(wf.indexOf('paths:'));
  const globs = [];
  for (const line of block.split('\n').slice(1)) {
    const m = /^\s+-\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (m) { globs.push(m[1]); continue; }
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    break; // reached `jobs:` or another key
  }
  assert.ok(globs.length > 0, 'the workflow must declare a paths filter, not run on every PR');
  for (const g of globs) {
    assert.ok(
      g.startsWith('plugins/model-apps/') || g.startsWith('evals/model-apps/') || g.endsWith('model-apps-script-tests.yml'),
      `path filter "${g}" is not scoped to model-apps — this workflow must not run for other plugins`
    );
  }
  // And it must not be scoped so tightly that the plugin's own code stops triggering it.
  assert.ok(globs.some((g) => g.startsWith('plugins/model-apps/')), 'the plugin source must trigger the workflow');
});

test('the model-apps CI workflow opts out of telemetry transmission on every job', () => {
  // Repo convention: any job that could execute a telemetry-emitting hook or script must set the
  // plugin's opt-out var, so a test that forgets to isolate emission cannot reach a real collector.
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  const jobCount = (wf.match(/^ {4}[a-z0-9-]+:\s*$/gim) || []).length;
  const optOuts = (wf.match(/POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT/g) || []).length;
  assert.ok(jobCount >= 2, `expected at least 2 jobs, found ${jobCount}`);
  assert.strictEqual(optOuts, jobCount, `every job must set the opt-out (${optOuts} set / ${jobCount} jobs)`);
});
