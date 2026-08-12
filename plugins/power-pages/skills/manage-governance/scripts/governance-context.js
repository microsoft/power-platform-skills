#!/usr/bin/env node

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
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
// to get its token". The DATA defaults live in DEFAULT_RINGS below and can be
// overridden by the co-located app-settings.json (loaded inline — no separate
// config module). A single switch (resolveRing, app-settings.json > TIP)
// selects the active entry, and BOTH the governance gateway AND the
// env-list BAP path key off it.
//
//   gatewayHost     governance gateway base host (powerplatform.com API).
//   gatewayHostEnv  optional per-ring env var overriding gatewayHost (sub-ring).
//   tokenStrategy   how to mint the gateway bearer:
//                     'device-code' → custom public-client app via tip-auth.js.
//                         The ONLY strategy that yields the PowerPages delegated
//                         scopes (PowerPages.Websites.Read/Write). The az CLI
//                         first-party client is NOT authorized for them, so it
//                         403s (InsufficientDelegatedPermissions).
//                     'az'          → az account get-access-token against the
//                         ring host's resource (prod, where the signed-in cloud
//                         token is already scoped).
//   bapStrategy     how the admin env list is fetched:
//                     'pac'  → `pac admin list --json` (follows PAC's signed-in
//                         cloud; correct for Prod).
//                     'rest' → direct GET to bapHost (correct for TIP, which
//                         `pac admin list` cannot reach without a Preprod sign-in).
//   bapHost         BAP host for the 'rest' strategy.
//   bapResource     az token audience for the BAP REST call.
//
// NOTE the TIP hosts are api.preprod.powerplatform.com / tip1.api.bap.microsoft
// .com — the `api.tip...` form does NOT resolve in DNS (verified 2026-07).
// ---------------------------------------------------------------------------
const DEFAULT_RINGS = Object.freeze({
  TIP: Object.freeze({
    label: 'TIP',
    gatewayHost: 'https://api.preprod.powerplatform.com',
    gatewayHostEnv: 'PP_GOV_TIP_HOST',
    tokenStrategy: 'device-code',
    bapStrategy: 'rest',
    bapHost: 'https://tip1.api.bap.microsoft.com',
    bapResource: 'https://service.powerapps.com/',
  }),
  Prod: Object.freeze({
    label: 'Prod',
    gatewayHost: 'https://api.powerplatform.com',
    gatewayHostEnv: null,
    tokenStrategy: 'az',
    bapStrategy: 'pac',
    bapHost: 'https://api.bap.microsoft.com',
    bapResource: 'https://service.powerapps.com/',
  }),
});

// The routing config file, co-located so a marketplace install (which copies
// only the plugin dir) always ships it beside the code.
const CONFIG_PATH = path.join(__dirname, 'app-settings.json');

function stripTrailingSlashes(s) {
  return String(s == null ? '' : s).trim().replace(/\/+$/, '');
}

// Memoize the parsed config for the process — app-settings.json is read-only
// routing config, so re-forking fs on every governance call is wasted work.
let cachedConfig;

// Load + normalize app-settings.json. Fail-open: a missing file, IO error, or
// invalid JSON all resolve to DEFAULT_RINGS rather than throwing — a governance
// call must never break because the config was deleted or fat-fingered.
// DEFAULT_RINGS remain the fail-open fallback when the file is absent/unusable.
function loadConfig(filePath) {
  if (!filePath && cachedConfig !== undefined) return cachedConfig;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(filePath || CONFIG_PATH, 'utf8'));
  } catch {
    raw = {};
  }
  const r = raw && typeof raw === 'object' ? raw : {};

  // activeRing: accept case-insensitive TIP/preprod/test and Prod/production;
  // ignore junk (→ null, so resolveRing falls through to its default).
  let activeRing = null;
  const ar = String(r.activeRing || '').trim().toLowerCase();
  if (ar === 'tip' || ar === 'preprod' || ar === 'test') activeRing = 'TIP';
  else if (ar.startsWith('prod')) activeRing = 'Prod';

  const targetEnv = typeof r.targetEnv === 'string' ? r.targetEnv.trim() : '';

  // Merge each file ring over its default. Accept legacy `host` as an alias for
  // `gatewayHost` so an older single-host config still routes the gateway.
  const rings = {};
  for (const key of Object.keys(DEFAULT_RINGS)) {
    const base = DEFAULT_RINGS[key];
    const over = (r.rings && typeof r.rings === 'object' && r.rings[key]) || {};
    rings[key] = Object.freeze({
      label: base.label,
      gatewayHost: stripTrailingSlashes(over.gatewayHost || over.host || base.gatewayHost),
      gatewayHostEnv: base.gatewayHostEnv,
      tokenStrategy: over.tokenStrategy || base.tokenStrategy,
      bapStrategy: over.bapStrategy || base.bapStrategy,
      bapHost: stripTrailingSlashes(over.bapHost || base.bapHost),
      bapResource: over.bapResource || base.bapResource,
    });
  }

  const cfg = Object.freeze({ activeRing, targetEnv, rings: Object.freeze(rings) });
  if (!filePath) cachedConfig = cfg;
  return cfg;
}

// Test-only seam: drop the process cache so a case can load a fresh fixture.
function resetConfigCache() {
  cachedConfig = undefined;
}

// Kept as a shared helper for existing callers/tests that still need the repo's
// standard truthy parsing semantics, even though ring selection no longer uses
// PP_GOV_PROD/PP_GOV_RING.
function isTruthyFlag(v) {
  if (v == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

// THE central switch. Resolve which ring key ('TIP' | 'Prod') is active.
// app-settings.json is the source of truth for ring selection. Runtime env vars
// may still override hosts/tokens inside the chosen ring, but they do not get to
// switch the ring away from the bundled config.
function resolveRing(env) {
  const cfg = loadConfig();
  if (cfg.activeRing && DEFAULT_RINGS[cfg.activeRing]) return cfg.activeRing;
  return 'TIP';
}

// The merged (defaults + app-settings.json overrides) ring object for the
// active (or a named) ring. This is the single lookup both the gateway and BAP
// paths use, so the same switch drives every endpoint.
function getRing(env, ringName) {
  const key = ringName || resolveRing(env);
  const cfg = loadConfig();
  return (cfg.rings && cfg.rings[key]) || DEFAULT_RINGS[key];
}

// Back-compat: a RINGS-shaped view (`.host` / `.hostEnv` / `.tokenStrategy`)
// built from DEFAULT_RINGS for callers/tests that read the old shape.
const RINGS = Object.freeze({
  TIP: Object.freeze({
    label: DEFAULT_RINGS.TIP.label,
    host: DEFAULT_RINGS.TIP.gatewayHost,
    hostEnv: DEFAULT_RINGS.TIP.gatewayHostEnv,
    tokenStrategy: DEFAULT_RINGS.TIP.tokenStrategy,
  }),
  Prod: Object.freeze({
    label: DEFAULT_RINGS.Prod.label,
    host: DEFAULT_RINGS.Prod.gatewayHost,
    hostEnv: DEFAULT_RINGS.Prod.gatewayHostEnv,
    tokenStrategy: DEFAULT_RINGS.Prod.tokenStrategy,
  }),
});

// TIP/Preprod is the DEFAULT ring for this skill (the team targets Preprod
// first); Prod is the opt-out. Kept as named exports for back-compat.
const TIP_GATEWAY_HOST = RINGS.TIP.host;
const PROD_GATEWAY_HOST = RINGS.Prod.host;

// Default target environment when a script gets no --envId. PP_GOV_ENV_ID wins
// over the file (env-vars-first precedence); returns null when neither is set so
// the caller falls back to the signed-in PAC env.
function resolveTargetEnv(env) {
  const e = env || process.env;
  const fromEnv = (e.PP_GOV_ENV_ID || '').trim();
  if (fromEnv) return fromEnv;
  return loadConfig().targetEnv || null;
}

// Effective gateway host for the active ring. Explicit PP_GOV_API_HOST always
// wins (pin an arbitrary host); otherwise the ring's gatewayHost (or its
// per-ring hostEnv override) decides. For Prod we prefer the host resolveContext
// already computed from the signed-in cloud (gov clouds etc.), falling back to
// the ring host.
function resolveHostOverride(env, prodApiHost) {
  const e = env || process.env;
  if (e.PP_GOV_API_HOST && e.PP_GOV_API_HOST.trim()) {
    return e.PP_GOV_API_HOST.trim().replace(/\/+$/, '');
  }
  const ring = getRing(e);
  // Prod: honor the signed-in cloud host (could be a gov cloud) over the
  // config default. TIP: the config host is authoritative.
  if (ring.label === 'Prod' && prodApiHost) {
    return prodApiHost.replace(/\/+$/, '');
  }
  const perRingOverride = ring.gatewayHostEnv ? e[ring.gatewayHostEnv] : null;
  return (perRingOverride || ring.gatewayHost).trim().replace(/\/+$/, '');
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

  // ONE switch → ring → { gatewayHost, tokenStrategy, ... }. Host is rewritten
  // onto the env-scoped base URL (scheme+authority only) before the request.
  const ring = getRing(e);
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

  // Default the environment from app-settings.json (targetEnv) / PP_GOV_ENV_ID
  // when the caller passed no explicit --envId, so a single config value can
  // pin the test env for the whole skill.
  const effectiveEnvId = envId || resolveTargetEnv(e);
  return applyEnvOverride(ctx, effectiveEnvId);
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
  getRing,
  loadConfig,
  resetConfigCache,
  resolveTargetEnv,
  resourceForHost,
  tokenResourceFor,
  isTruthyFlag,
  getTipTokenSync,
  DEFAULT_RINGS,
  CONFIG_PATH,
  RINGS,
  TIP_GATEWAY_HOST,
  PROD_GATEWAY_HOST,
};
