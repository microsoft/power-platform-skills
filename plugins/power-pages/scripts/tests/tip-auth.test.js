'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');

const {
  buildScope,
  resolveTipConfig,
  decodeJwtExp,
  isTokenFresh,
  isTruthyFlag,
  cachePath,
  writeCache,
  readCache,
  lockPath,
  acquireLockOnce,
  releaseLock,
  getTipToken,
  SignInRequiredError,
  SIGNIN_REQUIRED_MARKER,
  DEFAULT_TIP_HOST,
  DEFAULT_TIP_CLIENT_ID,
  DEFAULT_TIP_TENANT,
  LOCK_STALE_MS,
} = require('../../skills/manage-governance/scripts/tip-auth');

const fs = require('fs');

// Build a JWT whose payload carries the given exp (seconds since epoch). Only
// the payload segment is meaningful here — decodeJwtExp never verifies the sig.
function fakeJwt(exp) {
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'none' })}.${b64url({ exp })}.sig`;
}

test('buildScope resource-qualifies both PP scopes + offline_access', () => {
  assert.equal(
    buildScope('https://api.preprod.powerplatform.com'),
    'https://api.preprod.powerplatform.com/PowerPages.Websites.Read ' +
      'https://api.preprod.powerplatform.com/PowerPages.Websites.Write offline_access'
  );
});

test('buildScope strips a trailing slash off the host before qualifying', () => {
  assert.equal(
    buildScope('https://api.preprod.powerplatform.com/'),
    'https://api.preprod.powerplatform.com/PowerPages.Websites.Read ' +
      'https://api.preprod.powerplatform.com/PowerPages.Websites.Write offline_access'
  );
});

test('resolveTipConfig defaults to the shipped app id + organizations tenant', () => {
  const cfg = resolveTipConfig({});
  assert.equal(cfg.error, undefined);
  assert.equal(cfg.clientId, DEFAULT_TIP_CLIENT_ID);
  assert.equal(cfg.tenantId, DEFAULT_TIP_TENANT);
  assert.equal(cfg.host, DEFAULT_TIP_HOST);
});

test('resolveTipConfig lets env vars override the app id and tenant', () => {
  const cfg = resolveTipConfig({ PP_GOV_TIP_CLIENT_ID: 'abc', PP_GOV_TIP_TENANT: 'tid' });
  assert.equal(cfg.error, undefined);
  assert.equal(cfg.clientId, 'abc');
  assert.equal(cfg.tenantId, 'tid');
  assert.equal(cfg.host, DEFAULT_TIP_HOST);
});

test('resolveTipConfig honors PP_GOV_TIP_HOST and strips trailing slash', () => {
  const cfg = resolveTipConfig({
    PP_GOV_TIP_CLIENT_ID: 'abc',
    PP_GOV_TIP_TENANT: 'tid',
    PP_GOV_TIP_HOST: 'https://api.custom.powerplatform.com/',
  });
  assert.equal(cfg.host, 'https://api.custom.powerplatform.com');
});

test('decodeJwtExp extracts exp from a well-formed token, null otherwise', () => {
  assert.equal(decodeJwtExp(fakeJwt(1790000000)), 1790000000);
  assert.equal(decodeJwtExp('not-a-jwt'), null);
  assert.equal(decodeJwtExp(''), null);
  assert.equal(decodeJwtExp(null), null);
});

test('isTokenFresh is true for a future exp beyond the skew, false when expiring', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isTokenFresh(fakeJwt(now + 3600), 300), true);
  // Within the 300s skew window -> treated as not fresh (needs renewal).
  assert.equal(isTokenFresh(fakeJwt(now + 100), 300), false);
  assert.equal(isTokenFresh(fakeJwt(now - 10), 300), false);
  assert.equal(isTokenFresh('garbage', 300), false);
});

test('cachePath lives in the OS temp dir', () => {
  assert.ok(cachePath().startsWith(os.tmpdir()));
  assert.ok(cachePath().endsWith('pp-gov-tip-token.json'));
});

// --- Concurrency / expiry hardening (single-flight lock, atomic write,
//     non-interactive fast-fail) ---------------------------------------------

const now = () => Math.floor(Date.now() / 1000);
// A cache object whose access token is fresh well beyond the skew window.
const freshCache = () => ({
  clientId: 'c',
  host: DEFAULT_TIP_HOST,
  accessToken: fakeJwt(now() + 3600),
  refreshToken: 'rt',
});
// clientId+host match what resolveTipConfig({PP_GOV_TIP_CLIENT_ID:'c'}) yields.
const cfgEnv = { PP_GOV_TIP_CLIENT_ID: 'c', PP_GOV_TIP_TENANT: 't' };

// Ensure lock/cache files from a prior run don't leak between tests.
function cleanupFiles() {
  try { fs.rmSync(cachePath(), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(lockPath(), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(`${cachePath()}.${process.pid}.tmp`, { force: true }); } catch { /* ignore */ }
}

test('writeCache publishes atomically and leaves no temp file behind', () => {
  cleanupFiles();
  writeCache({ clientId: 'c', host: DEFAULT_TIP_HOST, accessToken: 'a', refreshToken: 'r' });
  const back = readCache();
  assert.equal(back.accessToken, 'a');
  assert.equal(back.refreshToken, 'r');
  // The pid temp file used during the rename dance must be gone.
  assert.equal(fs.existsSync(`${cachePath()}.${process.pid}.tmp`), false);
  cleanupFiles();
});

test('acquireLockOnce is exclusive, releasable, and steals a stale lock', () => {
  cleanupFiles();
  assert.equal(acquireLockOnce(), true, 'first acquire wins');
  assert.equal(acquireLockOnce(), false, 'second acquire blocked while held');
  releaseLock();
  assert.equal(acquireLockOnce(), true, 'reacquire after release');
  // A far-future clock makes the just-written lock look older than LOCK_STALE_MS,
  // so a waiter may steal it (the previous owner is presumed dead).
  const future = () => Date.now() + LOCK_STALE_MS + 5000;
  assert.equal(acquireLockOnce(future), true, 'stale lock is stolen');
  cleanupFiles();
});

test('getTipToken returns a fresh cached token without lock or network', async () => {
  let deviceCalled = 0;
  let refreshCalled = 0;
  let lockCalled = 0;
  const token = await getTipToken(cfgEnv, {
    readCache: () => freshCache(),
    acquireLock: () => { lockCalled += 1; return true; },
    releaseLock: () => {},
    tryRefresh: async () => { refreshCalled += 1; return null; },
    deviceCode: async () => { deviceCalled += 1; return { access_token: 'x' }; },
  });
  assert.ok(isTokenFresh(token));
  assert.equal(deviceCalled, 0, 'no device-code on a hot cache');
  assert.equal(refreshCalled, 0, 'no refresh on a hot cache');
  assert.equal(lockCalled, 0, 'hot path never takes the lock');
});

test('getTipToken silently refreshes an expired-but-refreshable token', async () => {
  let deviceCalled = 0;
  const written = [];
  const token = await getTipToken(cfgEnv, {
    // stale access token but a usable refresh token
    readCache: () => ({ clientId: 'c', host: DEFAULT_TIP_HOST, accessToken: fakeJwt(now() - 10), refreshToken: 'rt' }),
    writeCache: (o) => written.push(o),
    acquireLock: () => true,
    releaseLock: () => {},
    tryRefresh: async () => ({ access_token: 'refreshed', refresh_token: 'rt2' }),
    deviceCode: async () => { deviceCalled += 1; return { access_token: 'x' }; },
  });
  assert.equal(token, 'refreshed');
  assert.equal(deviceCalled, 0, 'refresh path must not fall through to device-code');
  assert.equal(written[0].refreshToken, 'rt2', 'rotated refresh token is persisted');
});

test('getTipToken fast-fails (SignInRequired) when non-interactive and refresh fails', async () => {
  let deviceCalled = 0;
  let released = 0;
  await assert.rejects(
    () =>
      getTipToken(cfgEnv, {
        nonInteractive: true,
        readCache: () => ({ clientId: 'c', host: DEFAULT_TIP_HOST, accessToken: fakeJwt(now() - 10), refreshToken: 'dead' }),
        writeCache: () => {},
        acquireLock: () => true,
        releaseLock: () => { released += 1; },
        tryRefresh: async () => null, // RT expired/revoked
        deviceCode: async () => { deviceCalled += 1; return { access_token: 'x' }; },
      }),
    (err) => {
      assert.ok(err instanceof SignInRequiredError);
      assert.equal(err.code, 'SIGNIN_REQUIRED');
      assert.ok(err.message.includes(SIGNIN_REQUIRED_MARKER));
      return true;
    }
  );
  assert.equal(deviceCalled, 0, 'non-interactive must never launch device-code');
  assert.equal(released, 1, 'the single-flight lock is released even on fast-fail');
});

test('getTipToken runs device-code interactively when refresh fails and interactive', async () => {
  let deviceCalled = 0;
  const written = [];
  const token = await getTipToken(cfgEnv, {
    nonInteractive: false,
    readCache: () => ({ clientId: 'c', host: DEFAULT_TIP_HOST, accessToken: fakeJwt(now() - 10), refreshToken: 'dead' }),
    writeCache: (o) => written.push(o),
    acquireLock: () => true,
    releaseLock: () => {},
    tryRefresh: async () => null,
    deviceCode: async () => { deviceCalled += 1; return { access_token: 'signed-in', refresh_token: 'newrt' }; },
  });
  assert.equal(token, 'signed-in');
  assert.equal(deviceCalled, 1);
  assert.equal(written[0].refreshToken, 'newrt');
});

test('getTipToken waits on the single-flight lock and reuses the winner\'s token', async () => {
  let deviceCalled = 0;
  let refreshCalled = 0;
  let poll = 0;
  // First read (hot-path probe) misses; once another process "mints", the cache
  // is fresh, so the waiter reuses it without ever taking the lock itself.
  const readCache = () => (poll++ === 0
    ? { clientId: 'c', host: DEFAULT_TIP_HOST, accessToken: fakeJwt(now() - 10), refreshToken: 'rt' }
    : freshCache());
  const token = await getTipToken(cfgEnv, {
    readCache,
    acquireLock: () => false, // someone else holds it
    releaseLock: () => {},
    sleep: async () => {},
    tryRefresh: async () => { refreshCalled += 1; return null; },
    deviceCode: async () => { deviceCalled += 1; return { access_token: 'x' }; },
  });
  assert.ok(isTokenFresh(token), 'reused the freshly-cached token');
  assert.equal(deviceCalled, 0, 'waiter must not launch its own device-code');
  assert.equal(refreshCalled, 0, 'waiter must not refresh — it reuses the cache');
});

test('isTruthyFlag recognizes dotnet-style truthy spellings', () => {
  for (const v of ['1', 'true', 'YES', ' on ', 'True']) assert.equal(isTruthyFlag(v), true, v);
  for (const v of ['0', 'false', '', null, undefined, 'nope']) assert.equal(isTruthyFlag(v), false, String(v));
});
