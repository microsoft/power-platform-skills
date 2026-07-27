#!/usr/bin/env node

const {
  resolveContext,
} = require('../../../scripts/lib/power-platform-api');

function applyEnvOverride(context, envId) {
  if (!envId || typeof envId !== 'string') return context;
  context.baseUrl = context.baseUrl.replace(
    /\/environments\/[^/]+/,
    `/environments/${encodeURIComponent(envId)}`
  );
  context.environmentId = envId;
  return context;
}

function resolveGovernanceContext(envId) {
  const ctx = resolveContext();
  if (ctx.error) return ctx;
  if (process.env.PP_GOV_TOKEN) {
    ctx.token = process.env.PP_GOV_TOKEN.trim();
  }
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
