#!/usr/bin/env node

// Verifies, in a TARGET environment after a deploy or import, that every site
// connection of a Power Pages site can resolve its connection: the site connection
// names its connection reference by logical name, a connection reference with that
// logical name exists, it is bound to a connection, and (optionally) that connection
// is in the Connected state.
//
// Read-only: this script never rewrites site connection content or connection
// references. Site connections are resolved by connectionreferencelogicalname, which is
// stable across environments; connection reference ids are not (they change on solution
// import), so an id-only site connection is reported as failing rather than remapped.
//
// Usage:
//   node verify-site-connections.js --envUrl <target url> --siteId <powerpagesite guid>
//        [--token <dataverse token>]
//        [--environmentId <target env guid> [--cloud Public] [--ppApiToken <token>]]
//
// --environmentId enables the connection-status check through the environment-routed
// Power Platform API; without it, that check reports `skipped`.
//
// Output (JSON to stdout):
//   { "ok": true|false, "siteId": "...",
//     "summary": { "total", "pass", "fail", "warn" },
//     "results": [{ "siteConnectionId", "name", "status": "pass"|"fail"|"warn",
//                   "code", "message", "connectionReferenceLogicalName", "connectionId" }] }
// Exit 0 when verification ran (inspect `ok`); exit 1 on usage/auth/request errors.

'use strict';

const helpers = require('./validation-helpers');
const connectivity = require('./connectivity-api');
const siteConnections = require('./site-connections');

const CODE = Object.freeze({
  OK: 'OK',
  CONTENT_UNPARSEABLE: 'CONTENT_UNPARSEABLE',
  LOGICAL_NAME_MISSING: 'LOGICAL_NAME_MISSING',
  CONNECTION_REFERENCE_NOT_FOUND: 'CONNECTION_REFERENCE_NOT_FOUND',
  CONNECTION_REFERENCE_UNBOUND: 'CONNECTION_REFERENCE_UNBOUND',
  CONNECTION_NOT_CONNECTED: 'CONNECTION_NOT_CONNECTED',
  CONNECTION_STATUS_UNKNOWN: 'CONNECTION_STATUS_UNKNOWN',
});

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, siteId: null, environmentId: null, cloud: null, ppApiToken: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--siteId' && args[i + 1]) out.siteId = args[++i];
    else if (args[i] === '--environmentId' && args[i + 1]) out.environmentId = args[++i];
    else if (args[i] === '--cloud' && args[i + 1]) out.cloud = args[++i];
    else if (args[i] === '--ppApiToken' && args[i + 1]) out.ppApiToken = args[++i];
  }
  return out;
}

async function connectionStatus({ environmentId, cloud, ppApiToken, connectorName, connectionId, makeRequest, cache }) {
  if (!cache.has(connectorName)) {
    cache.set(connectorName, connectivity.listConnections({
      environmentId, connectorName, cloud, token: ppApiToken, makeRequest,
    }).catch((err) => ({ error: err.message })));
  }
  const listed = await cache.get(connectorName);
  if (!Array.isArray(listed)) return { known: false, error: listed.error };
  const match = listed.find((c) => String(c.connectionId).toLowerCase() === String(connectionId).toLowerCase());
  if (!match) return { known: true, connected: false, status: 'NotFound' };
  return { known: true, connected: match.isConnected, status: match.status };
}

async function verifySiteConnections({
  envUrl, token, siteId, environmentId = null, cloud = 'Public', ppApiToken = null, makeRequest = helpers.makeRequest,
}) {
  const base = helpers.validateDataverseEnvironmentUrl(envUrl);
  const list = await siteConnections.listSiteConnections({ envUrl: base, token, siteId, makeRequest });
  const logicalNames = list.map((s) => s.connectionReferenceLogicalName).filter(Boolean);
  const refs = logicalNames.length
    ? await siteConnections.fetchConnectionReferences({ envUrl: base, token, logicalNames, makeRequest })
    : [];
  const refByName = new Map(refs.map((r) => [String(r.logicalName).toLowerCase(), r]));
  const statusCache = new Map();
  const results = [];

  for (const sc of list) {
    const common = { siteConnectionId: sc.id, name: sc.name, connectionReferenceLogicalName: sc.connectionReferenceLogicalName };
    if (!sc.contentOk) {
      results.push({ ...common, status: 'fail', code: CODE.CONTENT_UNPARSEABLE, message: sc.contentError });
      continue;
    }
    if (!sc.connectionReferenceLogicalName) {
      results.push({
        ...common, status: 'fail', code: CODE.LOGICAL_NAME_MISSING,
        message: 'The site connection has no connectionreferencelogicalname, so it cannot resolve a connection reference ' +
          'in this environment (connection reference ids change on import). Update the site connection in the source so ' +
          'it stores the logical name, then redeploy.',
      });
      continue;
    }
    const ref = refByName.get(sc.connectionReferenceLogicalName.toLowerCase());
    if (!ref) {
      results.push({
        ...common, status: 'fail', code: CODE.CONNECTION_REFERENCE_NOT_FOUND,
        message: `No connection reference "${sc.connectionReferenceLogicalName}" exists here. Deploy the solution that ` +
          'contains it (and, for a custom connector, the connectors solution first).',
      });
      continue;
    }
    if (!ref.connectionId) {
      results.push({
        ...common, status: 'fail', code: CODE.CONNECTION_REFERENCE_UNBOUND,
        message: `Connection reference "${ref.logicalName}" has no connection. Bind it (deployment settings ` +
          'ConnectionReferences, or Solutions → Connection references in the maker portal).',
      });
      continue;
    }
    if (!environmentId || !ppApiToken || !ref.connectorName) {
      results.push({ ...common, connectionId: ref.connectionId, status: 'pass', code: CODE.OK, message: 'Bound; connection status not checked.' });
      continue;
    }
    const st = await connectionStatus({
      environmentId, cloud, ppApiToken, connectorName: ref.connectorName, connectionId: ref.connectionId, makeRequest, cache: statusCache,
    });
    if (!st.known) {
      results.push({
        ...common, connectionId: ref.connectionId, status: 'warn', code: CODE.CONNECTION_STATUS_UNKNOWN,
        message: `Bound, but the connection status could not be read: ${st.error}`,
      });
    } else if (!st.connected) {
      results.push({
        ...common, connectionId: ref.connectionId, status: 'fail', code: CODE.CONNECTION_NOT_CONNECTED,
        message: `Bound to connection ${ref.connectionId}, whose status is ${st.status}. Fix or re-authenticate the connection.`,
      });
    } else {
      results.push({ ...common, connectionId: ref.connectionId, status: 'pass', code: CODE.OK, message: 'Bound to a connected connection.' });
    }
  }

  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    warn: results.filter((r) => r.status === 'warn').length,
  };
  return { ok: summary.fail === 0, siteId: String(siteId).toLowerCase(), summary, results };
}

async function main() {
  const args = parseArgs(process.argv);
  const envUrl = helpers.validateDataverseEnvironmentUrl(args.envUrl);
  const token = args.token || helpers.getAuthToken(envUrl);
  if (!token) throw new Error('Failed to acquire a Dataverse token. Run `az login` or pass --token.');
  const cloud = args.cloud || 'Public';
  let ppApiToken = args.ppApiToken;
  if (args.environmentId && !ppApiToken) {
    ppApiToken = helpers.getAuthToken(connectivity.tokenResourceForCloud(cloud));
  }
  const result = await verifySiteConnections({
    envUrl, token, siteId: args.siteId, environmentId: args.environmentId, cloud, ppApiToken,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { verifySiteConnections, CODE, parseArgs };
