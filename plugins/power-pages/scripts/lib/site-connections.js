#!/usr/bin/env node

// Discovers what a Power Pages site's site connections depend on, so ALM skills can
// package and bind them: the Dataverse connection references each site connection
// points at, and the connectors behind those references (flagging custom connectors,
// which need extra handling).
//
// Usage:
//   node site-connections.js --envUrl <url> --siteId <guid> [--token <t>]
//                            [--solutionIds <guid,guid>]
//
// Output (JSON to stdout): see discoverSiteConnectionDependencies() below. With
// --solutionIds, a `missing` block lists the connection references and custom
// connectors that are not yet in ANY of the given solutions.
//
// Exit 0 on success (problems are reported in the JSON, not as an exit code),
// exit 1 on usage or request failure.
//
// Data model (Enhanced data model sites — the only model solutions can carry):
//   A site connection is a powerpagecomponent row with powerpagecomponenttype 36.
//   Its `content` column is a JSON string, e.g.
//     {"connectionreferenceid":"0a0a0a0a-0000-4000-8000-000000000001",
//      "adx_siteconnection_adx_webrole":["<web role id>","<web role id>"]}
//   and, once the platform stores it, a stable logical name as well:
//     {"connectionreferencelogicalname":"cr123_sharedsharepointonline_1a2b3c4d", …}
//   Connection reference GUIDs CHANGE when a solution is imported (the solution XML
//   keys connection references by logical name), so only the logical name resolves in
//   the target environment. The id is still valid in the SOURCE environment, which is
//   all packaging needs — this module never rewrites site connection content.
//
// Some site connections carry whitespace after the separators and some don't (both
// shapes appear in the same environment), so the content is always JSON-parsed,
// never pattern-matched.

'use strict';

const helpers = require('./validation-helpers');
const { connectorNameFromId, looksLikeCustomConnector } = require('./connectivity-api');

const SITE_CONNECTION_PPC_TYPE = 36;

// Keys inside powerpagecomponent.content for a site connection. The logical-name key
// is the cross-environment reference; keep it in one constant so it is easy to adjust.
const CONTENT_KEYS = Object.freeze({
  connectionReferenceLogicalName: 'connectionreferencelogicalname',
  connectionReferenceId: 'connectionreferenceid',
  webRoles: 'adx_siteconnection_adx_webrole',
});

// solutioncomponent.componenttype for a connector (custom connector) is a fixed
// platform value (372), unlike connectionreference whose type is environment-specific
// and must be resolved through solutioncomponentdefinitions.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent#componenttype-choicesoptions
const CONNECTOR_COMPONENT_TYPE = 372;

const PROBLEM = Object.freeze({
  CONTENT_UNPARSEABLE: 'CONTENT_UNPARSEABLE',
  NO_CONNECTION_REFERENCE: 'NO_CONNECTION_REFERENCE',
  CONNECTION_REFERENCE_NOT_FOUND: 'CONNECTION_REFERENCE_NOT_FOUND',
  LOGICAL_NAME_MISSING: 'LOGICAL_NAME_MISSING',
  CUSTOM_CONNECTOR_NOT_SOLUTION_AWARE: 'CUSTOM_CONNECTOR_NOT_SOLUTION_AWARE',
});

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, siteId: null, solutionIds: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--siteId' && args[i + 1]) out.siteId = args[++i];
    else if (args[i] === '--solutionIds' && args[i + 1]) {
      out.solutionIds = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireGuid(value, label) {
  if (!GUID_RE.test(String(value || ''))) throw new Error(`${label} must be a GUID (got "${value}").`);
  return String(value).toLowerCase();
}

function odataLiteral(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Parses a site connection's `content` JSON. Never throws — a malformed row is
 * reported as a problem rather than aborting discovery for the whole site.
 */
function parseSiteConnectionContent(content) {
  if (content === null || content === undefined || content === '') {
    return { ok: false, error: 'content is empty' };
  }
  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch (err) {
    return { ok: false, error: `content is not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'content is not a JSON object' };
  }
  const logicalName = parsed[CONTENT_KEYS.connectionReferenceLogicalName];
  const id = parsed[CONTENT_KEYS.connectionReferenceId];
  const roles = parsed[CONTENT_KEYS.webRoles];
  return {
    ok: true,
    connectionReferenceLogicalName: typeof logicalName === 'string' && logicalName.trim() ? logicalName.trim() : null,
    connectionReferenceId: typeof id === 'string' && GUID_RE.test(id) ? id.toLowerCase() : null,
    webRoleIds: Array.isArray(roles) ? roles.filter((r) => typeof r === 'string') : [],
  };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Lists a site's site connections (ppc type 36) with parsed content. */
async function listSiteConnections({ envUrl, token, siteId, makeRequest = helpers.makeRequest }) {
  const base = helpers.validateDataverseEnvironmentUrl(envUrl);
  const site = requireGuid(siteId, 'siteId');
  const url =
    `${base}/api/data/v9.2/powerpagecomponents` +
    `?$filter=_powerpagesiteid_value eq ${site} and powerpagecomponenttype eq ${SITE_CONNECTION_PPC_TYPE}` +
    '&$select=powerpagecomponentid,name,content,statecode';
  const rows = await helpers.odataGetAll(url, token, makeRequest);
  return rows.map((row) => {
    const parsed = parseSiteConnectionContent(row.content);
    return {
      id: row.powerpagecomponentid,
      name: row.name,
      statecode: row.statecode,
      contentOk: parsed.ok,
      contentError: parsed.ok ? null : parsed.error,
      connectionReferenceLogicalName: parsed.ok ? parsed.connectionReferenceLogicalName : null,
      connectionReferenceId: parsed.ok ? parsed.connectionReferenceId : null,
      webRoleIds: parsed.ok ? parsed.webRoleIds : [],
    };
  });
}

const CONNECTION_REFERENCE_SELECT =
  'connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid,connectionid,ismanaged,statecode';

function normalizeConnectionReference(row) {
  let connectorName = null;
  try {
    connectorName = connectorNameFromId(row.connectorid);
  } catch {
    connectorName = null;
  }
  return {
    id: String(row.connectionreferenceid || '').toLowerCase(),
    logicalName: row.connectionreferencelogicalname,
    displayName: row.connectionreferencedisplayname || row.connectionreferencelogicalname,
    connectorId: row.connectorid || null,
    connectorName,
    connectionId: row.connectionid || null,
    isManaged: row.ismanaged === true,
  };
}

/**
 * Fetches connection references by logical name and/or id. OR-filters are batched
 * (20 per request) to keep the URL well under Dataverse's length limit.
 */
async function fetchConnectionReferences({ envUrl, token, logicalNames = [], ids = [], makeRequest = helpers.makeRequest }) {
  const base = helpers.validateDataverseEnvironmentUrl(envUrl);
  const clauses = [
    ...[...new Set(logicalNames)].map((n) => `connectionreferencelogicalname eq '${odataLiteral(n)}'`),
    ...[...new Set(ids)].map((id) => `connectionreferenceid eq ${requireGuid(id, 'connectionreferenceid')}`),
  ];
  const rows = [];
  for (const group of chunk(clauses, 20)) {
    const url =
      `${base}/api/data/v9.2/connectionreferences` +
      `?$filter=${encodeURIComponent(group.join(' or '))}&$select=${CONNECTION_REFERENCE_SELECT}`;
    rows.push(...(await helpers.odataGetAll(url, token, makeRequest)));
  }
  const byId = new Map();
  for (const row of rows) {
    const ref = normalizeConnectionReference(row);
    byId.set(ref.id, ref);
  }
  return [...byId.values()];
}

/**
 * Looks up solution-aware custom connectors in the Dataverse `connector` table by
 * internal name (`connectorinternalid`, e.g. `shared_myapi-<hash>-<hash>`) and/or by
 * schema name (`name`, e.g. `cr123_myapi`). Only solution-aware custom connectors have
 * a row there; certified connectors and custom connectors created outside a solution do
 * not. The internal name differs in every environment a connector is imported into, the
 * schema name does not — which is how connectors are matched across environments. A 404
 * (environment without the table) returns null so callers can fall back to the name
 * heuristic.
 */
async function fetchDataverseConnectors({ envUrl, token, connectorNames = [], schemaNames = [], makeRequest = helpers.makeRequest }) {
  const base = helpers.validateDataverseEnvironmentUrl(envUrl);
  const clauses = [
    ...[...new Set(connectorNames)].map((n) => `connectorinternalid eq '${odataLiteral(n)}'`),
    ...[...new Set(schemaNames)].map((n) => `name eq '${odataLiteral(n)}'`),
  ];
  if (clauses.length === 0) return [];
  const rows = [];
  try {
    for (const group of chunk(clauses, 20)) {
      const url =
        `${base}/api/data/v9.2/connectors?$filter=${encodeURIComponent(group.join(' or '))}` +
        '&$select=connectorid,connectorinternalid,name,displayname,ismanaged';
      rows.push(...(await helpers.odataGetAll(url, token, makeRequest)));
    }
  } catch (err) {
    if (/^HTTP 404\b/.test(String(err && err.message))) return null;
    throw err;
  }
  return rows.map((r) => ({
    xrmConnectorId: String(r.connectorid || '').toLowerCase(),
    connectorName: r.connectorinternalid,
    schemaName: r.name,
    displayName: r.displayname || r.name,
    isManaged: r.ismanaged === true,
  }));
}

/**
 * Resolves solutioncomponent.componenttype for an entity-backed component
 * (connection references are environment-specific — 10137, 10160, 10171 have all
 * been observed). Works even when no row of that entity is in any solution yet,
 * unlike reverse-lookup through solutioncomponents. Returns null when undefined.
 */
async function resolveComponentType({ envUrl, token, entityName, makeRequest = helpers.makeRequest }) {
  const base = helpers.validateDataverseEnvironmentUrl(envUrl);
  const url =
    `${base}/api/data/v9.2/solutioncomponentdefinitions` +
    `?$filter=${encodeURIComponent(`primaryentityname eq '${odataLiteral(entityName)}'`)}` +
    '&$select=solutioncomponenttype,primaryentityname';
  const rows = await helpers.odataGetAll(url, token, makeRequest);
  const value = rows.length ? Number(rows[0].solutioncomponenttype) : NaN;
  return Number.isFinite(value) ? value : null;
}

/** Returns the set of objectids (lowercased) that are components of any of the given solutions. */
async function fetchSolutionObjectIds({ envUrl, token, solutionIds = [], makeRequest = helpers.makeRequest }) {
  const base = helpers.validateDataverseEnvironmentUrl(envUrl);
  const ids = new Set();
  for (const solutionId of solutionIds) {
    const url =
      `${base}/api/data/v9.2/solutioncomponents` +
      `?$filter=_solutionid_value eq ${requireGuid(solutionId, 'solutionId')}&$select=objectid,componenttype`;
    for (const row of await helpers.odataGetAll(url, token, makeRequest)) {
      if (row.objectid) ids.add(String(row.objectid).toLowerCase());
    }
  }
  return ids;
}

/**
 * Main discovery entry point. Returns:
 *   {
 *     siteId,
 *     siteConnections: [{ id, name, statecode, connectionReferenceLogicalName, connectionReferenceId,
 *                         webRoleIds, resolvedBy: 'logicalName'|'id'|null, connectionReference: { id, logicalName }|null }],
 *     connectionReferences: [{ id, logicalName, displayName, connectorId, connectorName, connectionId, isManaged, usedBy: [siteConnectionId] }],
 *     connectors: [{ connectorName, connectorId, displayName, schemaName, isCustom, isSolutionAware, xrmConnectorId, classifiedBy }],
 *     customConnectors: [...connectors where isCustom],
 *     componentTypes: { connectionReference: <n|null>, connector: 372 },
 *     problems: [{ code, severity: 'error'|'warning', siteConnectionId?, connectorName?, message }],
 *   }
 */
async function discoverSiteConnectionDependencies({ envUrl, token, siteId, makeRequest = helpers.makeRequest }) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!token) throw new Error('--token is required');
  const site = requireGuid(siteId, 'siteId');

  const siteConnections = await listSiteConnections({ envUrl, token, siteId: site, makeRequest });
  const problems = [];

  for (const sc of siteConnections) {
    if (!sc.contentOk) {
      problems.push({
        code: PROBLEM.CONTENT_UNPARSEABLE, severity: 'error', siteConnectionId: sc.id,
        message: `Site connection "${sc.name}" has unreadable content (${sc.contentError}).`,
      });
    } else if (!sc.connectionReferenceLogicalName && !sc.connectionReferenceId) {
      problems.push({
        code: PROBLEM.NO_CONNECTION_REFERENCE, severity: 'error', siteConnectionId: sc.id,
        message: `Site connection "${sc.name}" does not reference a connection reference.`,
      });
    }
  }

  const references = siteConnections.length === 0 ? [] : await fetchConnectionReferences({
    envUrl,
    token,
    logicalNames: siteConnections.map((s) => s.connectionReferenceLogicalName).filter(Boolean),
    ids: siteConnections.map((s) => s.connectionReferenceId).filter(Boolean),
    makeRequest,
  });
  const refByLogicalName = new Map(references.map((r) => [String(r.logicalName || '').toLowerCase(), r]));
  const refById = new Map(references.map((r) => [r.id, r]));
  const usedBy = new Map();

  for (const sc of siteConnections) {
    let ref = null;
    let resolvedBy = null;
    if (sc.connectionReferenceLogicalName) {
      ref = refByLogicalName.get(sc.connectionReferenceLogicalName.toLowerCase()) || null;
      if (ref) resolvedBy = 'logicalName';
    }
    if (!ref && sc.connectionReferenceId) {
      ref = refById.get(sc.connectionReferenceId) || null;
      if (ref) resolvedBy = 'id';
    }
    sc.resolvedBy = resolvedBy;
    sc.connectionReference = ref ? { id: ref.id, logicalName: ref.logicalName } : null;
    if (ref) {
      if (!usedBy.has(ref.id)) usedBy.set(ref.id, []);
      usedBy.get(ref.id).push(sc.id);
    } else if (sc.contentOk && (sc.connectionReferenceLogicalName || sc.connectionReferenceId)) {
      problems.push({
        code: PROBLEM.CONNECTION_REFERENCE_NOT_FOUND, severity: 'error', siteConnectionId: sc.id,
        message: `Site connection "${sc.name}" points at a connection reference that does not exist in this environment ` +
          `(${sc.connectionReferenceLogicalName || sc.connectionReferenceId}).`,
      });
    }
    if (sc.contentOk && !sc.connectionReferenceLogicalName && sc.connectionReferenceId) {
      // Packaging still works (the id is valid here), but after import the target gets a
      // NEW connection reference id, and only the logical name can be resolved there.
      problems.push({
        code: PROBLEM.LOGICAL_NAME_MISSING, severity: 'warning', siteConnectionId: sc.id,
        message: `Site connection "${sc.name}" stores only connectionreferenceid. Connection reference ids change across ` +
          'environments, so it will not resolve in the target until it also stores connectionreferencelogicalname.',
      });
    }
  }

  const connectionReferences = references
    .filter((r) => usedBy.has(r.id))
    .map((r) => ({ ...r, usedBy: usedBy.get(r.id) }));

  const connectorNames = [...new Set(connectionReferences.map((r) => r.connectorName).filter(Boolean))];
  const dvConnectors = await fetchDataverseConnectors({ envUrl, token, connectorNames, makeRequest });
  const dvByName = new Map((dvConnectors || []).map((c) => [String(c.connectorName).toLowerCase(), c]));

  const connectors = connectorNames.map((name) => {
    const dv = dvByName.get(name.toLowerCase());
    const ref = connectionReferences.find((r) => r.connectorName === name);
    if (dv) {
      return {
        connectorName: name, connectorId: ref && ref.connectorId, displayName: dv.displayName, schemaName: dv.schemaName,
        isCustom: true, isSolutionAware: true, xrmConnectorId: dv.xrmConnectorId, classifiedBy: 'dataverse',
      };
    }
    const isCustom = looksLikeCustomConnector(name);
    return {
      connectorName: name, connectorId: ref && ref.connectorId, displayName: name, schemaName: null,
      isCustom, isSolutionAware: false, xrmConnectorId: null,
      classifiedBy: dvConnectors === null ? 'name-pattern (connector table unavailable)' : 'name-pattern',
    };
  });

  for (const c of connectors) {
    if (c.isCustom && !c.isSolutionAware) {
      problems.push({
        code: PROBLEM.CUSTOM_CONNECTOR_NOT_SOLUTION_AWARE, severity: 'error', connectorName: c.connectorName,
        message: `Custom connector ${c.connectorName} is not solution-aware, so connection references that use it ` +
          'cannot be exported (0x80040265). Make it solution-aware by adding it to a solution.',
      });
    }
  }

  const connectionReferenceType = connectionReferences.length
    ? await resolveComponentType({ envUrl, token, entityName: 'connectionreference', makeRequest })
    : null;

  return {
    siteId: site,
    siteConnections,
    connectionReferences,
    connectors,
    customConnectors: connectors.filter((c) => c.isCustom),
    componentTypes: { connectionReference: connectionReferenceType, connector: CONNECTOR_COMPONENT_TYPE },
    problems,
  };
}

/**
 * Diffs discovered dependencies against the object ids already in solution(s).
 * Connection references are checked against `solutionObjectIds`. Custom connectors
 * live in their own connectors solution, so they are checked against
 * `connectorSolutionObjectIds`:
 *   - undefined (default) → the same set as connection references (callers that pass
 *     the union of the site and connectors solutions);
 *   - null → membership is not checked; only a non-solution-aware connector is missing
 *     (callers that only know the site solution — the connector is never in it).
 *   - a Set → missing until solution-aware AND its Dataverse connector row is in the set.
 */
function computeMissing(dependencies, solutionObjectIds, { connectorSolutionObjectIds } = {}) {
  const has = (set, id) => !!id && set.has(String(id).toLowerCase());
  const connectorSet = connectorSolutionObjectIds === undefined ? solutionObjectIds : connectorSolutionObjectIds;
  return {
    connectionReferences: dependencies.connectionReferences.filter((r) => !has(solutionObjectIds, r.id)),
    customConnectors: dependencies.customConnectors.filter(
      (c) => !c.isSolutionAware || (connectorSet !== null && !has(connectorSet, c.xrmConnectorId))
    ),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const envUrl = helpers.validateDataverseEnvironmentUrl(args.envUrl);
  const token = args.token || helpers.getAuthToken(envUrl);
  if (!token) throw new Error('Failed to acquire a Dataverse token. Run `az login` or pass --token.');
  const result = await discoverSiteConnectionDependencies({ envUrl, token, siteId: args.siteId });
  if (args.solutionIds.length) {
    const objectIds = await fetchSolutionObjectIds({ envUrl, token, solutionIds: args.solutionIds });
    result.missing = computeMissing(result, objectIds);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  SITE_CONNECTION_PPC_TYPE,
  CONTENT_KEYS,
  CONNECTOR_COMPONENT_TYPE,
  PROBLEM,
  parseSiteConnectionContent,
  listSiteConnections,
  fetchConnectionReferences,
  fetchDataverseConnectors,
  resolveComponentType,
  fetchSolutionObjectIds,
  discoverSiteConnectionDependencies,
  computeMissing,
};
