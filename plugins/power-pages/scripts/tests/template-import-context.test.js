'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTemplateImportContext } = require('../lib/template-import-context');

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
