#!/usr/bin/env node

// Single network entry-point each script calls — branches gateway vs
// admin-portal at request time.
//
// gateway: uses the shared resolveContext() + request() (api-version=…&
//          gets appended automatically, env-scoped baseUrl).
// admin-portal: bypasses the shared request() helper and calls makeRequest
//          directly because (a) no api-version is needed on the portal-infra
//          host, (b) auth is a caller-supplied bearer rather than Azure CLI.

'use strict';

const { execSync } = require('child_process');
const {
  request,
} = require('../../../scripts/lib/power-platform-api');
const {
  makeRequest,
} = require('../../../scripts/lib/validation-helpers');
const {
  resolveGovernanceContext,
} = require('./governance-context');
const {
  buildRoute,
  buildAdminPortalHeaders,
} = require('./governance-route');

const ADMIN_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Reads the signed-in PAC profile's principalId (Entra Object Id) and tenantId
 * from `pac auth who` so admin-portal calls can populate the required
 * `x-ms-client-*` headers without the caller having to pass them.
 *
 * @returns {{ principalId: string|null, tenantId: string|null }}
 */
function readPacIdentity() {
  try {
    const out = execSync('pac auth who', { encoding: 'utf8', timeout: 15000 });
    const principal = out.match(/Entra ID Object Id:\s*([0-9a-fA-F-]+)/i);
    const tenant = out.match(/Tenant Id:\s*([0-9a-fA-F-]+)/i);
    return {
      principalId: principal ? principal[1] : null,
      tenantId: tenant ? tenant[1] : null,
    };
  } catch {
    return { principalId: null, tenantId: null };
  }
}

/**
 * Issues a governance API call against either transport. Caller fills out the
 * op + envId + policy + portalId in `args`; we pick the URL shape, build the
 * headers, and hand back a uniform `{ ok, statusCode, body, error }` envelope.
 *
 * Use this from each script instead of calling request() / makeRequest() yourself.
 *
 * @param {object} args
 * @param {'apply'|'getEnv'|'getStatus'|'getPortal'|'getDetails'} args.op
 * @param {string} args.envId
 * @param {string} [args.policy]
 * @param {string} [args.portalId]
 * @param {object} [args.body]              - POST body (apply op only).
 * @param {boolean} [args.useAdminPortal]   - false = gateway, true = admin portal.
 * @param {string} [args.token]             - Bearer token (admin portal only — required).
 * @param {string} [args.principalId]       - Entra Object Id (admin portal only — defaults to PAC).
 * @param {string} [args.tenantId]          - Tenant id (admin portal only — defaults to PAC).
 * @returns {Promise<{ ok: boolean, statusCode: number, body: any, transport: string, error?: { code: string, message: string } }>}
 */
async function callGovernance(args) {
  const route = buildRoute(args);

  if (args.useAdminPortal) {
    if (!args.token) {
      return {
        ok: false,
        statusCode: 0,
        body: null,
        transport: 'admin-portal',
        error: { code: 'TokenRequired', message: 'admin-portal transport requires --token' },
      };
    }
    const ident = (!args.principalId || !args.tenantId) ? readPacIdentity() : {};
    const principalId = args.principalId || ident.principalId;
    const tenantId = args.tenantId || ident.tenantId;
    if (!principalId || !tenantId) {
      return {
        ok: false,
        statusCode: 0,
        body: null,
        transport: 'admin-portal',
        error: {
          code: 'IdentityRequired',
          message:
            'admin-portal transport needs --principalId and --tenantId (or a signed-in PAC profile so we can read them).',
        },
      };
    }
    const headers = {
      ...buildAdminPortalHeaders({ token: args.token, principalId, tenantId }),
      Accept: 'application/json',
    };
    let payload = null;
    if (args.body != null) {
      if (typeof args.body === 'string') {
        payload = args.body;
      } else {
        payload = JSON.stringify(args.body);
        headers['Content-Type'] = 'application/json';
      }
    }
    const url = `${route.baseUrl}${route.path}`;
    const res = await makeRequest({
      url,
      method: route.method,
      headers,
      body: payload,
      includeHeaders: true,
      timeout: ADMIN_REQUEST_TIMEOUT_MS,
    });
    if (res.error) {
      return {
        ok: false,
        statusCode: 0,
        body: null,
        transport: 'admin-portal',
        error: { code: 'NetworkError', message: res.error },
      };
    }
    const parsed = parseJsonLoose(res.body, res.headers);
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    const out = {
      ok,
      statusCode: res.statusCode,
      body: parsed,
      transport: 'admin-portal',
    };
    if (!ok) out.error = extractError(parsed, res.statusCode);
    return out;
  }

  // Gateway transport: env id goes into the base URL via resolveGovernanceContext.
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

function parseJsonLoose(raw, headers) {
  if (!raw) return null;
  const ct = ((headers && (headers['content-type'] || headers['Content-Type'])) || '').toLowerCase();
  const first = typeof raw === 'string' ? raw.trimStart()[0] : '';
  if (ct.includes('application/json') || first === '{' || first === '[' || first === '"') {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through
    }
  }
  return raw;
}

function extractError(body, statusCode) {
  const codeFallback = statusCode != null ? `HTTP_${statusCode}` : 'HTTP_NoStatus';
  if (body && typeof body === 'object') {
    // Gateway / OData shape: { error: { code, message } }.
    if (body.error && typeof body.error === 'object') {
      return {
        code: body.error.code || codeFallback,
        message: body.error.message || '',
      };
    }
    // Admin-portal shape: { Message, ErrorCode, ErrorType }.
    if (body.Message || body.ErrorCode) {
      return {
        code: body.ErrorCode || codeFallback,
        message: body.Message || '',
      };
    }
  }
  if (typeof body === 'string' && body.length > 0) {
    return { code: codeFallback, message: body };
  }
  return { code: codeFallback, message: '' };
}

module.exports = {
  callGovernance,
  readPacIdentity,
};
