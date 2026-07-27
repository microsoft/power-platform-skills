#!/usr/bin/env node

// Builds the URL, and (optional) body for each governance API call.
//
// Single transport — the gateway:
//   Base: https://api.powerplatform.com/powerpages/environments/{envId}
//   Auth: Azure CLI bearer token (resource = apiHost)
//   The env-scoped base URL is supplied by resolveContext + governance-context,
//   so gateway routes are env-relative and the env id is embedded once in the
//   base URL rather than repeated in every op's path.

'use strict';

/**
 * Builds a route descriptor for a governance operation.
 *
 * @param {object} args
 * @param {'apply'|'getEnv'|'getStatus'|'getPortal'|'getDetails'} args.op
 * @param {string} args.envId      - Target environment id (always required).
 * @param {string} [args.policy]   - Policy name (required for everything but `apply` when env-wide).
 * @param {string} [args.portalId] - Portal id (required for getPortal, optional for apply).
 * @returns {{ method: string, path: string, transport: string }}
 */
function buildRoute(args) {
  const { op, envId, policy, portalId } = args || {};
  if (!op) throw new Error('buildRoute: op is required');
  if (!envId) throw new Error('buildRoute: envId is required');

  // Gateway transport. The shared power-platform-api client supplies the
  // env-scoped base URL, so gateway routes are env-relative and the env id
  // does NOT repeat in the path.
  switch (op) {
    case 'apply':
      return { method: 'POST', path: '/governance', transport: 'gateway' };
    case 'getEnv':
      return {
        method: 'GET',
        path: `/governance/${encodeURIComponent(policy)}`,
        transport: 'gateway',
      };
    case 'getStatus':
      return {
        method: 'GET',
        path: `/governance/status/${encodeURIComponent(policy)}`,
        transport: 'gateway',
      };
    case 'getPortal':
      return {
        method: 'GET',
        path: `/websites/${encodeURIComponent(portalId)}/governance/${encodeURIComponent(policy)}`,
        transport: 'gateway',
      };
    case 'getDetails':
      return {
        method: 'GET',
        path: `/governance/${encodeURIComponent(policy)}/details`,
        transport: 'gateway',
      };
    default:
      throw new Error(`buildRoute: unknown op "${op}"`);
  }
}

module.exports = {
  buildRoute,
};
