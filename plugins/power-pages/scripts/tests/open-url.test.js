'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openInDefaultBrowser } = require('../lib/default-browser');
const { parseArgs, openUrl } = require('../open-url');

test('openInDefaultBrowser uses platform-specific opener commands', () => {
  const calls = [];
  const execFileSync = (...args) => calls.push(args);

  openInDefaultBrowser('https://example.test', { os: { platform: () => 'darwin' }, execFileSync });
  openInDefaultBrowser('https://example.test', { os: { platform: () => 'win32' }, execFileSync });
  openInDefaultBrowser('https://example.test', { os: { platform: () => 'linux' }, execFileSync });

  assert.deepEqual(calls, [
    ['open', ['https://example.test'], { stdio: 'ignore' }],
    ['cmd', ['/c', 'start', '', 'https://example.test'], { stdio: 'ignore', windowsHide: true }],
    ['xdg-open', ['https://example.test'], { stdio: 'ignore' }],
  ]);
});

test('openUrl validates URL shape and reports opener failures without throwing', () => {
  assert.deepEqual(parseArgs(['--url', 'https://example.test']), { url: 'https://example.test' });
  assert.deepEqual(openUrl({ url: 'ftp://example.test' }), { ok: false, error: 'Usage: open-url.js --url <http(s)-url>' });
  assert.deepEqual(openUrl({ url: 'https://example.test' }, {
    os: { platform: () => 'linux' },
    execFileSync: () => { throw new Error('no browser'); },
  }), { ok: false, url: 'https://example.test', error: 'no browser' });
});
