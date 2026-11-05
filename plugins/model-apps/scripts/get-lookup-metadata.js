#!/usr/bin/env node
'use strict';
// get-lookup-metadata: the lookup columns of the tables a generative page reads, each with its COMPLETE target set and the concrete
// paths a page can filter a target through — what the genpage planner records in a page's `#### Lookup metadata` (and saves as
// `lookup-metadata.json` in its working folder), so neither the planner nor the page builder guesses a lookup's targets or a
// navigation path. Read-only: it composes the SDK's table metadata with the lookup-details relationship read (lib/lookup-metadata.js
// says how, and why a shared path such as Owner's `ownerid` is never a target discriminator).
//
// Like every script here it emits no telemetry of its own, prints no token and no row data.
//
// Usage: node scripts/get-lookup-metadata.js --env <envUrl> --tables '<table1>,<table2>'
//   --env     the environment's https origin, e.g. https://contoso.crm.dynamics.com
//   --tables  one table logical name or several, comma-separated (spaces around a name are dropped; a name given twice is read once)
//
// Output (stdout, one pure-ASCII JSON line), exit 0 — only after every table and every relationship page was read:
//   { "ok": true, "tables": [ { "logicalName": "opportunity", "primaryIdAttribute": "opportunityid", "primaryNameAttribute": "name",
//       "lookups": [ { "column": "customerid", "readProperty": "_customerid_value", "attributeType": "Customer",
//                      "targets": ["account", "contact"],
//                      "paths": [ { "target": "account", "navigationProperty": "customerid_account", "referencedKey": "accountid",
//                                   "relationship": "opportunity_customer_accounts" }, … ],
//                      "sharedPaths": [] }, … ] } ] }
//   A failed or incomplete read: { "ok": false, "error": "<message>", "code": "<code>" } on stdout and the message on stderr, exit 1 —
//   never an empty or shorter candidate list. Codes: LOOKUP_TABLE_NOT_FOUND (the environment has no table of that name), LOOKUP_METADATA_INCOMPLETE,
//   LOOKUP_RELATIONSHIPS_UNREADABLE, or the SDK's own (CONNECTION_ERROR for any other refused request, and when the Azure CLI cannot give a token).
//
// Exit codes: 0 read; 1 usage error (stderr names the flag and the usage, stdout stays empty) or a failure to read.

const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { withThrowawaySdk } = require('./lib/throwaway-sdk.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');
const { readLookupMetadata } = require('./lib/lookup-metadata.js');

const USAGE = "Usage: node scripts/get-lookup-metadata.js --env <envUrl> --tables '<table1>,<table2>'";

/**
 * The names of a --tables value: its comma-separated pieces, trimmed and lower-cased, the empty ones dropped and a name given twice kept
 * once, in the order first met.
 * @param {string} text
 * @returns {string[]}
 */
function tableNames(text) {
  const names = [];
  for (const piece of String(text).split(',')) {
    const name = piece.trim().toLowerCase();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Reads the lookups of `tables` through the vendored SDK.
 * @param {string} env - a Dataverse https origin
 * @param {{ tables: string[] }} args
 * @param {object} [httpClient] - the SDK's HttpClient; the az-token one for `env` when omitted (a test seam)
 */
async function readLookups(env, { tables }, httpClient) {
  return withThrowawaySdk({ env, httpClient, prefix: 'get-lookup-metadata-' }, async (make) => {
    const sdk = make();
    // fetchEntityMetadata keeps what it read in the SDK's workspace, which must exist first: a local folder, no request.
    await sdk.initWorkspace();
    return readLookupMetadata(sdk, tables);
  });
}

function usageError(message) {
  makeWritesBlocking(process.stdout, process.stderr);
  process.stderr.write(`✗ ${message}\n${USAGE}\n`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const flagError = validateFlags(argv, { known: ['env', 'tables'], needValue: ['env', 'tables'] });
  if (flagError) usageError(flagError);
  if (positional.length) usageError(`unexpected argument '${positional[0]}'`);
  if (!flags.env) usageError('--env is required');
  if (!flags.tables) usageError('--tables is required');
  let env;
  try {
    env = requireDataverseOrigin(flags.env);
  } catch (err) {
    usageError(err.message);
  }
  const tables = tableNames(flags.tables);
  if (!tables.length) usageError(`--tables '${flags.tables}' names no table`);
  const invalid = tables.find((name) => !/^[a-z_][a-z0-9_]*$/.test(name));
  if (invalid) usageError(`--tables: '${invalid}' is not a table logical name`);

  // emitResult() ends the process, so the read's outcome is settled first and emitted outside the try: an exit inside it would be caught
  // as a failure of the read.
  let result;
  let failure;
  try {
    result = await readLookups(env, { tables });
  } catch (err) {
    failure = err;
  }
  if (failure) {
    const code = failure && typeof failure.code === 'string' ? failure.code : undefined;
    emitResult(false, { ok: false, error: String((failure && failure.message) || failure), ...(code ? { code } : {}) }, { ascii: true });
    return;
  }
  emitResult(true, result, { ascii: true });
}

module.exports = { readLookups, tableNames };

if (require.main === module) {
  main().catch((err) => {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
