#!/usr/bin/env node

// Lists maker connections and Dataverse connection references for connector
// binding. Connections are not Dataverse rows: they come from the Power Apps
// connections API, which the bundled SDK reads first (`listConnections`, through the
// Business Application Platform, with an Azure CLI token for the Power Apps service)
// for an environment in the Public cloud. Where the SDK has no route — an environment in
// the Test cloud or any other (the plugin decides this from the host before asking the SDK,
// and asks PAC at once: lib/sdk-first.js says why the SDK is given no client for the
// Test cloud), a service that has been switched off (HTTP 410), a token the service
// refused (401 or 403), no Power Apps token to be had — the connections come from PAC
// instead (`pac connection list --environment <envUrl>`, parsed below) and the output
// says so; lib/sdk-first.js holds the rule and its codes. Any other
// failure of the SDK's read is a failure of this script, never answered by PAC.
// connectionreferences come from Dataverse because the GenPage runtime binds
// config.json connectorBindings[].logicalName to those rows.
//
// Usage:
//   node list-connections.js <envUrl>
//
// Output:
//   { "ok": true, "connections": [...], "connectionReferences": [...],
//     "connectionsSource": "sdk" | "pac" }
// and, when PAC answered because the SDK refused,
//     "connectionsFallback": { "code": "<the SDK's code>", "message": "..." }
// A failure — of the SDK's read (a route that serves and fails, an answer it cannot read), of PAC, of the connection references, an origin that is not a
// Dataverse one — exits 1 and prints one pure-ASCII line on stdout, and the message on stderr, as connector.js and solution-settings.js do:
//     { "ok": false, "error": "<message>", "code": "<the error's code, when it has one>" }
// (an SDK error has its code; a PAC failure, a bad origin and a refused read of the connection references have none), and — when PAC was asked because the SDK refused and then failed
// itself — the same "connectionsFallback" a PAC listing that worked has, so a failure of PAC is never read without the reason PAC was asked at all. A usage error — an unknown flag, no
// environment URL — is the exception: the problem and the usage on stderr alone, stdout empty, exit 1, before anything is read.

const { spawnResultTree } = require('./lib/process-runner.js');
const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  validateFlags,
  emitResult,
  requireDataverseOrigin,
} = require('./lib/dataverse-auth');
const { sdkFirst, connectivity } = require('./lib/sdk-first.js');
const { PAC_READ_TIMEOUT_MS, PAC_BANNER, LINE_BREAK, LEFTOVER_ADVICE, pacErrorText, stopClaim } = require('./lib/pac-fallback.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');

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

// `pac connection list` prints a GRID: after PAC's auth banner, a header row and one row per connection, every column as wide as its widest cell — the header
// name included — plus one space (live capture, PAC CLI 2.12.2; every value here is synthetic):
//   Connected as [maker001]
//   Id                               Name       API Id                                                      Status
//   00000000000000000000000000000001 Weather    /providers/Microsoft.PowerApps/apis/shared_msnweather       Connected
//   00000000000000000000000000000002 SharePoint /providers/Microsoft.PowerApps/apis/shared_sharepointonline Connected
// So the gap between two header names is not fixed: it is wide while some cell is longer than the name, and ONE space when none is. A name of four characters or
// fewer leaves "Name" the widest cell of its column, and an environment with no connections leaves every header name the widest cell of its column:
//   Id                               Name API Id                                               Status
//   00000000000000000000000000000001 mail /providers/Microsoft.PowerApps/apis/shared_office365 Connected        (one connection, named "mail")
//   Id Name API Id Status                                                                                       (no connections: the header alone, and no message)
// The last two are how PAC builds the grid — no capture of either exists. A header read by two-space gaps between its names missed both, and the empty one is the answer
// that matters, so the grid's header is recognised by its WORDS: the four names, in this order, and nothing else on the line, whatever the padding between them.
const PAC_GRID_HEADER = /^Id\s+Name\s+API\s+Id\s+Status$/i;

// Whether a row of column names is a connection table's header. A header proves the output is a table, and a table with no rows is an
// EMPTY listing — the answer that sends connection setup on to create a duplicate of a connection the maker already has — so a header is
// recognised only by a COMPLETE column set PAC prints, compared normalized (case and punctuation ignored), and never by one column that
// looks like an id column. A diagnostic that has such a column, or only mentions a connector, is prose:
//   Connection Id  could not be read.
//   Warning: failed to retrieve connector metadata.
// The first column set is the header of the grid above, which parseWhitespaceTable reads by its words (PAC_GRID_HEADER); here the same names are accepted
// under a dashed separator, where the columns are cut by the dashes. The others come from the layouts the fixtures in tests/list-connections.test.js cover:
//   Id  Name  API Id  Status                         no dashed separator
//   Connection Name  Connector Id  Connection Id      the default fixed-width table, and the plain whitespace one
//   Connection Id  Connector Id                       the two-column fixed-width table
// A build that prints another column set is refused as unreadable, which costs a re-run of `pac connection list`; a guess costs a duplicate. PAC's resources hold a
// `ConnectionListHeader` string too ("Connection ID,Connector ID,Created By"), but this command does not print it — its header is `ConnectionsListHeader`,
// "Id,Name,API Id,Status", as the grid above shows — so a table with those columns is not accepted.
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

// PAC's auth banner (`Connected as maker@contoso.onmicrosoft.com`, `Connected as [maker001]`) is recognised by the one definition every pac fallback shares —
// PAC_BANNER, with the line splitting that goes with it, in lib/pac-fallback.js: the exact shape of a WHOLE line, so that a diagnostic joined to it is not swallowed.
//
// There is NO "nothing to list" sentence in this parser, on purpose. `pac connection list` says an environment has no connections by printing the grid's header with
// no rows under it (see PAC_GRID_HEADER), never a sentence. PAC's resources do hold one — `ConnectionNotFound`, "No connections were found in the passed
// environment." — but the command does not print it (PAC CLI 2.12.2: nothing refers to that string), and an earlier version of this script took "No connections found."
// for the same job, a wording that is in none of PAC's resources. A sentence taken for emptiness is how a failure becomes "no connections" — an earlier, broader pattern
// read "No connections could be found because the request failed." that way — and that answer sends connection setup on to create a duplicate of a connection the
// maker already has. A sentence PAC never prints cannot be one that is needed, so a build that does print one is refused as unreadable, which costs a re-run, until a
// capture shows its exact wording.

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
// Blank lines and dashed separators are layout. Anything else that is not a row refuses the listing, the
// wrapped tail of a long name that older builds print on a second line included: a refusal costs a re-run of
// `pac connection list`, where a guess costs a duplicate connection.
function readTableRows(lines, readRow, layout) {
  const rows = [];
  for (const line of lines) {
    const text = line.trim();
    // The auth banner is recognised wherever it falls; any other text is not.
    if (!text || /^[\s-]+$/.test(text) || PAC_BANNER.test(text)) continue;
    const row = readRow(line);
    if (!row || !isConnectionRow(row)) {
      throw new Error(unreadableListing(null, `unrecognized connection listing — a line under the ${layout} table header is not a connection row`, text));
    }
    rows.push(row);
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
  // The grid `pac connection list` prints is found by the words of its header, whatever the padding between them; the other layouts by two-space gaps.
  const headerIndex = lines.findIndex((line) => PAC_GRID_HEADER.test(line.trim())
    || (/Connection Name|Connection Id|Connector|API Id/i.test(line) && isConnectionHeader(line.trim().split(/\s{2,}/))));
  if (headerIndex === -1) return null; // no table here — not the same as a table with no rows
  const headers = lines[headerIndex].trim().split(/\s{2,}/);
  const normalizedHeaders = headers.map(normalizeHeader);
  const isIdNameApi = PAC_GRID_HEADER.test(lines[headerIndex].trim()) || normalizedHeaders.join(',') === 'id,name,apiid,status';
  requireBannerPreamble(lines.slice(0, headerIndex), isIdNameApi ? 'Id/Name/API Id' : 'whitespace');
  // Current PAC builds emit the grid described at PAC_GRID_HEADER:
  //   Id  Name  API Id  Status
  // with no dashed separator. Names may contain spaces, so splitting each row on
  // whitespace loses the boundary. The connector API path is the stable delimiter.
  if (isIdNameApi) {
    // A row is `<id> <name, which may hold spaces> <API path> [<status, which may be several words or none>]`, however many spaces PAC left between the cells — one
    // when a cell is the widest of its column, as in `00000000000000000000000000000001 mail /providers/Microsoft.PowerApps/apis/shared_office365 Connected`:
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
//   stdout   Id Name API Id Status                           (a header and no rows)
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
  // No table and no JSON: nothing here says "no connections" (an empty environment is a header with no rows, read above), so whatever this is, it is refused.
  const hasText = text.split(LINE_BREAK).some((l) => l.trim() && !PAC_BANNER.test(l.trim()));
  throw new Error(unreadableListing(text, hasText ? 'no connection table or JSON list' : 'it printed no listing at all'));
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
  // ENOENT) or to finish in time (ETIMEDOUT) via `pac.error`, leaving `status` null. A process that ran but exited
  // non-zero has a numeric `status` (and maybe a `signal`). Distinguish them so
  // a missing PAC install produces an actionable message instead of "exit null", and a
  // slow or stalled pac is never reported as a missing one.
  if (pac.error && pac.error.code === 'ETIMEDOUT') {
    // What the call may claim about pac is what the runner confirmed (lib/pac-fallback.js stopClaim): a process pac started that still holds its output is not "stopped".
    const { stopped, claim } = stopClaim(pac.error);
    return `pac connection list did not finish within ${PAC_READ_TIMEOUT_MS / 1000} s; ${claim}.${stopped ? '' : LEFTOVER_ADVICE} A stalled call is usually transient, or pac is waiting for a sign-in (\`pac auth list\` shows the profile it uses): run it again.`;
  }
  if (pac.error) {
    return `pac connection list could not run: ${pac.error.message}. Ensure the PAC CLI is installed and on PATH (dotnet tool install -g Microsoft.PowerApps.CLI.Tool).`;
  }
  const detail = pacErrorText(String(pac.stderr || pac.stdout || ''));
  const signal = pac.signal ? `, signal ${pac.signal}` : '';
  return `pac connection list failed (exit ${pac.status}${signal})${detail ? `: ${detail}` : ''}`;
}

// The connections as `pac connection list` shows them: the path this script has always had — run PAC, refuse output it cannot read, parse what
// it can. It is the FALLBACK now, reached only when the SDK's read is refused in a way lib/sdk-first.js names (see main).
//
// `--environment` pins the listing to the environment this script was asked about. Without it pac answers for the ACTIVE organization of its auth profile, which is
// not necessarily that one: measured, a pac whose active organization was another environment listed that environment's connections, and the script printed them as
// the connections of `env` (an import that bound one of them then failed in the platform, which could not find the connection in the environment it was imported into).
//
// `refusal` is why PAC is asked at all — the SDK's `{ code, message }` (lib/sdk-first.js). A failure of PAC keeps it on the error, as connector.js and solution-settings.js keep theirs, and
// `failureLine` prints it: PAC read alone would send a maker to repair a PAC they never chose to depend on, for a route (a Test-cloud environment, a token the service refused) that is the
// real reason.
async function listConnectionsWithPac(env, refusal = null) {
  try {
    const pac = await spawnResultTree('pac', ['connection', 'list', '--environment', env], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Bounded like every other pac fallback (lib/pac-fallback.js): a pac that is stalled, or waiting for a sign-in, would otherwise hold discovery
      // for ever — and one that runs out of time has its whole process tree ended (on Windows `pac.cmd` can be cmd.exe running pac).
      timeout: PAC_READ_TIMEOUT_MS,
    });
    if (pac.error || pac.status !== 0) {
      throw new Error(pacFailureMessage(pac));
    }
    requireQuietStderr(pac.stderr);
    return parsePacConnectionList(pac.stdout);
  } catch (error) {
    // Only an object can carry it, and the error is the one PAC raised — its message and cause stay what they were.
    if (refusal && error !== null && typeof error === 'object') error.fallback = refusal;
    throw error;
  }
}

// A connection of the SDK as a row of this script's output: the three fields PAC's row has (its Id, API Id and Name columns, which the
// parsers above read into connectionId, connectorId and displayName). The row goes through the same mapper as a PAC row, so a name is
// trimmed and an empty one falls back to the connector's id exactly as it does there — the two sources give the same row for the same
// connection (measured on a Public environment: the same ids, API ids and names). The SDK's `statuses` and `connectorName` are not
// part of the row PAC gives, so they are not part of this one.
function connectionRowFromSdk(connection) {
  return mapConnectionRow({
    connectionId: connection.connectionId,
    connectorId: connection.connectorId,
    displayName: connection.displayName,
  });
}

// What a failure prints: one `ok: false` line — `error`, and the error's `code` when it has one — and `emitResult` writes the message on stderr as well. An SDK error always has a code
// (CONNECTION_ERROR for an HTTP status, CONNECTIVITY_RESPONSE_UNREADABLE for an answer it cannot read, …), and lib/sdk-first.js throws it unchanged; a `pac` failure, an origin that is not a
// Dataverse one and a refused read of the connection references are plain errors, which say what failed in their message and have none. The code is the error's own property, never
// read out of a message. A failure of `pac` carries, as `connectionsFallback` — the key a listing `pac` gave uses — the SDK's reason for asking `pac` (listConnectionsWithPac), when it has one.
function failureLine(error) {
  const code = error && typeof error.code === 'string' && error.code !== '' ? error.code : undefined;
  const fallback = error && error.fallback ? error.fallback : undefined;
  return {
    ok: false,
    error: String((error && error.message) || error),
    ...(code ? { code } : {}),
    ...(fallback ? { connectionsFallback: fallback } : {}),
  };
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
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  if (positional.length < 1) {
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }
  const [envUrl] = positional;

  try {
    // The validated origin, not the caller's text, is what every read below is made for. A URL that is not a Dataverse origin is refused
    // here, before the Azure CLI or PAC is started (PAC used to run first, and the text was refused only by the query after it).
    const env = requireDataverseOrigin(envUrl);
    const listed = await sdkFirst(env, {
      ...connectivity,
      fromSdk: async (sdk) => (await sdk.listConnections()).map(connectionRowFromSdk),
      fromPac: async (refusal) => listConnectionsWithPac(env, refusal),
    });
    const connections = listed.value;

    // NB: on `connectionreference`, `connectionid` is a plain String attribute (not a Dataverse
    // lookup), so it's selected as `connectionid` — `_connectionid_value` does not exist and 400s.
    const refsRes = await dataverseRequest(
      env,
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
      // Which source answered, so a reader who sees the PAC grid's quirks (or none) knows where the list came from, and why PAC was asked.
      connectionsSource: listed.source,
      ...(listed.fallback ? { connectionsFallback: listed.fallback } : {}),
    });
  } catch (e) {
    // Every failure past the argument checks prints the same: one pure-ASCII `ok: false` line (a raw non-ASCII character is garbled by the code page of the console that
    // captures stdout) and the message on stderr — the way connector.js and solution-settings.js print theirs — whether the SDK's read failed, `pac` did, the origin is not a
    // Dataverse one or the connection references could not be read. A caller that reads stdout alone then finds one line to parse for every outcome that got past the arguments.
    // A usage error (an unknown flag, no environment URL) is stderr alone, above, as it is in the other scripts: it is the caller's mistake, not a result.
    emitResult(false, failureLine(e), { ascii: true });
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
  failureLine,
  connectionRowFromSdk,
  listConnectionsWithPac,
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
