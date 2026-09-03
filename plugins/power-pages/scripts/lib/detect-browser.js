#!/usr/bin/env node

// Detects the best available Chromium-based browser on the system.
// Returns either the legacy Playwright channel name or launch options. Linux
// distro Chromium needs its executable path; channel "chromium" would instead
// select Playwright's separately downloaded browser.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function whichExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function whichPath(cmd) {
  try {
    return execSync(`which ${cmd}`, { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function detectBrowser() {
  const platform = os.platform();

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.PROGRAMFILES || '';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || '';

    // Edge — pre-installed on all Windows 10/11 machines
    const edgePaths = [
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    for (const p of edgePaths) {
      if (exists(p)) return 'msedge';
    }

    // Chrome
    const chromePaths = [
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const p of chromePaths) {
      if (exists(p)) return 'chrome';
    }
  } else if (platform === 'darwin') {
    // macOS
    if (exists('/Applications/Google Chrome.app')) return 'chrome';
    if (exists('/Applications/Microsoft Edge.app')) return 'msedge';
  } else {
    // Linux
    if (whichExists('google-chrome')) return 'chrome';
    if (whichExists('google-chrome-stable')) return 'chrome';
    if (whichExists('microsoft-edge')) return 'msedge';
    if (whichExists('microsoft-edge-stable')) return 'msedge';
    if (whichExists('chromium-browser')) return 'chromium';
    if (whichExists('chromium')) return 'chromium';
  }

  // Fallback: Playwright's bundled Chromium (requires `npx playwright install chromium`)
  return 'chromium';
}

function detectBrowserLaunchOptions() {
  const platform = os.platform();
  if (platform === 'linux') {
    for (const command of ['google-chrome', 'google-chrome-stable']) {
      if (whichExists(command)) return { channel: 'chrome' };
    }
    for (const command of ['microsoft-edge', 'microsoft-edge-stable']) {
      if (whichExists(command)) return { channel: 'msedge' };
    }
    for (const command of ['chromium-browser', 'chromium']) {
      const executablePath = whichPath(command);
      if (executablePath) return { executablePath };
    }
    return {};
  }
  const channel = detectBrowser();
  return channel === 'chromium' ? {} : { channel };
}

module.exports = {
  detectBrowser,
  detectBrowserLaunchOptions,
};
