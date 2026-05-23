#!/usr/bin/env node

// Lists the authoritative set of columns for a Dataverse table. Used as a lightweight,
// per-table pre-write check in `/integrate-webapi` Phase 7.3: before the skill writes
// `.powerpages-site/site-settings/Webapi-<table>-fields.sitesetting.yml`, it queries
// this script to confirm every column in the proposed whitelist actually exists on the
// target table — preventing hallucinated column names from landing in deployed config.
//
// For a full schema snapshot covering many tables + relationships/optionsets/lookups,
// use `snapshot-dataverse-schema.js`. This script is the cheap, single-table cousin.
//
// Usage:
//   node list-table-columns.js --table faq_article [--envUrl https://org.crm.dynamics.com]
//
// Output (JSON to stdout):
//   { "table": "faq_article", "columns": [ { logicalName, schemaName, attributeType, ... } ] }
//   { "error": "..." }
//
// Exit codes:
//   0 — columns returned
//   1 — fatal error (missing args, no token, table not found, network failure)

const { getAuthToken, getEnvironmentUrl } = require('./lib/validation-helpers');
const { listTableColumns } = require('./lib/dataverse-metadata');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--table') args.table = argv[++i];
    else if (argv[i] === '--envUrl') args.envUrl = argv[++i];
  }
  return args;
}

function output(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.table) {
    process.stderr.write('Usage: list-table-columns.js --table <logicalName> [--envUrl <url>]\n');
    process.exit(1);
  }
  const envUrl = args.envUrl || getEnvironmentUrl();
  if (!envUrl) {
    output({ error: 'Could not determine Dataverse environment URL. Pass --envUrl or run `pac env who` first.' }, 1);
  }
  const token = getAuthToken(envUrl);
  if (!token) {
    output({ error: 'Could not acquire Azure CLI token. Run `az login --allow-no-subscriptions` first.' }, 1);
  }
  try {
    const columns = await listTableColumns({ envUrl, token, table: args.table });
    output({ table: args.table, columns });
  } catch (e) {
    // NOT_FOUND is the most informative failure here — a misspelled table name from the
    // migration plan lands as a clean error message rather than a confusing 404 trace.
    output({ error: e.code === 'NOT_FOUND' ? `Table "${args.table}" not found in Dataverse` : e.message }, 1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    output({ error: e.message }, 1);
  });
}

module.exports = { parseArgs };
