'use strict';
// One OS process of the configuration fresh-process tests (configuration-build-real-bundle.test.js): one run of the build
// command (helpers/configuration-command.js) with the real maker-SDK bundle, over the maker's app folder on disk. The
// process is the boundary under test: only the binding store and the files under the app folder carry over from one run
// to the next, never anything a process held in memory.
//   fork(configuration-command-child.js) with an IPC channel; the parent sends { start: { origin, spec, appDir, argv } }.
// The service is the strict in-memory org in the parent's process (it outlives every child): each request is sent to the
// parent as { request: n, req } and answered as { reply: n, answer }. The outcome is sent back as { result } before the
// channel closes: the pid, the exit code or the thrown error's code and message, the payload, stderr, and the throwaway SDK
// workspace folders the command made (the durable one under the app folder stays) with whether they are gone again.
const fs = require('node:fs');
const path = require('node:path');
const { runCommand } = require('./configuration-command.js');

const pending = new Map();
let serial = 0;

process.on('message', async (message) => {
  if (message.reply) {
    const resume = pending.get(message.reply);
    pending.delete(message.reply);
    resume(message.answer);
    return;
  }
  if (!message.start) return;
  const { origin, spec, appDir, argv } = message.start;
  const org = {
    origin,
    requests: [],
    request(req) {
      this.requests.push(req);
      const n = ++serial;
      return new Promise((resolve) => {
        pending.set(n, resolve);
        process.send({ request: n, req });
      });
    },
  };
  const storage = [];
  const out = await runCommand(spec, { org, appDir, ...(argv ? { argv } : {}), onStorage: (dir) => storage.push(dir) });
  // The maker's durable workspace lives under the app folder and stays; every other one is the run's throwaway workspace.
  const throwaway = storage.filter((dir) => !path.resolve(dir).startsWith(path.resolve(appDir) + path.sep));
  const result = {
    pid: process.pid,
    exitCode: out.exitCode,
    thrown: out.thrown ? { code: out.thrown.code, message: String(out.thrown.message) } : null,
    payload: out.payload,
    stderr: out.stderr,
    workspaceDirs: throwaway,
    workspacesRemoved: throwaway.every((dir) => !fs.existsSync(dir)),
  };
  process.send({ result }, () => process.disconnect());
});
