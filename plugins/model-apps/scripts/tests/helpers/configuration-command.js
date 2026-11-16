'use strict';
// One run of the build COMMAND (build-model-app.js main) with the SDK it makes itself over the real maker-SDK bundle, for the
// configuration tests (configuration-build-real-bundle.test.js) and for one OS process of their fresh-process tests
// (configuration-command-child.js). Only what reaches outside the process is a double: the transport (`org.request`, behind
// the plugin's own az-token client), the identity checks, the language read, the page backend and telemetry. Each SDK the
// command makes is watched for `initWorkspace`, which reads and writes local files only.
//
// `org` is anything with `origin`, `request(req)` and a `requests` array: the strict in-memory org in the test's process, or a
// proxy that forwards each request to it from a child process. `appDir` is the maker's app folder; the binding store lives
// under it, so a second run over the same folder (in this process or another) meets what the first left there.
const fs = require('node:fs');
const path = require('node:path');
const { loadCli } = require('./cli-harness.js');

const SCRIPTS = path.join(__dirname, '..', '..');

// `--allow-destructive` skips the read-only collision check, whose reads (app modules, forms) the strict org does not model.
// `onStorage(dir)` sees each SDK workspace folder the command makes; `liveIdentity` is the changed-only flow's live identity
// (an object, or a function returning one), none by default.
function runCommand(spec, { org, appDir, apply = true, argv = ['--stage', 'data', '--allow-destructive'], liveIdentity, onStorage } = {}) {
  const realHttp = require('../../lib/sdk-http-client.js');
  const realMakerSdk = require('../../lib/maker-sdk.js');
  fs.mkdirSync(appDir, { recursive: true });
  const specPath = path.join(appDir, 'app-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const sdks = [];
  const authCli = loadCli(path.join(SCRIPTS, 'lib', 'dataverse-auth.js'));
  const cli = loadCli(path.join(SCRIPTS, 'build-model-app.js'), {
    argv: ['--env', org.origin, '--spec', `@${specPath}`, ...(apply ? ['--apply'] : []), '--non-interactive', ...argv],
    env: { PATH: path.dirname(process.execPath), POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    requires: {
      './lib/dataverse-auth.js': { ...authCli.exports, preflightAuth: async () => ({ ok: true }) },
      // The changed-only flow's live identity (a WhoAmI and an app lookup the org does not model).
      './lib/changed-only-flow.js': { ...require('../../lib/changed-only-flow.js'), resolveLiveIdentity: async () => (typeof liveIdentity === 'function' ? liveIdentity() : liveIdentity || null) },
      './lib/entity-provision.js': { ...require('../../lib/entity-provision.js'), resolveAuthoringLanguage: async () => 1033 },
      './lib/sdk-http-client.js': {
        ...realHttp,
        createAzHttpClient: (env, o = {}) => realHttp.createAzHttpClient(env, { ...o, getToken: () => 'test-token-0123456789abcdef', request: (req) => org.request(req), sleep: async () => {} }),
      },
      './lib/maker-sdk.js': {
        ...realMakerSdk,
        createNodeWorkspaceStorage: (dir) => {
          if (onStorage) onStorage(dir);
          return realMakerSdk.createNodeWorkspaceStorage(dir);
        },
        createMakerSdk: (o) => {
          const sdk = realMakerSdk.createMakerSdk(o);
          const seen = { scoped: !!o.solutionUniqueName, inits: 0, requestsAtInit: [] };
          const init = sdk.initWorkspace.bind(sdk);
          sdk.initWorkspace = async () => {
            seen.inits += 1;
            const before = org.requests.length;
            await init();
            seen.requestsAtInit.push(org.requests.length - before);
          };
          sdks.push(seen);
          return sdk;
        },
      },
      './lib/genpage-sdk.js': { ...require('../../lib/genpage-sdk.js'), makeGenpageSdk: () => ({ dispose: async () => ({ left: [] }) }) },
      './lib/telemetry/skill-completed.js': { ...require('../../lib/telemetry/skill-completed.js'), emitSkillCompleted: async () => {} },
    },
  });
  return (async () => {
    let exitCode;
    let thrown;
    try {
      await cli.main();
    } catch (e) {
      if (e && e.exitCode !== undefined) exitCode = e.exitCode;
      else thrown = e;
    }
    let payload;
    try { payload = JSON.parse(authCli.stdoutText()); } catch { payload = undefined; }
    return { org, appDir, sdks, exitCode, thrown, payload, stderr: [...cli.stderr, ...authCli.stderr].join('') };
  })();
}

module.exports = { runCommand };
