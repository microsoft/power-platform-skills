'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const modulePath = require.resolve('../../../skills/manage-governance/scripts/tip-auth');
const {
  buildScope,
  resolveTipConfig,
  decodeJwtExp,
  isTokenFresh,
  cachePath,
  DEFAULT_TIP_HOST,
  DEFAULT_TIP_CLIENT_ID,
  DEFAULT_TIP_TENANT,
} = require(modulePath);

function fakeJwt(exp) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ exp })}.sig`;
}

const now = () => Math.floor(Date.now() / 1000);
const cfgEnv = { PP_GOV_TIP_CLIENT_ID: 'c', PP_GOV_TIP_TENANT: 't' };
const cachedToken = (exp = now() + 3600) => ({
  clientId: 'c',
  host: DEFAULT_TIP_HOST,
  accessToken: fakeJwt(exp),
  refreshToken: 'rt',
});

// Load the real module with in-memory storage and queued HTTPS responses.
// No test may read/delete an operator's token cache or contact the real login
// endpoint, including when a fixture misses the cached-token fast path.
function authHarness({ cache, responses = [], readError = false, writeError = false } = {}) {
  const requests = [];
  const writes = [];
  const prompts = [];
  const waits = [];
  let stored = cache == null ? null : JSON.stringify(cache);
  const realRequire = createRequire(modulePath);
  const mockedFs = {
    readFileSync() {
      if (readError || stored === null) throw new Error('cache unavailable');
      return stored;
    },
    writeFileSync(file, data, options) {
      if (writeError) throw new Error('cache not writable');
      stored = data;
      writes.push({ file, data: JSON.parse(data), options });
    },
  };
  const mockedHttps = {
    request(url, options, onResponse) {
      const response = responses[requests.length];
      assert.ok(response, `Unexpected HTTPS request: ${url}`);
      const req = new EventEmitter();
      let body = '';
      req.write = (chunk) => { body += chunk; };
      req.end = () => {
        requests.push({ url, options, form: Object.fromEntries(new URLSearchParams(body)) });
        queueMicrotask(() => {
          if (response.error) {
            req.emit('error', new Error(response.error));
            return;
          }
          const res = new EventEmitter();
          res.statusCode = response.statusCode;
          onResponse(res);
          res.emit('data', JSON.stringify(response.body));
          res.emit('end');
        });
      };
      return req;
    },
  };
  const sandbox = {
    module: { exports: {} },
    require: (name) => name === 'fs' ? mockedFs : name === 'https' ? mockedHttps : realRequire(name),
    Buffer,
    process: { stderr: { write: (text) => prompts.push(text) } },
    setTimeout(callback, ms) {
      waits.push(ms);
      queueMicrotask(callback);
    },
  };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox, { filename: modulePath });
  return { getTipToken: sandbox.module.exports.getTipToken, requests, writes, prompts, waits };
}

test('buildScope resource-qualifies both PP scopes + offline_access', () => {
  assert.equal(
    buildScope(DEFAULT_TIP_HOST),
    `${DEFAULT_TIP_HOST}/PowerPages.Websites.Read ${DEFAULT_TIP_HOST}/PowerPages.Websites.Write offline_access`,
  );
});

test('buildScope strips a trailing slash before qualifying scopes', () => {
  assert.equal(buildScope(`${DEFAULT_TIP_HOST}/`), buildScope(DEFAULT_TIP_HOST));
});

test('resolveTipConfig defaults to the shipped app id and organizations tenant', () => {
  const cfg = resolveTipConfig({});
  assert.equal(cfg.clientId, DEFAULT_TIP_CLIENT_ID);
  assert.equal(cfg.tenantId, DEFAULT_TIP_TENANT);
  assert.equal(cfg.host, DEFAULT_TIP_HOST);
});

test('resolveTipConfig honors app, tenant, and host overrides', () => {
  const cfg = resolveTipConfig({
    PP_GOV_TIP_CLIENT_ID: ' abc ',
    PP_GOV_TIP_TENANT: ' tid ',
    PP_GOV_TIP_HOST: 'https://api.custom.powerplatform.com/',
  });
  assert.equal(cfg.clientId, 'abc');
  assert.equal(cfg.tenantId, 'tid');
  assert.equal(cfg.host, 'https://api.custom.powerplatform.com');
});

test('decodeJwtExp extracts expiry and rejects malformed tokens', () => {
  assert.equal(decodeJwtExp(fakeJwt(1790000000)), 1790000000);
  for (const value of ['not-a-jwt', '', null, 'a.invalid.sig']) {
    assert.equal(decodeJwtExp(value), null);
  }
});

test('isTokenFresh accounts for expiry skew', () => {
  assert.equal(isTokenFresh(fakeJwt(now() + 3600), 300), true);
  assert.equal(isTokenFresh(fakeJwt(now() + 100), 300), false);
  assert.equal(isTokenFresh(fakeJwt(now() - 10), 300), false);
  assert.equal(isTokenFresh('garbage', 300), false);
});

test('cachePath lives in the OS temp dir', () => {
  assert.ok(cachePath().startsWith(os.tmpdir()));
  assert.ok(cachePath().endsWith('pp-gov-tip-token.json'));
});

test('getTipToken reuses a fresh matching cached token without HTTPS or writes', async () => {
  const cache = cachedToken();
  const h = authHarness({ cache });
  assert.equal(await h.getTipToken(cfgEnv), cache.accessToken);
  assert.equal(h.requests.length, 0);
  assert.equal(h.writes.length, 0);
});

test('getTipToken refreshes an expired token and persists the rotated refresh token', async () => {
  const h = authHarness({
    cache: cachedToken(now() - 10),
    responses: [{ statusCode: 200, body: { access_token: 'refreshed', refresh_token: 'rt2' } }],
  });
  assert.equal(await h.getTipToken(cfgEnv), 'refreshed');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].form.grant_type, 'refresh_token');
  assert.equal(h.requests[0].form.refresh_token, 'rt');
  assert.equal(h.requests[0].form.client_id, 'c');
  assert.equal(h.requests[0].form.scope, buildScope(DEFAULT_TIP_HOST));
  assert.equal(h.writes[0].data.refreshToken, 'rt2');
  assert.equal(h.writes[0].options.mode, 0o600);
});

test('getTipToken preserves the prior refresh token when no replacement is returned', async () => {
  const h = authHarness({
    cache: cachedToken(now() - 10),
    responses: [{ statusCode: 200, body: { access_token: 'refreshed' } }],
  });
  assert.equal(await h.getTipToken(cfgEnv), 'refreshed');
  assert.equal(h.writes[0].data.refreshToken, 'rt');
});

const deviceResponse = {
  statusCode: 200,
  body: { device_code: 'device-code', message: 'Test sign-in prompt', expires_in: 60, interval: 5 },
};
const tokenResponse = { statusCode: 200, body: { access_token: 'signed-in', refresh_token: 'newrt' } };

test('getTipToken falls back to mocked device-code sign-in after refresh rejection', async () => {
  const h = authHarness({
    cache: cachedToken(now() - 10),
    responses: [
      { statusCode: 400, body: { error: 'invalid_grant' } },
      deviceResponse,
      tokenResponse,
    ],
  });
  assert.equal(await h.getTipToken(cfgEnv), 'signed-in');
  assert.equal(h.requests.length, 3);
  assert.match(h.requests[1].url, /\/t\/oauth2\/v2\.0\/devicecode$/);
  assert.equal(h.requests[2].form.device_code, 'device-code');
  assert.equal(h.writes[0].data.refreshToken, 'newrt');
  assert.match(h.prompts.join(''), /Test sign-in prompt/);
});

test('getTipToken ignores a fresh cache for a different client or host', async () => {
  for (const mismatch of [{ clientId: 'other' }, { host: 'https://other.example' }]) {
    const h = authHarness({
      cache: { ...cachedToken(), ...mismatch },
      responses: [deviceResponse, tokenResponse],
    });
    assert.equal(await h.getTipToken(cfgEnv), 'signed-in');
    assert.match(h.requests[0].url, /\/devicecode$/);
  }
});

test('getTipToken handles a missing or unreadable cache with mocked sign-in', async () => {
  const h = authHarness({ readError: true, responses: [deviceResponse, tokenResponse] });
  assert.equal(await h.getTipToken(cfgEnv), 'signed-in');
  assert.equal(h.requests.length, 2);
});

test('device-code polling honors pending and slow_down responses', async () => {
  const h = authHarness({
    responses: [
      deviceResponse,
      { statusCode: 400, body: { error: 'authorization_pending' } },
      { statusCode: 400, body: { error: 'slow_down' } },
      tokenResponse,
    ],
  });
  assert.equal(await h.getTipToken(cfgEnv), 'signed-in');
  assert.deepEqual(h.waits, [5000, 5000, 10000]);
});

test('device-code rejection and network errors propagate without cache writes', async () => {
  for (const responses of [
    [{ statusCode: 400, body: { error: 'invalid_client' } }],
    [deviceResponse, { statusCode: 400, body: { error: 'access_denied' } }],
    [{ error: 'offline' }],
  ]) {
    const h = authHarness({ responses });
    await assert.rejects(() => h.getTipToken(cfgEnv), /invalid_client|access_denied|offline/);
    assert.equal(h.writes.length, 0);
  }
});

test('cache write failure does not discard a successfully acquired token', async () => {
  const h = authHarness({ writeError: true, responses: [deviceResponse, tokenResponse] });
  assert.equal(await h.getTipToken(cfgEnv), 'signed-in');
});
