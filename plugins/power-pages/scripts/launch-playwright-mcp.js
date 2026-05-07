#!/usr/bin/env node

// Launches the Playwright MCP server with the best available browser.
// Detects system-installed Chromium-based browsers in preference order,
// then falls back to Playwright's bundled Chromium.
// Generates a temp config that sizes the browser window and viewport to
// the user's actual screen (instead of Playwright's 1280x720 default) so
// the rendered page fills the window without empty/black gutters.
// Self-contained — no external dependencies required.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectBrowser } = require('./lib/detect-browser');
const { detectScreenSize } = require('./lib/detect-screen');

// Approximate vertical space taken by Chrome's tab strip + address bar so the
// rendered viewport doesn't overflow the visible page area. Conservative — a
// small empty strip is preferable to a scrollbar.
const CHROME_VERTICAL_OFFSET = 120;

function buildConfig({ width, height }) {
  const viewportHeight = Math.max(600, height - CHROME_VERTICAL_OFFSET);
  return {
    browser: {
      launchOptions: {
        args: [
          '--window-position=0,0',
          `--window-size=${width},${height}`,
          // Suppress the "unsupported command-line flag" infobar that otherwise
          // eats vertical space on every run.
          '--test-type',
        ],
      },
      contextOptions: {
        viewport: { width, height: viewportHeight },
        colorScheme: 'light',
      },
    },
  };
}

function writeTempConfig(config, { tmpdir = os.tmpdir(), writeFn = fs.writeFileSync } = {}) {
  const file = path.join(tmpdir, `powerpages-playwright-mcp-${process.pid}-${Date.now()}.json`);
  writeFn(file, JSON.stringify(config, null, 2), 'utf8');
  return file;
}

function buildMcpArgs(browser, configPath) {
  return [
    '@playwright/mcp@latest',
    '--browser',
    browser,
    '--config',
    configPath,
  ];
}

function launch({
  browser = detectBrowser(),
  screen = detectScreenSize(),
  spawnFn = spawn,
  writeFn = fs.writeFileSync,
  unlinkFn = fs.unlinkSync,
  tmpdir = os.tmpdir(),
  onExit = (code) => process.exit(code || 0),
} = {}) {
  const config = buildConfig(screen);
  const configPath = writeTempConfig(config, { tmpdir, writeFn });

  const child = spawnFn('npx', buildMcpArgs(browser, configPath), {
    stdio: 'inherit',
    shell: true,
  });

  child.on('exit', (code) => {
    try {
      unlinkFn(configPath);
    } catch {
      // best-effort cleanup; OS will clear tmp eventually
    }
    onExit(code);
  });

  return child;
}

if (require.main === module) {
  launch();
}

module.exports = { buildConfig, buildMcpArgs, writeTempConfig, launch, CHROME_VERTICAL_OFFSET };

