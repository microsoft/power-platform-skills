'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkAvailableLanguages,
  main,
  parseArgs,
} = require('../check-available-languages');

test('checkAvailableLanguages allows template import when required template languages are enabled', async () => {
  const result = await checkAvailableLanguages({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'token',
    requiredLocaleIds: [1033, 1036],
    request: async (options) => {
      assert.equal(options.url, 'https://org.crm.dynamics.com/api/data/v9.2/RetrieveAvailableLanguages');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer token');
      return { statusCode: 200, body: JSON.stringify({ LocaleIds: [1033, 1036] }) };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    hasRequiredLanguages: true,
    requiredLocaleIds: [1033, 1036],
    missingLocaleIds: [],
    localeIds: [1033, 1036],
  });
});

test('checkAvailableLanguages blocks template import when any template language is missing', async () => {
  const result = await checkAvailableLanguages({
    envUrl: 'https://org.crm.dynamics.com/',
    token: 'token',
    requiredLocaleIds: [1033, 1041],
    request: async () => ({ statusCode: 200, body: JSON.stringify({ LocaleIds: [1036, 1041] }) }),
  });

  assert.deepEqual(result, {
    ok: true,
    hasRequiredLanguages: false,
    requiredLocaleIds: [1033, 1041],
    missingLocaleIds: [1033],
    localeIds: [1036, 1041],
  });
});

test('checkAvailableLanguages defaults to en-US for older callers', async () => {
  const result = await checkAvailableLanguages({
    envUrl: 'https://org.crm.dynamics.com/',
    token: 'token',
    request: async () => ({ statusCode: 200, body: JSON.stringify({ LocaleIds: [1033] }) }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.hasRequiredLanguages, true);
  assert.deepEqual(result.requiredLocaleIds, [1033]);
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

test('checkAvailableLanguages rejects untrusted environment URLs before acquiring a token', async () => {
  let tokenCalls = 0;
  const result = await checkAvailableLanguages({
    envUrl: 'https://attacker.invalid',
    requiredLocaleIds: [1033],
    resolveToken: () => {
      tokenCalls += 1;
      return 'token';
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /not an allowed Microsoft Dataverse/);
  assert.equal(tokenCalls, 0);
});

test('parseArgs reads environment and locale arguments without accepting a bearer token', () => {
  assert.deepEqual(parseArgs(['--envUrl', 'https://org.crm.dynamics.com/', '--requiredLocaleIds', '1033,1041']), {
    envUrl: 'https://org.crm.dynamics.com/',
    requiredLocaleIds: [1033, 1041],
  });
});

test('main uses the drain-safe JSON runner instead of forcing process exit', async () => {
  const output = [];
  const proc = {};

  await main({
    argv: ['--envUrl', 'https://org.crm.dynamics.com', '--requiredLocaleIds', '1033'],
    checkOptions: {
      token: 'token',
      request: async () => ({ statusCode: 200, body: JSON.stringify({ LocaleIds: [1033] }) }),
    },
    process: proc,
    stdout: {
      write(value) {
        output.push(value);
      },
    },
  });

  assert.equal(proc.exitCode, 0);
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).hasRequiredLanguages, true);
});
