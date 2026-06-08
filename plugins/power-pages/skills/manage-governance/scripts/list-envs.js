#!/usr/bin/env node

// list-envs.js — Lists Power Platform environments the signed-in user has
// admin access to. Backed by `pac admin list --json` via the shared shim.

const {
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const { listEnvsViaPac } = require('../../../scripts/lib/pac-bap-shim');

const HELP = `list-envs.js — Lists Power Platform environments visible to the signed-in PAC profile.

Usage:
  node list-envs.js [--type <Production|Sandbox|Trial|Developer|Default>]

Flags:
  --type   Optional filter on environment SKU.
  --help   Show this help message.

Exit codes:
  0  Success (including empty result)
  2  Sign-in required
  1  Other failure

Stdout (JSON):
  { "status": "ok", "envs": [ { "envId", "displayName", "envUrl", "type", "domain" } ] }
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
