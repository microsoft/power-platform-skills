#!/usr/bin/env node

// list-portals.js — Lists Power Pages portals (websites) in an environment.
//
// gateway transport (the only transport): GET /websites on
//                       api.powerplatform.com, env-scoped via base URL. The
//                       client sends plain `select` (and `skip`) query keys —
//                       NOT OData `$select`/`$skip` — which the gateway maps.
//                       Paginates via @odata.nextLink.

const {
  request,
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const { resolveGovernanceContext } = require('./governance-context');

const HELP = `list-portals.js — Lists Power Pages portals in an environment.

Usage:
  node list-portals.js [--envId <guid>]

Flags:
  --envId            Power Platform environment id. When omitted, uses the env
                     the PAC profile is currently signed into.
  --help             Show this help message.

Exit codes:
  0  Success (including empty result)
  2  Sign-in required
  1  Other failure

Stdout (JSON):
  { "status": "ok", "transport": "gateway",
    "portals": [ { "portalId", "name", "websiteUrl", "websiteRecordId",
                   "type", "status", "createdOn" } ] }
`;

const FIELDS = ['Id', 'Name', 'WebsiteUrl', 'WebsiteRecordId', 'Type', 'Status', 'CreatedOn'].join(',');
const MAX_PAGES = 500;

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

async function listViaGateway(args) {
  const ctx = resolveGovernanceContext(args.envId);
  if (ctx.error) fail(ctx.error, 2);

  const { portals, error } = await fetchPortalsPaged(ctx);
  if (error) fail(error, 1);
  return { transport: 'gateway', portals };
}

// Page through GET /websites for a PRE-RESOLVED context and return the
// normalized portal records. Split out from listViaGateway so other scripts
// (e.g. fetch-env-status.js) can fetch the site list as ONE promise inside a
// parallel Promise.all batch — sharing the same governance context/token
// instead of re-resolving it. Returns { portals, error }: a non-null `error`
// string means a page read failed (the caller decides whether to fail() or
// tolerate a partial list); `portals` always holds whatever was read so far.
async function fetchPortalsPaged(ctx) {
  const portals = [];
  let skip;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = { select: FIELDS };
    if (skip !== undefined) query.skip = String(skip);
    const res = await request({ context: ctx, method: 'GET', path: '/websites', query });
    if (!res.ok) {
      return { portals, error: `List portals failed (${res.statusCode}): ${res.error?.message || ''}` };
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
  return { portals };
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  const result = await listViaGateway(args);

  process.stdout.write(
    JSON.stringify({ status: 'ok', ...result }, null, 2) + '\n'
  );
}

module.exports = { nextSkipFrom, normalize, compareForDisplay, orderPortalsForDisplay, fetchPortalsPaged, DISPLAY_LIMIT };

runCli(module, main);
