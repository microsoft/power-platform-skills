'use strict';
// The bundled SDK over a throwaway workspace folder, for a script that reads — or makes one write — and keeps nothing.
//
// `createMakerSdk` requires a workspace storage even for a call that never touches it (the SDK's design: "no workspace, no cache"), so every
// such script made a folder under the OS temp directory, built the SDK over it and removed the folder whichever way the run ended. That was
// written out in each of them; this is the one copy. The folder is made by lib/temp-workspace.js, in the plugin's own folder of the temp directory
// and with a record of whose it is: a run that is killed cannot remove it, and the next run does.
//
//   const tables = await withThrowawaySdk({ env, httpClient, prefix: 'list-tables-' }, async (make) => {
//     const sdk = make();                       // a reader
//     return sdk.findTables('account');
//   });
//
//   `make(extra)` builds another instance over the same folder and the same HTTP client. `languageCode` is a construction option of the
//   SDK, so a writer that labels in the environment's base language is a second instance (`make({ languageCode })`), never a changed one.
//
// The SDK is made through lib/maker-sdk.js, never the bundle itself (tests/maker-sdk.test.js), and INSIDE the guarded block: a constructor
// that throws, or a module that cannot be loaded, must not strand the folder. The other entry points that make a throwaway workspace are held
// to the same rule by tests/sdk-async-surface.test.js, which reads their syntax tree; this module's own tests (tests/throwaway-sdk.test.js)
// make each of those things fail and look for the folder.
const fs = require('node:fs');
const { createAzHttpClient } = require('./sdk-http-client.js');
const { makeTempWorkspace } = require('./temp-workspace.js');

/**
 * Runs `run(make)` with a way to make SDK instances over one throwaway workspace folder, removed whichever way the run ends.
 * @param {object} options
 * @param {string} options.env - a Dataverse https origin
 * @param {string} options.prefix - what the folder's name starts with (in the plugin's folder of the OS temp directory), so a folder left behind says whose it was
 * @param {object} [options.httpClient] - the SDK's HttpClient; the az-token one for `env` when omitted (a test seam). One client serves every instance made
 * @param {object} [options.deps] - a test seam: { makerSdk: { createMakerSdk, createNodeWorkspaceStorage }, createAzHttpClient }
 * @param {(make: (extra?: object) => object) => Promise<*>} run
 */
async function withThrowawaySdk({ env, prefix, httpClient, deps = {} }, run) {
  const workspaceDir = makeTempWorkspace(prefix);
  try {
    const { createMakerSdk, createNodeWorkspaceStorage } = deps.makerSdk || require('./maker-sdk.js');
    const client = httpClient || (deps.createAzHttpClient || createAzHttpClient)(env);
    const make = (extra = {}) => createMakerSdk({
      workspaceStorage: createNodeWorkspaceStorage(workspaceDir),
      instanceUrl: env,
      httpClient: client,
      ...extra,
    });
    return await run(make);
  } finally {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // A folder that held at most a copy of what was just written must not turn a finished run, or hide the failure of a failed one.
    }
  }
}

module.exports = { withThrowawaySdk };
