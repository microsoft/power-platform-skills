#!/usr/bin/env node

// Launches the Playwright MCP server with the best available browser.
// Detects system-installed Chromium-based browsers in preference order,
// then falls back to Playwright's bundled Chromium.
// Self-contained — no external dependencies required.

const { spawn } = require('child_process');
const path = require('path');
const { detectBrowser } = require('./lib/detect-browser');

function quoteShellArg(value, platform = process.platform) {
  const argument = String(value);

  if (platform === 'win32') {
    if (argument.includes('"')) {
      throw new Error('Cannot quote an argument containing double quotes for cmd.exe.');
    }

    return `"${argument}"`;
  }

  return `'${argument.replace(/'/g, "'\\''")}'`;
}

function buildMcpArgs(browser, {
  configPath = path.join(__dirname, 'playwright-mcp-fullscreen.config.json'),
  platform = process.platform,
} = {}) {
  return [
    '-y',
    '@playwright/mcp@latest',
    '--browser',
    browser,
    '--config',
    quoteShellArg(configPath, platform),
  ];
}

function launch({ browser = detectBrowser(), spawnFn = spawn, onExit = (code) => process.exit(code || 0) } = {}) {
  const child = spawnFn('npx', buildMcpArgs(browser), {
    stdio: 'inherit',
    shell: true,
  });

  child.on('exit', onExit);
  return child;
}

if (require.main === module) {
  launch();
}

module.exports = { buildMcpArgs, launch, quoteShellArg };
