#!/usr/bin/env node

/**
 * list-environments.js — enumerate the Power Platform environments the signed-in PAC
 * user can access, as JSON, so `/create-mobile-app` can offer a pick list instead of
 * demanding a raw environment GUID.
 *
 * Ported from the power-pages plugin's `scripts/lib/list-environments.js`. Marketplace
 * installs copy only one plugin directory, so cross-plugin `require` is impossible and
 * each adopting plugin keeps a physical copy - the same rule the shared skills and
 * telemetry libraries follow. Keep the parser in step with that sibling.
 *
 * Why parse a table instead of asking for JSON:
 *   `pac env list --output json` is INVALID on current PAC CLI (verified on 2.12.2);
 *   `pac env list` accepts only `--filter`. It does print a plain table with an
 *   "Environment URL" column, so this helper parses that.
 *
 * The "Environment ID" column is the BAP environment GUID, which is exactly what
 * `npx power-apps init --environment-id` expects - not the Dataverse organization id.
 *
 * PAC is NOT a prerequisite of this plugin. When it is missing, unauthenticated, or
 * failing, this prints `[]` and exits 0 so the caller degrades to asking for an
 * environment ID by hand. It must never be the reason app creation cannot start.
 *
 * Ask for the narrowest thing that answers the question. A real tenant returned 224
 * environments — 47 KB, roughly 12k tokens, on a single line — so a bare call floods the
 * caller's context with environment names, URLs and GUIDs it will never show. `--active`
 * answers "which environment am I on?" in 226 bytes.
 *
 * Usage:
 *   node list-environments.js --active           -> the PAC-connected environment only
 *   node list-environments.js --filter <term>    -> narrowed server-side by PAC
 *   node list-environments.js --limit 10         -> cap the rows returned
 *   node list-environments.js                    -> every accessible environment
 *
 * Output (JSON array, always parseable, `[]` when unavailable):
 *   [ { "displayName": "...", "environmentId": "...", "environmentUrl": "https://…",
 *       "uniqueName": "...", "active": true|false }, ... ]
 */

'use strict';

const { execFileSync } = require('node:child_process');

const PAC_TIMEOUT_MS = 30000;

/**
 * Parse the plain `pac env list` table. Pure, so it is unit-testable without PAC.
 *
 * Example real output (PAC 2.12.2) — note the "Connected as" banner, the header row,
 * and the `*` flag in the leading "Active" column:
 *
 *   Connected as maker@contoso.onmicrosoft.com
 *   Active Display Name          Environment ID                       Environment URL                      Unique Name
 *   *      Contoso Dev           11111111-2222-3333-4444-555555555555 https://contosodev.crm.dynamics.com/ unq11111111111111111111111111111
 *          Contoso Prod          22222222-3333-4444-5555-666666666666 https://contosoprod.crm4.dynamics.com/ unq22222222222222222222222222222
 *
 * Display names contain spaces, variable padding, and sometimes a literal `*`
 * (a real tenant had "[DO NOT USE] Web API * Migration Testing"), so anchor on the
 * three unambiguous trailing tokens — the 36-char GUID, the https URL, and the
 * unique name — and treat everything before the GUID as `[activeMarker] + displayName`.
 * The active marker is only recognized at the START of that prefix, so an interior
 * `*` in a display name is not mistaken for it.
 */
function parseEnvList(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];

  const rows = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^Connected as\b/i.test(line.trim())) continue;
    if (/^Active\s+Display Name\b/i.test(line.trim())) continue;

    const match = line.match(
      /^(.*?)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(https:\/\/\S+)\s+(\S+)\s*$/i,
    );
    if (!match) continue;

    const prefix = match[1];
    rows.push({
      displayName: prefix.replace(/^\s*\*?\s*/, '').trim(),
      environmentId: match[2],
      environmentUrl: match[3].replace(/\/+$/, ''),
      uniqueName: match[4],
      active: /^\s*\*/.test(prefix),
    });
  }
  return rows;
}

function listEnvironments({ filter } = {}) {
  // Fixed executable, argv array, no shell: `filter` is user-supplied text and must
  // never be able to become shell syntax.
  const args = ['env', 'list'];
  if (filter) args.push('--filter', String(filter));

  let stdout = '';
  try {
    stdout = execFileSync('pac', args, { encoding: 'utf8', timeout: PAC_TIMEOUT_MS });
  } catch (error) {
    // Missing PAC (ENOENT), an unauthenticated session, or a timeout all mean "no pick
    // list", never a failed run. PAC writes its table to stdout even on some non-zero
    // exits, so parse whatever was captured before giving up.
    stdout = (error && error.stdout) || '';
  }
  return parseEnvList(stdout);
}

function activeEnvironment(rows) {
  return (rows || []).find((row) => row.active) || null;
}

/**
 * Reduce the rows to what the caller actually asked for. Applied after PAC returns, so
 * `--active` still works on a tenant where `--filter` would not help.
 */
function selectRows(rows, { active, limit } = {}) {
  let selected = rows;
  if (active) selected = selected.filter((row) => row.active);
  if (Number.isInteger(limit) && limit >= 0) selected = selected.slice(0, limit);
  return selected;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--filter') options.filter = argv[++index];
    else if (argument === '--active') options.active = true;
    else if (argument === '--limit') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 0) throw new Error('--limit must be a non-negative integer');
      options.limit = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (require.main === module) {
  // Always emit parseable JSON and always exit 0; `[]` means "ask the user instead".
  let result = [];
  try {
    const options = parseArgs(process.argv.slice(2));
    result = selectRows(listEnvironments(options), options);
  } catch {
    result = [];
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

module.exports = { activeEnvironment, listEnvironments, parseEnvList, selectRows };
