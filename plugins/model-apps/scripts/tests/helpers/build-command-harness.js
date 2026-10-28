'use strict';
// The build command (build-model-app.js main), loaded over its real modules — the build lease's included — with doubles for what reaches an
// environment or the SDK (helpers/cli-harness.js): the auth check, the language read, the SDK's factory and its HTTP client, the journal, the
// engine, the verify and the baseline writer.
//
// Each double is handed `held()`, which answers whether the app's build lock is on disk right now. What the command prints goes through the real
// printer (emitResult), whose process exit is the harness's: `printed` says what it printed and whether the lock was still there at that moment.
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./temp-dirs.js');
const { loadCli } = require('./cli-harness.js');
const { sha256 } = require('../../lib/hash.js');
const realEntityProvision = require('../../lib/entity-provision.js');
const realSdkBuild = require('../../lib/sdk-build.js');
const realBaseline = require('../../lib/deployed-baseline.js');

const SCRIPTS = path.join(__dirname, '..', '..');
const ENV = 'https://contoso.crm.dynamics.com';

// An app folder holding `spec`, and the workspace the command makes beside it. `lock` is the app's build lock, named here the way the lease names it
// (its app unique name, lower-cased, hashed) rather than asked of the lease, so that a test using it runs on a build that has no lease at all.
function appFolder(spec) {
  const appDir = path.join(makeTempDir('build-command-'), 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const specPath = path.join(appDir, 'app-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const workspaceDir = path.join(appDir, '.maker-workspace');
  const app = realSdkBuild.appUniqueName(spec);
  return { appDir, specPath, workspaceDir, lock: path.join(workspaceDir, `app-build.${sha256(app.toLowerCase())}.lock`) };
}

// The command for `folder`'s spec, with `--apply` and `argv`, and these doubles — each optional, each handed `held` first:
//   auth(held)              what the auth check answers (else `{ ok: true }`);
//   language(held)          the authoring language (else 1033);
//   makeSdk(held)           called as the SDK is made; it may throw;
//   openJournal(held)       called as the journal is opened (the real one is opened after it); it may throw;
//   engine(held, opts)      the engine (runSdkBuild) — `opts` is what buildModelApp hands it — and what it answers (else a success);
//   verify(held)            the inline verify (else a pass);
//   writeBaseline(held)     called as the baseline is written (the real one is written after it); it may throw.
// `calls` lists, in order, which doubles ran.
function command(folder, { argv = [], auth, language, makeSdk, openJournal, engine, verify, writeBaseline } = {}) {
  const held = () => fs.existsSync(folder.lock);
  const authCli = loadCli(path.join(SCRIPTS, 'lib', 'dataverse-auth.js'));
  const printed = { at: null, ok: null, heldThen: null };
  const calls = [];
  const note = (what) => { calls.push(what); return held(); };
  const sdk = { initWorkspace: async () => {}, queryRecords: async () => [] };
  const requires = {
    './lib/dataverse-auth.js': {
      ...authCli.exports,
      preflightAuth: async () => { note('auth'); return auth ? auth(held) : { ok: true }; },
      emitResult: (ok, payload) => { printed.ok = ok; printed.heldThen = held(); printed.at = calls.length; authCli.exports.emitResult(ok, payload); },
    },
    './lib/entity-provision.js': { ...realEntityProvision, resolveAuthoringLanguage: async () => { note('language'); return language ? language(held) : 1033; } },
    './lib/sdk-http-client.js': { createAzHttpClient: () => ({}), SQL_DEADLOCK_VICTIM: /Sql Number: 1205/ },
    './lib/maker-sdk.js': {
      createNodeWorkspaceStorage: (dir) => ({ dir }),
      createMakerSdk: () => { note('sdk'); if (makeSdk) makeSdk(held); return sdk; },
    },
    './lib/sdk-build.js': { ...realSdkBuild, runSdkBuild: async (s, o) => { note('engine'); return engine ? engine(held, o) : { ok: true, dryRun: false, created: {} }; } },
    './lib/genpage-sdk.js': { ...require('../../lib/genpage-sdk.js'), makeGenpageSdk: () => ({ dispose: async () => ({ left: [] }) }) },
    './lib/verify-spec.js': { ...require('../../lib/verify-spec.js'), verifySpec: async () => { note('verify'); return verify ? verify(held) : { ok: true, checks: [], missing: [] }; } },
    './lib/deployed-baseline.js': { ...realBaseline, writeBaseline: (...a) => { note('baseline'); if (writeBaseline) writeBaseline(held); return realBaseline.writeBaseline(...a); } },
  };
  if (openJournal) {
    const realJournal = require('../../lib/build-journal.js');
    requires['./lib/build-journal.js'] = { ...realJournal, openJournal: (...a) => { note('journal'); openJournal(held); return realJournal.openJournal(...a); } };
  }
  const cli = loadCli(path.join(SCRIPTS, 'build-model-app.js'), {
    argv: ['--env', ENV, '--spec', `@${folder.specPath}`, '--apply', ...argv],
    env: { PATH: path.dirname(process.execPath), POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    requires,
  });
  return { cli, authCli, printed, calls, held };
}

// What main() does with its outcome: a printed result ends the process (the harness's exit throws, with its code); an error it throws goes to
// main().catch, which prints it the same way — the harness has no main().catch, so the error itself is the rejection, and `heldThen` says whether
// the lock was still there when it came.
async function settle(run) {
  try {
    await run.cli.main();
    return { returned: true };
  } catch (e) {
    return e && e.exitCode !== undefined ? { exitCode: e.exitCode } : { thrown: e, heldThen: run.held() };
  }
}

module.exports = { appFolder, command, settle, ENV };
