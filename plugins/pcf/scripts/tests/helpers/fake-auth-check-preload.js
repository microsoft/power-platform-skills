'use strict';
// Loaded with `node --require` ahead of check-auth.js (this plugin's copy of model-apps' script), for tests/pcf-printers-whole-before-exit.test.js: the
// Azure CLI and PAC answer as for a signed-in maker@contoso.com, a Dataverse token is in hand, and WhoAmI is refused with HTTP 500 whose diagnostic is
// FAKE_WHOAMI_DIAGNOSTIC_SIZE characters long (helpers/huge-failure-preload.js hugeFailureText('whoami', size)) — the service's whole message, which the
// result carries as `whoAmI.message`. No process is started and no request is sent; the script and the rest of its helpers are the real ones.
const path = require('node:path');
const { hugeFailureText } = require('./huge-failure-preload.js');

const lib = path.join(__dirname, '..', '..', 'lib');
const authPath = require.resolve(path.join(lib, 'dataverse-auth.js'));
const runnerPath = require.resolve(path.join(lib, 'process-runner.js'));
const auth = require(authPath);
const runner = require(runnerPath);
const diagnostic = hugeFailureText('whoami', Number(process.env.FAKE_WHOAMI_DIAGNOSTIC_SIZE || 0));

require.cache[authPath].exports = {
  ...auth,
  getAuthTokenAsync: async () => 'synthetic-check-auth-token',
  dataverseRequest: async () => ({ status: 500, data: { error: { message: diagnostic } } }),
};
// `az account show` and `pac org who`, as check-auth.js starts them: a callback with the CLI's stdout, and a handle it can cancel.
require.cache[runnerPath].exports = {
  ...runner,
  execFileAsync: (command, args, options, done) => {
    setImmediate(() => done(null, command === 'pac' ? 'Connected as maker@contoso.com\n' : 'maker@contoso.com\n', ''));
    return { stdin: { end() {} }, kill() {} };
  },
};
