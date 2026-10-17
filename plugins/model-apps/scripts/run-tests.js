#!/usr/bin/env node
'use strict';
// One-command regression gate for model-apps. Runs the full plugin node:test suite and, with
// `--with-sdk <ppux-path>`, the vendored SDK's Jest suite under Node 20 (the canvas native module
// is built for the Node-20 ABI; the default Node fails to load it). Prints a combined PASS/FAIL and
// exits non-zero on any failure — the "did I break anything?" gate to run before every commit.
// The plugin suite runs in a temporary folder of its own, and the run also fails when a test leaves
// a file or folder in it (runPluginSuite, below).
//
// Usage:
//   node scripts/run-tests.js                       # plugin suite only
//   node scripts/run-tests.js --with-sdk D:/Projects/power-platform-ux-sdk
//   NODE20_BIN=C:/path/to/node20/dir node scripts/run-tests.js --with-sdk <ppux>

const { spawnSync } = require('node:child_process');
const { spawnResultSync, withPathFirst } = require('./lib/process-runner.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Node-20 bin dir for the SDK Jest suite (its canvas native module is built for the Node-20 ABI).
// Portable: set NODE20_BIN=<dir-containing-node20> or pass nothing to skip the SDK suite.
const NODE20_BIN = process.env.NODE20_BIN || null;

// The plugin test files to run, as repo-relative paths (sorted, stable order).
//
// RECURSIVE on purpose. This used to be a flat `readdirSync`, which silently ran zero tests from any
// `scripts/tests/<subdir>/*.test.js` — the file would be committed, reviewed and green, and never
// execute. Nothing else in CI would notice, because the runner reports success on the files it did
// find. Every test file today happens to be top-level, so this changes nothing now; it removes the
// trap for the first one that is not. `helpers/` holds fixtures, not tests, so the `.test.js` suffix
// (not the directory) remains the selector.
function pluginTestFiles(testsDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.js')) out.push(full);
    }
  };
  walk(testsDir);
  // Paths stay `scripts/tests/...`-prefixed and relative to the PLUGIN root (what the runner spawns
  // with), and a nested file keeps its subdirectory segment.
  return out.map((f) => path.join('scripts', 'tests', path.relative(testsDir, f))).sort();
}

// Resolve the SDK package dir + whether it (and a Node-20 bin dir) are present.
function sdkTestSpec(sdkPath, node20Bin) {
  const pkgDir = sdkPath ? path.join(sdkPath, 'packages', 'cds-maker-sdk') : null;
  return {
    pkgDir,
    pkgExists: !!pkgDir && fs.existsSync(pkgDir),
    node20Bin,
    node20Exists: !!node20Bin && fs.existsSync(node20Bin),
  };
}

// The plugin suite runs in a temporary folder of its own: TEMP, TMP and TMPDIR point into it, so os.tmpdir() does too,
// in every test file and in every process a test starts. Whatever is still in it when the suite ends was left by a test
// that did not clean up after itself, so the run names it and fails. A full run used to leave about 260 folders in the
// developer's own temp folder, which grew by hundreds of thousands of entries; tests/helpers/temp-dirs.js is the shared
// way to clean up. The private folder is removed either way, so a leak never reaches the developer's temp folder.
function runPluginSuite(files, { cwd, stdio = 'inherit', tempParent = os.tmpdir() } = {}) {
  const tempDir = fs.mkdtempSync(path.join(tempParent, 'model-apps-tests-'));
  try {
    // A process a test runner starts inherits NODE_TEST_CONTEXT, and a `node --test` that has it acts as that runner's
    // child: given these files, it ran none of them and exited 0 (measured: a test that makes a folder made none). The
    // suite must run as a runner of its own, whoever starts this script (this script's own tests do).
    const env = withTempDir(process.env, tempDir);
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', ...files], { cwd, stdio, env });
    return { status: run.status, left: fs.readdirSync(tempDir).sort() };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      // A process a test left running can still hold a file in it. Say where the folder is, rather than lose the summary.
      process.stderr.write(`could not remove the suite's temporary folder ${tempDir}: ${error.message}\n`);
    }
  }
}

// os.tmpdir() reads TEMP, then TMP, on Windows, and TMPDIR on macOS and Linux. Windows names are case-insensitive, so every
// spelling already in the environment is dropped first: a child handed both `Temp` and `TEMP` would see only one of them,
// and not necessarily ours.
function withTempDir(env, dir) {
  const rest = {};
  for (const [name, value] of Object.entries(env)) if (!/^(TEMP|TMP|TMPDIR)$/i.test(name)) rest[name] = value;
  return { ...rest, TEMP: dir, TMP: dir, TMPDIR: dir };
}

function main(argv) {
  const args = argv.slice(2);
  const sdkIdx = args.indexOf('--with-sdk');
  const sdkPath = sdkIdx > -1 && args[sdkIdx + 1] && !args[sdkIdx + 1].startsWith('--') ? args[sdkIdx + 1] : null;
  if (sdkIdx > -1 && !sdkPath) {
    // `--with-sdk` is a regression gate opt-in; silently skipping on a missing path makes a
    // supposedly SDK-covered run green, so treat the omitted value as a usage error.
    process.stderr.write('Usage: node scripts/run-tests.js [--with-sdk <ppux-path>]\n');
    return 2;
  }
  const pluginRoot = path.join(__dirname, '..');
  const results = [];

  // 1) Plugin suite (current Node).
  const files = pluginTestFiles(path.join(__dirname, 'tests'));
  process.stdout.write(`\n=== plugin node:test (${files.length} files) ===\n`);
  const plugin = runPluginSuite(files, { cwd: pluginRoot });
  results.push({ name: 'plugin node:test', ok: plugin.status === 0 });
  if (plugin.left.length) {
    process.stdout.write(`\n${plugin.left.length} file(s) or folder(s) left in the suite's temporary folder:\n`);
    for (const name of plugin.left.slice(0, 50)) process.stdout.write(`  ${name}\n`);
    if (plugin.left.length > 50) process.stdout.write(`  ... and ${plugin.left.length - 50} more\n`);
    process.stdout.write('A test must remove every file and folder it makes (scripts/tests/helpers/temp-dirs.js).\n');
  }
  results.push({ name: 'nothing left in the temporary folder', ok: plugin.left.length === 0 });

  // 2) SDK Jest suite (opt-in, Node 20).
  if (sdkPath) {
    const node20Bin = process.env.NODE20_BIN || NODE20_BIN;
    const spec = sdkTestSpec(sdkPath, node20Bin);
    if (!spec.pkgExists) {
      process.stdout.write(`\n(skipping SDK tests — ${spec.pkgDir} not found)\n`);
      results.push({ name: 'cds-maker-sdk Jest', ok: true, skipped: 'SDK package not found' });
    } else if (!spec.node20Exists) {
      process.stdout.write(`\n(skipping SDK tests — set NODE20_BIN to a Node-20 bin dir${node20Bin ? ` (not found at ${node20Bin})` : ''})\n`);
      results.push({ name: 'cds-maker-sdk Jest', ok: true, skipped: 'no Node 20 (set NODE20_BIN)' });
    } else {
      process.stdout.write('\n=== cds-maker-sdk Jest (Node 20) ===\n');
      // Node 20 first on the path. On Windows, where names are case-insensitive, an added `PATH` beside the
      // inherited `Path` would leave two values, of which Node passes the child only one.
      const env = withPathFirst(process.env, spec.node20Bin);
      // npm is resolved from the Node 20 PATH above, and started without a shell.
      const sdk = spawnResultSync('npm', ['test'], { cwd: spec.pkgDir, stdio: 'inherit', env }, { env });
      results.push({ name: 'cds-maker-sdk Jest', ok: sdk.status === 0 });
    }
  }

  // Summary.
  process.stdout.write('\n=== regression summary ===\n');
  const { lines, exitCode } = summarize(results);
  for (const l of lines) process.stdout.write(`${l}\n`);
  return exitCode;
}

// Render summary lines + resolve the exit code from collected suite results. A suite marked
// `skipped` is reported as SKIP and never fails the run — the SDK Jest suite is opt-in, so a missing
// prerequisite (no Node-20 bin / SDK package) leaves the regression gate green rather than red.
function summarize(results) {
  const lines = results.map((r) => `  ${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.skipped ? ` (${r.skipped})` : ''}`);
  const exitCode = results.every((r) => r.ok) ? 0 : 1;
  return { lines, exitCode };
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { pluginTestFiles, sdkTestSpec, summarize, runPluginSuite, withTempDir, main };
