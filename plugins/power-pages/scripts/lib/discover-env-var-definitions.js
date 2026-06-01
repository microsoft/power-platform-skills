#!/usr/bin/env node

// Discovers environment variable definitions in a Power Pages site's solution
// and returns per-variable metadata in the shape that render-alm-plan.js
// expects for its envVars[] array (so the Env Variables tab renders rows
// instead of just a count).
//
// Two passes:
//   1. environmentvariabledefinitions filtered by `startswith(schemaname,'<prefix>_')`
//      — same query the size estimator uses, so the count and the enumeration
//      agree on which definitions belong to this site.
//   2. mspp_sitesettings filtered by website + mspp_source eq 1 — returns every
//      site setting bound to an env var. We then index by env var definition id
//      to attach the bound site setting name to each definition.
//
// Per-environment values (Dev / Staging / Production) are NOT collected here —
// for an ALM plan generated from dev, only the dev value is observable, and
// staging/prod values come from deployment-settings.json (which deploy-pipeline
// will collect later). The renderer handles a missing `values` map by showing
// just the defaultValue column.
//
// Usage:
//   node discover-env-var-definitions.js
//          --envUrl <url>
//          --publisherPrefix <prefix>      (e.g. "cr5fe" — no trailing _)
//          --websiteRecordId <guid>        (used to find bound site settings)
//          [--solutionId <guid>]           (when provided, results are filtered to env vars
//                                           that belong to this solution — preferred for plans
//                                           with an existing solution so cross-project env vars
//                                           sharing the publisher prefix don't bleed in)
//          [--token <t>]                   (otherwise acquired via az CLI)
//
// Output (JSON to stdout):
//   {
//     "envVars": [
//       {
//         "schemaName": "cr5fe_LocalLoginEnabled",
//         "displayName": "Local Login Enabled",
//         "type": "Boolean",
//         "defaultValue": "true",
//         "description": "Toggles the username/password sign-in form on the…",
//         "siteSetting": "Authentication/Local/Enabled"
//       },
//       ...
//     ],
//     "count": 5
//   }
//
// `displayName` and `description` come from environmentvariabledefinition's
// `displayname` and `description` columns. Both are surfaced unchanged so the
// renderer can show a friendly heading + the design rationale for each var
// without re-querying.
//
// Exit 0 always — empty envVars[] when nothing matches the prefix or auth
// fails. Exit 1 on argparse / fatal error so the caller can degrade
// gracefully.

'use strict';

const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;

// Canonical Dataverse option-set values for environmentvariabledefinition.type
// (verified against live tenant data — a Secret env var created via the Power
// Platform UI returns 100000005, not 100000003). Earlier revisions of this
// map (and create-env-var-definition.js) had 100000003 ↔ 100000005 swapped —
// the symptom was a Secret env var rendering as "Json" in the plan, and
// create-env-var-definition.js silently producing JSON-typed records when
// callers asked for Secret. Keep in sync with create-env-var-definition.js
// ENV_VAR_TYPES.
const TYPE_LABELS = {
  100000000: 'String',
  100000001: 'Number',
  100000002: 'Boolean',
  100000003: 'JSON',
  100000004: 'DataSource',
  100000005: 'Secret',
};

function typeLabel(code) {
  if (code === null || code === undefined) return 'String';
  return TYPE_LABELS[code] || 'String';
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null,
    token: null,
    publisherPrefix: null,
    websiteRecordId: null,
    solutionId: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--publisherPrefix' && args[i + 1]) out.publisherPrefix = args[++i];
    else if (args[i] === '--websiteRecordId' && args[i + 1]) out.websiteRecordId = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
  }
  return out;
}

// Page size + Prefer header pattern matches estimate-solution-size.js and
// discover-site-components.js. The previous `$top=2000` plain query silently
// capped at 2000 results on tenants with more matching definitions; this
// version paginates via @odata.nextLink until exhausted.
const ODATA_MAX_PAGE_SIZE = 5000;

async function fetchPaginated(url, token) {
  const aggregated = [];
  let next = url;
  let safety = 100; // ~500K rows; pathological cases bail early
  while (next && safety > 0) {
    const res = await helpers.makeRequest({
      url: next,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        Prefer: `odata.maxpagesize=${ODATA_MAX_PAGE_SIZE}`,
      },
      timeout: 20000,
    });
    if (!res || res.error || res.statusCode !== 200 || !res.body) return aggregated;
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return aggregated;
    }
    if (Array.isArray(parsed.value)) aggregated.push(...parsed.value);
    next = parsed['@odata.nextLink'] || null;
    safety -= 1;
  }
  return aggregated;
}

async function fetchAllDefinitions(envUrl, publisherPrefix, token) {
  if (!publisherPrefix) return [];
  const base = envUrl.replace(/\/+$/, '');
  const url =
    `${base}/api/data/v9.2/environmentvariabledefinitions` +
    `?$select=environmentvariabledefinitionid,schemaname,displayname,description,type,defaultvalue` +
    `&$filter=startswith(schemaname,'${publisherPrefix}_')` +
    `&$top=${ODATA_MAX_PAGE_SIZE}`;
  return fetchPaginated(url, token);
}

// Returns the set of `objectid` values (lowercased) from `solutioncomponents`
// for the target solution's Environment Variable Definition rows
// (componenttype=380). Used to intersect with publisher-prefix-matched env var
// defs so the result reflects "env vars in THIS solution", not "env vars
// matching THIS prefix tenant-wide" — important when the publisher prefix is
// shared across multiple projects in the same tenant.
async function fetchSolutionEnvVarDefIds(envUrl, solutionId, token) {
  if (!solutionId) return null;
  const base = envUrl.replace(/\/+$/, '');
  // componenttype 380 = Environment Variable Definition (well-known value).
  const url =
    `${base}/api/data/v9.2/solutioncomponents` +
    `?$select=objectid` +
    `&$filter=_solutionid_value eq ${solutionId} and componenttype eq 380` +
    `&$top=${ODATA_MAX_PAGE_SIZE}`;
  const rows = await fetchPaginated(url, token);
  return new Set(rows.map((r) => (r.objectid || '').toLowerCase()).filter(Boolean));
}

async function fetchSiteSettingBindings(envUrl, websiteRecordId, token) {
  if (!websiteRecordId) return new Map();
  const base = envUrl.replace(/\/+$/, '');
  const url =
    `${base}/api/data/v9.2/mspp_sitesettings` +
    `?$select=mspp_name,mspp_source,_mspp_environmentvariable_value` +
    `&$filter=_mspp_websiteid_value eq ${websiteRecordId} and mspp_source eq 1` +
    `&$top=${ODATA_MAX_PAGE_SIZE}`;
  const rows = await fetchPaginated(url, token);
  const map = new Map();
  for (const row of rows) {
    const defId = row._mspp_environmentvariable_value;
    if (!defId) continue;
    // First binding wins. A given env var should be bound to exactly one
    // site setting, but defend against duplicate bindings by keeping the first.
    if (!map.has(defId)) map.set(defId, row.mspp_name);
  }
  return map;
}

async function discoverEnvVarDefinitions({ envUrl, token, publisherPrefix, websiteRecordId, solutionId }) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!publisherPrefix) {
    // No prefix → nothing to enumerate. Return empty rather than scanning
    // the whole tenant (would be slow and contaminated by cross-site defs).
    return { envVars: [], count: 0, scope: 'none' };
  }

  const resolvedToken = token || getAuthToken(envUrl);
  if (!resolvedToken) {
    // Match the caller-degrades-gracefully contract: empty result, exit 0.
    return { envVars: [], count: 0, scope: 'none' };
  }

  // Pull the three datasets in parallel:
  //   1. Env var definitions matching the publisher prefix (tenant-wide)
  //   2. Site setting bindings for this site (env var def ID → site setting name)
  //   3. (optional) solution membership: env var def IDs in the target solution
  // The third only fires when solutionId is set; without it we return the
  // tenant-wide prefix match (the legacy behavior, preserved for fresh
  // projects that don't yet have a solution).
  const [definitions, bindings, solutionEnvVarDefIds] = await Promise.all([
    fetchAllDefinitions(envUrl, publisherPrefix, resolvedToken),
    fetchSiteSettingBindings(envUrl, websiteRecordId, resolvedToken),
    fetchSolutionEnvVarDefIds(envUrl, solutionId, resolvedToken),
  ]);

  // Solution-scope filter: keep only definitions whose ID appears as an
  // `objectid` in the target solution's componenttype-380 set. This eliminates
  // the over-count regression where a publisher prefix shared across projects
  // (e.g. `new_`, `cr5fe_`) inflated the env-var stat.
  let scoped = definitions;
  let scope = 'publisher-prefix';
  if (solutionEnvVarDefIds && solutionEnvVarDefIds.size > 0) {
    scoped = definitions.filter((def) => {
      const id = (def.environmentvariabledefinitionid || '').toLowerCase();
      return id && solutionEnvVarDefIds.has(id);
    });
    scope = 'solution';
  } else if (solutionId && solutionEnvVarDefIds && solutionEnvVarDefIds.size === 0) {
    // Caller asked for solution scope and the solution has zero env var defs.
    // Honor that — return empty rather than falling back to the wider scope
    // that would suggest the solution contains env vars when it doesn't.
    scoped = [];
    scope = 'solution';
  }

  const envVars = scoped.map((def) => ({
    schemaName: def.schemaname,
    displayName: def.displayname || def.schemaname,
    type: typeLabel(def.type),
    defaultValue: def.defaultvalue == null ? '' : String(def.defaultvalue),
    description: def.description || '',
    siteSetting: bindings.get(def.environmentvariabledefinitionid) || '',
  }));

  return { envVars, count: envVars.length, scope };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  discoverEnvVarDefinitions(args)
    .then((result) => {
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write('discover-env-var-definitions: ' + err.message + '\n');
      process.exit(1);
    });
}

module.exports = { discoverEnvVarDefinitions, typeLabel, TYPE_LABELS };
