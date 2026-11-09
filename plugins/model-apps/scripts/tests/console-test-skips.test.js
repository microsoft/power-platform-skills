'use strict';
// The three test files that send a REAL console event — console-event.test.js, exit-cleanup.test.js and solution-settings-snapshot.test.js — answer the same two questions the same way (helpers/console-event.js):
//   - a machine that cannot send an event, or whose control does not end as a cancelled process, says nothing about the code under test, so the test SKIPS and says why;
//   - an event that was delivered to a console that another process shared, and every defect of the sender or of the child, say something about the code, so the test FAILS.
// Here each file's console tests are run, in a process of their own, on a machine whose consoles are made to answer as each kind of machine would (helpers/console-results-preload.js — which sends nothing: no console
// event is sent by any of these runs, so this test is safe on a machine that does take them), and what each file does about it is read from the report.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WINDOWS = process.platform === 'win32';
const PRELOAD = path.join(__dirname, 'helpers', 'console-results-preload.js');
// Each file, and a pattern of the names of its console tests.
const FILES = {
  'console-event.test.js': 'is not sent to a console that another process shares',
  'exit-cleanup.test.js': 'Windows console event',
  'solution-settings-snapshot.test.js': 'reaches the importer',
};

function report(file, mode) {
  return new Promise((resolve, reject) => {
    // The runner marks the processes it starts for test files (NODE_TEST_CONTEXT), and a `node --test` that finds the mark in its environment takes itself for a nested run and runs nothing.
    const { NODE_TEST_CONTEXT, ...inherited } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${FILES[file]}`, path.join(__dirname, file)], {
      env: { ...inherited, NODE_OPTIONS: `--require=${JSON.stringify(PRELOAD)}`, CONSOLE_RESULTS: mode, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stdout += data; });
    const timer = setTimeout(() => child.kill(), 120 * 1000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', () => {
      clearTimeout(timer);
      // One line per test, at the left edge of the TAP report: `ok 3 - name # SKIP reason`, `not ok 4 - name`. Node 20 lists the tests a name pattern leaves out as skipped ("test name does not match pattern"); Node 22 does
      // not list them at all — neither is a console test that ran, so neither is counted.
      const tests = [];
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^(not ok|ok) \d+ - (.*)$/.exec(line);
        if (!match) continue;
        const skip = / # SKIP (.*)$/.exec(match[2]);
        if (skip && skip[1] === 'test name does not match pattern') continue;
        tests.push({ passed: match[1] === 'ok' && !skip, failed: match[1] === 'not ok', skipped: Boolean(skip), reason: skip ? skip[1] : null });
      }
      resolve({
        tests: tests.length,
        pass: tests.filter((test) => test.passed).length,
        fail: tests.filter((test) => test.failed).length,
        skipped: tests.filter((test) => test.skipped).length,
        skips: tests.filter((test) => test.skipped).map((test) => test.reason),
        output: stdout,
      });
    });
  });
}

// All of them are started together, the first time one is asked for: each is a process that does nothing but compile a test file and answer the stand-in.
const runs = new Map();
function ran(file, mode) {
  if (runs.size === 0) {
    for (const [name, modes] of Object.entries(PLAN)) for (const wanted of modes) runs.set(`${name}/${wanted}`, report(name, wanted));
  }
  return runs.get(`${file}/${mode}`);
}
// What is run: each file with every kind of machine that is of interest to it. (A console that is shared is a refusal the console-event tests EXPECT of a child that shares one on purpose, and with the stand-in
// there is no such child: it is not run there.)
const PLAN = {
  'console-event.test.js': ['attach-denied', 'constrained', 'wrong-status', 'defect'],
  'exit-cleanup.test.js': ['attach-denied', 'constrained', 'shared', 'wrong-status', 'defect'],
  'solution-settings-snapshot.test.js': ['attach-denied', 'constrained', 'shared', 'wrong-status', 'defect'],
};

const SKIP = { skip: !WINDOWS && 'console events are a Windows thing: elsewhere every one of these tests skips for that reason' };

for (const [mode, machine] of [
  ['attach-denied', 'whose consoles cannot be attached to'],
  ['constrained', 'whose PowerShell is in a constrained language mode'],
]) {
  for (const file of Object.keys(PLAN)) {
    test(`${file}: on a machine ${machine}, every console test skips — with the reason — and none fails`, SKIP, async () => {
      const { tests, pass, fail, skipped, skips, output } = await ran(file, mode);
      assert.ok(tests > 0, `no console test was run:\n${output}`);
      assert.deepStrictEqual([fail, pass, skipped], [0, 0, tests], output);
      assert.strictEqual(skips.length, tests, 'each skip says why');
      assert.ok(skips.every((reason) => /cannot|could not/.test(reason) && /handle is invalid|ConstrainedLanguage/.test(reason)), `a skip says what the machine said: ${skips.join(' | ')}`);
    });
  }
}

for (const file of ['exit-cleanup.test.js', 'solution-settings-snapshot.test.js']) {
  test(`${file}: when every child's console is shared with another process — nothing could be sent — the tests that need a control skip, and none fails`, SKIP, async () => {
    const { tests, pass, fail, skipped, skips, output } = await ran(file, 'shared');
    assert.ok(tests > 0, output);
    assert.deepStrictEqual([fail, pass, skipped], [0, 0, tests], output);
    assert.ok(skips.every((reason) => /shared with another process/.test(reason)), skips.join(' | '));
  });
  test(`${file}: when the control child of an event ends with a status that is not a cancellation, the tests skip — a machine that cannot show how a process ends cannot say how another one does`, SKIP, async () => {
    const { tests, pass, fail, skipped, skips, output } = await ran(file, 'wrong-status');
    assert.ok(tests > 0, output);
    assert.deepStrictEqual([fail, pass, skipped], [0, 0, tests], output);
    assert.ok(skips.every((reason) => /ended with status 1 and not with STATUS_CONTROL_C_EXIT/.test(reason)), skips.join(' | '));
  });
}

// What must NOT skip: an event that was delivered to a console that another process shared (the stand-in says every scenario was sent the event, to a child that is meant to share its console), and a sender or child
// that fails in a way nobody explains.
test('console-event.test.js: an event that WAS delivered to a console another process shares fails — the sender\'s guard did not hold, and a skip would hide it', SKIP, async () => {
  const { tests, pass, fail, skipped, output } = await ran('console-event.test.js', 'wrong-status');
  assert.deepStrictEqual([tests, pass, fail, skipped], [2, 0, 2, 0], output);
  assert.match(output, /no event was sent/);
});

for (const file of Object.keys(PLAN)) {
  test(`${file}: a sender or a child that fails in a way nobody explains — a child that was never ready — fails the tests: it is a defect, and a skip would hide it`, SKIP, async () => {
    const { tests, pass, fail, skipped, output } = await ran(file, 'defect');
    assert.ok(tests > 0, output);
    assert.deepStrictEqual([fail, pass, skipped], [tests, 0, 0], output);
    assert.match(output, /the child ended before it was ready/);
  });
}
