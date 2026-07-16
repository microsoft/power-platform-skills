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

const { spawnSync } = require('node:child_process');
const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  emitResult,
} = require('./lib/dataverse-auth');
const { isConnectorsEnabled, connectorsDisabledMessage } = require('./lib/feature-flags');

function normalizeHeader(header) {
  return String(header).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapConnectionRow(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[normalizeHeader(key)] = value;
  }

  const connectionId =
    normalized.connectionid ||
    normalized.id ||
    normalized.connection ||
    '';
  const connectorId =
    normalized.connectorid ||
    normalized.apiid ||
    normalized.connector ||
    extractConnectorId(connectionId) ||
    '';
  const displayName =
    normalized.connectionname ||
    normalized.displayname ||
    normalized.name ||
    connectorId ||
    connectionId;

  return { connectorId, connectionId, displayName };
}

function extractConnectorId(connectionId) {
  const match = String(connectionId).match(/(\/providers\/Microsoft\.PowerApps\/apis\/[^/]+)\/connections/i);
  return match ? match[1] : '';
}

function parseJsonConnections(raw) {
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed?.value;
    if (!Array.isArray(rows)) return null;
    return rows.map(mapConnectionRow).filter((row) => row.connectorId || row.connectionId || row.displayName);
  } catch {
    return null;
  }
}

function parseFixedWidthTable(raw) {
  const lines = raw.replace(/\r/g, '').split('\n');
  const separatorIndex = lines.findIndex((line) => {
    const runs = line.match(/-{3,}/g) || [];
    return runs.length >= 2;
  });
  if (separatorIndex <= 0) return [];

  const headerLine = lines[separatorIndex - 1];
  const ranges = [...lines[separatorIndex].matchAll(/-+/g)].map((match, index, matches) => ({
    name: headerLine.slice(match.index, matches[index + 1]?.index).trim(),
    start: match.index,
    end: matches[index + 1]?.index,
  }));

  return lines
    .slice(separatorIndex + 1)
    .filter((line) => line.trim() && !/^-+$/.test(line.trim()))
    .map((line) => {
      const row = {};
      for (const range of ranges) {
        row[range.name] = line.slice(range.start, range.end).trim();
      }
      return mapConnectionRow(row);
    })
    .filter((row) => row.connectorId || row.connectionId || row.displayName);
}

function parseWhitespaceTable(raw) {
  const lines = raw.replace(/\r/g, '').split('\n').filter((line) => line.trim());
  const headerIndex = lines.findIndex((line) => /Connection Name|Connection Id|Connector/i.test(line));
  if (headerIndex === -1) return [];
  const headers = lines[headerIndex].trim().split(/\s{2,}/);
  return lines
    .slice(headerIndex + 1)
    .filter((line) => !/^-+$/.test(line.trim()))
    .map((line) => {
      const values = line.trim().split(/\s{2,}/);
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });
      return mapConnectionRow(row);
    })
    .filter((row) => row.connectorId || row.connectionId || row.displayName);
}

function parsePacConnectionList(raw) {
  const jsonRows = parseJsonConnections(raw);
  if (jsonRows) return jsonRows;

  // PAC commonly emits a fixed-width table similar to:
  //   Connection Name        Connector Id                                           Connection Id
  //   ---------------------  -----------------------------------------------------  ------------------------------------
  //   Contoso SharePoint     /providers/Microsoft.PowerApps/apis/shared_sharepointonline /providers/.../connections/abc
  // Some older builds wrap friendly names but keep 2+ spaces between columns, so
  // parse fixed-width first and fall back to a whitespace table for simpler output.
  const fixed = parseFixedWidthTable(raw);
  return fixed.length ? fixed : parseWhitespaceTable(raw);
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
      return {
        ...connection,
        readyToBind: refs.length > 0,
        connectionReferences: refs.map((ref) => ref.logicalName),
      };
    })
    .sort((a, b) => {
      if (a.readyToBind !== b.readyToBind) return a.readyToBind ? -1 : 1;
      return String(a.displayName).localeCompare(String(b.displayName));
    });
}

async function main() {
  // Feature gate first: connector support is OFF until the pac verbs, GenUX
  // control, and maker/admin setting are all live in PROD. Exit 3 (distinct from
  // 1=runtime error / usage) so callers can tell "disabled" apart from "failed".
  if (!isConnectorsEnabled()) {
    process.stderr.write(connectorsDisabledMessage() + '\n');
    process.exit(3);
  }

  const { positional } = parseArgs(process.argv.slice(2));
  if (positional.length < 1) {
    process.stderr.write('Usage: node list-connections.js <envUrl>\n');
    process.exit(1);
  }
  const [envUrl] = positional;

  try {
    const pac = spawnSync('pac', ['connection', 'list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    if (pac.status !== 0) {
      throw new Error(`pac connection list failed: ${pac.stderr || pac.stdout || `exit ${pac.status}`}`);
    }
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

main();
