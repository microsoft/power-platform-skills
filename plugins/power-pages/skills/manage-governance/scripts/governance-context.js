#!/usr/bin/env node

// Skill-local helper. Wraps the shared resolveContext() so callers can override
// the environment id via --envId. The shared helper always reads the env from
// `pac auth who`; this skill needs to address any env the signed-in user has
// admin access to, so we patch the base URL after the shared resolution runs.

const {
  resolveContext,
} = require('../../../scripts/lib/power-platform-api');

function applyEnvOverride(context, envId) {
  if (!envId || typeof envId !== 'string') return context;
  // The base URL is built as `${apiHost}/powerpages/environments/${pac.environmentId}`.
  // Swap the env id segment; everything else (apiHost, token, tenantId) stays the same.
  context.baseUrl = context.baseUrl.replace(
    /\/environments\/[^/]+/,
    `/environments/${encodeURIComponent(envId)}`
  );
  context.environmentId = envId;
  return context;
}

/**
 * Resolves a Power Platform API context, optionally overriding the env id.
 *
 * @param {string} [envId] - GUID of the target env. When omitted, falls back to
 *                           the env the signed-in PAC profile is on.
 * @returns {object|{error:string}} The same shape as the shared resolveContext().
 */
function resolveGovernanceContext(envId) {
  const ctx = resolveContext();
  if (ctx.error) return ctx;
  // Token override: the Power Pages governance APIs require delegated scopes
  // (PowerPages.Websites.Read/Write) that the Azure CLI first-party app cannot
  // obtain (first-party->first-party consent needs API-owner preauthorization).
  // When PP_GOV_TOKEN is set — a bearer minted against a dedicated app
  // registration that HAS those scopes — use it instead of the az CLI token.
  if (process.env.PP_GOV_TOKEN) {
    ctx.token = process.env.PP_GOV_TOKEN.trim();
  }
  // Host override: pac.cloud only emits Public/Preprod/gov clouds — there is no
  // "Test" cloud key. To target a ring not in CLOUD_TO_API (e.g. the test ring
  // https://api.test.powerplatform.com) set PP_GOV_API_HOST to that origin.
  // We swap only the scheme+host of the base URL; the /powerpages/... path,
  // env id, tenant id and token are untouched. The token's audience MUST match
  // the overridden host or the ring will return 401 AuthorizationHeaderInvalid.
  if (process.env.PP_GOV_API_HOST) {
    const host = process.env.PP_GOV_API_HOST.trim().replace(/\/+$/, '');
    ctx.baseUrl = ctx.baseUrl.replace(/^https?:\/\/[^/]+/, host);
    ctx.apiHost = host;
  }
  return applyEnvOverride(ctx, envId);
}

module.exports = {
  resolveGovernanceContext,
  applyEnvOverride,
};
