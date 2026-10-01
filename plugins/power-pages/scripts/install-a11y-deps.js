#!/usr/bin/env node
'use strict';

// Installs the pinned playwright-core and axe-core used by a11y-audit.js into a
// private per-user cache (or --deps-dir). Safe to run repeatedly: it is a no-op when
// the pinned versions are already present.
//
// Usage: node install-a11y-deps.js [--deps-dir <path>]
// Prints JSON: { depsDir, installed: true|false, versions: {...} }
// Exit codes: 0 ok, 1 install failed, 2 usage error.

const { defaultDepsDir, installDeps } = require('./lib/a11y/deps');

function parse(argv) {
  const opts = { depsDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--deps-dir' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      opts.depsDir = argv[++i];
    } else {
      return { error: `Unknown or incomplete argument: ${argv[i]}` };
    }
  }
  return opts;
}

function main(argv = process.argv.slice(2), { install = installDeps, stdout = process.stdout, stderr = process.stderr } = {}) {
  const opts = parse(argv);
  if (opts.error) {
    stderr.write(`${opts.error}\nUsage: node install-a11y-deps.js [--deps-dir <path>]\n`);
    return 2;
  }
  try {
    const result = install({ depsDir: opts.depsDir || defaultDepsDir() });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    stderr.write(`Failed to install accessibility audit dependencies: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main };
