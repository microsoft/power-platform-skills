#!/usr/bin/env node

// Launches the Playwright MCP server with the best available browser.
// Detects system-installed Chromium-based browsers in preference order,
// then falls back to Playwright's bundled Chromium.
// Self-contained — no external dependencies required.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { detectBrowser } = require('./lib/detect-browser');

function buildMcpArgs(browser, {
  configPath = path.join(__dirname, 'playwright-mcp-fullscreen.config.json'),
} = {}) {
  return [
    '--yes',
    '--ignore-scripts',
    '--package=@playwright/mcp@0.0.78',
    'playwright-mcp',
    '--browser',
    browser,
    '--config',
    configPath,
  ];
}

function resolveNpxCli(execPath = process.execPath) {
  // Invoke npm's JavaScript entry point through the current Node executable.
  // This avoids a command shell on Windows, where the public `npx` shim is a
  // .cmd file, while still supporting standard Node, nvm, Homebrew, and Volta
  // layouts.
  const nodeDir = path.dirname(execPath);
  const candidates = [
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(
      'Could not locate npm/bin/npx-cli.js beside the current Node installation. Install Node.js with npm before starting the Playwright MCP server.',
    );
  }
  return match;
}

function launch({
  browser = detectBrowser(),
  npxCliPath = resolveNpxCli(),
  spawnFn = spawn,
  onExit = (code) => process.exit(code || 0),
} = {}) {
  const child = spawnFn(process.execPath, [npxCliPath, ...buildMcpArgs(browser)], {
    stdio: 'inherit',
    shell: false,
  });

  child.on('exit', onExit);
  return child;
}

if (require.main === module) {
  launch();
}

module.exports = { buildMcpArgs, launch, resolveNpxCli };
