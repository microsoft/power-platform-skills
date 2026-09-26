'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

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

// A row that does not match the Id/Name/API Id shape is kept as a row with no ids: when every row fails to
// match (a changed column layout, say) the listing fails closed instead of reading as "no connections", and
// beside a usable row it is dropped — never offered as a connection.
test('an Id/Name/API Id listing with no row carrying both ids fails closed', () => {
  const header = 'Id                               Name                                API Id                                                              Status';
  // Connection rows read wrong: each carries a connector's API path but not the columns around it.
  assert.throws(() => parsePacConnectionList([header, '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', 'Contoso /providers/Microsoft.PowerApps/apis/shared_office365'].join('\n')),
    /Id\/Name\/API Id table contained 2 row\(s\), but no usable connection rows/);
  // A line with no API path is no connection: a message under the header is still an empty listing.
  assert.deepEqual(parsePacConnectionList([header, 'No connections found.'].join('\n')), []);
  // A Status of several words, or none, still parses.
  const status = (s) => `00000000000000000000000000000001 Contoso Dataverse                   /providers/Microsoft.PowerApps/apis/shared_commondataservice${s}`;
  for (const s of ['        Not connected', '']) {
    assert.deepEqual(parsePacConnectionList([header, status(s)].join('\n')).map((r) => r.connectionId), ['00000000000000000000000000000001'], JSON.stringify(s));
  }
  const mixed = [header,
    '00000000000000000000000000000001 Contoso Dataverse                   /providers/Microsoft.PowerApps/apis/shared_commondataservice        Connected',
    '(wrapped name tail)'].join('\n');
  assert.deepEqual(parsePacConnectionList(mixed).map((r) => r.connectionId), ['00000000000000000000000000000001']);
  assert.deepEqual(parsePacConnectionList(header), [], 'a header with no rows is still an empty listing');
});

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

test('unparseable output yields no rows rather than throwing', () => {
  // The caller reports "no connections found"; a throw here would abort a /genpage run that could
  // still proceed with mock data.
  assert.deepEqual(parsePacConnectionList('no table here'), []);
  assert.deepEqual(parsePacConnectionList(''), []);
  assert.equal(parseJsonConnections('{not json'), null, 'invalid JSON defers to the table parsers');
  assert.equal(parseJsonConnections('"a string"'), null, 'non-array JSON defers too');
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

// Beside real rows, an unidentified one is dropped rather than offered. Older PAC builds wrap a long
// friendly name onto a second table line, and that continuation line parses as a name with no ids —
// it used to be listed as a connection of its own that a maker could pick and never bind.
test('a row without both ids is dropped beside usable rows, never offered as a phantom connection', () => {
  const rows = parsePacConnectionList(JSON.stringify([
    { Name: 'Contoso SharePoint (wrapped name continues here)' },
    { Name: 'Contoso SharePoint', Id: SP_CONN },
  ]));
  assert.deepEqual(rows, [{ connectorId: SP_API, connectionId: SP_CONN, displayName: 'Contoso SharePoint' }]);
  //   Connection Name        Connector Id                                                Connection Id
  //   ---------------------  ----------------------------------------------------------  ------------------------------
  //   Contoso SharePoint     /providers/Microsoft.PowerApps/apis/shared_sharepointonline  <SP_CONN>
  //   (wrapped name tail)
  const table = [
    'Connection Name        Connector Id                                                Connection Id',
    '---------------------  ----------------------------------------------------------  ------------------------------',
    `Contoso SharePoint     ${SP_API.padEnd(58)}  ${SP_CONN}`,
    '(wrapped name tail)',
  ].join('\n');
  assert.deepEqual(parsePacConnectionList(table).map((r) => r.connectionId), [SP_CONN]);
});
