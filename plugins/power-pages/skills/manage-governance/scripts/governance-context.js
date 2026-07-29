#!/usr/bin/env node

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const {
  resolveContext,
} = require('../../../scripts/lib/power-platform-api');
const {
  getAuthToken,
} = require('../../../scripts/lib/validation-helpers');
const {
  resolveTipConfig,
} = require('./tip-auth');

// ---------------------------------------------------------------------------
// Central ring registry — the single source of truth for "which endpoint + how
// to get its token". Add/point a ring in ONE place and both the gateway host
// and the token-acquisition path fall out of the same lookup. A single flag
// (resolveRing) selects the active entry.
//
//   host          gateway base host for the ring.
//   hostEnv       optional per-ring env var to override `host` (a sub-ring).
//   tokenStrategy how to mint the bearer for this ring:
//                   'device-code' → custom public-client app via tip-auth.js.
//                       This is the ONLY strategy that yields the PowerPages
//                       delegated scopes (PowerPages.Websites.Read/Write). The
//                       az CLI first-party client is NOT authorized for them,
//                       so it 403s (InsufficientDelegatedPermissions).
//                   'az'          → az account get-access-token against the
//                       ring host's resource (works for prod, where the
//                       signed-in cloud token is already scoped).
//
// NOTE the TIP host is api.preprod.powerplatform.com — `api.tip.powerplatform.com`
// does NOT resolve in DNS and is NOT the Preprod gateway (verified 2026-07).
// ---------------------------------------------------------------------------
const RINGS = Object.freeze({
  TIP: Object.freeze({
    label: 'TIP',
    host: 'https://api.preprod.powerplatform.com',
    hostEnv: 'PP_GOV_TIP_HOST',
    tokenStrategy: 'device-code',
  }),
  Prod: Object.freeze({
    label: 'Prod',
    host: 'https://api.powerplatform.com',
    hostEnv: null,
    tokenStrategy: 'az',
  }),
});

// TIP/Preprod is the DEFAULT ring for this skill (the team targets Preprod
// first); Prod is the opt-out. Kept as named exports for back-compat.
const TIP_GATEWAY_HOST = RINGS.TIP.host;
const PROD_GATEWAY_HOST = RINGS.Prod.host;

// dotnet-style truthy spellings (mirrors the *_OPTOUT convention used elsewhere
// in this repo) so PP_GOV_PROD=1/true/yes/on all flip to the prod ring.
function isTruthyFlag(v) {
  if (v == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

// THE central flag. Resolve which ring key ('TIP' | 'Prod') is active.
// Precedence:
//   1. PP_GOV_RING explicit ('prod'/'production' | 'tip'/'preprod')
//   2. PP_GOV_PROD truthy -> Prod
//   3. default -> TIP
function resolveRing(env) {
  const e = env || process.env;
  const explicit = (e.PP_GOV_RING || '').trim().toLowerCase();
  if (explicit) {
    if (explicit.startsWith('prod')) return 'Prod';
    if (explicit === 'tip' || explicit === 'preprod') return 'TIP';
  }
  if (isTruthyFlag(e.PP_GOV_PROD)) return 'Prod';
  return 'TIP';
}

// Effective gateway host for the active ring. Explicit PP_GOV_API_HOST always
// wins (pin an arbitrary host); otherwise the ring's `host` (or its per-ring
// `hostEnv` override) decides. For Prod we prefer the host resolveContext
// already computed from the signed-in cloud (gov clouds etc.), falling back to
// the registry host.
function resolveHostOverride(env, prodApiHost) {
  const e = env || process.env;
  if (e.PP_GOV_API_HOST && e.PP_GOV_API_HOST.trim()) {
    return e.PP_GOV_API_HOST.trim().replace(/\/+$/, '');
  }
  const ring = RINGS[resolveRing(e)];
  // Prod: honor the signed-in cloud host (could be a gov cloud) over the
  // registry default. TIP: the registry host is authoritative.
  if (ring.label === 'Prod' && prodApiHost) {
    return prodApiHost.replace(/\/+$/, '');
  }
  const perRingOverride = ring.hostEnv ? e[ring.hostEnv] : null;
  return (perRingOverride || ring.host).trim().replace(/\/+$/, '');
}

// Rewrite ONLY the scheme+authority of the env-scoped base URL, preserving the
// /powerpages/environments/{envId} path.
function applyHostOverride(ctx, host) {
  const clean = host.replace(/\/+$/, '');
  ctx.baseUrl = ctx.baseUrl.replace(/^https?:\/\/[^/]+/, clean);
  ctx.apiHost = clean;
  return ctx;
}

function applyEnvOverride(context, envId) {
  if (!envId || typeof envId !== 'string') return context;
  context.baseUrl = context.baseUrl.replace(
    /\/environments\/[^/]+/,
    `/environments/${encodeURIComponent(envId)}`
  );
  context.environmentId = envId;
  return context;
}

// Build the AAD token *resource* (audience) for a gateway host. The Power
// Platform API resource principal is the host with a single trailing slash,
// e.g. `https://api.preprod.powerplatform.com/` — az returns
// `aud=https://api.preprod.powerplatform.com/` for that value and the Preprod
// gateway rejects (401) a token minted for the prod audience.
function resourceForHost(host) {
  return host.replace(/\/+$/, '') + '/';
}

// Synchronously obtain a TIP token via the device-code helper. The governance
// call path is synchronous (resolveGovernanceContext returns a plain object), so
// we run the async device-code/refresh flow in a child process and capture its
// stdout. stderr is inherited so the one-time "open this URL / enter this code"
// prompt reaches the operator live; a cached/refreshable token returns instantly
// with no prompt. Returns null on any failure so the caller can fall back.
function getTipTokenSync(env) {
  const cfg = resolveTipConfig(env);
  if (cfg.error) return null;
  try {
    const out = execSync(`node "${path.join(__dirname, 'tip-auth.js')}"`, {
      encoding: 'utf8',
      // stdin ignored, stdout captured (the token), stderr inherited (prompt).
      stdio: ['ignore', 'pipe', 'inherit'],
      // Device-code sign-in can take a while; allow the full device-code lifetime.
      timeout: 15 * 60 * 1000,
      env,
    });
    const token = (out || '').trim();
    return token || null;
  } catch {
    return null;
  }
}

function resolveGovernanceContext(envId, env) {
  const e = env || process.env;
  const ctx = resolveContext();
  if (ctx.error) return ctx;

  // ONE flag → ring → { host, tokenStrategy }. Host is rewritten onto the
  // env-scoped base URL (scheme+authority only) before the request goes out.
  const ringKey = resolveRing(e);
  const ring = RINGS[ringKey];
  const host = resolveHostOverride(e, ctx.apiHost);
  const hostChanged = host !== (ctx.apiHost || '').replace(/\/+$/, '');
  if (hostChanged) applyHostOverride(ctx, host);

  // Token resolution, driven by the SAME ring lookup:
  //   1. PP_GOV_TOKEN — explicit bearer always wins (paste a portal/ring token).
  //   2. tokenStrategy 'device-code' — custom-app token via tip-auth.js, the
  //      ONLY token carrying the PowerPages delegated scopes.
  //   3. tokenStrategy 'az' — az mint against the (possibly overridden) host's
  //      resource; skipped when the host is unchanged since resolveContext()
  //      already minted the right prod token.
  if (e.PP_GOV_TOKEN && e.PP_GOV_TOKEN.trim()) {
    ctx.token = e.PP_GOV_TOKEN.trim();
  } else if (ring.tokenStrategy === 'device-code') {
    const tipToken = getTipTokenSync(e);
    if (tipToken) {
      ctx.token = tipToken;
    } else {
      // No custom-app config (or the flow failed). Fall back to an az mint for
      // the ring resource so reads that don't need PowerPages scopes still work,
      // and tell the operator how to unblock scoped writes.
      const fallback = getAuthToken(tokenResourceFor(e, host));
      if (fallback) ctx.token = fallback;
      process.stderr.write(
        `${ring.label} ring uses device-code auth but no token was generated. Set ` +
        'PP_GOV_TIP_CLIENT_ID + PP_GOV_TIP_TENANT (a custom app with ' +
        'PowerPages.Websites.Read/Write) or paste a scoped token via PP_GOV_TOKEN. ' +
        'Falling back to an az-minted token, which lacks PowerPages scopes and will ' +
        '403 on governance calls.\n'
      );
    }
  } else if (hostChanged) {
    // 'az' strategy with an overridden host — re-mint for that host's resource
    // since resolveContext() minted against the default cloud resource.
    const hostToken = getAuthToken(tokenResourceFor(e, host));
    if (hostToken) ctx.token = hostToken;
  }

  return applyEnvOverride(ctx, envId);
}

// The AAD token resource (audience) to mint against. PP_GOV_TOKEN_RESOURCE lets
// advanced callers override the audience when it differs from the host.
function tokenResourceFor(env, host) {
  const e = env || process.env;
  return e.PP_GOV_TOKEN_RESOURCE ? e.PP_GOV_TOKEN_RESOURCE.trim() : resourceForHost(host);
}

module.exports = {
  resolveGovernanceContext,
  applyEnvOverride,
  applyHostOverride,
  resolveHostOverride,
  resolveRing,
  resourceForHost,
  tokenResourceFor,
  isTruthyFlag,
  getTipTokenSync,
  RINGS,
  TIP_GATEWAY_HOST,
  PROD_GATEWAY_HOST,
};
