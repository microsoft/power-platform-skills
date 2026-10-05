#!/usr/bin/env node

// Lists maker connections and Dataverse connection references for connector
// binding. Connections come from PAC because the Power Platform connection APIs
// are outside Dataverse; connectionreferences come from Dataverse because the
// GenPage runtime binds config.json connectorBindings[].logicalName to those rows.
//
// Usage:
//   node list-connections.js <envUrl>
//
// Output:
//   { "ok": true, "connections": [...], "connectionReferences": [...] }

const { spawnResultSync } = require('./lib/process-runner.js');
const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  validateFlags,
  emitResult,
} = require('./lib/dataverse-auth');

function normalizeHeader(header) {
  return String(header).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapConnectionRow(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[normalizeHeader(key)] = value;
  }
  // An identifier is a non-empty STRING, trimmed. A number, an object, an array or whitespace in an id
  // column is not one: kept, it made a row with "both ids" that no connection reference could ever bind.
  const text = (value) => (typeof value === 'string' ? value.trim() : '');

  const connectionId =
    text(normalized.connectionid) ||
    text(normalized.id) ||
    text(normalized.connection) ||
    '';
  const connectorId =
    text(normalized.connectorid) ||
    text(normalized.apiid) ||
    text(normalized.connector) ||
    extractConnectorId(connectionId) ||
    '';
  const displayName =
    text(normalized.connectionname) ||
    text(normalized.displayname) ||
    text(normalized.name) ||
    connectorId ||
    connectionId;

  return { connectorId, connectionId, displayName };
}

function extractConnectorId(connectionId) {
  const match = String(connectionId).match(/(\/providers\/Microsoft\.PowerApps\/apis\/[^/]+)\/connections/i);
  return match ? match[1] : '';
}

// Whether a row of column names is a connection table's header. A header proves the output is a table, and a table with no rows is an
// EMPTY listing — the answer that sends connection setup on to create a duplicate of a connection the maker already has — so a header is
// recognised only by a COMPLETE column set PAC prints, compared normalized (case and punctuation ignored), and never by one column that
// looks like an id column. A diagnostic that has such a column, or only mentions a connector, is prose:
//   Connection Id  could not be read.
//   Warning: failed to retrieve connector metadata.
// The column sets are the first from a live capture of `pac connection list` and the others from the layouts the fixtures in
// tests/list-connections.test.js cover:
//   Id  Name  API Id  Status                         no dashed separator
//   Connection Name  Connector Id  Connection Id      the default fixed-width table, and the plain whitespace one
//   Connection Id  Connector Id                       the two-column fixed-width table
// A build that prints another column set is refused as unreadable, which costs a re-run of `pac connection list`; a guess costs a duplicate.
const CONNECTION_TABLE_COLUMNS = new Set(['id,name,apiid,status', 'connectionname,connectorid,connectionid', 'connectionid,connectorid']);
function isConnectionHeader(names) {
  return CONNECTION_TABLE_COLUMNS.has(names.map(normalizeHeader).filter(Boolean).join(','));
}

function usableConnection(row) {
  return Boolean(row.connectorId && row.connectionId);
}

function usableConnectionRows(rows, source) {
  const usable = rows.filter(usableConnection);
  if (rows.length && !usable.length) {
    throw new Error(`pac connection list ${source} contained ${rows.length} row(s), but no usable connection rows with both connection and connector identifiers`);
  }
  return usable;
}

function parseJsonConnections(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.value;
  if (!Array.isArray(rows)) return null;
  return usableConnectionRows(rows.map(mapConnectionRow), 'JSON');
}

// PAC's auth banner, printed before any listing, and its one "nothing to list" message:
//   Connected as maker@contoso.onmicrosoft.com       (the form most PAC commands print)
//   Connected as [maker001]                          (the form `pac connection list` printed in a live capture)
//   No connections found.
// Each is recognised by its exact shape and nothing broader. The banner is a WHOLE line — `Connected as`, then one word or one bracketed
// alias (a word that opens a bracket must close it), and nothing after it — because a prefix test swallowed a diagnostic joined to it:
//   Connected as [maker001] Warning: failed to retrieve connections.
// A failure worded like the empty-state message —
//   No connections could be found because the request failed.
// — matched the earlier pattern ("no connections ... found") and read as an EMPTY environment, the answer that
// sends connection setup on to create a duplicate of a connection the maker already has. The trailing period is
// optional so a build that drops it is not refused, but no other wording is taken for emptiness: a build that
// words its empty state differently is refused as unreadable, which costs a re-run, not a duplicate.
const PAC_BANNER = /^connected as (?:[^\s[]\S*|\[[^\]\r\n]+\])$/i;
const NO_CONNECTIONS_MESSAGE = /^no connections found\.?$/i;
// A line ends at CRLF, a bare CR or LF, and PAC's output is split on all three everywhere. Deleting the CRs instead joined the line a bare
// CR ended to the next one: `Connected as [maker001]\rWarning: …` became a single line that began like the banner.
const LINE_BREAK = /\r\n|\r|\n/;

// What a table cell must look like to be an id. A table is text: a diagnostic cut on its column gaps —
//   Warning: failed | to retrieve connections.
// — fills a row's id cells as well as a real row does, and so does one that merely names a connector —
//   Warning: could not read /providers/Microsoft.PowerApps/apis/shared_sql connections
// fits the Id/Name/API Id row grammar, its first word becoming the connection id. So a cell is accepted as an id only by shape.
// A connection id is one of the shapes PAC prints:
//   00000000000000000000000000000001                                    a GUID without dashes (what `pac connection list` prints)
//   00000000-0000-0000-0000-000000000001                                a GUID with dashes
//   shared-sharepointonl-00000000-0000-0000-0000-000000000001           a connection resource name, `shared-<connector>-<guid>`
//   /providers/Microsoft.PowerApps/apis/shared_sql/connections/<id>     a full resource path
// and a connector id is its API path, or the `shared_*` name that path ends in. A bare word — `Warning:`, `conn-1` — is neither.
const GUID_WITHOUT_DASHES = '[0-9a-f]{32}';
const GUID_WITH_DASHES = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CONNECTION_ID_SHAPE = new RegExp(
  `^(?:${GUID_WITHOUT_DASHES}|${GUID_WITH_DASHES}|shared[-_][a-z0-9]+(?:[-_][a-z0-9]+)*|/providers/Microsoft\\.PowerApps/apis/[^/\\s]+/connections/\\S+)$`,
  'i'
);
const CONNECTOR_ID_SHAPE = /^(?:\/providers\/Microsoft\.PowerApps\/apis\/\S+|shared_\S+)$/i;
function isConnectionRow(row) {
  return CONNECTION_ID_SHAPE.test(row.connectionId) && CONNECTOR_ID_SHAPE.test(row.connectorId);
}

// What may precede a table's header: PAC's auth banner and blank lines, and nothing else. A warning printed first and a table after
// it was read as the table with the warning dropped — and, with no rows under the header, as an EMPTY listing, the answer that
// sends connection setup on to create a duplicate. A line this script does not recognise there means the output is one it has not
// seen, and the listing is refused, as one under the header is.
function requireBannerPreamble(lines, layout) {
  for (const line of lines) {
    const text = line.trim();
    if (!text || PAC_BANNER.test(text)) continue;
    throw new Error(unreadableListing(null, `unrecognized connection listing — a line before the ${layout} table header is not PAC's auth banner`, text));
  }
}

// The rows of a table whose header is recognised: EVERY line under it must be a connection row. A header proves
// the output is a table and says nothing about the lines below it, and a failed listing puts its diagnostics
// there — a header followed by
//   Warning: failed to retrieve connections.
// was read as an empty listing (the line has no API path) or as a connection (its words filled the id cells).
// Blank lines and dashed separators are layout, and PAC's own empty-state message is the one non-row line
// allowed — only when no row is listed, since it would contradict one. Anything else refuses the listing, the
// wrapped tail of a long name that older builds print on a second line included: a refusal costs a re-run of
// `pac connection list`, where a guess costs a duplicate connection.
function readTableRows(lines, readRow, layout) {
  const rows = [];
  let emptyMessage = null;
  for (const line of lines) {
    const text = line.trim();
    // The auth banner is recognised wherever it falls; any other text is not.
    if (!text || /^[\s-]+$/.test(text) || PAC_BANNER.test(text)) continue;
    if (NO_CONNECTIONS_MESSAGE.test(text)) { emptyMessage = text; continue; }
    const row = readRow(line);
    if (!row || !isConnectionRow(row)) {
      throw new Error(unreadableListing(null, `unrecognized connection listing — a line under the ${layout} table header is not a connection row`, text));
    }
    rows.push(row);
  }
  if (emptyMessage && rows.length) {
    throw new Error(unreadableListing(null, `unrecognized connection listing — the ${layout} table lists connections and also says there are none`, emptyMessage));
  }
  return rows;
}

function parseFixedWidthTable(raw) {
  const lines = raw.split(LINE_BREAK);
  const separatorIndex = lines.findIndex((line) => {
    const runs = line.match(/-{3,}/g) || [];
    return runs.length >= 2;
  });
  if (separatorIndex <= 0) return null; // no table here — not the same as a table with no rows

  const headerLine = lines[separatorIndex - 1];
  const ranges = [...lines[separatorIndex].matchAll(/-+/g)].map((match, index, matches) => ({
    name: headerLine.slice(match.index, matches[index + 1]?.index).trim(),
    start: match.index,
    end: matches[index + 1]?.index,
  }));
  if (!isConnectionHeader(ranges.map((range) => range.name))) return null;
  requireBannerPreamble(lines.slice(0, separatorIndex - 1), 'fixed-width');

  return readTableRows(lines.slice(separatorIndex + 1), (line) => {
    const row = {};
    for (const range of ranges) {
      row[range.name] = line.slice(range.start, range.end).trim();
    }
    return mapConnectionRow(row);
  }, 'fixed-width');
}

function parseWhitespaceTable(raw) {
  const lines = raw.split(LINE_BREAK).filter((line) => line.trim());
  const headerIndex = lines.findIndex((line) => /Connection Name|Connection Id|Connector|API Id/i.test(line)
    && isConnectionHeader(line.trim().split(/\s{2,}/)));
  if (headerIndex === -1) return null; // no table here — not the same as a table with no rows
  const headers = lines[headerIndex].trim().split(/\s{2,}/);
  const normalizedHeaders = headers.map(normalizeHeader);
  const isIdNameApi = normalizedHeaders.join(',') === 'id,name,apiid,status';
  requireBannerPreamble(lines.slice(0, headerIndex), isIdNameApi ? 'Id/Name/API Id' : 'whitespace');
  // Current PAC builds emit:
  //   Id  Name  API Id  Status
  // with no dashed separator. Names may contain spaces, so splitting each row on
  // whitespace loses the boundary. The connector API path is the stable delimiter.
  if (isIdNameApi) {
    // A row is `<id> <name, which may hold spaces> <API path> [<status, which may be several words or none>]`:
    //   00000000000000000000000000000001 Contoso Dataverse  /providers/Microsoft.PowerApps/apis/shared_commondataservice  Not connected
    // A line that does not match — a warning, JSON cut short, a connection row in a changed layout — is not a row,
    // and readTableRows refuses the listing for it.
    return readTableRows(lines.slice(headerIndex + 1), (line) => {
      const match = line.match(/^(\S+)\s+(.+?)\s+(\/providers\/Microsoft\.PowerApps\/apis\/\S+)(?:\s+(.+?))?\s*$/i);
      return match ? mapConnectionRow({ Id: match[1], Name: match[2], 'API Id': match[3], Status: match[4] || '' }) : null;
    }, 'Id/Name/API Id');
  }
  // Cells are separated by two or more spaces. readTableRows skips a dashed separator ("-----  -----"): kept as a
  // row, its dash runs read as a connection's ids and made an empty table one phantom connection.
  return readTableRows(lines.slice(headerIndex + 1), (line) => {
    const values = line.trim().split(/\s{2,}/);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    return mapConnectionRow(row);
  }, 'whitespace');
}

// Output none of the parsers recognised, or a table with a line it could not read. It is REFUSED rather than
// read as "no connections": that answer sends connection setup on to create a connection the maker already has
// — and a warning printed on a zero exit ("Warning: failed to retrieve connections."), JSON cut short, or a
// changed format are all failures to read, not an empty environment. `line` names the offending line when the
// refusal is about one (under a table header, or on stderr); otherwise the first line PAC printed after its banner
// is shown. `label` says where `line` is from.
function unreadableListing(raw, why, line, label = line === undefined ? 'first line' : 'line') {
  const shown = line !== undefined
    ? line
    : String(raw).split(LINE_BREAK).map((l) => l.trim()).find((l) => l && !PAC_BANNER.test(l)) || '(no output)';
  return `pac connection list printed output this script could not read — ${why} (${label}: "${shown.slice(0, 200)}"). `
    + 'It is not reported as "no connections", which would lead connection setup to create a duplicate; run `pac connection list` to see what it printed.';
}

// What PAC wrote to stderr on a zero exit. A real `pac connection list` that exits 0 writes nothing there, so text on it means the
// run had something to report that the table on stdout does not show — and a failed listing can still exit 0:
//   stdout   Id  Name  API Id  Status                          (a header and no rows)
//   stderr   Warning: failed to retrieve connections.
// Read from stdout alone, that was an empty environment, the answer that sends connection setup on to create a duplicate. Blank lines are
// not text, so a stderr that is only a trailing newline is clean; the first line that is not blank refuses the listing, quoted.
function requireQuietStderr(stderr) {
  const line = String(stderr == null ? '' : stderr).split(LINE_BREAK).map((l) => l.trim()).find(Boolean);
  if (line) throw new Error(unreadableListing(null, 'it exited 0 but wrote to stderr, so the listing on stdout cannot be trusted', line, 'stderr line'));
}

// The listing without the blank lines and auth-banner lines that open it. Only a banner — recognised by its exact
// shape — is skipped, never other text: a JSON listing is parsed after `Connected as <user>`, but not after a
// warning, which would be the start of output this script has not seen.
function afterLeadingBanner(text) {
  const lines = text.split(LINE_BREAK);
  let first = 0;
  while (first < lines.length && (!lines[first].trim() || PAC_BANNER.test(lines[first].trim()))) first += 1;
  return lines.slice(first).join('\n').trim();
}

function parsePacConnectionList(raw) {
  const text = String(raw == null ? '' : raw);
  // JSON is recognised by its first character (after PAC's banner), so JSON that does not parse — cut short,
  // say — is an unreadable listing rather than something for the table parsers to find nothing in.
  const body = afterLeadingBanner(text);
  if (/^[[{]/.test(body)) {
    const jsonRows = parseJsonConnections(body);
    if (jsonRows) return jsonRows;
    throw new Error(unreadableListing(text, 'it starts like JSON but is not a connection list'));
  }

  // PAC commonly emits a fixed-width table similar to:
  //   Connection Name        Connector Id                                           Connection Id
  //   ---------------------  -----------------------------------------------------  ------------------------------------
  //   Contoso SharePoint     /providers/Microsoft.PowerApps/apis/shared_sharepointonline /providers/.../connections/abc
  // Some older builds wrap friendly names but keep 2+ spaces between columns, so
  // parse fixed-width first and fall back to a whitespace table for simpler output.
  // The first table whose header is recognised decides the listing — rows, or none — so a line under it that
  // is not a row refuses the listing instead of falling through to a parser that would skip it.
  const fixed = parseFixedWidthTable(text);
  if (fixed) return fixed;
  const loose = parseWhitespaceTable(text);
  if (loose) return loose;
  // No table and no JSON: only PAC's own message says there is nothing to list.
  const lines = text.split(LINE_BREAK).map((l) => l.trim()).filter((l) => l && !PAC_BANNER.test(l));
  if (lines.length && lines.every((l) => NO_CONNECTIONS_MESSAGE.test(l))) return [];
  throw new Error(unreadableListing(text, lines.length ? 'no connection table, JSON list or "no connections found" message' : 'it printed no listing at all'));
}

function sameConnectionId(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  return Boolean(left && right && (left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)));
}

function refsForConnection(connection, connectionReferences) {
  return connectionReferences.filter((ref) => {
    const sameConnection = sameConnectionId(connection.connectionId, ref.connectionId);
    const sameConnector =
      connection.connectorId &&
      ref.connectorId &&
      String(connection.connectorId).toLowerCase() === String(ref.connectorId).toLowerCase();
    return sameConnection || sameConnector;
  });
}

function sortReadyToBindFirst(connections, connectionReferences) {
  return connections
    .map((connection) => {
      const refs = refsForConnection(connection, connectionReferences);
      // "Ready to bind" means a connectionreference is actually bound to THIS
      // connection (its connectionId matches). Matching only by connectorId is
      // not enough — that reference may be bound to a different connection (or
      // none), so binding a page to it here would not resolve at runtime. The
      // broader `connectionReferences` list still includes connector-id matches
      // for operator convenience.
      const boundRefs = refs.filter((ref) => sameConnectionId(connection.connectionId, ref.connectionId));
      return {
        ...connection,
        readyToBind: boundRefs.length > 0,
        connectionReferences: refs.map((ref) => ref.logicalName),
      };
    })
    .sort((a, b) => {
      if (a.readyToBind !== b.readyToBind) return a.readyToBind ? -1 : 1;
      return String(a.displayName).localeCompare(String(b.displayName));
    });
}

function pacFailureMessage(pac) {
  // spawnSync signals a failure to LAUNCH the process (e.g. `pac` not on PATH →
  // ENOENT) via `pac.error`, leaving `status` null. A process that ran but exited
  // non-zero has a numeric `status` (and maybe a `signal`). Distinguish the two so
  // a missing PAC install produces an actionable message instead of "exit null".
  if (pac.error) {
    return `pac connection list could not run: ${pac.error.message}. Ensure the PAC CLI is installed and on PATH (dotnet tool install -g Microsoft.PowerApps.CLI.Tool).`;
  }
  const detail = String(pac.stderr || pac.stdout || '').trim();
  const signal = pac.signal ? `, signal ${pac.signal}` : '';
  return `pac connection list failed (exit ${pac.status}${signal})${detail ? `: ${detail}` : ''}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional } = parseArgs(argv);
  const USAGE = 'Usage: node list-connections.js <envUrl>';
  // This CLI takes no flags at all, so the contract declares an EMPTY `known` set. That is not a
  // no-op: parseArgs accepts any `--name` and drops it silently while still swallowing the token
  // after it, so `--environment https://contoso.crm.dynamics.com` would leave `positional` empty
  // and report a missing envUrl — naming the symptom instead of the typo that caused it.
  const flagError = validateFlags(argv, { known: [] });
  if (flagError) {
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  if (positional.length < 1) {
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }
  const [envUrl] = positional;

  try {
    const pac = spawnResultSync('pac', ['connection', 'list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (pac.error || pac.status !== 0) {
      throw new Error(pacFailureMessage(pac));
    }
    requireQuietStderr(pac.stderr);
    const connections = parsePacConnectionList(pac.stdout);

    // NB: on `connectionreference`, `connectionid` is a plain String attribute (not a Dataverse
    // lookup), so it's selected as `connectionid` — `_connectionid_value` does not exist and 400s.
    const refsRes = await dataverseRequest(
      envUrl,
      'GET',
      'connectionreferences?$select=connectionreferencelogicalname,connectorid,connectionid'
    );
    ensureOk(refsRes, 'List connection references');
    const connectionReferences = (refsRes.data?.value || [])
      .map((row) => ({
        logicalName: row.connectionreferencelogicalname,
        connectorId: row.connectorid,
        connectionId: row.connectionid || null,
      }))
      .filter((row) => row.logicalName)
      .sort((a, b) => String(a.logicalName).localeCompare(String(b.logicalName)));

    emitResult(true, {
      ok: true,
      connections: sortReadyToBindFirst(connections, connectionReferences),
      connectionReferences,
    });
  } catch (e) {
    emitResult(false, e);
  }
}

// Only run when invoked directly as a CLI; when required by tests, export the
// pure helpers so their logic can be unit-tested without side effects.
if (require.main === module) {
  main();
}

module.exports = {
  sameConnectionId,
  refsForConnection,
  sortReadyToBindFirst,
  pacFailureMessage,
  // The `pac connection list` parsers are exported for unit tests. They consume loosely
  // structured CLI output whose shape varies across PAC builds (JSON, fixed-width table,
  // whitespace table), which is exactly the code most likely to break silently on a CLI
  // upgrade — so output none of them recognises is refused, never read as "no connections".
  parsePacConnectionList,
  parseJsonConnections,
  parseFixedWidthTable,
  parseWhitespaceTable,
  mapConnectionRow,
  extractConnectorId,
};
