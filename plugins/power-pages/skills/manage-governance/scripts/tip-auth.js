#!/usr/bin/env node

// tip-auth.js — Acquires a DELEGATED Power Platform API access token for the
// TIP/Preprod ring using a CUSTOM public-client app via the OAuth 2.0
// device-code flow, with silent refresh-token renewal between runs.
//
// WHY this exists (and why we can't just use `az account get-access-token`):
// The governance gateway requires the delegated scopes
// `PowerPages.Websites.Read` / `PowerPages.Websites.Write`. The Azure CLI
// first-party client (04b07795-8ddb-461a-bbee-02f9e1bf7b46) is NOT preauthorized
// for those scopes and CANNOT be granted them (it's Microsoft-owned; the API
// owner controls preauthorization), so an az-minted token 403s with
// InsufficientDelegatedPermissions. A tenant-registered public-client app CAN
// hold those delegated scopes, but az can't mint for an arbitrary client id —
// hence this standalone device-code implementation.
//
// Device-code flow reference:
// https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
//
// Output contract: prints ONLY the access token to stdout (so callers can
// `execSync` and capture it verbatim); all human-facing prompts go to stderr.
//
// Config (all from env, so the skill stays generic — no app id is hard-coded):
//   PP_GOV_TIP_CLIENT_ID  (required) public-client app id with the PP scopes
//   PP_GOV_TIP_TENANT     (required) tenant id (or 'organizations'/'common')
//   PP_GOV_TIP_HOST       (optional) gateway host; default api.preprod...

'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URLSearchParams } = require('url');

const AUTHORITY = 'https://login.microsoftonline.com';
const DEFAULT_TIP_HOST = 'https://api.preprod.powerplatform.com';
// Default public-client app id for the TIP device-code flow: "pp-governance-cli"
// (registered with delegated PowerPages.Websites.Read/Write on the Preprod Power
// Platform API resource). A client id is a PUBLIC identifier, not a secret, so it
// is safe to ship as a default — the flow still requires an interactive user
// sign-in, and no client secret is involved. Override with PP_GOV_TIP_CLIENT_ID
// to point at a different registration.
const DEFAULT_TIP_CLIENT_ID = 'c5ae9f06-f0bb-4ef6-9ee4-c7a3803da37a';
// Default authority tenant. `organizations` lets any work/school account complete
// the sign-in (the app is single-tenant, so AAD still scopes consent to the
// registering tenant). Override with PP_GOV_TIP_TENANT to pin a specific tenant.
const DEFAULT_TIP_TENANT = 'organizations';
// Refresh when the cached token is within this many seconds of expiry so a
// long-running set-governance poll never dies mid-flight on an expired bearer.
const EXPIRY_SKEW_SECONDS = 300;

// Delegated scopes the governance gateway demands. offline_access asks AAD for a
// refresh token so subsequent runs renew silently without another browser
// sign-in. Scopes are resource-qualified (host + '/' + scope) per the v2
// endpoint contract, e.g. `https://api.preprod.powerplatform.com/PowerPages.Websites.Read`.
function buildScope(host) {
  const h = String(host || '').replace(/\/+$/, '');
  return `${h}/PowerPages.Websites.Read ${h}/PowerPages.Websites.Write offline_access`;
}

function resolveTipConfig(env) {
  const e = env || process.env;
  // Client id and tenant default to the shipped pp-governance-cli app and the
  // `organizations` authority, so the TIP flow works out-of-the-box with no
  // env vars. Both remain overridable for a different app/tenant.
  const clientId = (e.PP_GOV_TIP_CLIENT_ID || '').trim() || DEFAULT_TIP_CLIENT_ID;
  const tenantId = (e.PP_GOV_TIP_TENANT || '').trim() || DEFAULT_TIP_TENANT;
  const host = (e.PP_GOV_TIP_HOST || DEFAULT_TIP_HOST).trim().replace(/\/+$/, '');
  return { clientId, tenantId, host };
}

// Decode the `exp` (seconds since epoch) from a JWT WITHOUT verifying the
// signature — we only need the expiry to decide whether to reuse the cache.
// A JWT is header.payload.signature; the payload is the middle base64url
// segment. base64url uses '-'/'_' instead of '+'/'/' and drops '=' padding, so
// restore both before decoding. Example payload JSON: {"aud":"...","exp":1790000000,...}
function decodeJwtExp(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (p.length % 4) p += '=';
  try {
    const claims = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}

function isTokenFresh(token, skewSeconds = EXPIRY_SKEW_SECONDS) {
  const exp = decodeJwtExp(token);
  if (!exp) return false;
  return exp > Math.floor(Date.now() / 1000) + skewSeconds;
}

// Single cache file in the OS temp dir. The filename is fixed but the contents
// are validated against clientId+host on read, so switching app/ring forces a
// fresh sign-in rather than replaying a token minted for the wrong app/audience.
function cachePath() {
  return path.join(os.tmpdir(), 'pp-gov-tip-token.json');
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(obj) {
  try {
    // mode 0o600: the file holds a refresh token (a long-lived credential), so
    // restrict it to the owner. Best-effort — a failure to persist must not
    // break auth, it just means the next run re-prompts.
    fs.writeFileSync(cachePath(), JSON.stringify(obj), { mode: 0o600 });
  } catch {
    /* ignore — cache is an optimization, not a requirement */
  }
}

function postForm(url, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* non-JSON error body — leave parsed null, raw carries the text */
          }
          resolve({ statusCode: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exchange a stored refresh token for a new access token. AAD ROTATES refresh
// tokens on redemption, so the caller must persist the returned refresh_token.
async function tryRefresh(cfg, refreshToken) {
  const res = await postForm(`${AUTHORITY}/${cfg.tenantId}/oauth2/v2.0/token`, {
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    refresh_token: refreshToken,
    scope: buildScope(cfg.host),
  });
  if (res.statusCode === 200 && res.body && res.body.access_token) return res.body;
  return null;
}

// Full interactive device-code flow: request a code, print the prompt, then
// poll the token endpoint until the user completes the browser sign-in.
async function deviceCode(cfg) {
  const dc = await postForm(`${AUTHORITY}/${cfg.tenantId}/oauth2/v2.0/devicecode`, {
    client_id: cfg.clientId,
    scope: buildScope(cfg.host),
  });
  if (dc.statusCode !== 200 || !dc.body || !dc.body.device_code) {
    throw new Error(`Device code request failed: ${dc.raw}`);
  }
  // The prompt MUST go to stderr — stdout is reserved for the token so the
  // parent process can capture it cleanly.
  process.stderr.write(`\n${dc.body.message}\n\n`);
  const deadline = Date.now() + Number(dc.body.expires_in) * 1000;
  let interval = Number(dc.body.interval || 5);
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const res = await postForm(`${AUTHORITY}/${cfg.tenantId}/oauth2/v2.0/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: cfg.clientId,
      device_code: dc.body.device_code,
    });
    if (res.statusCode === 200 && res.body && res.body.access_token) return res.body;
    const err = res.body && res.body.error;
    // Per the device-code spec, authorization_pending = keep polling, and
    // slow_down = AAD asks us to add 5s to the interval. Anything else
    // (expired_token, access_denied, ...) is terminal.
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      interval += 5;
      continue;
    }
    throw new Error(`Device-code auth failed: ${err || res.raw}`);
  }
  throw new Error('Timed out waiting for device-code sign-in.');
}

// Acquire a token, cheapest path first: (1) reuse a fresh cached access token,
// (2) silent refresh, (3) interactive device-code. Steps 1–2 require the cache
// to match the requested clientId+host.
async function getTipToken(env) {
  const cfg = resolveTipConfig(env);
  if (cfg.error) throw new Error(cfg.error);

  const cache = readCache();
  const cacheMatchesConfig =
    cache && cache.clientId === cfg.clientId && cache.host === cfg.host;

  if (cacheMatchesConfig && isTokenFresh(cache.accessToken)) {
    return cache.accessToken;
  }
  if (cacheMatchesConfig && cache.refreshToken) {
    const refreshed = await tryRefresh(cfg, cache.refreshToken);
    if (refreshed) {
      writeCache({
        clientId: cfg.clientId,
        host: cfg.host,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || cache.refreshToken,
      });
      return refreshed.access_token;
    }
    // Refresh failed (RT expired/revoked — delegated RTs die after ~90d of
    // inactivity). Fall through to an interactive sign-in.
  }
  const tok = await deviceCode(cfg);
  writeCache({
    clientId: cfg.clientId,
    host: cfg.host,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || null,
  });
  return tok.access_token;
}

async function main() {
  const token = await getTipToken(process.env);
  // Contract: ONLY the token on stdout so callers (governance-context.js) can
  // capture it verbatim via execSync.
  process.stdout.write(token);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`tip-auth: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildScope,
  resolveTipConfig,
  decodeJwtExp,
  isTokenFresh,
  cachePath,
  getTipToken,
  DEFAULT_TIP_HOST,
  DEFAULT_TIP_CLIENT_ID,
  DEFAULT_TIP_TENANT,
  EXPIRY_SKEW_SECONDS,
};
