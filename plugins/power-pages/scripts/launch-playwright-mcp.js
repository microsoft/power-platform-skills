#!/usr/bin/env node

// Launches the Playwright MCP server with the best available browser.
// Detects system-installed Chromium-based browsers in preference order,
// then falls back to Playwright's bundled Chromium.
// Self-contained — no external dependencies required.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('path');
const { detectBrowser } = require('./lib/detect-browser');

const PLAYWRIGHT_MCP_VERSION = '0.0.78';
const PLAYWRIGHT_MCP_PACKAGE = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;

function buildMcpArgs(browser, {
  configPath = path.join(__dirname, 'playwright-mcp-fullscreen.config.json'),
} = {}) {
  // Marketplace installs copy only this plugin directory and do not run npm install,
  // so a lockfile would not materialize a local executable. Keep the runtime package
  // immutable, and disable lifecycle scripts while npx prepares the reviewed version.
  return [
    '--yes',
    '--ignore-scripts',
    `--package=${PLAYWRIGHT_MCP_PACKAGE}`,
    'playwright-mcp',
    '--browser',
    browser,
    '--config',
    configPath,
  ];
}

function resolveNpxCli({
  execPath = process.execPath,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  // Windows exposes npx as a .cmd shim that cannot run with shell:false. Invoking
  // npm's JavaScript entrypoint through Node preserves raw argv on every platform.
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const nodeDir = pathApi.dirname(execPath);
  const candidates = [
    pathApi.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    pathApi.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));

  if (!match) {
    throw new Error(
      'Could not locate npm/bin/npx-cli.js beside the current Node installation. Install Node.js with npm before starting the Playwright MCP server.',
    );
  }

  return match;
}

function launch({
  browser = detectBrowser(),
  npxCliPath,
  resolveNpxCliFn = resolveNpxCli,
  spawnFn = spawn,
  exitFn = (code) => process.exit(code),
  writeError = (message) => process.stderr.write(message),
} = {}) {
  let resolvedNpxCliPath = npxCliPath;
  if (resolvedNpxCliPath === undefined) {
    try {
      resolvedNpxCliPath = resolveNpxCliFn();
    } catch (error) {
      writeError(`Failed to start Playwright MCP: ${error.message}\n`);
      exitFn(1);
      return null;
    }
  }

  const child = spawnFn(process.execPath, [resolvedNpxCliPath, ...buildMcpArgs(browser)], {
    stdio: 'inherit',
    shell: false,
  });

  child.once('error', (error) => {
    writeError(`Failed to start Playwright MCP: ${error.message}\n`);
    exitFn(1);
  });
  child.once('exit', (code) => exitFn(code ?? 1));
  return child;
}

if (require.main === module) {
  launch();
}

module.exports = {
  PLAYWRIGHT_MCP_PACKAGE,
  buildMcpArgs,
  launch,
  resolveNpxCli,
};
