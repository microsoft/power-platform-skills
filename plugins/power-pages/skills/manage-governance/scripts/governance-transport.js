#!/usr/bin/env node

// Single network entry-point each script calls. All governance traffic goes
// through the gateway transport only (api.powerplatform.com). The shared
// resolveContext() + request() helper appends the api-version query param
// automatically and issues the call against the env-scoped base URL. There is
// no admin-portal / sitewide transport — every op resolves to the gateway.

'use strict';

const {
  request,
} = require('../../../scripts/lib/power-platform-api');
const {
  resolveGovernanceContext,
} = require('./governance-context');
const {
  buildRoute,
} = require('./governance-route');

/**
 * Issues a governance API call against the gateway. Caller fills out the
 * op + envId + policy + portalId in `args`; we pick the URL shape and hand back
 * a uniform `{ ok, statusCode, body, error }` envelope.
 *
 * Use this from each script instead of calling request() yourself.
 *
 * @param {object} args
 * @param {'apply'|'getEnv'|'getStatus'|'getPortal'|'getDetails'} args.op
 * @param {string} [args.envId]             - Defaults to the resolved context's environment.
 * @param {string} [args.policy]
 * @param {string} [args.portalId]
 * @param {object} [args.body]              - POST body (apply op only).
 * @param {object} [args.context]           - Pre-resolved governance context.
 *   Resolving the context mints a bearer via a `tip-auth.js` SUBPROCESS
 *   (`execFileSync`), so a caller issuing many calls for the same env should
 *   resolve ONCE with `resolveGovernanceContext(envId)` and pass it here to
 *   every call — otherwise each call re-spawns the token helper. When omitted
 *   we resolve per-call (the original single-call behavior).
 * @param {number} [args.timeout]           - Per-request timeout (ms). Defaults
 *   to the request() default (15s). Raise it for slow gateways / parallel
 *   batches where the shared server is slower under concurrent load.
 * @returns {Promise<{ ok: boolean, statusCode: number, body: any, transport: string, error?: { code: string, message: string } }>}
 */
async function callGovernance(args) {
  // Gateway transport: env id goes into the base URL via resolveGovernanceContext,
  // which also carries the Azure CLI bearer token (see governance-context.js).
  // A caller may pass a pre-resolved `context` to avoid re-minting the token on
  // every call (each mint is a blocking tip-auth.js subprocess).
  const ctx = args.context || resolveGovernanceContext(args.envId);
  if (ctx.error) {
    return {
      ok: false,
      statusCode: 0,
      body: null,
      transport: 'gateway',
      error: { code: 'ContextError', message: ctx.error },
    };
  }
  // The route guard requires an environment, but omitted --envId is valid:
  // resolve it from the current/configured context before checking the route.
  const envId = args.envId || ctx.environmentId;
  if (!envId) {
    return {
      ok: false,
      statusCode: 0,
      body: null,
      transport: 'gateway',
      error: {
        code: 'ContextError',
        message: 'No environment could be resolved. Supply --envId or select a current PAC environment.',
      },
    };
  }
  const route = buildRoute({ ...args, envId });
  const res = await request({
    context: ctx,
    method: route.method,
    path: route.path,
    body: args.body,
    ...(args.timeout != null && { timeout: args.timeout }),
  });
  // Only GET /governance/{policy} documents 404 as "never applied".
  // Model its disabled scope while retaining absence explicitly; a missing
  // site, rollout, details endpoint, or rejected write is still an error.
  if (args.op === 'getEnv' && res.statusCode === 404) {
    return {
      ok: true,
      statusCode: 404,
      body: 'None',
      settingPresent: false,
      transport: 'gateway',
    };
  }
  return { ...res, transport: 'gateway' };
}

module.exports = {
  callGovernance,
};
