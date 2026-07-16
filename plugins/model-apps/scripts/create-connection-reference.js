#!/usr/bin/env node

// Creates a Dataverse connectionreference row — the env-portable binding target
// that a GenPage's config.json connectorBindings[].logicalName resolves to at
// runtime. The runtime looks up the connectionreference by logical name to get
// the env-specific connectionId, so the page travels cross-env while the
// connection stays env-local.
// See: https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference
//
// Usage:
//   node create-connection-reference.js <envUrl> <logicalName> <connectorId>
//     [--connection-id <connectionId>]   (bind to an existing connection now)
//     [--display-name <name>]
//
// <connectorId> is the API id, e.g.
//   /providers/Microsoft.PowerApps/apis/shared_sharepointonline
//
// Output: { "ok": true, "connectionReferenceId": "...", "logicalName": "..." }

const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  emitResult,
} = require('./lib/dataverse-auth');
const { isConnectorsEnabled, connectorsDisabledMessage } = require('./lib/feature-flags');

async function main() {
  // Feature gate first: connector support is OFF until the pac verbs, GenUX
  // control, and maker/admin setting are all live in PROD. Exit 3 (distinct from
  // 1=runtime error / usage) so callers can tell "disabled" apart from "failed".
  if (!isConnectorsEnabled()) {
    process.stderr.write(connectorsDisabledMessage() + '\n');
    process.exit(3);
  }

  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 3) {
    process.stderr.write(
      'Usage: node create-connection-reference.js <envUrl> <logicalName> <connectorId> [--connection-id <id>] [--display-name <name>]\n'
    );
    process.exit(1);
  }
  const [envUrl, logicalName, connectorId] = positional;

  const body = {
    connectionreferencelogicalname: logicalName,
    connectionreferencedisplayname: flags['display-name'] || logicalName,
    connectorid: connectorId,
  };
  // Binding is optional because ALM imports fill target-env ConnectionId values
  // through deployment settings; same-env smoke runs can bind immediately.
  if (flags['connection-id']) body.connectionid = flags['connection-id'];

  try {
    const res = await dataverseRequest(envUrl, 'POST', 'connectionreferences', body, { includeHeaders: true });
    ensureOk(res, `Create connection reference ${logicalName}`);
    const entityUrl = res.headers && (res.headers['odata-entityid'] || res.headers['OData-EntityId']);
    let connectionReferenceId = null;
    if (entityUrl) {
      const m = String(entityUrl).match(/\(([0-9a-f-]{36})\)/i);
      if (m) connectionReferenceId = m[1];
    }
    emitResult(true, { ok: true, connectionReferenceId, logicalName });
  } catch (e) {
    emitResult(false, e);
  }
}

main();
