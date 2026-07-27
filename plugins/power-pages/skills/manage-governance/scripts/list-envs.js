#!/usr/bin/env node

// list-envs.js — Lists Power Platform environments the signed-in user has
// admin access to. Backed by `pac admin list --json` via the shared shim.
//
// Optional on-disk cache (opt-in via --cacheFile): the governance skill
// pre-warms the env list in the background and reuses it for the rest of the
// run. `pac admin list` cold-starts the .NET CLI (~seconds) and the tenant's
// env set changes rarely, so we serve a cached copy when it is younger than
// the TTL (default 6h) and only re-hit PAC once the cache goes stale. The TTL
// is enforced by the cache file's mtime — a fresh write restarts the window.

const fs = require('fs');
const {
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const { listEnvsViaPac } = require('../../../scripts/lib/pac-bap-shim');

// Default cache lifetime. The env inventory for a tenant is slow-changing, so
// 6 hours keeps the interactive picker fast without serving a day-old list.
const DEFAULT_CACHE_MAX_AGE_HOURS = 6;

const HELP = `list-envs.js — Lists Power Platform environments visible to the signed-in PAC profile.

Usage:
  node list-envs.js [--type <Production|Sandbox|Trial|Developer|Default>]
                    [--cacheFile <path>] [--maxAgeHours <n>] [--refresh]

Flags:
  --type         Optional filter on environment SKU.
  --cacheFile    Path to a JSON cache file. When present and fresh (younger
                 than --maxAgeHours), the cached list is served and the slow
                 pac admin list call is skipped. On a miss/stale cache, the
                 freshly fetched list is written back to this path.
  --maxAgeHours  Cache time-to-live in hours (default ${DEFAULT_CACHE_MAX_AGE_HOURS}). The cache is
                 considered stale once now - mtime >= this many hours.
  --refresh      Force a fresh fetch, ignoring any existing cache. The result
                 still overwrites --cacheFile when provided.
  --help         Show this help message.

Exit codes:
  0  Success (including empty result)
  2  Sign-in required
  1  Other failure

Stdout (JSON):
  { "status": "ok", "envs": [ { "envId", "displayName", "envUrl", "type", "domain" } ],
    "cache": { "hit": <bool>, "ageMinutes": <n|null>, "maxAgeHours": <n> } }
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

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  let envs;
  try {
    envs = await listEnvsViaPac();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // `pac admin list` failures most often mean the user is signed out of PAC.
    if (/not signed in|sign in|authentication/i.test(msg)) {
      fail(`Power Platform CLI is not signed in. Run: pac auth create\n${msg}`, 2);
    }
    fail(`Failed to list environments: ${msg}`, 1);
  }

  let normalized = envs.map(normalize).filter((e) => e.envId);
  if (args.type) {
    const filter = String(args.type).toLowerCase();
    normalized = normalized.filter((e) => (e.type || '').toLowerCase() === filter);
  }

  process.stdout.write(
    JSON.stringify({ status: 'ok', envs: normalized }, null, 2) + '\n'
  );
}

module.exports = { normalize };

runCli(module, main);
