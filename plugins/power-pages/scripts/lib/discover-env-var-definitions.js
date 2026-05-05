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
//          [--token <t>]                   (otherwise acquired via az CLI)
//
// Output (JSON to stdout):
//   {
//     "envVars": [
//       {
//         "schemaName": "cr5fe_LocalLoginEnabled",
//         "type": "Boolean",
//         "defaultValue": "true",
//         "siteSetting": "Authentication/Local/Enabled"
//       },
//       ...
//     ],
//     "count": 5
//   }
//
// Exit 0 always — empty envVars[] when nothing matches the prefix or auth
// fails. Exit 1 on argparse / fatal error so the caller can degrade
// gracefully.

'use strict';

const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;

// Reverse map of the option-set codes the create helper exports.
// Keep in sync with create-env-var-definition.js ENV_VAR_TYPES.
const TYPE_LABELS = {
  100000000: 'String',
  100000001: 'Number',
  100000002: 'Boolean',
  100000003: 'Secret',
  100000004: 'DataSource',
  100000005: 'Json',
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
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--publisherPrefix' && args[i + 1]) out.publisherPrefix = args[++i];
    else if (args[i] === '--websiteRecordId' && args[i + 1]) out.websiteRecordId = args[++i];
  }
  return out;
}

async function fetchAllDefinitions(envUrl, publisherPrefix, token) {
  if (!publisherPrefix) return [];
  const base = envUrl.replace(/\/+$/, '');
  const url =
    `${base}/api/data/v9.2/environmentvariabledefinitions` +
    `?$select=environmentvariabledefinitionid,schemaname,displayname,type,defaultvalue` +
    `&$filter=startswith(schemaname,'${publisherPrefix}_')` +
    `&$top=2000`;
  const res = await helpers.makeRequest({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    timeout: 20000,
  });
  if (!res || res.error || res.statusCode !== 200 || !res.body) return [];
  try {
    const parsed = JSON.parse(res.body);
    return Array.isArray(parsed.value) ? parsed.value : [];
  } catch {
    return [];
  }
}

async function fetchSiteSettingBindings(envUrl, websiteRecordId, token) {
  if (!websiteRecordId) return new Map();
  const base = envUrl.replace(/\/+$/, '');
  const url =
    `${base}/api/data/v9.2/mspp_sitesettings` +
    `?$select=mspp_name,mspp_source,_mspp_environmentvariable_value` +
    `&$filter=_mspp_websiteid_value eq ${websiteRecordId} and mspp_source eq 1` +
    `&$top=2000`;
  const res = await helpers.makeRequest({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    timeout: 20000,
  });
  if (!res || res.error || res.statusCode !== 200 || !res.body) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return new Map();
  }
  const map = new Map();
  for (const row of parsed.value || []) {
    const defId = row._mspp_environmentvariable_value;
    if (!defId) continue;
    // First binding wins. A given env var should be bound to exactly one
    // site setting, but defend against duplicate bindings by keeping the first.
    if (!map.has(defId)) map.set(defId, row.mspp_name);
  }
  return map;
}

async function discoverEnvVarDefinitions({ envUrl, token, publisherPrefix, websiteRecordId }) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!publisherPrefix) {
    // No prefix → nothing to enumerate. Return empty rather than scanning
    // the whole tenant (would be slow and contaminated by cross-site defs).
    return { envVars: [], count: 0 };
  }

  const resolvedToken = token || getAuthToken(envUrl);
  if (!resolvedToken) {
    // Match the caller-degrades-gracefully contract: empty result, exit 0.
    return { envVars: [], count: 0 };
  }

  const [definitions, bindings] = await Promise.all([
    fetchAllDefinitions(envUrl, publisherPrefix, resolvedToken),
    fetchSiteSettingBindings(envUrl, websiteRecordId, resolvedToken),
  ]);

  const envVars = definitions.map((def) => ({
    schemaName: def.schemaname,
    type: typeLabel(def.type),
    defaultValue: def.defaultvalue == null ? '' : String(def.defaultvalue),
    siteSetting: bindings.get(def.environmentvariabledefinitionid) || '',
  }));

  return { envVars, count: envVars.length };
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
