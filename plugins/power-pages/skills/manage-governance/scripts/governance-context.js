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
  return applyEnvOverride(ctx, envId);
}

module.exports = {
  resolveGovernanceContext,
  applyEnvOverride,
};
