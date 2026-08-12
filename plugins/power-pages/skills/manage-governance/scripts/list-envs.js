#!/usr/bin/env node

// list-envs.js — Lists Power Platform environments the signed-in user has
// admin access to. Backed by `pac admin list --json` via the shared shim.
//
// The environment inventory is intentionally fetched fresh on every invocation.
// Governance targets are admin-sensitive, so the picker must reflect the API's
// current environment list rather than a TTL or file cache.

const https = require('https');
const {
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const { getAuthToken } = require('../../../scripts/lib/validation-helpers');
const { listEnvsViaPac } = require('../../../scripts/lib/pac-bap-shim');
const { resolveRing, getRing } = require('./governance-context');

const HELP = `list-envs.js — Lists Power Platform environments visible to the signed-in PAC profile.

Routing follows the manage-governance ring switch from app-settings.json activeRing:
  Prod ring  → 'pac admin list --json' (follows PAC's signed-in cloud).
  TIP ring   → direct BAP REST GET against the ring's bapHost
               (tip1.api.bap.microsoft.com) with an az token — PAC cannot reach
               the Preprod BAP without a separate sign-in.

Usage:
  node list-envs.js [--type <Production|Sandbox|Trial|Developer|Default>]

Flags:
  --type         Optional filter on environment SKU.
  --help         Show this help message.

Exit codes:
  0  Success (including empty result)
  2  Sign-in required
  1  Other failure

Stdout (JSON):
  { "status": "ok", "ring": "TIP|Prod",
    "envs": [ { "envId", "displayName", "envUrl", "type", "domain" } ] }
`;

function normalize(bapShapedEnv) {
  const props = bapShapedEnv.properties || {};
  const meta = props.linkedEnvironmentMetadata || {};
  return {
    envId: bapShapedEnv.name || null,
    displayName: props.displayName || null,
    envUrl: meta.instanceUrl || null,
    type: props.environmentSku || null,
    domain: meta.domainName || null,
  };
}

// Fetch the admin env list straight from the BAP REST API for the TIP/Preprod
// ring, which `pac admin list` cannot reach without a separate Preprod sign-in.
// The endpoint returns the same BAP-shaped records `normalize()` already
// consumes, wrapped in `{ value: [...] }`. Example (trimmed):
//   GET https://tip1.api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01
//   { "value": [ { "name": "<envId>",
//                  "properties": { "displayName": "...", "environmentSku": "Sandbox",
//                    "linkedEnvironmentMetadata": { "instanceUrl": "https://...", "domainName": "..." } } } ] }
function fetchEnvsViaBapRest(bapHost, token) {
  const url =
    `${bapHost.replace(/\/+$/, '')}` +
    '/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01';
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`BAP REST returned ${res.statusCode}: ${String(data).slice(0, 300)}`)
            );
          }
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed.value) ? parsed.value : []);
          } catch (e) {
            reject(new Error(`Failed to parse BAP REST response: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
  });
}

// Fetch the raw BAP-shaped env list using the strategy the active ring dictates
// (the SAME switch that routes the governance gateway):
//   bapStrategy 'pac'  → `pac admin list --json` (follows PAC's signed-in cloud;
//                        used for Prod).
//   bapStrategy 'rest' → direct BAP REST GET against the ring's bapHost with an
//                        az token for bapResource (used for TIP).
async function fetchRawEnvs(env) {
  const ring = getRing(env);
  if (ring.bapStrategy === 'rest') {
    const token = getAuthToken(ring.bapResource);
    if (!token) {
      // No az token for the BAP audience → the user is signed out of az.
      const e = new Error(
        `Azure CLI is not signed in (needed for the ${ring.label} BAP REST call). Run: az login`
      );
      e.signInRequired = true;
      throw e;
    }
    return fetchEnvsViaBapRest(ring.bapHost, token);
  }
  // Default / 'pac' strategy: the canonical `pac admin list` path.
  return listEnvsViaPac();
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  const env = { ...process.env };
  const ringKey = resolveRing(env);

  let rawEnvs;
  try {
    rawEnvs = await fetchRawEnvs(env);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // Either explicit sign-in flag (BAP REST) or the pac shim's sign-out prose.
    if (e.signInRequired || /not signed in|sign in|authentication/i.test(msg)) {
      fail(`Sign-in required for the ${ringKey} ring. ${msg}`, 2);
    }
    fail(`Failed to list environments (${ringKey} ring): ${msg}`, 1);
  }

  let normalized = rawEnvs.map(normalize).filter((e) => e.envId);
  if (args.type) {
    const filter = String(args.type).toLowerCase();
    normalized = normalized.filter((e) => (e.type || '').toLowerCase() === filter);
  }

  process.stdout.write(
    JSON.stringify({ status: 'ok', ring: ringKey, envs: normalized }, null, 2) + '\n'
  );
}

module.exports = { normalize, fetchEnvsViaBapRest, fetchRawEnvs };

runCli(module, main);
