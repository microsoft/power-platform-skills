'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkAvailableLanguages,
  parseArgs,
} = require('../check-available-languages');

test('checkAvailableLanguages allows template import when en-US is enabled', async () => {
  const result = await checkAvailableLanguages({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'token',
    request: async (options) => {
      assert.equal(options.url, 'https://org.crm.dynamics.com/api/data/v9.2/RetrieveAvailableLanguages');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer token');
      return { statusCode: 200, body: JSON.stringify({ LocaleIds: [1033, 1036] }) };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    hasEnUs: true,
    requiredLocaleId: 1033,
    localeIds: [1033, 1036],
  });
});

test('checkAvailableLanguages blocks template import when en-US is missing', async () => {
  const result = await checkAvailableLanguages({
    envUrl: 'https://org.crm.dynamics.com/',
    token: 'token',
    request: async () => ({ statusCode: 200, body: JSON.stringify({ LocaleIds: [1036, 1041] }) }),
  });

  assert.deepEqual(result, {
    ok: true,
    hasEnUs: false,
    requiredLocaleId: 1033,
    localeIds: [1036, 1041],
  });
});

test('checkAvailableLanguages reports malformed language responses', async () => {
  const result = await checkAvailableLanguages({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'token',
    request: async () => ({ statusCode: 200, body: JSON.stringify({ value: [1033] }) }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /LocaleIds/);
});

test('checkAvailableLanguages reports request failures', async () => {
  const result = await checkAvailableLanguages({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'token',
    request: async () => ({ error: 'network down' }),
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'RetrieveAvailableLanguages request failed: network down',
  });
});

test('parseArgs reads env URL and token arguments', () => {
  assert.deepEqual(parseArgs(['--envUrl', 'https://org.crm.dynamics.com/', '--token', 'abc']), {
    envUrl: 'https://org.crm.dynamics.com/',
    token: 'abc',
  });
});
