'use strict';
// helpers/console-event.js sends a REAL Ctrl+C or Ctrl+Break to a child process on Windows, and such an event reaches every process attached to the console it is sent on — a shell, the test runner and other jobs
// included, if they shared it. What keeps it from reaching anyone else is that it is never sent until the console it would go to has been listed and holds the child and the sender alone. That is tested here with a
// child whose console is SHARED with a second process: nothing may be sent, the sender must say why, and the child must hear nothing.
// The same helper answers, for every test file that sends an event, when a test SKIPS (the machine cannot send one) and when it FAILS (an event reached a shared console, or the sender or the child is at fault):
// the answer is tested here in itself (`consoleVerdict`, `controlProblem`) and in the three files that use it (console-test-skips.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInConsoles, consoleVerdict, controlProblem, STATUS_CONTROL_C_EXIT } = require('./helpers/console-event.js');

const WINDOWS = process.platform === 'win32';
const CHILD = path.join(__dirname, 'helpers', 'console-sharing-child.js');

const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const event of ['CTRL_C', 'CTRL_BREAK']) {
  test(`${event} is not sent to a console that another process shares — the sender refuses, says so, and the child hears nothing`, { skip: !WINDOWS && 'console events are a Windows thing' }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-event-'));
    dirs.push(dir);
    const ready = path.join(dir, 'ready.json');
    const [result] = await runInConsoles([{ event, script: CHILD, args: [ready], ready }]);
    // A machine that cannot attach to the child's console, list it or compile the sender cannot say anything about sharing: the test skips, with the reason. An event that WAS delivered to a console that another process
    // shared, and a sender that fails in any other way, are not that — they fail below.
    const verdict = consoleVerdict(result);
    if (verdict.kind === 'unavailable') {
      t.skip(verdict.reason);
      return;
    }
    assert.strictEqual(result.delivered, false, `no event was sent: ${JSON.stringify(result)}`);
    assert.match(result.error, /shared with another process: no event was sent/);
    assert.strictEqual(fs.existsSync(`${ready}.heard`), false, 'the child heard neither Ctrl+C nor Ctrl+Break');
    // The sender ended the child; the process it shared the console with ends by itself soon after.
    const { pid, grandchild } = JSON.parse(fs.readFileSync(ready, 'utf8'));
    for (let waited = 0; waited < 10000 && (alive(pid) || alive(grandchild)); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepStrictEqual([alive(pid), alive(grandchild)], [false, false], 'nothing is left running');
  });
}

// --- what a result of the sender says, and what a test does about it (helpers/console-event.js) ---------------------------------------------------------

// The messages are the ones the sender and the PowerShell around it produce: the words of the driver (every refusal of `Send` ends in "no event was sent"), PowerShell's own wrapper for what `Send` throws, and the
// two that stop the driver before any child is started.
const SEND = (words) => `Exception calling "Send" with "2" argument(s): "${words}"`;
const RESULT = (fields) => ({ delivered: false, exited: false, status: null, error: null, ...fields });

test('a machine that cannot send a console event is told from one that refuses on purpose, from one that did send, and from a defect of the sender or the child', () => {
  const unavailable = [
    'this PowerShell is in ConstrainedLanguage language mode, which does not allow the helper that sends console events',
    'the helper that sends console events could not be compiled: Cannot add type. Compilation errors occurred.',
    // The wrapper of PowerShell for an attach that failed with the operating system's words, which is how the sender reported it before every refusal ended in "no event was sent".
    SEND('The handle is invalid'),
    SEND('Access is denied'),
    SEND("the child's console could not be attached (The handle is invalid): no event was sent"),
    SEND("the processes on the child's console could not be listed: no event was sent"),
    SEND('the child is not on the console that was attached: no event was sent'),
    SEND('the event could not be sent (The parameter is incorrect): no event was sent'),
  ];
  for (const error of unavailable) {
    const verdict = consoleVerdict(RESULT({ error }));
    assert.strictEqual(verdict.kind, 'unavailable', error);
    assert.ok(verdict.reason.includes(error), 'the reason carries what the sender said');
  }
  const shared = consoleVerdict(RESULT({ error: SEND("the child's console is shared with another process: no event was sent") }));
  assert.strictEqual(shared.kind, 'shared', 'a refusal by design is not a machine that cannot send');
  assert.strictEqual(consoleVerdict({ delivered: true, exited: true, status: STATUS_CONTROL_C_EXIT, error: null }).kind, 'delivered');
  assert.strictEqual(consoleVerdict({ delivered: true, exited: false, status: null, error: null }).kind, 'delivered', 'a child that is still running was sent the event all the same');
  for (const error of ['the child ended before it was ready', 'the child was not ready in 60 seconds', 'Start-Process : This command cannot be run due to the error: The system cannot find the file specified.', null, '']) {
    const verdict = consoleVerdict(RESULT({ error }));
    assert.strictEqual(verdict.kind, 'defect', String(error));
    assert.ok(verdict.reason.length > 0);
  }
});

test('the control of an event: a child that registers nothing and ends as a cancelled process lets the test go on — anything else that is the machine\'s says why the test skips, and a defect fails', () => {
  assert.strictEqual(controlProblem({ delivered: true, exited: true, status: STATUS_CONTROL_C_EXIT, error: null }, 'Ctrl+C'), null);

  for (const control of [
    RESULT({ error: SEND('The handle is invalid') }),
    RESULT({ error: 'this PowerShell is in ConstrainedLanguage language mode, which does not allow the helper that sends console events' }),
    RESULT({ error: SEND("the child's console is shared with another process: no event was sent") }),
  ]) {
    const reason = controlProblem(control, 'Ctrl+Break');
    assert.strictEqual(typeof reason, 'string', JSON.stringify(control));
    assert.match(reason, /cannot say how a process ends when Ctrl\+Break reaches it/);
    assert.ok(reason.includes(control.error), 'and what the sender said');
  }
  assert.match(controlProblem({ delivered: true, exited: true, status: 1, error: null }, 'Ctrl+C'), /ended with status 1 and not with STATUS_CONTROL_C_EXIT/);
  assert.match(controlProblem({ delivered: true, exited: false, status: null, error: null }, 'Ctrl+C'), /still running 20 seconds after/);

  assert.throws(() => controlProblem(RESULT({ error: 'the child ended before it was ready' }), 'Ctrl+C'), assert.AssertionError, 'a control that could not be run for a reason nobody explains is a failure, not a skip');
  assert.throws(() => controlProblem(RESULT(), 'Ctrl+C'), assert.AssertionError);
});
