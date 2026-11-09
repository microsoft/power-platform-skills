'use strict';
// Loaded with `node --require` ahead of a script that must reach NOTHING — no process, no connection, no token: it records each attempt to start a
// process (child_process), open a connection (http, https, net, tls, fetch) or load lib/dataverse-auth.js (the module that reads tokens from the
// Azure CLI and sends Dataverse requests), and writes the list to the file NO_SERVICE_LOG names when the process exits, e.g.
//   ["require lib/dataverse-auth.js","https.request"]
// An attempt to start a process or open a connection also throws, so a script that tried could not carry on as if it had been answered; loading
// the auth module is only recorded (a module can be loaded and never used, and the record is what a test asserts on).
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const attempts = [];
const refused = (what) => function refusedCall() {
  attempts.push(what);
  throw new Error(`${what} is not allowed in this process`);
};
for (const [name, members] of [
  ['child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ['http', ['request', 'get']],
  ['https', ['request', 'get']],
  ['net', ['connect', 'createConnection']],
  ['tls', ['connect']],
]) {
  const api = require(`node:${name}`);
  for (const member of members) api[member] = refused(`${name}.${member}`);
}
if (typeof globalThis.fetch === 'function') globalThis.fetch = refused('fetch');

const AUTH = path.resolve(__dirname, '..', '..', 'lib', 'dataverse-auth.js');
const load = Module._load;
Module._load = function recordedLoad(request, parent, isMain) {
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch {
    // The real load below reports a request that does not resolve.
  }
  if (resolved && path.resolve(resolved) === AUTH) attempts.push('require lib/dataverse-auth.js');
  return load.apply(this, arguments);
};

process.on('exit', () => {
  if (process.env.NO_SERVICE_LOG) fs.writeFileSync(process.env.NO_SERVICE_LOG, JSON.stringify(attempts));
});
