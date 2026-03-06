#!/usr/bin/env node

// Queries Dataverse for one-to-many relationships on a given table.
// Returns JSON array of { schemaName, referencedEntity, referencingEntity, referencingAttribute }.
//
// Usage:
//   node query-table-relationships.js --envUrl <url> --table <logical_name>
//
// Output (stdout): JSON array
//   [{ "schemaName": "cr4fc_order_orderitem", "referencedEntity": "cr4fc_order", "referencingEntity": "cr4fc_orderitem", "referencingAttribute": "cr4fc_orderid" }]
//
// Exit codes:
//   0 = success (JSON on stdout)
//   1 = error (message on stderr)

const { getAuthToken, makeRequest } = require('../../../scripts/lib/validation-helpers');

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
    process.stderr.write('Failed to get auth token. Run: az login\n');
    process.exit(1);
  }

  try {
    const result = await makeRequest({
      url: `${envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${table}')/OneToManyRelationships?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    if (result.error || result.statusCode !== 200) {
      process.stderr.write(`API error (${result.statusCode}): ${result.error || result.body}\n`);
      process.exit(1);
    }

    const parsed = JSON.parse(result.body);
    const rels = (parsed.value || []).map(r => ({
      schemaName: r.SchemaName,
      referencedEntity: r.ReferencedEntity,
      referencingEntity: r.ReferencingEntity,
      referencingAttribute: r.ReferencingAttribute,
    }));

    process.stdout.write(JSON.stringify(rels, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`Request failed: ${err.message}\n`);
    process.exit(1);
  }
})();
