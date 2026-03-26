#!/usr/bin/env node

// Launches the Playwright MCP server with the best available browser.
// Detects system-installed Chromium-based browsers in preference order,
// then falls back to Playwright's bundled Chromium.
// Self-contained — no external dependencies required.

const { spawn } = require('child_process');
const { detectBrowser } = require('./lib/detect-browser');

const browser = detectBrowser();
const child = spawn('npx', ['@playwright/mcp@latest', '--browser', browser, '--window-size', '1024,768'], {
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => process.exit(code || 0));
