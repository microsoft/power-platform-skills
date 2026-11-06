#!/usr/bin/env node

// Fetches user-defined column metadata for one or more Dataverse tables.
// Strips system columns (createdon, modifiedby, statecode, ownerId, etc.) so the
// agent only sees the schema the user cares about.
//
// Wraps `dataverse-request.js` so it inherits auth, retry, and 401/429 handling.
//
// Usage: node list-table-columns.js <envUrl> <table1> [<table2> ...] [--tenant-id <id>]
//
// Output (JSON to stdout):
//   {
//     "<tableLogicalName>": [
//       { "name": "cr_title", "type": "String", "required": "ApplicationRequired" },
//       ...
//     ],
//     ...
//   }
//
// Exit codes:
//   0 - All tables fetched successfully
//   1 - Fatal error (no token, invalid args, fetch failure after retries)

const { execFileSync } = require('child_process');
const path = require('path');
const { parseArgs: parseCliArgs } = require('node:util');

const SYSTEM_COLUMN_PATTERNS = [
  /^createdon/,
  /^modifiedon/,
  /createdby/,
  /modifiedby/,
  /^owner/,
  /^owning/,
  /versionnumber/,
  /overriddencreatedon/,
  /importsequencenumber/,
  /utcconversiontimezonecode/,
  /timezoneruleversionnumber/,
  /^processid$/,
  /^stageid$/,
  /^traversedpath$/,
  /^statecode$/,
  /^statuscode$/,
  /^organizationid$/,
  /onbehalfof/,
];

function isSystemColumn(name) {
  return SYSTEM_COLUMN_PATTERNS.some((re) => re.test(name));
}

function parseArgs() {
  const { positionals, values } = parseCliArgs({
    options: { 'tenant-id': { type: 'string' } },
    allowPositionals: true,
  });
  const tenantId = values['tenant-id'];
  if (positionals.length < 2 || (tenantId !== undefined && !tenantId.trim())) {
    throw new Error(
      'Usage: node list-table-columns.js <envUrl> <table1> [<table2> ...] [--tenant-id <id>]'
    );
  }
  return {
    envUrl: positionals[0].replace(/\/+$/, ''),
    tables: positionals.slice(1),
    tenantId,
  };
}

function fetchColumns(envUrl, table, tenantId) {
  const apiPath =
    `EntityDefinitions(LogicalName='${table}')/Attributes` +
    `?$select=LogicalName,AttributeType,RequiredLevel`;
  const requestScript = path.join(__dirname, 'dataverse-request.js');
  const args = [requestScript, envUrl, 'GET', apiPath];
  if (tenantId) args.push('--tenant-id', tenantId);
  const stdout = execFileSync(
    process.execPath,
    args,
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout);
  if (parsed.status !== 200 || !parsed.data || !parsed.data.value) {
    throw new Error(
      `Failed to fetch columns for '${table}': status ${parsed.status} ${parsed.error || ''}`
    );
  }
  return parsed.data.value
    .filter((c) => !isSystemColumn(c.LogicalName))
    .map((c) => ({
      name: c.LogicalName,
      type: c.AttributeType,
      required: c.RequiredLevel?.Value || 'None',
    }));
}

const out = {};
try {
  const { envUrl, tables, tenantId } = parseArgs();
  for (const table of tables) {
    out[table] = fetchColumns(envUrl, table, tenantId);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
