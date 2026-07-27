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
 * @param {string} args.envId
 * @param {string} [args.policy]
 * @param {string} [args.portalId]
 * @param {object} [args.body]              - POST body (apply op only).
 * @returns {Promise<{ ok: boolean, statusCode: number, body: any, transport: string, error?: { code: string, message: string } }>}
 */
async function callGovernance(args) {
  const route = buildRoute(args);

  // Gateway transport: env id goes into the base URL via resolveGovernanceContext,
  // which also carries the Azure CLI bearer token (see governance-context.js).
  const ctx = resolveGovernanceContext(args.envId);
  if (ctx.error) {
    return {
      ok: false,
      statusCode: 0,
      body: null,
      transport: 'gateway',
      error: { code: 'ContextError', message: ctx.error },
    };
  }
  const res = await request({
    context: ctx,
    method: route.method,
    path: route.path,
    body: args.body,
  });
  return { ...res, transport: 'gateway' };
}

module.exports = {
  callGovernance,
};
