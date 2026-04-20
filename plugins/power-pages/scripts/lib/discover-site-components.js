#!/usr/bin/env node

// Discovers all components associated with a Power Pages site for solution packaging.
// Returns a structured inventory so setup-solution / plan-alm can show gaps and
// bulk-add missing components.
//
// Usage:
//   node discover-site-components.js --envUrl <url> --siteId <guid> [--token <t>]
//                                    [--publisherPrefix <p>] [--solutionId <guid>]
//
// Output (JSON to stdout):
//   {
//     siteId: "...",
//     powerpagecomponents: {
//       total: N,
//       byType: { "<typeValue>": [{ id, name, type, typeLabel }, ...] },
//       typeLabels: { "1": "Publishing State", ... }
//     },
//     cloudFlows: [{ id, name, state, category }],
//     envVars: [{ id, schemaName, displayName, type, defaultValue }],
//     customTables: [{ logicalName, schemaName, displayName }],
//     inSolution: {               // only present when --solutionId passed
//       total, objectIds: Set<string>, byType: { <componenttype>: N }
//     },
//     missing: {                  // only present when --solutionId passed
//       powerpagecomponents: [...],
//       cloudFlows: [...],
//       envVars: [...],
//       customTables: [...]
//     }
//   }
//
// Exit 0 on success, exit 1 on failure.
//
// Authoritative powerpagecomponenttype enum (picklist values) from
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/powerpagecomponent

'use strict';

const helpers = require('./validation-helpers');

/** Authoritative picklist labels for powerpagecomponenttype. */
const PPC_TYPE_LABELS = Object.freeze({
  1: 'Publishing State',
  2: 'Web Page',
  3: 'Web File',
  4: 'Web Link Set',
  5: 'Web Link',
  6: 'Page Template',
  7: 'Content Snippet',
  8: 'Web Template',
  9: 'Site Setting',
  10: 'Web Page Access Control Rule',
  11: 'Web Role',
  12: 'Website Access',
  13: 'Site Marker',
  15: 'Basic Form',
  16: 'Basic Form Metadata',
  17: 'List',
  18: 'Table Permission',
  19: 'Advanced Form',
  20: 'Advanced Form Step',
  21: 'Advanced Form Metadata',
  24: 'Poll Placement',
  26: 'Ad Placement',
  27: 'Bot Consumer',
  28: 'Column Permission Profile',
  29: 'Column Permission',
  30: 'Redirect',
  31: 'Publishing State Transition Rule',
  32: 'Shortcut',
  33: 'Cloud Flow',
  34: 'UX Component',
  35: 'Server Logic',
});

/**
 * Default inclusion policy per powerpagecomponenttype.
 * `true`  — include by default.
 * `false` — exclude by default (none currently; we include everything site-scoped).
 * Callers can override via their own UX before bulk-adding.
 */
const PPC_DEFAULT_INCLUDE = Object.freeze(
  Object.fromEntries(Object.keys(PPC_TYPE_LABELS).map((k) => [k, true]))
);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null,
    token: null,
    siteId: null,
    publisherPrefix: null,
    solutionId: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--siteId' && args[i + 1]) out.siteId = args[++i];
    else if (args[i] === '--publisherPrefix' && args[i + 1]) out.publisherPrefix = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
  }
  return out;
}

/** GET helper that throws on non-200 with a useful message. */
async function odataGet(url, token, makeRequest = helpers.makeRequest) {
  const res = await makeRequest({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: 'odata.maxpagesize=5000',
    },
    timeout: 30000,
  });
  if (res.error) throw new Error(`Request failed: ${res.error}`);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode} from ${url}: ${(res.body || '').slice(0, 400)}`);
  }
  return JSON.parse(res.body);
}

/** Follows @odata.nextLink to aggregate all pages into one value[] array. */
async function odataGetAll(url, token, makeRequest = helpers.makeRequest) {
  const aggregated = [];
  let next = url;
  while (next) {
    const page = await odataGet(next, token, makeRequest);
    if (Array.isArray(page.value)) aggregated.push(...page.value);
    next = page['@odata.nextLink'] || null;
  }
  return aggregated;
}

/**
 * Main discovery entry point.
 * @param {object} args
 * @param {string} args.envUrl - Source environment URL
 * @param {string} args.token - Bearer token for envUrl
 * @param {string} args.siteId - powerpagesite GUID
 * @param {string} [args.publisherPrefix] - when provided, filters env vars + custom tables
 * @param {string} [args.solutionId] - when provided, computes `inSolution` and `missing` diff
 * @param {Function} [args.makeRequest] - injected for tests
 */
async function discoverSiteComponents({
  envUrl,
  token,
  siteId,
  publisherPrefix = null,
  solutionId = null,
  makeRequest = helpers.makeRequest,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!token) throw new Error('--token is required');
  if (!siteId) throw new Error('--siteId is required');

  // Validate publisherPrefix once, up front. Dataverse publisher prefixes are
  // alphanumeric + underscore; reject anything else so a typo surfaces as a
  // clear error rather than silently matching a shortened prefix (and returning
  // unrelated results) downstream.
  if (publisherPrefix !== null && !/^[A-Za-z0-9_]+$/.test(String(publisherPrefix).trim())) {
    throw new Error(
      `Invalid publisherPrefix "${publisherPrefix}" — only alphanumeric and underscore characters are allowed.`
    );
  }

  const baseUrl = envUrl.replace(/\/+$/, '');

  // 1) All site components (the primary inventory)
  const ppcUrl =
    `${baseUrl}/api/data/v9.2/powerpagecomponents` +
    `?$filter=_powerpagesiteid_value eq ${siteId}` +
    `&$select=powerpagecomponentid,name,powerpagecomponenttype,modifiedon,statecode` +
    `&$top=5000`;
  const ppcRows = await odataGetAll(ppcUrl, token, makeRequest);

  const ppcByType = {};
  for (const row of ppcRows) {
    const type = row.powerpagecomponenttype;
    const key = String(type);
    if (!ppcByType[key]) ppcByType[key] = [];
    ppcByType[key].push({
      id: row.powerpagecomponentid,
      name: row.name,
      type,
      typeLabel: PPC_TYPE_LABELS[type] || `Unknown (${type})`,
      modifiedOn: row.modifiedon,
      statecode: row.statecode,
    });
  }

  // 2) Cloud flows cross-linked through ppc type 33 (Cloud Flow binding) — BYOC sites
  //    don't use type 33, so we also enumerate flows by category when a solution scope
  //    lets us hang them on the publisher (otherwise we return only ppc-linked ones).
  const cloudFlows = await discoverCloudFlows({
    baseUrl,
    token,
    ppcRows,
    makeRequest,
  });

  // 3) Env vars filtered by publisher prefix (optional)
  const envVars = publisherPrefix
    ? await discoverEnvVars({ baseUrl, token, publisherPrefix, makeRequest })
    : [];

  // 4) Custom tables filtered by publisher prefix (optional)
  const customTables = publisherPrefix
    ? await discoverCustomTables({ baseUrl, token, publisherPrefix, makeRequest })
    : [];

  const result = {
    siteId,
    powerpagecomponents: {
      total: ppcRows.length,
      byType: ppcByType,
      typeLabels: { ...PPC_TYPE_LABELS },
    },
    cloudFlows,
    envVars,
    customTables,
  };

  // 5) Optional: diff against an existing solution
  if (solutionId) {
    const solutionUrl =
      `${baseUrl}/api/data/v9.2/solutioncomponents` +
      `?$filter=_solutionid_value eq ${solutionId}` +
      `&$select=objectid,componenttype`;
    const solComps = await odataGetAll(solutionUrl, token, makeRequest);

    const inSolutionIds = new Set(
      solComps.map((c) => (c.objectid || '').toLowerCase()).filter(Boolean)
    );
    const byComponentType = {};
    for (const c of solComps) {
      byComponentType[c.componenttype] = (byComponentType[c.componenttype] || 0) + 1;
    }

    result.inSolution = {
      total: solComps.length,
      objectIds: Array.from(inSolutionIds),
      byComponentType,
    };

    const missingPpc = [];
    for (const typeKey of Object.keys(ppcByType)) {
      for (const c of ppcByType[typeKey]) {
        if (!inSolutionIds.has((c.id || '').toLowerCase())) missingPpc.push(c);
      }
    }
    const missingFlows = cloudFlows.filter(
      (f) => !inSolutionIds.has((f.id || '').toLowerCase())
    );
    const missingEnvVars = envVars.filter(
      (e) => !inSolutionIds.has((e.id || '').toLowerCase())
    );
    const missingTables = customTables.filter(
      (t) => !inSolutionIds.has((t.id || '').toLowerCase())
    );

    result.missing = {
      powerpagecomponents: missingPpc,
      cloudFlows: missingFlows,
      envVars: missingEnvVars,
      customTables: missingTables,
    };
  }

  return result;
}

async function discoverCloudFlows({ baseUrl, token, ppcRows, makeRequest }) {
  const typeThreeThreeIds = new Set(
    ppcRows
      .filter((r) => r.powerpagecomponenttype === 33)
      .map((r) => (r.powerpagecomponentid || '').toLowerCase())
      .filter(Boolean)
  );

  // Return only unmanaged cloud flows (category 5). System + managed flows aren't
  // user-owned and would be noise in a "missing from your solution" prompt.
  // BYOC sites don't use type-33 bindings, so we don't narrow by ppc — callers
  // can still filter further by publisher scope if they want.
  const url =
    `${baseUrl}/api/data/v9.2/workflows` +
    `?$filter=category eq 5 and _parentworkflowid_value eq null and ismanaged eq false` +
    `&$select=workflowid,name,statecode,category,ismanaged` +
    `&$top=5000`;
  const rows = await odataGetAll(url, token, makeRequest);
  return rows.map((r) => ({
    id: r.workflowid,
    name: r.name,
    state: r.statecode,
    category: r.category,
    isManaged: r.ismanaged,
    linkedViaPpc: typeThreeThreeIds.has((r.workflowid || '').toLowerCase()),
  }));
}

async function discoverEnvVars({ baseUrl, token, publisherPrefix, makeRequest }) {
  // publisherPrefix validated at the entry point of discoverSiteComponents.
  const prefix = String(publisherPrefix).trim();
  const url =
    `${baseUrl}/api/data/v9.2/environmentvariabledefinitions` +
    `?$filter=startswith(schemaname,'${prefix}_')` +
    `&$select=environmentvariabledefinitionid,schemaname,displayname,type,defaultvalue` +
    `&$top=5000`;
  const rows = await odataGetAll(url, token, makeRequest);
  return rows.map((r) => ({
    id: r.environmentvariabledefinitionid,
    schemaName: r.schemaname,
    displayName: r.displayname,
    type: r.type,
    defaultValue: r.defaultvalue,
  }));
}

async function discoverCustomTables({ baseUrl, token, publisherPrefix, makeRequest }) {
  // The $metadata/EntityDefinitions endpoint doesn't support `startswith` (0x8006088a),
  // so we fetch all custom tables and filter client-side. Custom-entity sets are small
  // enough that a single request is fine. MetadataId is included so callers can diff
  // against solutioncomponents.objectid (componenttype 1 = Entity).
  // publisherPrefix validated at the entry point of discoverSiteComponents.
  const prefixLower = String(publisherPrefix).trim().toLowerCase();
  const url =
    `${baseUrl}/api/data/v9.2/EntityDefinitions` +
    `?$filter=IsCustomEntity eq true` +
    `&$select=LogicalName,SchemaName,DisplayName,MetadataId`;
  const rows = await odataGetAll(url, token, makeRequest);
  return rows
    .filter((r) => (r.LogicalName || '').toLowerCase().startsWith(`${prefixLower}_`))
    .map((r) => ({
      id: r.MetadataId,
      logicalName: r.LogicalName,
      schemaName: r.SchemaName,
      displayName:
        (r.DisplayName && r.DisplayName.UserLocalizedLabel && r.DisplayName.UserLocalizedLabel.Label) ||
        r.SchemaName,
    }));
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  discoverSiteComponents(args)
    .then((result) => {
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  discoverSiteComponents,
  PPC_TYPE_LABELS,
  PPC_DEFAULT_INCLUDE,
};
