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

function replay({ token = 'local-fixture-csrf', shell = true, url = `${origin}/_api/serverlogics/example` } = {}) {
  const calls = [];
  const window = {
    location: { origin },
    shell: shell ? {
      getTokenDeferred: () => ({
        done(resolve) {
          resolve(token);
          return { fail() {} };
        },
      }),
    } : undefined,
  };
  const fetch = async (requestUrl, options) => {
    calls.push({ requestUrl, options });
    return {
      status: 200,
      text: async () => JSON.stringify({
        success: true,
        data: JSON.stringify({ Body: JSON.stringify({ items: [{ id: 'fixture' }] }) }),
      }),
    };
  };
  const fn = vm.runInNewContext(`(${code.replace('<observed-url>', url)})`, {
    window, fetch, URL, Promise, Error, JSON, Object, Array,
  });
  return { execute: fn, calls };
}

test('test-site read-only replay uses authenticated same-origin GET with an in-memory verification token', async () => {
  const probe = replay();
  const result = await probe.execute();
  assert.equal(probe.calls.length, 1);
  assert.equal(probe.calls[0].options.credentials, 'include');
  assert.equal(probe.calls[0].options.redirect, 'error');
  assert.equal(probe.calls[0].options.headers.__RequestVerificationToken, 'local-fixture-csrf');
  assert.equal(probe.calls[0].options.method, undefined);
  assert.equal(probe.calls[0].options.body, undefined);
  assert.equal(result.levels.length, 3);
  assert.equal(result.levels[1].parsedFrom, 'data');
  assert.equal(result.levels[2].parsedFrom, 'Body');
  assert.ok(!JSON.stringify(result).includes('local-fixture-csrf'));
});

test('test-site cannot replay off-origin requests or redirects carrying credentials', async () => {
  const probe = replay({ url: 'https://example.org/_api/serverlogics/example' });
  await assert.rejects(probe.execute(), /authenticated site/);
  assert.equal(probe.calls.length, 0);
});

test('test-site reports unavailable verification-token APIs as blocked instead of unauthenticated replay', async () => {
  const probe = replay({ shell: false });
  await assert.rejects(probe.execute(), /replay is blocked/);
  assert.equal(probe.calls.length, 0);
});

test('test-site rejects empty or malformed verification tokens before requesting', async () => {
  for (const token of ['', ' ', null, 123]) {
    const probe = replay({ token });
    await assert.rejects(probe.execute(), /verification token is unavailable/);
    assert.equal(probe.calls.length, 0);
  }
});
