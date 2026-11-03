'use strict';
// A child for console-event.test.js: a process that SHARES its console with another process of its own — a grandchild that inherits the console, as the child of a shell does — and says it is ready.
// It records any Ctrl+C or Ctrl+Break it hears in `<ready>.heard`, so that a test can say that none reached it.
//
//   node console-sharing-child.js <ready>     <ready> is written whole, by a rename, once the grandchild runs: {"pid":…,"grandchild":…}
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [ready] = process.argv.slice(2);
for (const signal of ['SIGINT', 'SIGBREAK']) process.on(signal, () => fs.appendFileSync(`${ready}.heard`, `${signal}\n`));

// The grandchild ends by itself soon after its parent does, so that nothing is left running whatever the test finds.
// Ready only once the grandchild RUNS — it says so on its stdout — and not when it is spawned: a new process joins the console it inherits while it starts, after CreateProcess returns, so a
// sender that listed the console in between would find the child and itself alone and send the event (seen under load). The grandchild's stdout is a pipe; its console is still this one.
const watch = `process.stdout.write('up\\n'); const parent = ${process.pid}; setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 100);`;
const grandchild = spawn(process.execPath, ['-e', watch], { stdio: ['ignore', 'pipe', 'ignore'] });
grandchild.stdout.once('data', () => {
  grandchild.stdout.resume();
  fs.writeFileSync(`${ready}.new`, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
  fs.renameSync(`${ready}.new`, ready);
});
// Keeps the process alive until it is ended.
setInterval(() => {}, 1000);
