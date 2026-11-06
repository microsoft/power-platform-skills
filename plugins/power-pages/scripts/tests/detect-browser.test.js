'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectBrowserLaunchOptions,
  whichPath,
} = require('../lib/detect-browser');

test('whichPath uses a fixed executable and keeps the candidate in argv', () => {
  const calls = [];
  const result = whichPath('chromium;not-shell-syntax', (...args) => {
    calls.push(args);
    return '/usr/bin/chromium\n';
  });

  assert.equal(result, '/usr/bin/chromium');
  assert.deepEqual(calls, [[
    'which',
    ['chromium;not-shell-syntax'],
    { encoding: 'utf8', shell: false },
  ]]);
});

test('whichPath returns null when executable lookup fails', () => {
  const result = whichPath('chromium', () => {
    throw new Error('not found');
  });

  assert.equal(result, null);
});

test('Linux launch options use the installed distro Chromium path', () => {
  const requestedPaths = [];
  const result = detectBrowserLaunchOptions({
    platform: 'linux',
    whichExists: () => false,
    whichPath: (command) => {
      requestedPaths.push(command);
      return command === 'chromium' ? '/usr/bin/chromium' : null;
    },
  });

  assert.deepEqual(requestedPaths, ['chromium-browser', 'chromium']);
  assert.deepEqual(result, { executablePath: '/usr/bin/chromium' });
});

test('Linux launch options fall back when no system browser exists', () => {
  const result = detectBrowserLaunchOptions({
    platform: 'linux',
    whichExists: () => false,
    whichPath: () => null,
  });

  assert.deepEqual(result, {});
});
