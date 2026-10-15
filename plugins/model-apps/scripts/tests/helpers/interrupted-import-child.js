'use strict';
// A child process for solution-settings-snapshot.test.js: it runs the REAL importer over the fake platform, with a settings file that only pac can apply and a fake pac that never answers — a pac that is
// running — and tells the parent, over the IPC channel, where the settings copy pac was given is. What happens next is the parent's: it ends this process in a way the importer can catch (the child
// ends itself by `exit` or an uncaught exception, as `ending` says) or signals it, and then looks at what is left on disk.
//
//   node interrupted-import-child.js <package> <settings> <ending>      ending: exit | throw | wait
const fs = require('node:fs');
const { createCloud, ORG } = require('./fake-power-platform.js');
const ss = require('../../solution-settings.js');

const [packagePath, settingsPath, ending] = process.argv.slice(2);
const cloud = createCloud();
// The importer's pac step is all that is wanted of the SDK: its refusal of a feature of pac's is what sends the file there.
const refusal = { code: 'INVALID_ARGUMENT', message: 'importSolution: the settings file holds a feature only pac applies. Nothing was imported.' };

// Keeps the process alive while it waits for a signal: a promise that never settles holds no handle of its own.
const hold = setInterval(() => {}, 1000);

ss.runImport({ command: 'import', env: ORG, packagePath, settingsPath }, {
  http: { getToken: () => cloud.tokens.dataverse, request: cloud.request, sleep: async () => {} },
  sdkFirst: async (env, plan) => ({ source: 'pac', value: await plan.fromPac(refusal), fallback: refusal }),
  pac: {
    spawn: (name, args) => {
      const copy = args[args.indexOf('--settings-file') + 1];
      // What the copy held while pac "ran", read here: a child that ends itself right after it speaks has removed the copy by the time the parent looks.
      const text = fs.readFileSync(copy, 'utf8');
      // The message is flushed before the process ends itself, or the parent would never hear where the copy was.
      process.send({ kind: 'copy-ready', copy, text, pid: process.pid }, () => {
        if (ending === 'exit') process.exit(3);
        if (ending === 'throw') setImmediate(() => { throw new Error('an error nothing catches'); });
      });
      return new Promise(() => {});
    },
  },
}).then(
  () => { clearInterval(hold); process.send({ kind: 'finished' }); },
  (error) => { clearInterval(hold); process.send({ kind: 'failed', error: error.message }); },
);
