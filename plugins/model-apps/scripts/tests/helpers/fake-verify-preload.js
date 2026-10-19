'use strict';
// A `node --require` preload for END-TO-END runs of scripts/verify-model-app.js that need no environment. It replaces the four things that would reach one — the az-token HTTP
// client, the SDK factory, the page backend and the verification itself — so a real child process runs the real script, the real spec validation, the real throwaway workspace and
// the real `emitResult`, and the test sees what the process printed: its stdout bytes, its stderr and its exit status.
//
// The fake comes from the environment variable FAKE_VERIFY, a JSON object:
//   result   what the verification answers: { ok, checks: [{ kind, name, present }], missing: [{ kind, name, detail }], unverified: [text] }
//   left     the folders the page backend's `dispose()` says it could not remove (its `{ left }`)
//
// The script takes these by destructuring when it loads (the SDK factory, when it first needs one), which is after this preload, so replacing the exports here is what it receives.
const path = require('node:path');

const lib = path.resolve(__dirname, '..', '..', 'lib');
const options = JSON.parse(process.env.FAKE_VERIFY || '{}');

require(path.join(lib, 'sdk-http-client.js')).createAzHttpClient = (env) => ({ env });
const makerSdk = require(path.join(lib, 'maker-sdk.js'));
makerSdk.createNodeWorkspaceStorage = (root) => ({ root });
makerSdk.createMakerSdk = () => ({ initWorkspace: async () => {} });
require(path.join(lib, 'genpage-sdk.js')).makeGenpageSdk = () => ({ dispose: async () => ({ left: options.left || [] }) });
require(path.join(lib, 'verify-spec.js')).verifySpec = async () => options.result;
