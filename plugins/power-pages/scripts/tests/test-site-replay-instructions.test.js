'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const skill = fs.readFileSync(path.join(__dirname, '../../skills/test-site/SKILL.md'), 'utf8');
const section = skill.slice(skill.indexOf('#### 5.3b Inspect Server Logic Response Shapes'));
const code = /```javascript\s*([\s\S]*?)```/.exec(section)[1];
const origin = 'https://contoso.powerappsportals.com';

function replay({
  token = 'local-fixture-csrf',
  tokenStatus = 200,
  tokenHtml = null,
  url = `${origin}/_api/serverlogics/example`,
} = {}) {
  const calls = [];
  const window = { location: { origin } };
  const fetch = async (requestUrl, options) => {
    calls.push({ requestUrl, options });
    if (requestUrl === `${origin}/_layout/tokenhtml`) {
      return {
        status: tokenStatus,
        text: async () => tokenHtml === null
          ? `<input name="__RequestVerificationToken" type="hidden" value="${token}" />`
          : tokenHtml,
      };
    }
    return {
      status: 200,
      text: async () => JSON.stringify({
        success: true,
        data: JSON.stringify({ Body: JSON.stringify({ items: [{ id: 'fixture' }] }) }),
      }),
    };
  };
  const serializedUrl = JSON.stringify(url);
  const fn = vm.runInNewContext(`(${code.replace('<serialized-observed-url>', serializedUrl)})`, {
    window, fetch, URL, Promise, Error, JSON, Object, Array,
  });
  return { execute: fn, calls };
}

test('test-site read-only replay uses authenticated same-origin GET with an in-memory verification token', async () => {
  const probe = replay();
  const result = await probe.execute();
  assert.equal(probe.calls.length, 2);
  assert.equal(probe.calls[0].requestUrl, `${origin}/_layout/tokenhtml`);
  assert.equal(probe.calls[0].options.credentials, 'include');
  assert.equal(probe.calls[0].options.redirect, 'error');
  assert.equal(probe.calls[0].options.headers.Accept, 'text/html');
  assert.equal(probe.calls[1].options.credentials, 'include');
  assert.equal(probe.calls[1].options.redirect, 'error');
  assert.equal(probe.calls[1].options.headers.__RequestVerificationToken, 'local-fixture-csrf');
  assert.equal(probe.calls[1].options.method, undefined);
  assert.equal(probe.calls[1].options.body, undefined);
  assert.equal(result.levels.length, 3);
  assert.equal(result.levels[1].parsedFrom, 'data');
  assert.equal(result.levels[2].parsedFrom, 'Body');
  assert.ok(!JSON.stringify(result).includes('local-fixture-csrf'));
});

test('test-site safely serializes observed URLs containing quotes and backslashes', async () => {
  const observedUrl = `${origin}/_api/serverlogics/example?$filter=name eq 'O\\Reilly'`;
  const probe = replay({ url: observedUrl });
  await probe.execute();
  assert.equal(probe.calls.length, 2);
  assert.equal(probe.calls[1].requestUrl, new URL(observedUrl).href);
});

test('test-site cannot replay off-origin requests or redirects carrying credentials', async () => {
  const probe = replay({ url: 'https://example.org/_api/serverlogics/example' });
  await assert.rejects(probe.execute(), /authenticated site/);
  assert.equal(probe.calls.length, 0);
});

test('test-site reports unavailable verification-token endpoints as blocked instead of unauthenticated replay', async () => {
  const probe = replay({ tokenStatus: 404 });
  await assert.rejects(probe.execute(), /replay is blocked/);
  assert.equal(probe.calls.length, 1);
});

test('test-site rejects empty or malformed verification tokens before requesting', async () => {
  for (const tokenHtml of [
    '',
    '<input name="__RequestVerificationToken" type="hidden" />',
    '<input name="__RequestVerificationToken" type="hidden" value="" />',
    '<input name="__RequestVerificationToken" type="hidden" value=" " />',
  ]) {
    const probe = replay({ tokenHtml });
    await assert.rejects(probe.execute(), /verification token is unavailable/);
    assert.equal(probe.calls.length, 1);
  }
});
