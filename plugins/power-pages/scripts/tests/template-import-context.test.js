'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTemplateImportContext } = require('../lib/template-import-context');
const { parseArgs, capturePagesListVerbose } = require('../capture-pages-list');

test('resolveTemplateImportContext returns environment URL and token from shared helpers', () => {
  assert.deepEqual(resolveTemplateImportContext({
    getEnvironmentUrl: () => 'https://org.crm.dynamics.com',
    getAuthToken: (resource) => `token-for-${resource}`,
  }), {
    ok: true,
    environmentUrl: 'https://org.crm.dynamics.com',
    token: 'token-for-https://org.crm.dynamics.com',
  });
});

test('resolveTemplateImportContext reports missing PAC auth or Azure token', () => {
  assert.equal(resolveTemplateImportContext({ getEnvironmentUrl: () => null }).ok, false);
  assert.deepEqual(resolveTemplateImportContext({
    getEnvironmentUrl: () => 'https://org.crm.dynamics.com',
    getAuthToken: () => null,
  }), {
    ok: false,
    environmentUrl: 'https://org.crm.dynamics.com',
    error: 'Azure CLI token unavailable. Run `az login` first.',
  });
});

test('capturePagesListVerbose writes injected pac pages output', () => {
  const writes = [];
  assert.deepEqual(capturePagesListVerbose({ output: '/tmp/pages.txt' }, {
    execFileSync: (cmd, args) => {
      assert.equal(cmd, 'pac');
      assert.deepEqual(args, ['pages', 'list', '-v']);
      return 'pages output';
    },
    fs: { writeFileSync: (...args) => writes.push(args) },
  }), { ok: true, output: '/tmp/pages.txt' });
  assert.deepEqual(writes, [['/tmp/pages.txt', 'pages output', 'utf8']]);
});

test('capture-pages-list parseArgs and missing-output behavior', () => {
  assert.deepEqual(parseArgs(['--output', '/tmp/pages.txt']), { output: '/tmp/pages.txt' });
  assert.deepEqual(capturePagesListVerbose({}), { ok: false, error: 'Usage: capture-pages-list.js --output <file>' });
});
