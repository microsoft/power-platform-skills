'use strict';
// helpers/console-event.js sends a REAL Ctrl+C or Ctrl+Break to a child process on Windows, and such an event reaches every process attached to the console it is sent on — a shell, the test runner and other jobs
// included, if they shared it. What keeps it from reaching anyone else is that it is never sent until the console it would go to has been listed and holds the child and the sender alone. That is tested here with a
// child whose console is SHARED with a second process: nothing may be sent, the sender must say why, and the child must hear nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInConsoles } = require('./helpers/console-event.js');

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
    if (/language mode|could not be compiled/.test(String(result.error))) {
      t.skip(`this PowerShell cannot send console events at all: ${result.error}`);
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
