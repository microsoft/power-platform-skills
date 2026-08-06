'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const modulePath = path.join(__dirname, '..', 'lib', 'detect-browser.js');

function withDetectedBrowser({ platform, existing = [], which = [], existsThrows = [] }) {
  const originalLoad = Module._load;
  const originalEnv = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PROGRAMFILES: process.env.PROGRAMFILES,
    PROGRAMFILES_X86: process.env['PROGRAMFILES(X86)'],
  };
  const checkedPaths = [];
  const whichCalls = [];
  const existingSet = new Set(existing);
  const whichSet = new Set(which);
  const throwSet = new Set(existsThrows);

  process.env.LOCALAPPDATA = 'C:\\Users\\Maker\\AppData\\Local';
  process.env.PROGRAMFILES = 'C:\\Program Files';
  process.env['PROGRAMFILES(X86)'] = 'C:\\Program Files (x86)';

  try {
    delete require.cache[require.resolve(modulePath)];
    Module._load = function loadWithBrowserStubs(request, parent, isMain) {
      if (request === 'os') return { platform: () => platform };
      if (request === 'fs') {
        return {
          existsSync(filePath) {
            checkedPaths.push(filePath);
            if (throwSet.has(filePath)) throw new Error('filesystem probe failed');
            return existingSet.has(filePath);
          },
        };
      }
      if (request === 'child_process') {
        return {
          execFileSync(command, args, options) {
            whichCalls.push({ command, args, options });
            if (whichSet.has(args[0])) return '';
            throw new Error(`${args[0]} not found`);
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const { detectBrowser } = require(modulePath);
    return { browser: detectBrowser(), checkedPaths, whichCalls };
  } finally {
    Module._load = originalLoad;
    if (originalEnv.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalEnv.LOCALAPPDATA;
    if (originalEnv.PROGRAMFILES === undefined) delete process.env.PROGRAMFILES;
    else process.env.PROGRAMFILES = originalEnv.PROGRAMFILES;
    if (originalEnv.PROGRAMFILES_X86 === undefined) delete process.env['PROGRAMFILES(X86)'];
    else process.env['PROGRAMFILES(X86)'] = originalEnv.PROGRAMFILES_X86;
    delete require.cache[require.resolve(modulePath)];
  }
}

test('Windows prefers preinstalled Edge before Chrome when both browsers exist', () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Users\\Maker\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

  const result = withDetectedBrowser({ platform: 'win32', existing: [edge, chrome] });

  assert.equal(result.browser, 'msedge');
  assert.deepEqual(result.checkedPaths, [edge]);
});

test('Windows falls through to Chrome when no Edge install path exists', () => {
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const result = withDetectedBrowser({ platform: 'win32', existing: [chrome] });

  assert.equal(result.browser, 'chrome');
  assert.ok(result.checkedPaths.includes(chrome));
});

test('filesystem probe failures are treated the same as a missing browser path', () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const result = withDetectedBrowser({
    platform: 'win32',
    existing: [chrome],
    existsThrows: [edge],
  });

  assert.equal(result.browser, 'chrome');
});

test('macOS chooses Chrome before Edge to match the app bundle probing order', () => {
  const result = withDetectedBrowser({
    platform: 'darwin',
    existing: ['/Applications/Google Chrome.app', '/Applications/Microsoft Edge.app'],
  });

  assert.equal(result.browser, 'chrome');
  assert.deepEqual(result.checkedPaths, ['/Applications/Google Chrome.app']);
});

test('Linux probes fixed browser command names without invoking a shell', () => {
  const result = withDetectedBrowser({ platform: 'linux', which: ['microsoft-edge'] });

  assert.equal(result.browser, 'msedge');
  assert.deepEqual(result.whichCalls.map((c) => c.args[0]), ['google-chrome', 'google-chrome-stable', 'microsoft-edge']);
  assert.ok(result.whichCalls.every((c) => c.command === 'which'));
  assert.ok(result.whichCalls.every((c) => !Object.hasOwn(c.options, 'shell')));
});

test('Linux falls back to Playwright Chromium after every system browser probe fails', () => {
  const result = withDetectedBrowser({ platform: 'linux' });

  assert.equal(result.browser, 'chromium');
  assert.deepEqual(result.whichCalls.map((c) => c.args[0]), [
    'google-chrome',
    'google-chrome-stable',
    'microsoft-edge',
    'microsoft-edge-stable',
    'chromium-browser',
    'chromium',
  ]);
});
