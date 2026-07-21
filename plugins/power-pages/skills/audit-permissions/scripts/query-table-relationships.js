#!/usr/bin/env node

// Thin CLI wrapper over scripts/lib/query-table-relationships.js.
// Queries Dataverse for one-to-many relationships on a given table.
// Returns JSON array of { schemaName, referencedEntity, referencingEntity, referencingAttribute }.
//
// Usage:
//   node query-table-relationships.js --envUrl <url> --table <logical_name>
//
// Output (stdout): JSON array (OneToMany relationships only — the audit-permissions
//   relationship-scope validation consumes schemaName + referencedEntity).
//
// Exit codes:
//   0 = success (JSON on stdout)
//   1 = error (message on stderr)

const { getAuthToken } = require('../../../scripts/lib/validation-helpers');
const { fetchTableRelationships } = require('../../../scripts/lib/query-table-relationships');

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf('--' + name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const envUrl = getArg('envUrl');
const table = getArg('table');

if (!envUrl || !table) {
  process.stderr.write('Usage: node query-table-relationships.js --envUrl <url> --table <logical_name>\n');
  process.exit(1);
}

(async () => {
  const token = getAuthToken(envUrl);
  if (!token) {
    process.stderr.write('Failed to get auth token. Run: az login --allow-no-subscriptions\n');
    process.exit(1);
  }

  try {
    // OneToMany errors propagate here (preserves the original exit-1-on-API-error
    // behavior); ManyToMany is best-effort inside the lib and unused by this CLI.
    const { oneToMany } = await fetchTableRelationships(envUrl, table, token);
    process.stdout.write(JSON.stringify(oneToMany, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`Request failed: ${err.message}\n`);
    process.exit(1);
  }
})();
