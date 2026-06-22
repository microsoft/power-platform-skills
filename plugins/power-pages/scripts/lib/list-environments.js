#!/usr/bin/env node
'use strict';

// list-environments.js — enumerate the Dataverse environments the signed-in PAC
// user can access, as JSON, for ENV_LIST pre-fill (plan-alm / setup-pipeline /
// ensure-pipelines-host prompt the user with known env URLs).
//
// Why this exists:
//   The skills historically ran `pac env list --output json`. That is INVALID on
//   current PAC CLI (verified on 2.8.1): `pac env list` accepts only `--filter`
//   and errors with "An unknown argument --output was passed", so the JSON
//   pre-fill silently never worked. `pac env list` DOES emit a plain table with
//   an "Environment URL" column, so this helper runs the plain command and parses
//   that table into JSON. (`pac admin list --json` — used by pac-bap-shim.js —
//   also yields JSON, but it scopes to environments the signed-in user ADMINISTERS,
//   not the maker-accessible set `pac env list` shows, and returns a different
//   BAP-shaped object; `pac env list` is the right scope + shape for a maker
//   pre-fill, so we parse it instead.)
//
// Usage:
//   node list-environments.js            -> prints JSON array to stdout
//
// Output (JSON array; empty [] when PAC is unauthenticated / the command fails —
// the pre-fill is best-effort and callers degrade gracefully to manual entry):
//   [ { "displayName": "...", "environmentId": "...", "environmentUrl": "https://…",
//       "uniqueName": "...", "active": true|false }, ... ]
//
// Exit 0 always (callers parse stdout; [] means "no pre-fill available").

const { execSync } = require('child_process');

// Parse the plain `pac env list` table. Pure + exported for unit testing.
// Example real output (PAC 2.8.1) — note the header row, the "Connected as" banner
// line, and that the active env is flagged with `*` in the leading "Active" column:
//
//   Connected as admin@contoso.onmicrosoft.com
//   Active Display Name                     Environment ID                       Environment URL                                Unique Name
//   *      Contoso Dev                      d664a1f5-5c5b-efbf-9cc9-c1923c437109 https://contosodev.crm.dynamics.com/           unq78bd16d6e4baf01189f56045bd003
//          Contoso Prod                     e8ccb697-db78-e2d6-b721-ef23eedbc302 https://contosoprod.crm4.dynamics.com/         unqe4574a3ea1bff01195c56045bd03c
//
// Display names contain spaces and variable padding, so we anchor on the three
// unambiguous tokens that always appear in order — the 36-char environment GUID,
// the https URL, and the trailing unique name — and treat everything before the
// GUID as `[activeMarker] + displayName`.
function parseEnvList(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];
  const rows = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    // Skip the "Connected as ..." banner and the column header row.
    if (/^Connected as\b/i.test(line.trim())) continue;
    if (/^Active\s+Display Name\b/i.test(line.trim())) continue;

    // prefix = (optional `*` active marker) + display name; then GUID, URL, uniqueName.
    const m = line.match(
      /^(.*?)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(https:\/\/\S+)\s+(\S+)\s*$/i,
    );
    if (!m) continue;
    const prefix = m[1];
    // The active env is flagged with a leading `*` in the "Active" column.
    const active = /^\s*\*/.test(prefix);
    const displayName = prefix.replace(/^\s*\*?\s*/, '').trim();
    rows.push({
      displayName,
      environmentId: m[2],
      environmentUrl: m[3].replace(/\/+$/, ''),
      uniqueName: m[4],
      active,
    });
  }
  return rows;
}

function listEnvironments() {
  let stdout = '';
  try {
    stdout = execSync('pac env list', { encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    // Best-effort: an unauthenticated / failing PAC CLI yields no pre-fill, not an
    // error — callers (plan-alm Phase 1, setup-pipeline) fall back to manual entry.
    // `pac` writes its table to stdout even on some non-zero exits, so try to parse
    // whatever was captured before giving up.
    stdout = (e && (e.stdout || '')) || '';
  }
  return parseEnvList(stdout);
}

if (require.main === module) {
  // Never throw to the caller — emit [] on any failure so the consumer always
  // receives parseable JSON.
  let result = [];
  try { result = listEnvironments(); } catch { result = []; }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}

module.exports = { parseEnvList, listEnvironments };
