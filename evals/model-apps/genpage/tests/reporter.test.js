'use strict';
// The TAP reporter the genpage runners and the app-builder runner share (lib/reporter.js). An assertion is pass, fail or skip, and a skip grades
// nothing. So a fixture passes only when at least one of its assertions was graded and none failed; a fixture whose every assertion skipped — or
// that has none — is unscored: its line carries TAP's `# SKIP` directive, it is counted on a line of its own, and it is never counted as passed.
// The `# fixtures N (pass P, fail F)` summary keeps its exact form, and a run with no unscored fixture prints exactly what it always printed.
// The pcf eval runner prints through a byte-for-byte copy of this reporter (evals/pcf/lib/reporter.js); the last test here fails when the two
// drift apart, so a change to this file takes the copy with it in the same PR (the pcf reporter tests check the same from their side).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TapReporter } = require('../lib/reporter.js');

const PASS = { status: 'pass', reason: '' };
const SKIP = { status: 'skip', reason: 'not applicable' };
const FAIL = { status: 'fail', reason: 'broken' };

// Reports `fixtures` — [name, results] pairs — through one reporter, as a runner does; returns its whole output and the reporter.
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

test('a fixture whose every assertion skipped is unscored: a # SKIP fixture line, its own count, never the passed count, and no failure', () => {
  const { lines, reporter } = report([['all-skipped', [SKIP, SKIP, SKIP]]]);
  assert.ok(lines.includes('ok 1 - all-skipped # SKIP no expectation graded'), lines.join('\n'));
  assert.deepStrictEqual(summary(lines), ['# tests 3', '# pass  0', '# fail  0', '# skip  3', '# fixtures 1 (pass 0, fail 0)', '# unscored fixtures 1']);
  assert.deepStrictEqual([reporter.fixturePass, reporter.fixtureFail, reporter.fixtureUnscored], [0, 0, 1]);
  assert.equal(reporter.exitCode, 0);
});

test('a fixture with no assertion at all is unscored the same way', () => {
  const { lines, reporter } = report([['empty', []], ['graded', [PASS]]]);
  assert.ok(lines.includes('    1..0'), lines.join('\n'));
  assert.ok(lines.includes('ok 1 - empty # SKIP no expectation graded'), lines.join('\n'));
  assert.ok(lines.includes('ok 2 - graded'), lines.join('\n'));
  assert.deepStrictEqual(summary(lines), ['# tests 1', '# pass  1', '# fail  0', '# skip  0', '# fixtures 2 (pass 1, fail 0)', '# unscored fixtures 1']);
  assert.deepStrictEqual([reporter.fixturePass, reporter.fixtureFail, reporter.fixtureUnscored], [1, 0, 1]);
  assert.equal(reporter.exitCode, 0);
});

test('a fixture with one graded assertion and skips beside it still passes; one failed assertion fails a fixture, skips or not', () => {
  const { lines, reporter } = report([['mixed', [SKIP, PASS, SKIP]], ['failed', [SKIP, FAIL]], ['unscored', [SKIP]]]);
  assert.ok(lines.includes('ok 1 - mixed'), lines.join('\n'));
  assert.ok(lines.includes('not ok 2 - failed'), lines.join('\n'));
  assert.ok(lines.includes('ok 3 - unscored # SKIP no expectation graded'), lines.join('\n'));
  assert.deepStrictEqual(summary(lines), ['# tests 6', '# pass  1', '# fail  1', '# skip  4', '# fixtures 3 (pass 1, fail 1)', '# unscored fixtures 1']);
  assert.deepStrictEqual([reporter.fixturePass, reporter.fixtureFail, reporter.fixtureUnscored], [1, 1, 1]);
  // Only a failed fixture makes the run fail; an unscored one does not.
  assert.equal(reporter.exitCode, 1);
});

test('a run with no unscored fixture prints exactly what it always printed, and `# fixtures` stays its one summary line', () => {
  const { text, lines, reporter } = report([['graded', [PASS, SKIP]], ['broken', [SKIP, FAIL]]]);
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

test('the pcf eval runner\'s reporter is this reporter, byte for byte, so it grades and counts as these runners do', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reporter.js'));
  const copy = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'pcf', 'lib', 'reporter.js'));
  assert.ok(copy.equals(source), 'evals/pcf/lib/reporter.js differs from evals/model-apps/genpage/lib/reporter.js: change both in the same PR (copy the file over)');
});
