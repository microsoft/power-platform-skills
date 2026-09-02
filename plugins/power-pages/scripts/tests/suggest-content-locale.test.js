'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FALLBACK_LOCALE,
  readableLanguage,
  suggestContentLocale,
} = require('../suggest-content-locale');

function odataSequence(responses, calls = []) {
  return async (url, token, request) => {
    calls.push({ url, token, request });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
}

test('suggests the Dataverse organization base language', async () => {
  const calls = [];
  const request = () => {};
  const result = await suggestContentLocale({
    getEnvironmentUrl: () => 'https://contoso.crm.dynamics.com',
    getAuthToken: (resourceUrl) => {
      assert.equal(resourceUrl, 'https://contoso.crm.dynamics.com');
      return 'token';
    },
    makeRequest: request,
    odataGet: odataSequence([
      { value: [{ languagecode: 1036 }] },
      {
        value: [{
          localeid: 1036,
          code: 'fr-FR',
          language: 'French',
          name: 'French (France)',
        }],
      },
    ], calls),
  });

  assert.deepEqual(result, {
    locale: 'fr-FR',
    language: 'French (France)',
    direction: 'ltr',
    lcid: 1036,
    source: 'dataverse',
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /organizations\?\$select=languagecode&\$top=1$/);
  assert.match(calls[1].url, /languagelocale.*\$filter=localeid eq 1036/);
  assert.equal(calls[0].token, 'token');
  assert.equal(calls[0].request, request);
});

test('resolves the direction of an RTL Dataverse language', async () => {
  const result = await suggestContentLocale({
    getEnvironmentUrl: () => 'https://contoso.crm.dynamics.com',
    getAuthToken: () => 'token',
    odataGet: odataSequence([
      { value: [{ languagecode: 1025 }] },
      { value: [{ localeid: 1025, code: 'ar-SA', name: 'Arabic (Saudi Arabia)' }] },
    ]),
  });

  assert.equal(result.locale, 'ar-SA');
  assert.equal(result.direction, 'rtl');
  assert.equal(result.source, 'dataverse');
});

test('uses the locale tag when Dataverse omits a readable language name', () => {
  assert.equal(readableLanguage({ code: 'ja-JP' }, 'ja-JP'), 'ja-JP');
});

for (const [scenario, dependencies] of [
  ['no selected environment', {
    getEnvironmentUrl: () => null,
  }],
  ['no Azure CLI token', {
    getEnvironmentUrl: () => 'https://contoso.crm.dynamics.com',
    getAuthToken: () => null,
  }],
  ['organization query failure', {
    getEnvironmentUrl: () => 'https://contoso.crm.dynamics.com',
    getAuthToken: () => 'token',
    odataGet: odataSequence([new Error('HTTP 401')]),
  }],
  ['missing organization language code', {
    getEnvironmentUrl: () => 'https://contoso.crm.dynamics.com',
    getAuthToken: () => 'token',
    odataGet: odataSequence([{ value: [{}] }]),
  }],
  ['unmapped organization language code', {
    getEnvironmentUrl: () => 'https://contoso.crm.dynamics.com',
    getAuthToken: () => 'token',
    odataGet: odataSequence([
      { value: [{ languagecode: 99999 }] },
      { value: [] },
    ]),
  }],
  ['invalid mapped language tag', {
    getEnvironmentUrl: () => 'https://contoso.crm.dynamics.com',
    getAuthToken: () => 'token',
    odataGet: odataSequence([
      { value: [{ languagecode: 99999 }] },
      { value: [{ code: 'not_a_locale', name: 'Invalid' }] },
    ]),
  }],
]) {
  test(`silently falls back to en-US when there is ${scenario}`, async () => {
    assert.deepEqual(await suggestContentLocale(dependencies), FALLBACK_LOCALE);
  });
}
