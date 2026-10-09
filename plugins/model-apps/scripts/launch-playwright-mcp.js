#!/usr/bin/env node

// Launches the Playwright MCP server with the best available browser.
// Detects system-installed Chromium-based browsers in preference order,
// then falls back to Playwright's bundled Chromium.
// Self-contained — no external dependencies required.

const os = require('os');
const path = require('path');
const { detectBrowser } = require('./lib/detect-browser');
// npx is a batch shim on Windows; the runner starts it without a shell (see lib/process-runner.js).
const { spawnProcess } = require('./lib/process-runner');

function buildMcpArgs(browser, {
  configPath = path.join(__dirname, 'playwright-mcp-fullscreen.config.json'),
} = {}) {
  return [
    '-y',
    '@playwright/mcp@latest',
    '--browser',
    browser,
    '--config',
    configPath,
  ];
}

function launch({
  browser = detectBrowser(),
  spawnFn = spawnProcess,
  // Node passes (code, signal): on a SIGNAL termination `code` is null and `signal` is e.g.
  // 'SIGTERM'/'SIGSEGV'. `code || 0` therefore turned every crash and every kill into exit 0, so an
  // MCP host saw a server that had died as one that had shut down cleanly.
  //
  // The shell convention for a signal death is 128 + signum, which keeps the cause visible in the
  // exit status instead of flattening it to a bare 1. An unknown signal name still exits non-zero.
  onExit = (code, signal) => {
    if (signal) {
      process.stderr.write(`playwright-mcp terminated by signal ${signal}\n`);
      // `return` is not redundant: `process.exit` is injectable/stubbable in tests, and without it
      // the clean-exit line below also runs and reports 0 — the very outcome this guards against.
      process.exit(128 + (os.constants.signals[signal] || 0));
      return;
    }
    process.exit(code || 0);
  },
  onError = (err) => {
    // `spawn` emits 'error' (not 'exit') when npx itself can't be launched
    // (ENOENT, EACCES, ...). Without a handler Node throws the error as an
    // uncaught exception; surface it and exit non-zero so the MCP host sees the
    // server failed to start.
    process.stderr.write(`Failed to launch Playwright MCP server: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  },
} = {}) {
  let child;
  try {
    child = spawnFn('npx', buildMcpArgs(browser), { stdio: 'inherit' });
  } catch (err) {
    // npx is not on PATH, or the config path cannot reach the npx shim unchanged.
    onError(err);
    return null;
  }

  child.on('exit', onExit);
  child.on('error', onError);
  return child;
}

if (require.main === module) {
  launch();
}

module.exports = { buildMcpArgs, launch };
