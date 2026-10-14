#!/usr/bin/env node
'use strict';
// list-tables: the tables of an environment, optionally the ones named by a search — through the vendored SDK. It does what
// `pac model list-tables [--search <terms>]` does — the generative-page planner and `/app-builder` use that to find out which tables exist —
// without the Power Platform CLI.
//
// The SDK's `findTables(term)` reads the environment's table definitions once —
//   GET /EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,IsCustomEntity
// — and keeps the tables whose logical name, schema name or display name contains the term, whatever the letter case. That is `pac`'s
// --search too (a substring over those three names, so `account` also finds `accountleads` and `msdyn_accountkpiitem`): measured against
// `pac model list-tables`, the same tables for the whole list and for each of five searches, and each read in a third to a seventh of the time.
//
// --search takes one term or several, comma-separated, as `pac` did. Each term is one `findTables(term)` — a read of the whole list, which the
// SDK does not cache — and the reads run a few at a time (at most READ_CONCURRENCY in flight, so a search for many terms is not one long
// queue and is not a burst either); the answers are joined, a table once (by logical name), in the order of the terms and, within a term, as
// the SDK returns them. Without --search every table is listed: about 200 KB of JSON for an environment with 1,700 tables, so a caller that
// wants a few tables searches for them.
// --exact keeps only the tables whose logical name IS a term (any letter case) and names the terms no table has: it is what the planner did by
// hand with the substring matches, "is `cr_ticket` a table or only part of the name of one". It reads the list ONCE, as the unfiltered
// listing does, however many terms there are, and picks the named tables out of it, in the order of the terms; the SDK's substring rule is
// not applied for it, so it cannot differ from, or have to be kept in step with, that rule.
// --type custom|standard|all (default all) is `pac`'s own: only the custom tables, or only the standard ones. It is what keeps the answer short for
// the planner's dominant-prefix step, which reads every table and keeps the custom ones. `custom` is the SDK's own option,
// `findTables(term, { customOnly: true })`, which keeps the tables the platform flags `IsCustomEntity` — the read is the same one — so what counts as
// custom is the SDK's and `pac`'s (every table a managed solution brought counts as custom) and never decided here. The SDK has no option for the
// other kind, so `standard` is the rows its answer flags as not custom. With --exact, a term that names a table of the other kind is `missing`.
//
// Like every script here it emits no telemetry of its own (the plugin's hooks do), and it never prints a token.
//
// Usage: node scripts/list-tables.js --env <envUrl> [--search "<term>[,<term>...]"] [--exact] [--type custom|standard|all]
//   --env     the environment's https origin, e.g. https://contoso.crm.dynamics.com
//   --search  a term, or several separated by commas (spaces around a term are dropped; a term can hold spaces)
//   --exact   with --search: only the tables whose logical name equals a term; `missing` names the terms with no table
//   --type    only the custom tables, only the standard ones, or all (the default), in any letter case
//
// Output (stdout, one pure-ASCII JSON line — every character beyond ASCII is a \uXXXX escape any JSON parser reads back), exit 0:
//   { "ok": true, "search": ["incident", "cr_ticket"], "exact": true, "type": "custom", "count": 1,
//     "tables": [ { "logicalName": "cr_ticket", "displayName": "Support Ticket", "schemaName": "cr_Ticket", "isCustom": true } ],
//     "missing": ["incident"] }
//   `search`, `exact` and `missing` appear only when --search, and --search with --exact, were given; `type` only when --type was (as typed, lower-cased).
//   `isCustom` is what `pac` printed as Type `Custom` (true) or `Standard` (false); every table a managed solution brought counts as custom. A table with
//   no display name has "".
//   A failed read: { "ok": false, "error": "<message>", "code": "<SDK error code, when it has one>" } on stdout and the message on stderr.
//
// Exit codes: 0 read; 1 usage error (stderr names the flag and the usage, stdout stays empty) or a failure to read.

const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { withThrowawaySdk } = require('./lib/throwaway-sdk.js');

const USAGE = 'Usage: node scripts/list-tables.js --env <envUrl> [--search "<term>[,<term>...]"] [--exact] [--type custom|standard|all]';
const TABLE_TYPES = ['custom', 'standard', 'all'];
const TYPE_CHOICES = 'custom, standard or all';

/**
 * The terms of a --search value: its comma-separated pieces, trimmed, with the empty ones dropped and a term given twice (in any letter case)
 * kept once, in the order first met.
 * @param {string} search
 * @returns {string[]}
 */
function searchTerms(search) {
  const seen = new Set();
  const terms = [];
  for (const piece of String(search).split(',')) {
    const term = piece.trim();
    if (term && !seen.has(term.toLowerCase())) {
      seen.add(term.toLowerCase());
      terms.push(term);
    }
  }
  return terms;
}

// What a table is to the planner: pac's four columns (logical name, display name, schema name, type), the type as the SDK's flag.
const rowOf = (table) => ({
  logicalName: table.logicalName,
  displayName: table.displayName || '',
  schemaName: table.schemaName,
  isCustom: Boolean(table.isCustom),
});

// How many reads of the table list a search for several terms has in flight at once. Each answer is a few hundred KB, and the platform limits the
// requests one user may have running at a time, so the bound is small.
const READ_CONCURRENCY = 4;

/**
 * `fn` over `items`, at most `limit` at a time, the results in the order of the items. The first failure is the failure of the whole: nothing
 * new is started after it, and a read still running is left to end on its own.
 */
async function mapBounded(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const at = next;
      next += 1;
      try {
        results[at] = await fn(items[at]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Reads the tables through the vendored SDK.
 * @param {string} env - a Dataverse https origin
 * @param {{ terms?: string[], exact?: boolean, type?: 'custom'|'standard'|'all' }} [args] - no terms: every table; no type: all of them
 * @param {object} [httpClient] - the SDK's HttpClient; the az-token one for `env` when omitted (a test seam)
 */
async function readTables(env, args = {}, httpClient) {
  const terms = args.terms || [];
  if (args.type !== undefined && !TABLE_TYPES.includes(args.type)) throw new Error(`type must be ${TYPE_CHOICES} (got '${args.type}')`);
  return withThrowawaySdk({ env, httpClient, prefix: 'list-tables-' }, async (make) => {
    const sdk = make();
    const exact = Boolean(args.exact) && terms.length > 0;
    const keyOf = (table) => String(table.logicalName).toLowerCase();
    // `custom` is the SDK's option (see the header); the other kind it has no option for.
    const find = async (term) => {
      const answer = await sdk.findTables(term, args.type === 'custom' ? { customOnly: true } : undefined);
      return args.type === 'standard' ? answer.filter((table) => !table.isCustom) : answer;
    };
    const found = new Map();
    const add = (table) => { if (!found.has(keyOf(table))) found.set(keyOf(table), rowOf(table)); };
    if (exact) {
      // One read of every table, then the tables whose logical name IS a term. A logical name is unique whatever its letter case, so a term
      // names at most one table, and the terms' order is the answer's.
      const every = new Map();
      for (const table of await find(undefined)) if (!every.has(keyOf(table))) every.set(keyOf(table), table);
      for (const term of terms) if (every.has(term.toLowerCase())) add(every.get(term.toLowerCase()));
    } else {
      // One read per term, a few at a time (each is a read of the environment's whole table list, which the SDK does not cache) — or one read, for
      // every table. The answers are joined in the order of the terms, whichever read finishes first.
      const answers = await mapBounded(terms.length ? terms : [undefined], READ_CONCURRENCY, find);
      for (const answer of answers) for (const table of answer) add(table);
    }
    const tables = [...found.values()];
    return {
      ok: true,
      ...(terms.length ? { search: terms } : {}),
      ...(exact ? { exact: true } : {}),
      ...(args.type ? { type: args.type } : {}),
      count: tables.length,
      tables,
      ...(exact ? { missing: terms.filter((term) => !tables.some((table) => table.logicalName.toLowerCase() === term.toLowerCase())) } : {}),
    };
  });
}

function usageError(message) {
  process.stderr.write(`✗ ${message}\n${USAGE}\n`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const flagError = validateFlags(argv, { known: ['env', 'search', 'exact', 'type'], needValue: ['env', 'search', 'type'], hints: { type: TYPE_CHOICES } });
  if (flagError) usageError(flagError);
  if (positional.length) usageError(`unexpected argument '${positional[0]}'`);
  if (!flags.env) usageError('--env is required');
  // A boolean flag carries no value: `parseArgs` would take the next word for one (`--exact account` is not "exact", and swallows `account`).
  if (flags.exact !== undefined && flags.exact !== true) usageError(`--exact takes no value (got '${flags.exact}')`);
  let env;
  try {
    env = requireDataverseOrigin(flags.env);
  } catch (err) {
    usageError(err.message);
  }
  const terms = flags.search === undefined ? [] : searchTerms(flags.search);
  if (flags.search !== undefined && !terms.length) usageError(`--search '${flags.search}' names no table: give a term, or several separated by commas`);
  if (flags.exact === true && flags.search === undefined) usageError('--exact needs --search: it keeps the tables whose logical name is one of the terms');
  const type = flags.type === undefined ? undefined : String(flags.type).trim().toLowerCase();
  if (type !== undefined && !TABLE_TYPES.includes(type)) usageError(`--type must be ${TYPE_CHOICES} (got '${flags.type}')`);

  // emitResult() ends the process, so the read's outcome is settled first and emitted outside the try: an exit inside it would be caught as a failure of the read.
  let result;
  let failure;
  try {
    result = await readTables(env, { terms, exact: flags.exact === true, type });
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

module.exports = { readTables, searchTerms };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
