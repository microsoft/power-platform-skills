#!/usr/bin/env node

// list-portals.js — Lists Power Pages portals (websites) in an environment.
//
// gateway transport:    GET /websites?$select=... on api.powerplatform.com,
//                       env-scoped via base URL. Paginates via @odata.nextLink.
//
// admin-portal transport: GET /api/v1/powerPortal/ListPortalsByOrgId?orgId=...
//                         on portalsitewide-tip.portal-infra.dynamics.com.
//                         The endpoint is ORG-scoped, not env-scoped, so the
//                         script auto-resolves orgId from envId via
//                         `pac admin list --json` (the same shim list-envs.js
//                         uses) and then calls the admin-portal endpoint.

const { execSync } = require('child_process');
const {
  request,
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const {
  makeRequest,
} = require('../../../scripts/lib/validation-helpers');
const { resolveGovernanceContext } = require('./governance-context');
const {
  buildAdminPortalHeaders,
  ADMIN_PORTAL_BASE,
} = require('./governance-route');
const { listEnvsViaPac } = require('../../../scripts/lib/pac-bap-shim');

const HELP = `list-portals.js — Lists Power Pages portals in an environment.

Usage:
  node list-portals.js [--envId <guid>]
                       [--useAdminPortal --token <bearer>
                          [--orgId <guid>] [--principalId <guid>] [--tenantId <guid>]]

Flags:
  --envId            Power Platform environment id. When omitted on gateway
                     transport, uses the env the PAC profile is currently
                     signed into. Required with --useAdminPortal unless --orgId
                     is provided directly.
  --useAdminPortal   Use the admin-portal transport (ListPortalsByOrgId).
  --token            Bearer token for the admin portal (required with
                     --useAdminPortal).
  --orgId            Dataverse Organization Id (admin-portal only). When
                     omitted, auto-resolved from --envId via pac admin list.
  --principalId      Caller's Entra Object Id (admin portal only; defaults to PAC).
  --tenantId         Tenant id (admin portal only; defaults to PAC).
  --help             Show this help message.

Exit codes:
  0  Success (including empty result)
  2  Sign-in required
  1  Other failure

Stdout (JSON):
  { "status": "ok", "transport": "gateway"|"admin-portal",
    "portals": [ { "portalId", "name", "websiteUrl", "websiteRecordId",
                   "type", "status", "createdOn", "environmentName" } ] }
`;

const FIELDS = ['Id', 'Name', 'WebsiteUrl', 'WebsiteRecordId', 'Type', 'Status', 'CreatedOn'].join(',');
const MAX_PAGES = 500;
const ADMIN_REQUEST_TIMEOUT_MS = 60_000;

// Default display cap for the portal picker: show at most this many rows.
const DISPLAY_LIMIT = 10;

function nextSkipFrom(nextLink) {
  if (typeof nextLink !== 'string') return null;
  const match = nextLink.match(/[?&]skip=(\d+)/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalize(site) {
  // The gateway /websites response is camelCase on preprod (id, name,
  // websiteUrl, ...) but PascalCase on some rings. Accept either casing so the
  // portal list isn't silently filtered to empty.
  return {
    portalId: site.id || site.Id || null,
    name: site.name || site.Name || null,
    websiteUrl: site.websiteUrl || site.WebsiteUrl || null,
    websiteRecordId: site.websiteRecordId || site.WebsiteRecordId || null,
    type: site.type || site.Type || null,
    status: site.status || site.Status || null,
    createdOn: site.createdOn || site.CreatedOn || site.created || site.Created || null,
  };
}

function normalizeAdminPortal(site) {
  // admin portal returns: { Id, Name, Created, PackageUniqueName, PortalUrl,
  //   TenantId, CrmEditUrl, EnvironmentName, EnvironmentId, ... }
  return {
    portalId: site.Id || null,
    name: site.Name || null,
    websiteUrl: site.PortalUrl || null,
    websiteRecordId: site.WebsiteRecordId || null,
    type: site.PackageUniqueName || null,
    status: site.Status || site.State || null,
    createdOn: site.Created || site.CreatedOn || null,
    environmentName: site.EnvironmentName || null,
    environmentId: site.EnvironmentId || null,
  };
}

// Prioritized ordering for the portal picker. When the environment has more
// than `limit` portals, the full list is too long to render — so we surface
// the most relevant `limit` rows using the ordering the skill defines:
//   1. Production application type first (type === "Production").
//   2. Then StateConfigured status (status === "StateConfigured").
//   3. Then oldest-first by createdOn (ascending).
// When the env has `limit` portals or fewer, the original order is preserved
// (the special ordering only kicks in when we actually have to truncate).
// Returns { shown, total, truncated, limit } — `shown` is the capped list to
// render; `total` is the full count so the caller can note "showing N of M".
function compareForDisplay(a, b) {
  const isProd = (p) => String(p.type || '').trim().toLowerCase() === 'production';
  const isConfigured = (p) => String(p.status || '').trim().toLowerCase() === 'stateconfigured';
  const createdMs = (p) => {
    const t = Date.parse(p.createdOn || '');
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const prodRank = (isProd(a) ? 0 : 1) - (isProd(b) ? 0 : 1);
  if (prodRank !== 0) return prodRank;
  const configuredRank = (isConfigured(a) ? 0 : 1) - (isConfigured(b) ? 0 : 1);
  if (configuredRank !== 0) return configuredRank;
  return createdMs(a) - createdMs(b);
}

function orderPortalsForDisplay(portals, limit = DISPLAY_LIMIT) {
  const list = Array.isArray(portals) ? portals.slice() : [];
  const total = list.length;
  if (total <= limit) {
    return { shown: list, total, truncated: false, limit };
  }
  list.sort(compareForDisplay);
  return { shown: list.slice(0, limit), total, truncated: true, limit };
}

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

async function resolveOrgIdForEnv(envId) {
  try {
    const envs = await listEnvsViaPac();
    const match = envs.find(
      (e) => (e.name || '').toLowerCase() === String(envId).toLowerCase()
    );
    if (!match) return null;
    return match.properties?.linkedEnvironmentMetadata?.resourceId || null;
  } catch {
    return null;
  }
}

async function listViaGateway(args) {
  const ctx = resolveGovernanceContext(args.envId);
  if (ctx.error) fail(ctx.error, 2);

  const portals = [];
  let skip;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = { select: FIELDS };
    if (skip !== undefined) query.skip = String(skip);
    const res = await request({ context: ctx, method: 'GET', path: '/websites', query });
    if (!res.ok) {
      fail(`List portals failed (${res.statusCode}): ${res.error?.message || ''}`, 1);
    }
    const body = res.body && typeof res.body === 'object' ? res.body : {};
    for (const site of body.value || []) {
      const n = normalize(site);
      if (n.portalId) portals.push(n);
    }
    const advance = nextSkipFrom(body['@odata.nextLink'] || body.nextLink);
    if (advance == null || advance <= (skip ?? 0)) break;
    skip = advance;
  }
  return { transport: 'gateway', portals };
}

async function listViaAdminPortal(args) {
  if (!args.token) {
    fail('--useAdminPortal requires --token', 1);
  }
  let orgId = args.orgId;
  if (!orgId) {
    if (!args.envId) {
      fail('--useAdminPortal requires --envId (to auto-resolve orgId) or --orgId directly', 1);
    }
    orgId = await resolveOrgIdForEnv(args.envId);
    if (!orgId) {
      fail(`Could not resolve orgId for env ${args.envId}. Pass --orgId directly.`, 1);
    }
  }

  const ident = (!args.principalId || !args.tenantId) ? readPacIdentity() : {};
  const principalId = args.principalId || ident.principalId;
  const tenantId = args.tenantId || ident.tenantId;
  if (!principalId || !tenantId) {
    fail('admin-portal transport needs --principalId and --tenantId (or a signed-in PAC profile so we can read them).', 1);
  }

  const headers = {
    ...buildAdminPortalHeaders({ token: args.token, principalId, tenantId }),
    Accept: 'application/json',
  };
  const url = `${ADMIN_PORTAL_BASE}/ListPortalsByOrgId?orgId=${encodeURIComponent(orgId)}`;
  const res = await makeRequest({
    url,
    method: 'GET',
    headers,
    includeHeaders: true,
    timeout: ADMIN_REQUEST_TIMEOUT_MS,
  });
  if (res.error) {
    fail(`List portals failed (network): ${res.error}`, 1);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    fail(`List portals failed (${res.statusCode}): ${(res.body || '').slice(0, 300)}`, 1);
  }
  // Body is a JSON string containing an array (responses we observed are stringified-array).
  let parsed = res.body;
  try {
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    // Some responses are a string-wrapped JSON; unwrap once more.
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  } catch {}
  const sites = Array.isArray(parsed) ? parsed : [];
  const portals = sites.map(normalizeAdminPortal).filter((s) => s.portalId);
  // If --envId is set, scope the list to portals in that env (server returns
  // all portals for the org; usually one env per org but be defensive).
  const filtered = args.envId
    ? portals.filter((p) => !p.environmentId || p.environmentId.toLowerCase() === args.envId.toLowerCase())
    : portals;
  return { transport: 'admin-portal', orgId, portals: filtered };
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  const useAdminPortal = Boolean(args.useAdminPortal);

  const result = useAdminPortal
    ? await listViaAdminPortal(args)
    : await listViaGateway(args);

  process.stdout.write(
    JSON.stringify({ status: 'ok', ...result }, null, 2) + '\n'
  );
}

module.exports = { nextSkipFrom, normalize, normalizeAdminPortal, compareForDisplay, orderPortalsForDisplay, DISPLAY_LIMIT };

runCli(module, main);
