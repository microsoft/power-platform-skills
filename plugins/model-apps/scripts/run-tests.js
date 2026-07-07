#!/usr/bin/env node
'use strict';
// One-command regression gate for model-apps. Runs the full plugin node:test suite and, with
// `--with-sdk <ppux-path>`, the vendored SDK's Jest suite under Node 20 (the canvas native module
// is built for the Node-20 ABI; the default Node fails to load it). Prints a combined PASS/FAIL and
// exits non-zero on any failure — the "did I break anything?" gate to run before every commit.
//
// Usage:
//   node scripts/run-tests.js                       # plugin suite only
//   node scripts/run-tests.js --with-sdk D:/Projects/power-platform-ux-sdk
//   NODE20_BIN=C:/path/to/node20/dir node scripts/run-tests.js --with-sdk <ppux>

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_NODE20_BIN = 'C:/Users/akmaloo/AppData/Local/nvm/v20.18.2';

// The plugin test files to run, as repo-relative paths (sorted, stable order).
function pluginTestFiles(testsDir) {
  return fs
    .readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join('scripts', 'tests', f));
}

// Resolve the SDK package dir + whether it (and a Node-20 bin dir) are present.
function sdkTestSpec(sdkPath, node20Bin) {
  const pkgDir = sdkPath ? path.join(sdkPath, 'packages', 'cds-maker-sdk') : null;
  return {
    pkgDir,
    pkgExists: !!pkgDir && fs.existsSync(pkgDir),
    node20Bin,
    node20Exists: fs.existsSync(node20Bin),
  };
}

function main(argv) {
  const args = argv.slice(2);
  const sdkIdx = args.indexOf('--with-sdk');
  const sdkPath = sdkIdx > -1 ? args[sdkIdx + 1] : null;
  const pluginRoot = path.join(__dirname, '..');
  const results = [];

  // 1) Plugin suite (current Node).
  const files = pluginTestFiles(path.join(__dirname, 'tests'));
  process.stdout.write(`\n=== plugin node:test (${files.length} files) ===\n`);
  const plugin = spawnSync(process.execPath, ['--test', ...files], { cwd: pluginRoot, stdio: 'inherit' });
  results.push({ name: 'plugin node:test', ok: plugin.status === 0 });

  // 2) SDK Jest suite (opt-in, Node 20).
  if (sdkPath) {
    const node20Bin = process.env.NODE20_BIN || DEFAULT_NODE20_BIN;
    const spec = sdkTestSpec(sdkPath, node20Bin);
    if (!spec.pkgExists) {
      process.stdout.write(`\n(skipping SDK tests — ${spec.pkgDir} not found)\n`);
    } else if (!spec.node20Exists) {
      process.stdout.write(`\n(skipping SDK tests — Node 20 bin not found at ${node20Bin}; set NODE20_BIN)\n`);
      results.push({ name: 'cds-maker-sdk Jest', ok: false, skipped: 'no Node 20' });
    } else {
      process.stdout.write('\n=== cds-maker-sdk Jest (Node 20) ===\n');
      const env = { ...process.env, PATH: `${spec.node20Bin}${path.delimiter}${process.env.PATH}` };
      const sdk = spawnSync('npm', ['test'], { cwd: spec.pkgDir, stdio: 'inherit', env, shell: true });
      results.push({ name: 'cds-maker-sdk Jest', ok: sdk.status === 0 });
    }
  }

  // Summary.
  process.stdout.write('\n=== regression summary ===\n');
  for (const r of results) process.stdout.write(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.skipped ? ` (${r.skipped})` : ''}\n`);
  return results.every((r) => r.ok) ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { pluginTestFiles, sdkTestSpec, main };
