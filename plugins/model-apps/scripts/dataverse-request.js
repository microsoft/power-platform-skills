#!/usr/bin/env node

// General-purpose Dataverse OData Web API wrapper with built-in auth + retry.
// Use this as an escape hatch when a higher-level operation script
// (create-table.js / add-column.js / create-relationship.js / create-record.js /
//  add-to-solution.js) does not cover what you need.
//
// Usage:
//   node dataverse-request.js <envUrl> <method> <apiPath> [--body <json|@path>] [--include-headers]
//
// Arguments:
//   envUrl   - Dataverse environment URL (https://org.crm.dynamics.com)
//   method   - GET | POST | PATCH | DELETE
//   apiPath  - Path after /api/data/v9.2/ (e.g. "EntityDefinitions(LogicalName='account')")
//
// Options:
//   --body <json|@path>   Inline JSON or @filepath to a JSON file
//   --include-headers     Include response headers (useful for OData-EntityId on POST)
//   --timeout <ms>        Override default 60s timeout
//
// Output (stdout, JSON):
//   { "status": 200, "data": { ... } }
//   With --include-headers: { "status": 200, "data": { ... }, "headers": { ... } }
//
// Exit codes:
//   0 - Request completed (check status field for HTTP result)
//   1 - Fatal error (no token, invalid args, network failure after retries)

const { dataverseRequest, parseArgs, readJsonArg } = require('./lib/dataverse-auth');

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 3) {
    process.stderr.write(
      'Usage: node dataverse-request.js <envUrl> <method> <apiPath> [--body <json|@path>] [--include-headers] [--timeout <ms>]\n'
    );
    process.exit(1);
  }

  const [envUrl, methodRaw, apiPath] = positional;
  const method = methodRaw.toUpperCase();
  const body = flags.body !== undefined ? readJsonArg(flags.body) : null;
  const includeHeaders = flags['include-headers'] === true;

  let timeout = undefined;
  if (flags.timeout !== undefined) {
    const parsed = Number(flags.timeout);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      process.stderr.write(`--timeout must be a positive number (got "${flags.timeout}")\n`);
      process.exit(1);
    }
    timeout = parsed;
  }

  try {
    const res = await dataverseRequest(envUrl, method, apiPath, body, { includeHeaders, timeout });
    process.stdout.write(JSON.stringify(res) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  }
}

main();
