'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { loadCli } = require('./helpers/cli-harness.js');

const scriptPath = path.join(__dirname, '..', 'list-connections.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('reads connection references (ready-to-bind first)', () => {
  assert.match(scriptSrc, /connectionreferences\?\$select=connectionreferencelogicalname,connectorid,connectionid/);
  assert.match(scriptSrc, /readyToBind/);
});

test('invokes pac connection list', () => {
  assert.match(scriptSrc, /connection['"\s,]+list/);
});

test('documents raw pac output parsed', () => {
  assert.match(scriptSrc, /Connection Name/);
});

test('missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('an unknown flag is a usage error, not a token the CLI silently swallows', () => {
  // Without validateFlags, parseArgs drops `--environment` AND eats the URL after it, so this
  // typo left `positional` empty and the CLI reported a MISSING envUrl the caller had supplied.
  const res = spawnSync(
    process.execPath,
    [scriptPath, '--environment', 'https://contoso.crm.dynamics.com'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 1, 'a usage error is exit 1, distinct from the exit 3 rollback gate');
  assert.match(res.stderr, /unknown flag\(s\): --environment/);
  assert.match(res.stderr, /Usage:/);
});

// --- Unit tests for the pure helpers (require.main guard keeps main() from running) ---
const { sortReadyToBindFirst, pacFailureMessage } = require(scriptPath);

const SP_API = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';

test('readyToBind requires a connectionreference bound to THIS connection (by connectionId), not just a connectorId match', () => {
  const connections = [
    { displayName: 'Bound SP', connectionId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline/connections/aaa', connectorId: SP_API },
    { displayName: 'Unbound SP', connectionId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline/connections/bbb', connectorId: SP_API },
  ];
  const connectionReferences = [
    // bound to connection aaa via connectionId
    { logicalName: 'new_bound', connectorId: SP_API, connectionId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline/connections/aaa' },
    // same connector, but not bound to any connection (connectionId null)
    { logicalName: 'new_unbound', connectorId: SP_API, connectionId: null },
  ];
  const result = sortReadyToBindFirst(connections, connectionReferences);
  const bound = result.find((c) => c.displayName === 'Bound SP');
  const unbound = result.find((c) => c.displayName === 'Unbound SP');

  // The connection that actually has a bound connectionreference is ready to bind.
  assert.equal(bound.readyToBind, true);
  // A connection matched only by connectorId (no connectionreference bound to it) is NOT ready.
  assert.equal(unbound.readyToBind, false);
  // ...but the broader connectionReferences list still surfaces connector-id matches.
  assert.ok(unbound.connectionReferences.includes('new_bound'));
  assert.ok(unbound.connectionReferences.includes('new_unbound'));
  // Ready-to-bind connections sort first.
  assert.equal(result[0].displayName, 'Bound SP');
});

test('pacFailureMessage distinguishes a missing PAC CLI (spawn error) from a command failure', () => {
  const missing = pacFailureMessage({ error: new Error('spawn pac ENOENT'), status: null });
  assert.match(missing, /ENOENT/);
  assert.match(missing, /PATH/i);
  assert.doesNotMatch(missing, /exit null/);

  const failed = pacFailureMessage({ status: 1, stderr: 'Access denied', stdout: '' });
  assert.match(failed, /exit 1/);
  assert.match(failed, /Access denied/);
});

// --- `pac connection list` output parsing -----------------------------------
//
// This is the highest-risk code in the script: PAC emits three different shapes across builds,
// and a mis-parse is SILENT — it yields "no connections found", which reads as an environment
// with no connectors rather than as a parser that stopped working.

const {
  parsePacConnectionList, parseJsonConnections, parseWhitespaceTable, mapConnectionRow, extractConnectorId,
} = require(scriptPath);

const SP_CONN = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline/connections/abc';

test('parses the fixed-width table PAC emits by default', () => {
  //   Connection Name        Connector Id                     Connection Id
  //   ---------------------  -------------------------------  ------------------
  //   Contoso SharePoint     /providers/.../shared_sharepoint  /providers/.../connections/abc
  const raw = [
    'Connection Name        Connector Id                                                 Connection Id',
    '---------------------  -----------------------------------------------------------  ------------------------------------',
    `Contoso SharePoint     ${SP_API}  ${SP_CONN}`,
  ].join('\n');
  assert.deepEqual(parsePacConnectionList(raw), [
    { connectorId: SP_API, connectionId: SP_CONN, displayName: 'Contoso SharePoint' },
  ]);
});

test('parses a bare JSON array and derives the connector id from the connection id', () => {
  // Older/newer PAC builds emit JSON without a Connector Id column at all, so the connector has
  // to be recovered from the connection resource path or every row loses its binding target.
  const raw = JSON.stringify([
    { 'Connection Name': 'Weather', 'Connection Id': '/providers/Microsoft.PowerApps/apis/shared_msnweather/connections/z' },
  ]);
  assert.deepEqual(parsePacConnectionList(raw), [{
    connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather',
    connectionId: '/providers/Microsoft.PowerApps/apis/shared_msnweather/connections/z',
    displayName: 'Weather',
  }]);
});

test('parses the { value: [...] } JSON envelope as well as a bare array', () => {
  const raw = JSON.stringify({ value: [{ connectionId: SP_CONN, connectorId: SP_API, displayName: 'SP' }] });
  assert.deepEqual(parsePacConnectionList(raw), [{ connectorId: SP_API, connectionId: SP_CONN, displayName: 'SP' }]);
});

test('falls back to a whitespace-separated table when there is no dashed separator row', () => {
  const raw = [
    'Connection Name   Connector Id                                        Connection Id',
    `Contoso SP        ${SP_API}   ${SP_CONN}`,
  ].join('\n');
  assert.deepEqual(parseWhitespaceTable(raw), [
    { connectorId: SP_API, connectionId: SP_CONN, displayName: 'Contoso SP' },
  ]);
});

test('parses current PAC Id/Name/API Id/Status output without a separator row', () => {
  const raw = [
    'Id                               Name                                API Id                                                              Status',
    '00000000000000000000000000000001 maker@contoso.onmicrosoft.com       /providers/Microsoft.PowerApps/apis/shared_commondataservice        Connected',
    '00000000000000000000000000000002 Contoso Smoke Test - Dataverse      /providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps Connected',
  ].join('\n');

  assert.deepEqual(parsePacConnectionList(raw), [
    {
      connectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataservice',
      connectionId: '00000000000000000000000000000001',
      displayName: 'maker@contoso.onmicrosoft.com',
    },
    {
      connectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
      connectionId: '00000000000000000000000000000002',
      displayName: 'Contoso Smoke Test - Dataverse',
    },
  ]);
});

// The layout of a real `pac connection list` capture (recorded from a live run; every value here is synthetic): PAC's
// `Connected as [<alias>]` banner, then a header whose columns start at offsets 0, 33, 44 and 104, one row per connection in
// those columns, no separator row and no blank line before the header, CRLF line endings, and a blank line after the last
// row. Built by column offset, so it cannot drift from that shape:
//   Connected as [maker001]
//   Id                               Name       API Id                                                      Status
//   00000000000000000000000000000001 Weather    /providers/Microsoft.PowerApps/apis/shared_msnweather       Connected
const realRow = (id, name, api, status) => `${id.padEnd(33)}${name.padEnd(11)}${api.padEnd(60)}${status}`;
const REAL_BANNER = 'Connected as [maker001]';
const REAL_HEADER = realRow('Id', 'Name', 'API Id', 'Status');
const REAL_ROWS = [
  realRow('00000000000000000000000000000001', 'Weather', '/providers/Microsoft.PowerApps/apis/shared_msnweather', 'Connected'),
  realRow('00000000000000000000000000000002', 'SharePoint', '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', 'Connected'),
];
const realListing = (...lines) => `${[REAL_BANNER, REAL_HEADER, ...lines].join('\r\n')}\r\n\r\n`;
const REAL_LISTING = realListing(...REAL_ROWS);
const REAL_CONNECTIONS = [
  { connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather', connectionId: '00000000000000000000000000000001', displayName: 'Weather' },
  { connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', connectionId: '00000000000000000000000000000002', displayName: 'SharePoint' },
];

test('parses the exact layout of a real `pac connection list` capture, banner and CRLF included', () => {
  assert.deepEqual(REAL_LISTING.split('\r\n').map((line) => line.length), [23, 110, 113, 113, 0, 0], 'the same line lengths as the capture');
  assert.deepEqual(parsePacConnectionList(REAL_LISTING), REAL_CONNECTIONS);
  assert.deepEqual(parsePacConnectionList(REAL_LISTING.replace(/\r\n/g, '\n')), REAL_CONNECTIONS, 'the same output with LF endings');
  assert.deepEqual(parsePacConnectionList(realListing()), [], 'the real header with no rows is an empty listing');
  for (const [what, raw] of Object.entries(UNREADABLE_REAL_LISTINGS)) {
    assert.throws(() => parsePacConnectionList(raw), /unrecognized connection listing/, what);
  }
});

// A line under a recognised table header that is not a connection row is a failure to read, whether the table
// holds no usable row or some — a changed column layout, a warning, a wrapped name — so the listing is refused
// rather than answered with the rows that happened to parse (or with none).
test('an Id/Name/API Id listing with a line that is not a connection row fails closed', () => {
  const header = 'Id                               Name                                API Id                                                              Status';
  // Connection rows read wrong: each carries a connector's API path but not the columns around it.
  assert.throws(() => parsePacConnectionList([header, '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', 'Contoso /providers/Microsoft.PowerApps/apis/shared_office365'].join('\n')),
    /unrecognized connection listing[\s\S]*Id\/Name\/API Id[\s\S]*"\/providers\/Microsoft\.PowerApps\/apis\/shared_sharepointonline"/);
  // PAC's own empty-state message under the header is still an empty listing.
  assert.deepEqual(parsePacConnectionList([header, 'No connections found.'].join('\n')), []);
  // A Status of several words, or none, still parses.
  const status = (s) => `00000000000000000000000000000001 Contoso Dataverse                   /providers/Microsoft.PowerApps/apis/shared_commondataservice${s}`;
  for (const s of ['        Not connected', '']) {
    assert.deepEqual(parsePacConnectionList([header, status(s)].join('\n')).map((r) => r.connectionId), ['00000000000000000000000000000001'], JSON.stringify(s));
  }
  const mixed = [header,
    '00000000000000000000000000000001 Contoso Dataverse                   /providers/Microsoft.PowerApps/apis/shared_commondataservice        Connected',
    '(wrapped name tail)'].join('\n');
  assert.throws(() => parsePacConnectionList(mixed), /unrecognized connection listing[\s\S]*"\(wrapped name tail\)"/, 'a row beside the unreadable line is not offered on its own');
  assert.deepEqual(parsePacConnectionList(header), [], 'a header with no rows is still an empty listing');
});

const REAL_WARNING = 'Warning: failed to retrieve connections.';
// The real layout with something other than a connection row, or a banner, where a row or a banner belongs: none of these is an empty
// listing, and none is a listing whose bad line may be dropped. (Used by the tests above and below.)
const UNREADABLE_REAL_LISTINGS = {
  'a warning in place of the rows': realListing(REAL_WARNING),
  'a warning after the rows': realListing(...REAL_ROWS, REAL_WARNING),
  'a warning between the rows': realListing(REAL_ROWS[0], REAL_WARNING, REAL_ROWS[1]),
  'a warning before the rows': realListing(REAL_WARNING, ...REAL_ROWS),
  'a warning before the header, after the banner': `${[REAL_BANNER, REAL_WARNING, REAL_HEADER, ...REAL_ROWS].join('\r\n')}\r\n\r\n`,
  'a warning before the header, with no rows': `${[REAL_BANNER, REAL_WARNING, REAL_HEADER].join('\r\n')}\r\n\r\n`,
  'a warning where the banner belongs': `${[REAL_WARNING, REAL_HEADER, ...REAL_ROWS].join('\r\n')}\r\n\r\n`,
  'a diagnostic that names an API path': realListing('Warning: could not read /providers/Microsoft.PowerApps/apis/shared_msnweather connections'),
  'JSON cut off after the header': realListing('[{"Id":'),
  'a row cut off after its name': realListing(REAL_ROWS[0].slice(0, 44)),
  'a wrapped name': realListing(REAL_ROWS[0], '(wrapped name tail)'),
  'a failure worded like emptiness': realListing('No connections could be found because the request failed.'),
};

test('header matching is case- and punctuation-insensitive', () => {
  // normalizeHeader strips non-alphanumerics and lower-cases, so "Connection Id", "connectionId"
  // and "CONNECTION-ID" are the same column. Without that, a cosmetic CLI header change silently
  // empties every row.
  for (const row of [
    { 'Connection Name': 'N', 'Connector Id': 'C', 'Connection Id': 'I' },
    { connectionName: 'N', connectorId: 'C', connectionId: 'I' },
    { 'CONNECTION-NAME': 'N', 'CONNECTOR_ID': 'C', 'connection id': 'I' },
  ]) {
    assert.deepEqual(mapConnectionRow(row), { connectorId: 'C', connectionId: 'I', displayName: 'N' });
  }
});

test('extractConnectorId returns the api path, or empty string when there is none', () => {
  assert.equal(extractConnectorId(SP_CONN), SP_API);
  // Empty string (not null/undefined) — mapConnectionRow ORs through this value, so a nullish
  // return would fall through to a different field and mislabel the row.
  assert.equal(extractConnectorId('garbage'), '');
});

// Output no parser recognises is REFUSED, never read as "no connections". That answer sends the connector
// agent on to CREATE a connection (genpage-connector-builder.md, "No suitable connection exists"), so an
// unreadable listing — a warning printed on a zero exit, JSON cut short, a changed format — would make a
// duplicate of a connection the maker already has.
test('unreadable output is refused, never read as "no connections"', () => {
  for (const raw of ['Warning: failed to retrieve connections.', 'not JSON', '[{"Id":', '{"unexpected":true}', 'no table here', '', 'Connected as maker@contoso.onmicrosoft.com\r\n', 'null',
    // Prose that only MENTIONS a connector or an id column is not a table header — nor is prose over a run of dashes.
    'Warning: failed to retrieve connector metadata.', 'Connection Id could not be read.',
    'Status of connector refresh\n------  -------\n', 'Connector  Status\nshared_sql  Connected\n']) {
    assert.throws(() => parsePacConnectionList(raw), /could not read[\s\S]*not reported as "no connections"/, JSON.stringify(raw));
  }
  assert.throws(() => parsePacConnectionList('Warning: failed to retrieve connections.'), /first line: "Warning: failed to retrieve connections\."/);
  // The helper itself still answers "not JSON" with null, for the caller to judge.
  assert.equal(parseJsonConnections('{not json'), null);
  assert.equal(parseJsonConnections('"a string"'), null);
});

test('an empty listing is one PAC itself reports as empty', () => {
  for (const raw of ['[]', '{"value":[]}', 'No connections found.', 'Connected as maker@contoso.onmicrosoft.com\r\nNo connections found.\r\n',
    'Connected as maker@contoso.onmicrosoft.com\r\nId                               Name       API Id                                                      Status\r\n',
    'Connection Name    Connector Id    Connection Id\n---------------    ------------    -------------\n']) {
    assert.deepEqual(parsePacConnectionList(raw), [], JSON.stringify(raw));
  }
});

// An identifier is a non-empty string. Whitespace, a number, an object or an array in an id column made a
// row with "both ids" that nothing could ever bind — offered to the maker as a real connection.
test('identifiers must be non-empty strings, trimmed', () => {
  for (const [Id, ConnectorId] of [['   ', '\t'], [42, 27], [{ nested: 'x' }, { nested: 'y' }], [['a'], ['b']]]) {
    assert.throws(() => parsePacConnectionList(JSON.stringify([{ Id, ConnectorId }])), /no usable connection rows/, JSON.stringify({ Id, ConnectorId }));
  }
  assert.deepEqual(parsePacConnectionList(JSON.stringify([{ Id: '  connection-a ', ConnectorId: ` ${SP_API}\t` }])),
    [{ connectorId: SP_API, connectionId: 'connection-a', displayName: SP_API }]);
});

test('rows with no identifying field at all are dropped', () => {
  const raw = JSON.stringify([{ 'Connection Name': '', 'Connection Id': '' }, { 'Connection Name': 'Real', 'Connection Id': SP_CONN }]);
  assert.deepEqual(parsePacConnectionList(raw).map((r) => r.displayName), ['Real']);
});

test('display-name-only JSON rows fail instead of becoming selectable connections', () => {
  assert.throws(
    () => parsePacConnectionList(JSON.stringify([{ Name: 'Looks Real But Has No IDs' }])),
    /no usable connection rows/i,
  );
});

// Beside real rows, an unidentified JSON row is dropped rather than offered: JSON is structured, so a row with
// no ids is a record PAC emitted without them, not a diagnostic. In a TABLE the same row would be a line of text
// — a wrapped name tail, a warning — and the table is refused instead (see the diagnostics test below).
test('a JSON row without both ids is dropped beside usable rows, never offered as a phantom connection', () => {
  const rows = parsePacConnectionList(JSON.stringify([
    { Name: 'Contoso SharePoint (wrapped name continues here)' },
    { Name: 'Contoso SharePoint', Id: SP_CONN },
  ]));
  assert.deepEqual(rows, [{ connectorId: SP_API, connectionId: SP_CONN, displayName: 'Contoso SharePoint' }]);
});

// A recognised header proves the output is a table. It says nothing about the lines under it, and those are
// where a failed listing puts its diagnostics: a header followed by "Warning: failed to retrieve connections."
// was read as an EMPTY listing (the Id/Name/API Id layout dropped any line without an API path), or — in the
// fixed-width layout — as a connection whose ids were "Warning: failed" and "to retrieve connections.".
// Every line under a header must be a connection row, and a row's ids must have the shape of ids.
test('a diagnostic under a recognised table header fails closed in every layout', () => {
  const idNameApi = 'Id                               Name                                API Id                                                              Status';
  const goodRow = '00000000000000000000000000000001 Contoso Dataverse                   /providers/Microsoft.PowerApps/apis/shared_commondataservice        Connected';
  const fixedHeader = [
    'Connection Name        Connector Id                                                Connection Id',
    '---------------------  ----------------------------------------------------------  ------------------------------',
  ];
  const fixedRow = `Contoso SharePoint     ${SP_API.padEnd(58)}  ${SP_CONN}`;
  const warning = 'Warning: failed to retrieve connections.';
  const refused = /could not read[\s\S]*unrecognized connection listing[\s\S]*not reported as "no connections"/;
  const cases = {
    'Id/Name/API Id, alone': ['Id  Name  API Id  Status', warning],
    'Id/Name/API Id, truncated JSON': ['Id  Name  API Id  Status', '[{"Id":'],
    'Id/Name/API Id, after a banner': ['Connected as maker@contoso.onmicrosoft.com', idNameApi, warning],
    'Id/Name/API Id, beside a good row': [idNameApi, goodRow, warning],
    'Id/Name/API Id, before a good row': [idNameApi, warning, goodRow],
    'fixed-width Connection Id/Connector Id': ['Connection Id  Connector Id', '-------------  ------------', warning],
    'fixed-width, beside a good row': [...fixedHeader, fixedRow, warning],
    'fixed-width, a wrapped name tail': [...fixedHeader, fixedRow, '(wrapped name tail)'],
    'fixed-width, cells that are not ids': [...fixedHeader, 'Warning:  failed  retry'],
    'whitespace table, alone': ['Connection Name   Connector Id   Connection Id', warning],
    'whitespace table, beside a good row': ['Connection Name   Connector Id   Connection Id', `Contoso SP        ${SP_API}   ${SP_CONN}`, warning],
    'whitespace table, cells that are not ids': ['Connection Name   Connector Id   Connection Id', 'Warning:  failed  retry'],
  };
  for (const [what, lines] of Object.entries(cases)) {
    for (const eol of ['\n', '\r\n']) {
      assert.throws(() => parsePacConnectionList(lines.join(eol)), refused, `${what} (${JSON.stringify(eol)})`);
    }
  }
  // The refusal names the line it could not read, not just the header above it.
  assert.throws(() => parsePacConnectionList(['Id  Name  API Id  Status', warning].join('\n')), /line: "Warning: failed to retrieve connections\."/);
  // The phantom the fixed-width layout used to build from the warning is gone.
  assert.throws(() => parsePacConnectionList(['Connection Id  Connector Id', '-------------  ------------', warning].join('\n')), /unrecognized connection listing/);
});

// The lines BEFORE a header are as much of the listing as the ones under it. A warning printed first, then a table, was read as the
// table with the warning dropped — and, with no rows under the header, as an EMPTY listing. Only PAC's auth banner and blank lines
// may open a listing: any other line means this script has not seen the output before, and says so.
test('a line other than the banner before a recognised table header is refused, not dropped, in every layout', () => {
  const idNameApi = 'Id                               Name                                API Id                                                              Status';
  const goodRow = '00000000000000000000000000000001 Contoso Dataverse                   /providers/Microsoft.PowerApps/apis/shared_commondataservice        Connected';
  const fixedHeader = [
    'Connection Name        Connector Id                                                Connection Id',
    '---------------------  ----------------------------------------------------------  ------------------------------',
  ];
  const fixedRow = `Contoso SharePoint     ${SP_API.padEnd(58)}  ${SP_CONN}`;
  const wsHeader = 'Connection Name   Connector Id   Connection Id';
  const wsRow = `Contoso SP        ${SP_API}   ${SP_CONN}`;
  const warning = 'Warning: failed to retrieve connections.';
  const refused = /could not read[\s\S]*unrecognized connection listing[\s\S]*before the[\s\S]*table header[\s\S]*not reported as "no connections"/;
  const cases = {
    'Id/Name/API Id, header only': [warning, 'Id  Name  API Id  Status'],
    'Id/Name/API Id, with a row': [warning, idNameApi, goodRow],
    'Id/Name/API Id, after the banner': ['Connected as maker@contoso.onmicrosoft.com', warning, idNameApi, goodRow],
    'Id/Name/API Id, between two banners': ['Connected as a@contoso.com', warning, 'Connected as b@contoso.com', idNameApi, goodRow],
    'Id/Name/API Id, text that only resembles the banner': ['Connected to maker@contoso.onmicrosoft.com', idNameApi, goodRow],
    'Id/Name/API Id, the empty-state message is not preamble': ['No connections found.', idNameApi],
    'fixed-width, header only': [warning, ...fixedHeader],
    'fixed-width, with a row': [warning, ...fixedHeader, fixedRow],
    'fixed-width, after the banner': ['Connected as maker@contoso.onmicrosoft.com', warning, ...fixedHeader, fixedRow],
    'whitespace table, header only': [warning, wsHeader],
    'whitespace table, with a row': [warning, wsHeader, wsRow],
    'whitespace table, after the banner': ['Connected as maker@contoso.onmicrosoft.com', warning, wsHeader, wsRow],
  };
  for (const [what, lines] of Object.entries(cases)) {
    for (const eol of ['\n', '\r\n']) {
      assert.throws(() => parsePacConnectionList(lines.join(eol)), refused, `${what} (${JSON.stringify(eol)})`);
    }
  }
  // The refusal names the line it could not place, not the header after it.
  assert.throws(() => parsePacConnectionList([warning, idNameApi, goodRow].join('\n')), /line: "Warning: failed to retrieve connections\."/);
  // Controls: the banner — however many — and blank lines open a listing, and so does nothing at all.
  const layouts = {
    'Id/Name/API Id': [[idNameApi, goodRow], '00000000000000000000000000000001'],
    'fixed-width': [[...fixedHeader, fixedRow], SP_CONN],
    'whitespace': [[wsHeader, wsRow], SP_CONN],
  };
  for (const [layout, [table, id]] of Object.entries(layouts)) {
    for (const opening of [[], [''], ['   '], ['Connected as maker@contoso.onmicrosoft.com'], ['Connected as [maker001]', ''], ['', 'Connected as a@contoso.com', 'Connected as b@contoso.com', '  ']]) {
      for (const eol of ['\n', '\r\n']) {
        assert.deepEqual(parsePacConnectionList([...opening, ...table].join(eol)).map((r) => r.connectionId), [id], `${layout} after ${JSON.stringify(opening)}`);
      }
    }
  }
});

// A table is text, and a diagnostic that happens to name a connector's API path fits the Id/Name/API Id row grammar: its first word
// becomes the connection id (`Warning:`). So a connection id must be one of the shapes PAC prints:
//   a GUID with or without dashes · a connection resource name `shared-<connector>-<guid>` · a full /providers/…/connections/<id> path
test('a connection id must be one of the shapes PAC prints, so a diagnostic that names an API path is not a connection', () => {
  const idNameApi = 'Id                               Name                                API Id                                                              Status';
  const row = (id) => `${id}  Contoso SQL  /providers/Microsoft.PowerApps/apis/shared_sql  Connected`;
  const refused = /could not read[\s\S]*unrecognized connection listing[\s\S]*not a connection row[\s\S]*not reported as "no connections"/;
  for (const diagnostic of [
    'Warning: could not read /providers/Microsoft.PowerApps/apis/shared_sharepointonline connections',
    'Error: connector /providers/Microsoft.PowerApps/apis/shared_sql is unavailable',
    'Warning  /providers/Microsoft.PowerApps/apis/shared_sql',
  ]) {
    assert.throws(() => parsePacConnectionList([idNameApi, diagnostic].join('\n')), refused, diagnostic);
    assert.throws(() => parsePacConnectionList([idNameApi, row('00000000000000000000000000000001'), diagnostic].join('\n')), refused, `beside a row: ${diagnostic}`);
    assert.throws(() => parsePacConnectionList([REAL_BANNER, REAL_HEADER, diagnostic].join('\r\n')), refused, `in the real layout: ${diagnostic}`);
  }
  for (const id of ['Warning:', 'Warning', 'Error:', '0000000000000000000000000000000G', '0000000000000000000000000000001', '000000000000000000000000000000001',
    '00000000-0000-0000-0000000000000001', 'conn-1', 'abc', 'shared', 'shared-', 'shared--x', 'shared-sharepointonl-0000!',
    '/providers/Microsoft.PowerApps/apis/shared_sql', '/providers/Microsoft.PowerApps/apis/shared_sql/connections/']) {
    assert.throws(() => parsePacConnectionList([idNameApi, row(id)].join('\n')), refused, `connection id ${id}`);
  }
  for (const id of ['00000000000000000000000000000001', 'ABCDEF0123456789abcdef0123456789', '00000000-0000-4000-8000-000000000001',
    'shared-sharepointonl-00000000-0000-4000-8000-000000000001', 'shared_sql-0001', '/providers/Microsoft.PowerApps/apis/shared_sql/connections/sql1']) {
    assert.deepEqual(parsePacConnectionList([idNameApi, row(id)].join('\n')).map((r) => r.connectionId), [id], `connection id ${id}`);
  }
  // The older layouts read their ids by the same rule: a short name is not an id there either.
  assert.throws(() => parsePacConnectionList(['Connection Name   Connector Id   Connection Id', 'Weather   shared_msnweather   conn-1'].join('\n')), /unrecognized connection listing/);
  assert.deepEqual(parsePacConnectionList(['Connection Name   Connector Id   Connection Id', 'Weather   shared_msnweather   00000000000000000000000000000001'].join('\n')).map((r) => r.connectionId), ['00000000000000000000000000000001']);
});

// Control for the test above: the same layouts with only real rows, and with the shapes they allow, still parse.
test('tables of real rows, a trailing blank line and a separator-only line still parse', () => {
  const idNameApi = 'Id                               Name                                API Id                                                              Status';
  const goodRow = '00000000000000000000000000000001 Contoso Dataverse                   /providers/Microsoft.PowerApps/apis/shared_commondataservice        Connected';
  assert.deepEqual(parsePacConnectionList(`Connected as maker@contoso.onmicrosoft.com\r\n\r\n${idNameApi}\r\n${goodRow}\r\n\r\n`).map((r) => r.connectionId), ['00000000000000000000000000000001']);
  const table = [
    'Connection Name        Connector Id                                                Connection Id',
    '---------------------  ----------------------------------------------------------  ------------------------------',
    `Contoso SharePoint     ${SP_API.padEnd(58)}  ${SP_CONN}`,
    '',
    '   ',
  ].join('\n');
  assert.deepEqual(parsePacConnectionList(table).map((r) => r.connectionId), [SP_CONN]);
  // PAC's auth banner is recognised wherever it falls, even under the header; nothing else is skipped there.
  assert.deepEqual(parsePacConnectionList(`${idNameApi}\n${goodRow}\nConnected as maker@contoso.onmicrosoft.com\n`).map((r) => r.connectionId), ['00000000000000000000000000000001']);
  // A bare `shared_*` connector name is an API id too, and a connection resource name (`shared-<connector>-<guid>`) is an id.
  const loose = ['Connection Name   Connector Id   Connection Id', 'Weather   shared_msnweather   shared-msnweather-00000000-0000-4000-8000-000000000001'].join('\n');
  assert.deepEqual(parsePacConnectionList(loose), [{ connectorId: 'shared_msnweather', connectionId: 'shared-msnweather-00000000-0000-4000-8000-000000000001', displayName: 'Weather' }]);
});

// Emptiness is PAC's own statement that there is nothing to list — or a header with no rows. A broad pattern
// ("no connections ... found") accepted "No connections could be found because the request failed.", the
// answer that sends connection setup on to create a duplicate of a connection the maker already has.
test('only the exact PAC empty-state message, or a header with no rows, reads as an empty listing', () => {
  const idNameApi = 'Id  Name  API Id  Status';
  for (const raw of ['No connections found.', 'no connections found', 'No connections found.\r\n', '\r\n  No connections found.  \r\n',
    'Connected as maker@contoso.onmicrosoft.com\nNo connections found.', 'Connected as a@contoso.com\nConnected as b@contoso.com\n\nNo connections found.',
    idNameApi, `${idNameApi}\nNo connections found.`, `${idNameApi}\n\n`, '[]', '{"value":[]}']) {
    assert.deepEqual(parsePacConnectionList(raw), [], JSON.stringify(raw));
  }
  for (const raw of ['No connections could be found because the request failed.', 'No connections found because the request failed.',
    'No connections were found.', 'No connection found.', 'No connections found. Try again later.', 'No connections found.\nWarning: partial failure',
    'Warning: partial failure\nNo connections found.', 'No connections found.\nNo connections found. Retrying...',
    // The message beside a row contradicts it: neither is trusted.
    `${idNameApi}\n00000000000000000000000000000001 Contoso Dataverse  /providers/Microsoft.PowerApps/apis/shared_commondataservice  Connected\nNo connections found.`]) {
    assert.throws(() => parsePacConnectionList(raw), /could not read[\s\S]*not reported as "no connections"/, JSON.stringify(raw));
  }
});

// PAC prints its auth banner before a JSON listing as it does before a table. It is recognised by its exact
// shape — "Connected as <user>" — and only at the start; text of any other kind before the JSON is not skipped.
test('a JSON listing after PAC\'s auth banner is parsed, but arbitrary leading or trailing text is refused', () => {
  const json = JSON.stringify([{ 'Connection Name': 'Contoso SharePoint', 'Connector Id': SP_API, 'Connection Id': SP_CONN }]);
  const expected = [{ connectorId: SP_API, connectionId: SP_CONN, displayName: 'Contoso SharePoint' }];
  for (const raw of [json, `Connected as maker@contoso.onmicrosoft.com\n${json}`, `\r\nConnected as maker@contoso.onmicrosoft.com\r\n\r\n${json}\r\n`,
    `Connected as a@contoso.com\nConnected as b@contoso.com\n${json}`]) {
    assert.deepEqual(parsePacConnectionList(raw), expected, JSON.stringify(raw));
  }
  assert.deepEqual(parsePacConnectionList('Connected as maker@contoso.onmicrosoft.com\n[]'), []);
  for (const raw of [`Warning: failed to retrieve connections.\n${json}`, `Connected as maker@contoso.onmicrosoft.com\nWarning: slow response\n${json}`,
    `Connected as maker@contoso.onmicrosoft.com\n[{"Id":`, `${json}\nWarning: trailing text`, `Id  Name  API Id  Status\n${json}`,
    `Please sign in\n${json}`]) {
    assert.throws(() => parsePacConnectionList(raw), /could not read[\s\S]*not reported as "no connections"/, JSON.stringify(raw));
  }
});

// A row's ids must have the shape of ids: a connection id is one token, and a connector id an API path or a
// `shared_*` name — so a line of prose split on two-space gaps is not a connection.
test('table cells that are not ids are not a connection', () => {
  for (const [connection, connector] of [['Warning: failed', 'to retrieve connections.'], ['two words', SP_API], ['conn-1', 'not an api id'], ['conn-1', 'failed'], ['', SP_API]]) {
    const table = ['Connection Id        Connector Id', '-------------------  ----------------------------------------------------------',
      `${connection.padEnd(19)}  ${connector}`].join('\n');
    assert.throws(() => parsePacConnectionList(table), /unrecognized connection listing/, JSON.stringify([connection, connector]));
  }
});

// main() is the only place a PAC result becomes a connection-reference query and then a structured
// result. Parser unit tests never see a zero exit with a warning turned into `{ ok: true, connections: [] }`,
// which is the answer that sends connection setup on to create a duplicate.
const ENV_URL = 'https://contoso.crm.dynamics.com';
const SQL_API = '/providers/Microsoft.PowerApps/apis/shared_sql';
const SQL_CONN = '/providers/Microsoft.PowerApps/apis/shared_sql/connections/sql1';

function driveDiscovery({ pac, refs, refsError }) {
  const spawned = [];
  const queries = [];
  const emitted = [];
  const real = require('../lib/dataverse-auth.js');
  const cli = loadCli(scriptPath, {
    argv: [ENV_URL],
    requires: {
      './lib/process-runner.js': {
        spawnResultSync: (cmd, args, opts) => {
          spawned.push({ cmd, args, opts });
          return pac;
        },
      },
      // Required without the `.js` suffix. emitResult sits inside main's try, so a throwing stand-in
      // would be caught and re-reported as a discovery failure — hiding the payload under test.
      // The real printer exits instead of throwing, which is what this recording stands in for.
      './lib/dataverse-auth': {
        parseArgs: real.parseArgs,
        validateFlags: real.validateFlags,
        ensureOk: real.ensureOk,
        dataverseRequest: async (envUrl, method, apiPath) => {
          queries.push({ envUrl, method, apiPath });
          if (refsError) throw refsError;
          return refs;
        },
        emitResult: (ok, payload) => { emitted.push({ ok, payload }); },
      },
    },
  });
  return cli.main().then(() => ({ spawned, queries, emitted }));
}

test('CLI discovery failure is not an empty success', async () => {
  const warning = 'Warning: failed to retrieve connections.';
  const warningMessage = 'pac connection list printed output this script could not read — no connection table, JSON list or "no connections found" message '
    + `(first line: "${warning}"). It is not reported as "no connections", which would lead connection setup to create a duplicate; run \`pac connection list\` to see what it printed.`;
  const malformed = '[{"Id":';
  const malformedMessage = 'pac connection list printed output this script could not read — it starts like JSON but is not a connection list '
    + `(first line: "${malformed}"). It is not reported as "no connections", which would lead connection setup to create a duplicate; run \`pac connection list\` to see what it printed.`;

  const refused = await driveDiscovery({ pac: { status: 0, stdout: warning, stderr: '' } });
  assert.deepEqual(refused.spawned.map((s) => [s.cmd, s.args]), [['pac', ['connection', 'list']]]);
  assert.deepEqual(refused.queries, [], 'a warning on exit 0 must not query connection references');
  assert.equal(refused.emitted.length, 1);
  assert.equal(refused.emitted[0].ok, false);
  assert.equal(refused.emitted[0].payload.message, warningMessage);

  const badTable = await driveDiscovery({ pac: { status: 0, stdout: malformed, stderr: '' } });
  assert.deepEqual(badTable.queries, []);
  assert.equal(badTable.emitted[0].ok, false);
  assert.equal(badTable.emitted[0].payload.message, malformedMessage);

  const nonzero = await driveDiscovery({ pac: { status: 2, stdout: '', stderr: 'Access denied' } });
  assert.deepEqual(nonzero.queries, []);
  assert.equal(nonzero.emitted[0].ok, false);
  assert.equal(nonzero.emitted[0].payload.message, 'pac connection list failed (exit 2): Access denied');

  const missing = await driveDiscovery({ pac: { error: new Error('spawn pac ENOENT'), status: null, stdout: '', stderr: '' } });
  assert.deepEqual(missing.queries, []);
  assert.equal(missing.emitted[0].ok, false);
  assert.equal(
    missing.emitted[0].payload.message,
    'pac connection list could not run: spawn pac ENOENT. Ensure the PAC CLI is installed and on PATH (dotnet tool install -g Microsoft.PowerApps.CLI.Tool).'
  );

  const empty = await driveDiscovery({
    pac: { status: 0, stdout: 'No connections found.', stderr: '' },
    refs: { status: 200, data: { value: [] } },
  });
  assert.deepEqual(empty.queries, [{
    envUrl: ENV_URL,
    method: 'GET',
    apiPath: 'connectionreferences?$select=connectionreferencelogicalname,connectorid,connectionid',
  }]);
  assert.deepEqual(empty.emitted, [{
    ok: true,
    payload: { ok: true, connections: [], connectionReferences: [] },
  }]);

  const listed = await driveDiscovery({
    pac: {
      status: 0,
      stdout: JSON.stringify([
        { 'Connection Name': 'Zulu SQL', 'Connector Id': SQL_API, 'Connection Id': SQL_CONN },
        { 'Connection Name': 'Alpha SharePoint', 'Connector Id': SP_API, 'Connection Id': SP_CONN },
      ]),
      stderr: '',
    },
    refs: {
      status: 200,
      data: {
        value: [
          { connectionreferencelogicalname: 'new_sql_unbound', connectorid: SQL_API, connectionid: null },
          { connectionreferencelogicalname: 'new_sp_bound', connectorid: SP_API, connectionid: SP_CONN },
        ],
      },
    },
  });
  assert.equal(listed.queries[0].envUrl, ENV_URL);
  assert.deepEqual(listed.emitted, [{
    ok: true,
    payload: {
      ok: true,
      connections: [
        {
          connectorId: SP_API,
          connectionId: SP_CONN,
          displayName: 'Alpha SharePoint',
          readyToBind: true,
          connectionReferences: ['new_sp_bound'],
        },
        {
          connectorId: SQL_API,
          connectionId: SQL_CONN,
          displayName: 'Zulu SQL',
          readyToBind: false,
          connectionReferences: ['new_sql_unbound'],
        },
      ],
      connectionReferences: [
        { logicalName: 'new_sp_bound', connectorId: SP_API, connectionId: SP_CONN },
        { logicalName: 'new_sql_unbound', connectorId: SQL_API, connectionId: null },
      ],
    },
  }]);

  const refsDown = await driveDiscovery({
    pac: { status: 0, stdout: 'No connections found.', stderr: '' },
    refs: { status: 500, data: { error: { message: 'refs unavailable' } } },
  });
  assert.equal(refsDown.queries.length, 1, 'the reference read is attempted only after a readable listing');
  assert.equal(refsDown.emitted[0].ok, false);
  assert.equal(refsDown.emitted[0].payload.message, 'List connection references failed: HTTP 500 — refs unavailable');
});

// The same refusals, at the CLI: a failed listing must end discovery with `ok: false` before the reference
// query. `{ ok: true, connections: [] }` is what the connector agent reads as "none exist — create one".
test('CLI: a diagnostic after a table header, or a failure worded like emptiness, is a discovery failure', async () => {
  for (const stdout of [
    'Id  Name  API Id  Status\nWarning: failed to retrieve connections.',
    'Connection Id  Connector Id\n-------------  ------------\nWarning: failed to retrieve connections.',
    'Id  Name  API Id  Status\n[{"Id":',
    'No connections could be found because the request failed.',
  ]) {
    const run = await driveDiscovery({ pac: { status: 0, stdout, stderr: '' } });
    assert.deepEqual(run.queries, [], `${JSON.stringify(stdout)} must not query connection references`);
    assert.equal(run.emitted.length, 1);
    assert.equal(run.emitted[0].ok, false);
    assert.match(run.emitted[0].payload.message, /could not read[\s\S]*not reported as "no connections"/);
  }
  // Controls: PAC's own empty-state message, with its banner, is a successful empty listing; so is JSON after the banner.
  const empty = await driveDiscovery({
    pac: { status: 0, stdout: 'Connected as maker@contoso.onmicrosoft.com\r\nNo connections found.\r\n', stderr: '' },
    refs: { status: 200, data: { value: [] } },
  });
  assert.deepEqual(empty.emitted, [{ ok: true, payload: { ok: true, connections: [], connectionReferences: [] } }]);
  const banneredJson = await driveDiscovery({
    pac: { status: 0, stdout: `Connected as maker@contoso.onmicrosoft.com\n${JSON.stringify([{ Id: SQL_CONN, ConnectorId: SQL_API, Name: 'Zulu SQL' }])}`, stderr: '' },
    refs: { status: 200, data: { value: [] } },
  });
  assert.equal(banneredJson.emitted[0].ok, true);
  assert.deepEqual(banneredJson.emitted[0].payload.connections.map((c) => c.connectionId), [SQL_CONN]);
});

// The two ways a failed listing used to pass for a real one, through main() with a PAC result that exits 0: a diagnostic printed
// BEFORE a table header (dropped, so a header with no rows read as "no connections"), and a diagnostic that names an API path under
// one (read as a connection whose id is its first word). Each must end discovery before the reference query.
test('CLI: a diagnostic before the header, or one that names an API path, is a discovery failure', async () => {
  const warning = 'Warning: failed to retrieve connections.';
  const namesApiPath = 'Warning: could not read /providers/Microsoft.PowerApps/apis/shared_sharepointonline connections';
  for (const stdout of [
    `${warning}\nId  Name  API Id  Status`,
    `${warning}\r\nId  Name  API Id  Status\r\n`,
    `Connected as [maker001]\r\n${warning}\r\nId  Name  API Id  Status\r\n`,
    `${warning}\nConnection Id  Connector Id\n-------------  ------------`,
    `${warning}\nConnection Name   Connector Id   Connection Id`,
    `Id  Name  API Id  Status\n${namesApiPath}`,
    `Connected as [maker001]\r\nId  Name  API Id  Status\r\n${namesApiPath}\r\n`,
  ]) {
    const run = await driveDiscovery({ pac: { status: 0, stdout, stderr: '' } });
    assert.deepEqual(run.queries, [], `${JSON.stringify(stdout)} must not query connection references`);
    assert.equal(run.emitted.length, 1);
    assert.equal(run.emitted[0].ok, false);
    assert.match(run.emitted[0].payload.message, /could not read[\s\S]*unrecognized connection listing[\s\S]*not reported as "no connections"/);
  }
  // The control for each: the same header with only PAC's banner before it is a real (here empty) listing.
  const empty = await driveDiscovery({
    pac: { status: 0, stdout: 'Connected as [maker001]\r\n\r\nId  Name  API Id  Status\r\n', stderr: '' },
    refs: { status: 200, data: { value: [] } },
  });
  assert.deepEqual(empty.emitted, [{ ok: true, payload: { ok: true, connections: [], connectionReferences: [] } }]);
});

// The real layout through main(): its connections come out with the ids PAC printed, a header with no rows is an empty
// discovery, and a diagnostic anywhere under the header ends discovery before the reference query.
test('CLI: a real-layout listing yields its connections, and the same listing holding a diagnostic is a discovery failure', async () => {
  const run = await driveDiscovery({ pac: { status: 0, stdout: REAL_LISTING, stderr: '' }, refs: { status: 200, data: { value: [] } } });
  assert.equal(run.emitted.length, 1);
  assert.equal(run.emitted[0].ok, true);
  // The CLI orders connections itself (ready-to-bind first, then by name), so compare by id.
  const connectorById = (list) => Object.fromEntries(list.map((c) => [c.connectionId, c.connectorId]));
  assert.deepEqual(connectorById(run.emitted[0].payload.connections), connectorById(REAL_CONNECTIONS));
  assert.equal(run.queries.length, 1, 'the reference read follows a readable listing');

  const empty = await driveDiscovery({ pac: { status: 0, stdout: realListing(), stderr: '' }, refs: { status: 200, data: { value: [] } } });
  assert.deepEqual(empty.emitted, [{ ok: true, payload: { ok: true, connections: [], connectionReferences: [] } }]);

  for (const [what, stdout] of Object.entries(UNREADABLE_REAL_LISTINGS)) {
    const refused = await driveDiscovery({ pac: { status: 0, stdout, stderr: '' } });
    assert.deepEqual(refused.queries, [], `${what}: no reference query`);
    assert.equal(refused.emitted.length, 1, what);
    assert.equal(refused.emitted[0].ok, false, what);
    assert.match(refused.emitted[0].payload.message, /could not read[\s\S]*not reported as "no connections"/, what);
  }
});

// After a zero exit only stdout was read, so a failed listing that still exited 0 passed for an empty one: a header with no rows
// (or `[]`) beside
//   Warning: failed to retrieve connections.
// on stderr is `{ ok: true, connections: [] }`, the answer that sends connection setup on to create a duplicate. A real
// `pac connection list` that exited 0 wrote nothing to stderr, so any text there says the stdout cannot be trusted: discovery
// ends before the reference query, quoting the first line (bounded).
test('CLI: text on stderr after a zero exit is a discovery failure, before the reference query', async () => {
  const header = 'Id  Name  API Id  Status\n';
  const cases = {
    'a header with no rows beside a warning': [{ status: 0, stdout: header, stderr: 'Warning: failed to retrieve connections.\n' }, 'Warning: failed to retrieve connections.'],
    'an empty JSON list beside an error': [{ status: 0, stdout: '[]', stderr: 'Error: the request failed\n' }, 'Error: the request failed'],
    'PAC\'s empty-state message beside a warning': [{ status: 0, stdout: 'No connections found.', stderr: 'Warning: partial results\n' }, 'Warning: partial results'],
    'a readable listing beside a warning': [{ status: 0, stdout: REAL_LISTING, stderr: 'Warning: some connections were skipped\n' }, 'Warning: some connections were skipped'],
    'blank lines, then a warning': [{ status: 0, stdout: header, stderr: '\r\n  \t\r\n   Warning: indented\r\nsecond line\r\n' }, 'Warning: indented'],
    'output that is unreadable too': [{ status: 0, stdout: 'garbage', stderr: 'Error: boom\n' }, 'Error: boom'],
  };
  for (const [what, [pac, shown]] of Object.entries(cases)) {
    const run = await driveDiscovery({ pac, refs: { status: 200, data: { value: [] } } });
    assert.deepEqual(run.queries, [], `${what}: no connection-reference query`);
    assert.equal(run.emitted.length, 1, what);
    assert.equal(run.emitted[0].ok, false, what);
    assert.equal(
      run.emitted[0].payload.message,
      'pac connection list printed output this script could not read — it exited 0 but wrote to stderr, so the listing on stdout cannot be trusted '
        + `(stderr line: "${shown}"). It is not reported as "no connections", which would lead connection setup to create a duplicate; run \`pac connection list\` to see what it printed.`,
      what
    );
  }
  // The quoted line is bounded, so a long one does not flood the report.
  const flooded = await driveDiscovery({ pac: { status: 0, stdout: header, stderr: `Error: ${'x'.repeat(5000)}\n` } });
  assert.equal(flooded.emitted[0].ok, false);
  assert.ok(flooded.emitted[0].payload.message.length < 800, `${flooded.emitted[0].payload.message.length} characters`);
  assert.ok(flooded.emitted[0].payload.message.includes(`"Error: ${'x'.repeat(100)}`));
  // Controls: nothing on stderr — empty, only whitespace, or absent — is the clean exit PAC really gives, and still lists.
  for (const stderr of ['', '\r\n', '  \t \r\n\r\n', undefined, null]) {
    const listed = await driveDiscovery({ pac: { status: 0, stdout: REAL_LISTING, stderr }, refs: { status: 200, data: { value: [] } } });
    assert.equal(listed.emitted.length, 1, JSON.stringify(stderr));
    assert.equal(listed.emitted[0].ok, true, JSON.stringify(stderr));
    assert.equal(listed.emitted[0].payload.connections.length, REAL_CONNECTIONS.length, JSON.stringify(stderr));
    assert.equal(listed.queries.length, 1, `${JSON.stringify(stderr)}: the reference read follows a readable listing`);
    const empty = await driveDiscovery({ pac: { status: 0, stdout: header, stderr }, refs: { status: 200, data: { value: [] } } });
    assert.deepEqual(empty.emitted, [{ ok: true, payload: { ok: true, connections: [], connectionReferences: [] } }], `${JSON.stringify(stderr)}: a real empty listing is still empty`);
  }
  // A non-zero exit keeps its own report, which already quotes stderr.
  const failed = await driveDiscovery({ pac: { status: 2, stdout: '', stderr: 'Access denied' } });
  assert.equal(failed.emitted[0].payload.message, 'pac connection list failed (exit 2): Access denied');
});

// A table header proves the output is a table, and a table with no rows is an EMPTY listing — so a header is recognised only by a COMPLETE
// column set PAC prints (compared normalized: case and punctuation do not matter), never by one column that looks like an id column.
// `Connection Id  could not be read.` has such a column, was read as a header with no rows, and so as "no connections": the answer that
// sends connection setup on to create a duplicate. The column sets, from the layouts in this file:
//   Id  Name  API Id  Status                         a live capture of `pac connection list` (no dashed separator)
//   Connection Name  Connector Id  Connection Id      the default fixed-width table, and the plain whitespace one
//   Connection Id  Connector Id                       the two-column fixed-width table
test('a line with an id column and prose, or any column set PAC does not print, is unreadable rather than an empty table', async () => {
  const lookalikes = [
    'Connection Id  could not be read.', 'Connection Id  Error', 'Id  Error', 'Id  Name', 'Id  Name  API Id', 'Id  Name  API Id  Status  Extra',
    'Name  Id  API Id  Status', 'Connection  Connector', 'Connection Id  Connector Id  Status', 'Connection Name  Connection Id', 'Connection Name  Connector Id',
  ];
  for (const header of lookalikes) {
    for (const [where, stdout] of [
      ['alone', `${header}\r\n`],
      ['after the banner', `${REAL_BANNER}\r\n\r\n${header}\r\n`],
      ['with a dashed separator', `${header}\n${header.replace(/\S/g, '-')}\n`],
      ['after the banner, with a dashed separator', `${REAL_BANNER}\r\n${header}\r\n${header.replace(/\S/g, '-')}\r\n`],
    ]) {
      const label = `${JSON.stringify(header)} ${where}`;
      assert.throws(() => parsePacConnectionList(stdout), /could not read[\s\S]*not reported as "no connections"/, label);
      const run = await driveDiscovery({ pac: { status: 0, stdout, stderr: '' }, refs: { status: 200, data: { value: [] } } });
      assert.deepEqual(run.queries, [], `${label}: no connection-reference query`);
      assert.equal(run.emitted.length, 1, label);
      assert.equal(run.emitted[0].ok, false, label);
      assert.match(run.emitted[0].payload.message, /could not read[\s\S]*not reported as "no connections"/, label);
    }
  }
});

// The control: each column set PAC prints is still a table, with rows or without, however its header is cased or punctuated.
test('each column set PAC prints is still a table, with rows or none, whatever the case or punctuation of its header', async () => {
  const guid = '00000000000000000000000000000001';
  const fixed = (headers, rows) => {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)) + 2);
    const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('').trimEnd();
    return [line(headers), line(headers.map((h, i) => '-'.repeat(widths[i] - 2))), ...rows.map(line)].join('\n');
  };
  const three = [['Contoso SQL', SQL_API, guid]];
  const expectedThree = [{ connectorId: SQL_API, connectionId: guid, displayName: 'Contoso SQL' }];
  const cases = [
    ['fixed-width Connection Name / Connector Id / Connection Id', fixed(['Connection Name', 'Connector Id', 'Connection Id'], three), expectedThree],
    ['the same, lower-case', fixed(['connection name', 'connector id', 'connection id'], three), expectedThree],
    ['the same, upper-case', fixed(['CONNECTION NAME', 'CONNECTOR ID', 'CONNECTION ID'], three), expectedThree],
    ['the same, punctuated', fixed(['Connection_Name', 'Connector-Id', 'Connection.Id'], three), expectedThree],
    ['whitespace Connection Name / Connector Id / Connection Id', `Connection Name   Connector Id   Connection Id\nContoso SQL   ${SQL_API}   ${guid}`, expectedThree],
    ['fixed-width Connection Id / Connector Id', fixed(['Connection Id', 'Connector Id'], [[guid, SQL_API]]), [{ connectorId: SQL_API, connectionId: guid, displayName: SQL_API }]],
    ['Id / Name / API Id / Status', `Id  Name  API Id  Status\n${guid}  Contoso SQL  ${SQL_API}  Connected`, expectedThree],
    ['Id / Name / API Id / Status, lower-case', `id  name  api id  status\n${guid}  Contoso SQL  ${SQL_API}  Connected`, expectedThree],
    ['Id / Name / API Id / Status, after the banner and in CRLF', `${REAL_BANNER}\r\n\r\nId  Name  API Id  Status\r\n${guid}  Contoso SQL  ${SQL_API}  Connected\r\n`, expectedThree],
  ];
  for (const [what, stdout, expected] of cases) {
    assert.deepEqual(parsePacConnectionList(stdout), expected, what);
    const run = await driveDiscovery({ pac: { status: 0, stdout, stderr: '' }, refs: { status: 200, data: { value: [] } } });
    assert.equal(run.emitted[0].ok, true, `${what}: ${run.emitted[0].ok ? '' : run.emitted[0].payload.message}`);
    assert.deepEqual(run.emitted[0].payload.connections.map((c) => c.connectionId), [guid], what);
  }
  // With no rows each is an empty listing.
  for (const headers of [['Connection Name', 'Connector Id', 'Connection Id'], ['Connection Id', 'Connector Id']]) {
    assert.deepEqual(parsePacConnectionList(fixed(headers, [])), [], `${headers.join(' / ')}: fixed-width, no rows`);
    assert.deepEqual(parsePacConnectionList(headers.join('   ')), [], `${headers.join(' / ')}: whitespace, no rows`);
  }
  assert.deepEqual(parsePacConnectionList('Id  Name  API Id  Status'), []);
});

// PAC's output is split into lines on CRLF, CR and LF alike, never by deleting CRs, and the auth banner is a WHOLE line. Deleting every CR
// joined a banner and the line a bare CR put after it —
//   Connected as [maker001]\rWarning: failed to retrieve connections.\r\nId  Name  API Id  Status
// — into ONE line that began like the banner, so the warning was swallowed with it and a header with no rows read as "no connections".
// The banner is `Connected as <user>` or `Connected as [<alias>]` and nothing more on its line.
test('CLI: a bare CR does not hide a diagnostic behind the auth banner, and the banner is a whole line', async () => {
  const warning = 'Warning: failed to retrieve connections.';
  const idNameApi = 'Id  Name  API Id  Status';
  const refused = [
    `${REAL_BANNER}\r${warning}\r\n${idNameApi}\r\n`,
    `${REAL_BANNER}\r${warning}\n${idNameApi}\n`,
    `${REAL_BANNER}\r${warning}\r${idNameApi}\r`,
    `Connected as maker@contoso.onmicrosoft.com\r${warning}\r\nConnection Name   Connector Id   Connection Id\r\n`,
    `${REAL_BANNER}\r${warning}\r\nConnection Id  Connector Id\r\n-------------  ------------\r\n`,
    `${REAL_BANNER}\r${warning}`,
    `${idNameApi}\r${warning}\r`,
    `${REAL_BANNER} ${warning}\n${idNameApi}\n`,
    `${REAL_BANNER}${warning}\r\n${idNameApi}\r\n`,
    `Connected as ${warning}\n${idNameApi}\n`,
    `Connected as\n${idNameApi}\n`,
    `Connected as [maker001\n${idNameApi}\n`,
    `Connected as [maker001] [maker002]\n${idNameApi}\n`,
    `Connected as maker001 maker002\n${idNameApi}\n`,
    `Connected as [maker001]\u2028${warning}\n${idNameApi}\n`,
  ];
  for (const stdout of refused) {
    assert.throws(() => parsePacConnectionList(stdout), /could not read[\s\S]*not reported as "no connections"/, JSON.stringify(stdout));
    const run = await driveDiscovery({ pac: { status: 0, stdout, stderr: '' }, refs: { status: 200, data: { value: [] } } });
    assert.deepEqual(run.queries, [], `${JSON.stringify(stdout)}: no connection-reference query`);
    assert.equal(run.emitted.length, 1, JSON.stringify(stdout));
    assert.equal(run.emitted[0].ok, false, JSON.stringify(stdout));
    assert.match(run.emitted[0].payload.message, /could not read[\s\S]*not reported as "no connections"/, JSON.stringify(stdout));
  }
  // The same listings with each line ended by whichever terminator, and the banner in both of its forms, still read — an empty listing
  // for a header with no rows, and the real connections for the real layout.
  const banners = [REAL_BANNER, 'Connected as maker@contoso.onmicrosoft.com', 'Connected as [Maker One]', 'connected as [maker001]'];
  for (const banner of banners) {
    for (const eol of ['\r\n', '\n', '\r']) {
      const empty = `${banner}${eol}${eol}${idNameApi}${eol}`;
      assert.deepEqual(parsePacConnectionList(empty), [], `${JSON.stringify(banner)} ended by ${JSON.stringify(eol)}`);
      const run = await driveDiscovery({ pac: { status: 0, stdout: empty, stderr: '' }, refs: { status: 200, data: { value: [] } } });
      assert.deepEqual(run.emitted, [{ ok: true, payload: { ok: true, connections: [], connectionReferences: [] } }], `${JSON.stringify(banner)} ended by ${JSON.stringify(eol)}: an empty listing is a success`);
    }
  }
  for (const eol of ['\r\n', '\n', '\r']) {
    assert.deepEqual(parsePacConnectionList(REAL_LISTING.replace(/\r\n/g, eol)), REAL_CONNECTIONS, `the real layout ended by ${JSON.stringify(eol)}`);
  }
  const json = JSON.stringify([{ 'Connection Name': 'Contoso SharePoint', 'Connector Id': SP_API, 'Connection Id': SP_CONN }]);
  assert.deepEqual(parsePacConnectionList(`${REAL_BANNER}\r${json}`).map((c) => c.connectionId), [SP_CONN], 'a JSON listing after the banner and a bare CR');
  assert.throws(() => parsePacConnectionList(`${REAL_BANNER} ${warning}\r${json}`), /could not read/, 'a banner with text after it is not skipped before JSON either');
});
