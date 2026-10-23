'use strict';
// A folder of its own for a test's apply.
//
// An apply opens its workspace — and holds the app's build lease in it (lib/app-operation-lease.js) — in `<app folder>/.maker-workspace`, and a call
// that names no app folder and no workspace means `.`: the folder the suite runs in, which is the plugin's own, and which scripts/run-tests.js
// refuses to see a `.maker-workspace` made in. So a test that runs an apply and names neither is given a folder of its own, removed with the file's
// other temporary folders (helpers/temp-dirs.js). A call that names either keeps what it named, and a dry run, which opens no workspace and takes no
// lease, is left as it is.
//
// Which of the two it is given decides nothing else the test relies on only when it is chosen for that test:
//   - inOwnFolder names an APP FOLDER, one per test file (the tests of a file run one at a time), whose workspace the build makes inside it and keeps
//     nothing in but the lease, which it lets go. The build then checks that the source files the spec names (a page's `codeFile`, a web resource's
//     `contentPath`) are in that folder, so it is for a spec that names none, or a test that never gets that far;
//   - inOwnWorkspace names a WORKSPACE, and leaves the app folder unnamed, so the build checks no source file, as it did for such a call. A workspace
//     is also where the build keeps its records (the destructive approval, the page receipts), which such a call never had, so each call is given a
//     new one: no record one test's build writes is there for the next.
const { makeTempDir } = require('./temp-dirs.js');

let sharedAppDir = null;

const namesNone = (opts) => !!opts && !!opts.apply && opts.appDir === undefined && opts.workspaceDir === undefined;
function ownAppFolder(opts) {
  if (!namesNone(opts)) return opts;
  if (!sharedAppDir) sharedAppDir = makeTempDir('build-app-');
  return { ...opts, appDir: sharedAppDir };
}
const ownWorkspace = (opts) => (namesNone(opts) ? { ...opts, workspaceDir: makeTempDir('build-workspace-') } : opts);

// `runSdkBuild(spec, opts)` or `buildModelApp(spec, opts, deps)`, with its options given a folder of their own when they need one.
const inOwnFolder = (entry) => (spec, opts, ...rest) => entry(spec, ownAppFolder(opts), ...rest);
const inOwnWorkspace = (entry) => (spec, opts, ...rest) => entry(spec, ownWorkspace(opts), ...rest);

module.exports = { ownAppFolder, ownWorkspace, inOwnFolder, inOwnWorkspace };
