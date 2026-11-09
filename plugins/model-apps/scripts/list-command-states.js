#!/usr/bin/env node
'use strict';
// list-command-states: the modern command buttons (`appaction` rows) of an app's tables, each with its row id, its bar, its scope, its stored
// `hidden` / `isdisabled` state, and whether it is a candidate for a row-state edit — and, when it is not, every reason why, in a fixed
// vocabulary (lib/command-state-contract.js, REASONS). Read-only: it sends GET requests and nothing else, and it accepts no write flag.
//
// What it reads (lib/command-state-read.js, through the read-only transport of lib/command-state-transport.js):
//   the app by its unique name (every page; exactly one), its current saved layer, its complete list of table components, the named table (or
//   every table of the app), whether the table of commands keeps row versions, and every command bound to each table by `contextvalue` — every
//   page, every continuation on the same origin.
// A button the listing shows as not a candidate is still a button: a deactivated, managed, migrated, nested, container or another app's row is
// listed with its reasons, never left out, so "no row" is never mistaken for "no button". A bar the App Spec has no name for is `unsupported`,
// never mapped onto MainTab, HomeTab or ContextualTab. Two buttons with the same caption on one bar each carry the other's row id in
// `sameCaption`: pick by row id, never by caption.
// A candidate is a row whose SHAPE allows a row-state edit; the listing proves nothing about how the app renders it.
//
// Usage: node scripts/list-command-states.js --env <envUrl> --app <uniqueName> [--entity <logical>] [--location MainTab|HomeTab|ContextualTab]
//   --env       the environment's https origin, e.g. https://contoso.crm.dynamics.com
//   --app       the app's unique name
//   --entity    one table's logical name (any letter case); without it, every table of the app
//   --location  only the buttons of one bar
//
// Output (stdout, one pure-ASCII JSON line), exit 0:
//   { "ok": true, "app": { "uniqueName": "contoso_Support", "appId": "<guid>" }, "optimisticConcurrency": true,
//     "tables": [ { "entity": "contoso_ticket", "metadataId": "<guid>", "inApp": true } ], "count": 2, "candidates": 1,
//     "commands": [ { "entity": "contoso_ticket", "location": 0, "bar": "MainTab", "caption": "Escalate", "rowId": "<guid>", "scope": "table",
//                     "appId": null, "hidden": false, "disabled": false, "type": 0, "origin": 0, "parentId": null, "visibilityType": 0,
//                     "onClickType": 2, "active": true, "managed": false, "customizable": true, "candidate": true, "reasons": [] }, ... ] }
//   `caption` is null for an unlabelled button; `details` (when present) names the columns that could not be read; `sameCaption` lists the
//   other buttons with the same caption on the same bar of the same table.
//   A failed or incomplete read: { "ok": false, "code": "<command-state-...>", "error": "<message>" } and exit 1 — never an empty success.
//
// Exit codes: 0 read; 1 usage error (stderr names the flag and the usage, stdout stays empty) or a failed read.

const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { withThrowawaySdk } = require('./lib/throwaway-sdk.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { createCommandStateTransport } = require('./lib/command-state-transport.js');
const { resolveCommandStateContext, listCommandStateRows } = require('./lib/command-state-read.js');
const { LOCATION_BY_BAR } = require('./lib/command-state-contract.js');
const { TABLE_NAME } = require('./lib/app-components.js');

const USAGE = 'Usage: node scripts/list-command-states.js --env <envUrl> --app <uniqueName> [--entity <logical>] [--location MainTab|HomeTab|ContextualTab]';
const BARS = Object.keys(LOCATION_BY_BAR);
// Flags of the build that change an environment. They are named apart from any other unknown flag so the message says why they are refused.
const WRITE_FLAGS = ['apply', 'publish', 'authorize', 'yes', 'force'];

// One listed button, for the output.
function itemOf({ table, eligible, reasons, details, sameCaption, row }) {
  return {
    entity: table,
    location: row.location,
    bar: row.bar,
    caption: row.caption,
    rowId: row.rowId,
    scope: row.scope,
    appId: row.appId,
    hidden: row.hidden,
    disabled: row.disabled,
    type: row.type,
    origin: row.origin,
    parentId: row.parentId,
    visibilityType: row.visibilityType,
    onClickType: row.onClickType,
    active: row.statecode === 0 && row.statuscode === 1,
    managed: row.managed,
    customizable: row.customizable,
    candidate: eligible,
    reasons,
    ...(details.length ? { details } : {}),
    ...(sameCaption ? { sameCaption } : {}),
  };
}

/**
 * Lists the modern commands of an app's tables.
 * @param {string} env - a Dataverse https origin
 * @param {{ app: string, entity?: string, location?: string }} args
 * @param {object} [httpClient] - the raw az-token client for `env` (a test seam); made here when omitted
 */
async function listCommandStates(env, { app, entity, location } = {}, httpClient) {
  if (location !== undefined && !BARS.includes(location)) throw new Error(`location must be one of ${BARS.join(', ')} (got '${location}')`);
  const client = httpClient || createAzHttpClient(env);
  return withThrowawaySdk({ env, httpClient: client, prefix: 'list-command-states-' }, async (make) => {
    const sdk = make();
    // The SDK says where the API root is; the reads go through the raw client, so each answer is read whole (lib/command-state-transport.js).
    const reader = createCommandStateTransport({ client, apiUrl: (path) => sdk.dataverse.apiUrl(path) });
    const context = await resolveCommandStateContext(reader, { appUniqueName: app, entities: entity ? [entity] : undefined });
    const listed = await listCommandStateRows(reader, context, location === undefined ? {} : { location: LOCATION_BY_BAR[location] });
    const commands = listed.map(itemOf);
    return {
      ok: true,
      app: { uniqueName: context.appUniqueName, appId: context.appId },
      ...(entity ? { entity } : {}),
      ...(location !== undefined ? { location } : {}),
      optimisticConcurrency: context.optimisticConcurrency,
      tables: [...context.tables.values()].map((table) => ({ entity: table.entity, metadataId: table.metadataId, inApp: table.inApp })),
      count: commands.length,
      candidates: commands.filter((item) => item.candidate).length,
      commands,
    };
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
  const writeFlag = argv.find((arg) => typeof arg === 'string' && WRITE_FLAGS.includes(arg.replace(/^--/, '').split('=')[0]) && arg.startsWith('--'));
  if (writeFlag) usageError(`${writeFlag.split('=')[0]} is not accepted: list-command-states only reads`);
  const flagError = validateFlags(argv, { known: ['env', 'app', 'entity', 'location'], needValue: ['env', 'app', 'entity', 'location'], hints: { location: BARS.join(', ') } });
  if (flagError) usageError(flagError);
  if (positional.length) usageError(`unexpected argument '${positional[0]}'`);
  if (!flags.env) usageError('--env is required');
  if (!flags.app) usageError('--app is required: the app\'s unique name');
  let env;
  try {
    env = requireDataverseOrigin(flags.env);
  } catch (err) {
    usageError(err.message);
  }
  const entity = flags.entity === undefined ? undefined : String(flags.entity).trim().toLowerCase();
  if (entity !== undefined && !TABLE_NAME.test(entity)) usageError(`--entity '${flags.entity}' is not a table's logical name`);
  const location = flags.location === undefined ? undefined : String(flags.location);
  if (location !== undefined && !BARS.includes(location)) usageError(`--location must be one of ${BARS.join(', ')} (got '${flags.location}')`);

  // emitResult() ends the process, so the read's outcome is settled first and emitted outside the try.
  let result;
  let failure;
  try {
    result = await listCommandStates(env, { app: String(flags.app), entity, location });
  } catch (err) {
    failure = err;
  }
  if (failure) {
    const code = failure && typeof failure.code === 'string' ? failure.code : undefined;
    emitResult(false, { ok: false, ...(code ? { code } : {}), error: String((failure && failure.message) || failure) }, { ascii: true });
    return;
  }
  emitResult(true, result, { ascii: true });
}

module.exports = { listCommandStates };

if (require.main === module) {
  main().catch((err) => {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
