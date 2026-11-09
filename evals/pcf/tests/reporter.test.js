'use strict';
// The TAP reporter of the pcf eval runner (lib/reporter.js, used by run-pcf.js). An assertion is pass, fail or skip, and a skip grades nothing.
// So a case passes only when at least one of its assertions was graded and none failed; a case whose every assertion skipped — or that has
// none — is unscored: its line carries TAP's `# SKIP` directive, it is counted on a line of its own, and it is never counted as passed. The
// `# fixtures N (pass P, fail F)` summary keeps its exact form, and a run with no unscored case prints exactly what it always printed.
//
// The reporter is the model-apps eval runners' reporter (evals/model-apps/genpage/lib/reporter.js), copied byte for byte: the last test here
// fails when the two drift apart, and the model-apps reporter tests check the same from their side.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TapReporter } = require('../lib/reporter.js');

const EVALS_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(EVALS_ROOT, '..', '..');
const RUNNER = path.join(EVALS_ROOT, 'run-pcf.js');

const PASS = { status: 'pass', reason: '' };
const SKIP = { status: 'skip', reason: 'not applicable' };
const FAIL = { status: 'fail', reason: 'broken' };

// Reports `fixtures` — [name, results] pairs — through one reporter, as the runner does; returns its whole output and the reporter.
function report(fixtures) {
  let text = '';
  const reporter = new TapReporter({ write: (chunk) => { text += chunk; } });
  reporter.start(fixtures.length);
  for (const [name, results] of fixtures) {
    reporter.startFixture(name);
    results.forEach((result, index) => reporter.assertion(`assertion ${index + 1}`, result));
    reporter.endFixture();
  }
  reporter.end();
  return { text, lines: text.split('\n'), reporter };
}
const summary = (lines) => lines.filter((line) => /^# (?:tests|pass|fail|skip|fixtures|unscored)/.test(line));

test('a case whose every assertion skipped is unscored: a # SKIP case line, its own count, never the passed count, and no failure', () => {
  const { lines, reporter } = report([['all-skipped', [SKIP, SKIP, SKIP]]]);
  assert.ok(lines.includes('ok 1 - all-skipped # SKIP no expectation graded'), lines.join('\n'));
  assert.deepStrictEqual(summary(lines), ['# tests 3', '# pass  0', '# fail  0', '# skip  3', '# fixtures 1 (pass 0, fail 0)', '# unscored fixtures 1']);
  assert.deepStrictEqual([reporter.fixturePass, reporter.fixtureFail, reporter.fixtureUnscored], [0, 0, 1]);
  assert.equal(reporter.exitCode, 0);
});

test('a case with no assertion at all is unscored the same way', () => {
  const { lines, reporter } = report([['empty', []], ['graded', [PASS]]]);
  assert.ok(lines.includes('    1..0'), lines.join('\n'));
  assert.ok(lines.includes('ok 1 - empty # SKIP no expectation graded'), lines.join('\n'));
  assert.ok(lines.includes('ok 2 - graded'), lines.join('\n'));
  assert.deepStrictEqual(summary(lines), ['# tests 1', '# pass  1', '# fail  0', '# skip  0', '# fixtures 2 (pass 1, fail 0)', '# unscored fixtures 1']);
  assert.deepStrictEqual([reporter.fixturePass, reporter.fixtureFail, reporter.fixtureUnscored], [1, 0, 1]);
  assert.equal(reporter.exitCode, 0);
});

test('a case with one graded assertion and skips beside it still passes; one failed assertion fails a case, skips or not', () => {
  const { lines, reporter } = report([['mixed', [SKIP, PASS, SKIP]], ['failed', [SKIP, FAIL]], ['unscored', [SKIP]]]);
  assert.ok(lines.includes('ok 1 - mixed'), lines.join('\n'));
  assert.ok(lines.includes('not ok 2 - failed'), lines.join('\n'));
  assert.ok(lines.includes('ok 3 - unscored # SKIP no expectation graded'), lines.join('\n'));
  assert.deepStrictEqual(summary(lines), ['# tests 6', '# pass  1', '# fail  1', '# skip  4', '# fixtures 3 (pass 1, fail 1)', '# unscored fixtures 1']);
  assert.deepStrictEqual([reporter.fixturePass, reporter.fixtureFail, reporter.fixtureUnscored], [1, 1, 1]);
  // Only a failed case makes the run fail; an unscored one does not.
  assert.equal(reporter.exitCode, 1);
});

test('a run with no unscored case prints exactly what it always printed, and `# fixtures` stays its one summary line', () => {
  const { text, reporter } = report([['graded', [PASS, SKIP]], ['broken', [SKIP, FAIL]]]);
  assert.equal(text, [
    'TAP version 13',
    '1..2',
    '# Subtest: graded',
    '    ok 1 - assertion 1',
    '    ok 2 - assertion 2 # SKIP not applicable',
    '    1..2',
    'ok 1 - graded',
    '# Subtest: broken',
    '    ok 1 - assertion 1 # SKIP not applicable',
    '    not ok 2 - assertion 2',
    '      ---',
    '      reason: "broken"',
    '      ...',
    '    1..2',
    'not ok 2 - broken',
    '# tests 4',
    '# pass  1',
    '# fail  1',
    '# skip  2',
    '# fixtures 2 (pass 1, fail 1)',
    '',
  ].join('\n'));
  assert.equal(reporter.fixtureUnscored, 0);
  assert.equal(reporter.exitCode, 1);
  const unscored = report([['all-skipped', [SKIP]]]).lines;
  assert.deepStrictEqual(unscored.filter((line) => line.startsWith('# fixtures')), ['# fixtures 1 (pass 0, fail 0)']);
});

// Through the runner: a case whose assertions name no registered check (each one skips, `no check registered for this assertion text`) and a case
// with an empty `assertions` list are unscored beside the cases that are graded, and the run still exits 0.
test('run-pcf.js reports a smoke case with no registered check, and one with no assertion, as unscored beside the graded ones, and exits 0', () => {
  const data = JSON.parse(fs.readFileSync(path.join(EVALS_ROOT, 'evals.json'), 'utf8'));
  const smoke = data.evals.filter((ev) => ev.tier === 'smoke');
  assert.equal(smoke.length, 8, 'the smoke subset the runner test pins');
  const [unchecked, empty] = smoke;
  unchecked.assertions = ['no check is registered for this assertion text'];
  empty.assertions = [];
  const nameOf = (ev) => `${String(ev.id).padStart(3, '0')}-${ev.fixture || ev.family}`;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-eval-unscored-'));
  try {
    const copy = path.join(tmpRoot, 'evals.json');
    fs.writeFileSync(copy, JSON.stringify(data, null, 2));
    const run = spawnSync(process.execPath, [RUNNER, '--tier', 'smoke', '--evals', copy], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, `an unscored case does not fail the run\nstderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
    const lines = run.stdout.split(/\r?\n/);
    assert.ok(lines.includes(`ok 1 - ${nameOf(unchecked)} # SKIP no expectation graded`), run.stdout);
    assert.ok(lines.includes(`ok 2 - ${nameOf(empty)} # SKIP no expectation graded`), run.stdout);
    assert.ok(lines.includes(`ok 3 - ${nameOf(smoke[2])}`), run.stdout);
    assert.deepStrictEqual(lines.filter((line) => /^# (?:fixtures|unscored)/.test(line)), ['# fixtures 8 (pass 6, fail 0)', '# unscored fixtures 2']);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('the pcf reporter is the model-apps eval reporter, byte for byte, so the pcf runner grades and counts as those runners do', () => {
  const copy = fs.readFileSync(path.join(EVALS_ROOT, 'lib', 'reporter.js'));
  const source = fs.readFileSync(path.join(REPO_ROOT, 'evals', 'model-apps', 'genpage', 'lib', 'reporter.js'));
  assert.ok(copy.equals(source), 'evals/pcf/lib/reporter.js differs from evals/model-apps/genpage/lib/reporter.js: change both in the same PR (copy the file over)');
});
