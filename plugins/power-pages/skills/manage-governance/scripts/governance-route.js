#!/usr/bin/env node

// Builds the URL, headers, and (optional) body for each governance API call.
// Knows two transports:
//
//   - gateway (default, long-term target):
//       Base: https://api.powerplatform.com/powerpages/environments/{envId}
//       Auth: Azure CLI bearer token (resource = apiHost)
//       The default once admin consent for `PowerPages.Websites.Read` is in
//       place on the target tenant.
//
//   - admin-portal (TIP testing only):
//       Base: https://portalsitewide-tip.portal-infra.dynamics.com/api/v1/powerPortal
//       Auth: bearer token copied from a browser session into the
//             admin.preprod.powerplatform.microsoft.com portal. Required
//             because the Azure CLI app isn't admin-consented for the
//             gateway scopes on most Preprod tenants today.
//       Extra headers: x-ms-client-principal-id, x-ms-client-tenant-id,
//                      x-ms-client-request-id, x-correlation-id.
//
// Switching transport changes URL shape — particularly, the admin portal
// embeds envId in the URL for every op while the gateway embeds it once in
// the base URL.

'use strict';

const crypto = require('crypto');

const ADMIN_PORTAL_HOST_TIP = 'https://portalsitewide-tip.portal-infra.dynamics.com';
const ADMIN_PORTAL_BASE = `${ADMIN_PORTAL_HOST_TIP}/api/v1/powerPortal`;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [8, 4, 4, 4, 12]
    .map((n) => crypto.randomBytes(n / 2).toString('hex'))
    .join('-');
}

/**
 * Builds a route descriptor for a governance operation.
 *
 * @param {object} args
 * @param {'apply'|'getEnv'|'getStatus'|'getPortal'|'getDetails'} args.op
 * @param {string} args.envId      - Target environment id (always required).
 * @param {string} [args.policy]   - Policy name (required for everything but `apply` when env-wide).
 * @param {string} [args.portalId] - Portal id (required for getPortal, optional for apply).
 * @param {boolean} [args.useAdminPortal] - When true, use the admin portal transport.
 * @returns {{ method: string, path: string, baseUrl: string, transport: string }}
 */
function buildRoute(args) {
  const { op, envId, policy, portalId, useAdminPortal } = args || {};
  if (!op) throw new Error('buildRoute: op is required');
  if (!envId) throw new Error('buildRoute: envId is required');

  if (useAdminPortal) {
    switch (op) {
      case 'apply':
        // POST /api/v1/powerPortal/governance/{envId} — body is the policies array.
        return {
          method: 'POST',
          path: `/governance/${encodeURIComponent(envId)}`,
          baseUrl: ADMIN_PORTAL_BASE,
          transport: 'admin-portal',
        };
      case 'getEnv':
        // GET /api/v1/powerPortal/governance/environments/{envId}/{policy}
        return {
          method: 'GET',
          path: `/governance/environments/${encodeURIComponent(envId)}/${encodeURIComponent(policy)}`,
          baseUrl: ADMIN_PORTAL_BASE,
          transport: 'admin-portal',
        };
      case 'getStatus':
        return {
          method: 'GET',
          path: `/governance/status/${encodeURIComponent(envId)}/${encodeURIComponent(policy)}`,
          baseUrl: ADMIN_PORTAL_BASE,
          transport: 'admin-portal',
        };
      case 'getPortal':
      case 'getDetails':
        // The admin portal exposes a single policyRecord endpoint that holds
        // the inclusion / exclusion lists for the policy on the env. The
        // skill caller checks the portalId against those lists.
        return {
          method: 'GET',
          path: `/governance/policyRecord/${encodeURIComponent(envId)}/${encodeURIComponent(policy)}`,
          baseUrl: ADMIN_PORTAL_BASE,
          transport: 'admin-portal',
        };
      default:
        throw new Error(`buildRoute: unknown op "${op}"`);
    }
  }

  // Default transport: gateway. The shared power-platform-api client supplies
  // the env-scoped base URL via resolveContext + governance-context, so the
  // gateway routes are env-relative and the env id does NOT repeat in path.
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

/**
 * Builds the headers needed for an admin-portal request. The portal-infra
 * gateway requires the `x-ms-client-*` triplet to identify the caller — the
 * admin portal's frontend injects them from the signed-in user's session.
 *
 * @param {object} args
 * @param {string} args.token        - Bearer token copied from the browser session.
 * @param {string} args.principalId  - Caller's Entra Object Id (UUID).
 * @param {string} args.tenantId     - Caller's tenant id (UUID).
 * @returns {object} A header bag the shared `request()` accepts as `extraHeaders`.
 */
function buildAdminPortalHeaders({ token, principalId, tenantId }) {
  if (!token) throw new Error('buildAdminPortalHeaders: token is required');
  if (!principalId) throw new Error('buildAdminPortalHeaders: principalId is required');
  if (!tenantId) throw new Error('buildAdminPortalHeaders: tenantId is required');
  const corr = uuid();
  return {
    Authorization: `Bearer ${token}`,
    'x-ms-client-principal-id': principalId,
    'x-ms-client-tenant-id': tenantId,
    'x-ms-client-request-id': corr,
    'x-correlation-id': corr,
    // x-ms-client-session-id is a portal-issued session id; absent from CLI
    // callers — both gateway and admin portal accept the call without it.
  };
}

module.exports = {
  buildRoute,
  buildAdminPortalHeaders,
  ADMIN_PORTAL_BASE,
  ADMIN_PORTAL_HOST_TIP,
};
