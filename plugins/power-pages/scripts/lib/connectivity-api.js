#!/usr/bin/env node

// Client for the environment-routed Power Platform API "connectivity" surface:
// connector metadata, the connections that exist for a connector, and migrating
// custom connectors into a Dataverse solution ("making them solution-aware").
//
// Why a separate client: these endpoints are served ONLY from the per-environment
// host (`<env-hex>.<shard>.environment.api.powerplatform.com`), not from the global
// `api.powerplatform.com` used by power-platform-api.js, and they use their own
// api-version values. The host shape is allow-listed in validation-helpers.js
// (isEnvironmentApiHost) so an Authorization header never follows an arbitrary URL.
//
// Endpoints used (all require a token for the Power Platform API audience):
//   GET  /connectivity/connectors/{connectorName}?api-version=1&$filter=environment eq '{envId}'
//        → { name, properties: { displayName, isCustomApi, almMode, xrmConnectorId, ... } }
//          `almMode: "Solution"` + `xrmConnectorId` (the Dataverse `connector` row id) means the
//          custom connector is solution-aware; a connector created outside a solution has neither.
//   GET  /connectivity/connectors/{connectorName}/connections?api-version=1
//        → { value: [{ name, id, properties: { displayName, apiId, statuses: [{ status }] } }], nextLink? }
//          `name` (a GUID without dashes) is the value Dataverse stores in
//          connectionreference.connectionid and Pipelines expects as `ConnectionId`.
//   POST /connectivity/solutions/{solutionId}/makeConnectorsSolutionAware?api-version=2022-03-01-preview
//        body { "apisToMigrate": ["shared_<name>-<hash>-<hash>"] }
//        → { statuses: { "<connectorName>": { status: "Success" | ... , error? } } }
//          This is the call the maker portal makes when a non-solution-aware custom connector
//          is added to a solution. It moves the connector into Dataverse, so callers MUST get
//          explicit user consent first (see make-connectors-solution-aware.js).
//
// Custom connectors must be solution-aware, and imported in their own solution before any
// connection reference that uses them:
// https://learn.microsoft.com/en-us/connectors/custom-connectors/customconnectorssolutions#known-limitations

'use strict';

const helpers = require('./validation-helpers');

const CONNECTOR_API_VERSION = '1';
const MIGRATE_API_VERSION = '2022-03-01-preview';

// Cloud name (as printed by `pac auth who`) → environment-routed host suffix. The
// shard length per suffix lives in validation-helpers so the allowlist and the URL
// builder can never disagree. China is intentionally absent: no environment-routed
// host has been verified there, so callers fall back to maker-portal guidance.
const CLOUD_TO_ENVIRONMENT_API_SUFFIX = Object.freeze({
  Public: 'environment.api.powerplatform.com',
  UsGov: 'environment.api.gov.powerplatform.microsoft.us',
  UsGovHigh: 'environment.api.high.powerplatform.microsoft.us',
  UsGovDod: 'environment.api.appsplatform.us',
});

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Connector internal names: `shared_sharepointonline`, `shared_myapi-5f0a…-5f18…`.
const CONNECTOR_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
// Custom connectors carry an 18-hex-character suffix that certified connectors never
// have. The shape differs by how the connector got into the environment, e.g.
//   shared_contosoapi-0123456789abcdef01-fedcba9876543210fe   (created in this environment)
//   shared_cr123-5fcontosoapi-0123456789abcdef01              (imported from a solution)
// The internal name therefore CHANGES across environments; the Dataverse `connector`
// row's schema name (`name`, e.g. cr123_contosoapi) is the stable identity. Used only as
// a fallback signal when neither Dataverse nor the connectivity API can classify it.
const CUSTOM_CONNECTOR_NAME_RE = /^shared_[A-Za-z0-9_-]+-[0-9a-f]{18}$/i;

/**
 * Builds the environment-routed base URL, e.g. for environment
 * `00000000-0000-0000-0000-0000000000ab` in the Public cloud:
 *   https://000000000000000000000000000000.ab.environment.api.powerplatform.com
 * A `Default-<guid>` environment id keeps a `default` prefix on the first label.
 */
function buildEnvironmentApiBaseUrl(environmentId, cloud = 'Public') {
  const suffix = CLOUD_TO_ENVIRONMENT_API_SUFFIX[cloud || 'Public'];
  if (!suffix) {
    throw new Error(`No environment-routed Power Platform API host is known for cloud "${cloud}".`);
  }
  const raw = String(environmentId || '').trim();
  const isDefault = /^default-/i.test(raw);
  const guid = raw.replace(/^default-/i, '');
  if (!GUID_RE.test(guid)) {
    throw new Error(`Invalid environment id "${environmentId}" — expected a GUID (optionally prefixed with "Default-").`);
  }
  const hex = guid.replace(/-/g, '').toLowerCase();
  const shardLength = helpers.ENVIRONMENT_API_HOST_SUFFIXES[suffix];
  const splitAt = hex.length - shardLength;
  return `https://${isDefault ? 'default' : ''}${hex.slice(0, splitAt)}.${hex.slice(splitAt)}.${suffix}`;
}

/** Token audience for the environment-routed host is the cloud's Power Platform API. */
function tokenResourceForCloud(cloud = 'Public') {
  const resource = helpers.CLOUD_TO_API[cloud || 'Public'];
  if (!resource || !CLOUD_TO_ENVIRONMENT_API_SUFFIX[cloud || 'Public']) {
    throw new Error(`No Power Platform API token audience is known for cloud "${cloud}".`);
  }
  return resource;
}

/**
 * Accepts a connector id as stored on connectionreference.connectorid
 * (`/providers/Microsoft.PowerApps/apis/shared_sharepointonline`) or a bare
 * connector name, and returns the bare name. Throws on anything else so a
 * malformed value can never be spliced into a request path.
 */
function connectorNameFromId(connectorId) {
  const value = String(connectorId || '').trim();
  const match = /^\/providers\/Microsoft\.PowerApps\/apis\/([^/?#]+)$/i.exec(value);
  const name = match ? match[1] : value;
  if (!CONNECTOR_NAME_RE.test(name)) {
    throw new Error(`Invalid connector id "${connectorId}".`);
  }
  return name;
}

function connectorIdFromName(connectorName) {
  return `/providers/Microsoft.PowerApps/apis/${connectorNameFromId(connectorName)}`;
}

function looksLikeCustomConnector(connectorName) {
  return CUSTOM_CONNECTOR_NAME_RE.test(String(connectorName || ''));
}

function odataLiteral(value) {
  return String(value).replace(/'/g, "''");
}

async function apiRequest({ method = 'GET', url, token, body, makeRequest = helpers.makeRequest }) {
  const res = await makeRequest({
    url,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : null,
    timeout: 60000,
  });
  if (res.error) return { ok: false, statusCode: 0, body: null, error: res.error };
  let parsed = null;
  try {
    parsed = res.body ? JSON.parse(res.body) : null;
  } catch {
    parsed = res.body;
  }
  const ok = res.statusCode >= 200 && res.statusCode < 300;
  let error = null;
  if (!ok) {
    // Connectivity errors arrive as { "error": { "code": "...", "message": "..." } }
    // (e.g. code "MissingEnvironmentFilter" when $filter=environment is omitted).
    const e = parsed && typeof parsed === 'object' ? parsed.error : null;
    error = e ? `${e.code || `HTTP ${res.statusCode}`}: ${e.message || ''}`.trim() : `HTTP ${res.statusCode}`;
  }
  return { ok, statusCode: res.statusCode, body: parsed, error };
}

function normalizeConnector(body) {
  const p = (body && body.properties) || {};
  const xrmConnectorId = p.xrmConnectorId || null;
  return {
    name: body && body.name,
    displayName: p.displayName || (body && body.name) || null,
    isCustomApi: p.isCustomApi === true,
    almMode: p.almMode || null,
    xrmConnectorId,
    isSolutionAware: String(p.almMode || '').toLowerCase() === 'solution' && !!xrmConnectorId,
  };
}

/** Reads one connector's metadata in the given environment. Returns null on 404. */
async function getConnector({ environmentId, connectorName, cloud = 'Public', token, makeRequest }) {
  const name = connectorNameFromId(connectorName);
  const base = buildEnvironmentApiBaseUrl(environmentId, cloud);
  const filter = encodeURIComponent(`environment eq '${odataLiteral(environmentId)}'`);
  const url = `${base}/connectivity/connectors/${name}?api-version=${CONNECTOR_API_VERSION}&$filter=${filter}`;
  const res = await apiRequest({ url, token, makeRequest });
  if (res.statusCode === 404) return null;
  if (!res.ok) throw new Error(`Connector lookup for ${name} failed: ${res.error}`);
  return normalizeConnector(res.body);
}

/**
 * Lists the connections that exist for a connector in the environment, following
 * `nextLink` pages (bounded). Only same-origin next links are followed — the token
 * is never sent to a host the first request didn't target.
 */
async function listConnections({ environmentId, connectorName, cloud = 'Public', token, makeRequest, maxPages = 20 }) {
  const name = connectorNameFromId(connectorName);
  const base = buildEnvironmentApiBaseUrl(environmentId, cloud);
  let url = `${base}/connectivity/connectors/${name}/connections?api-version=${CONNECTOR_API_VERSION}`;
  const out = [];
  for (let page = 0; url && page < maxPages; page++) {
    const res = await apiRequest({ url, token, makeRequest });
    if (!res.ok) throw new Error(`Listing connections for ${name} failed: ${res.error}`);
    for (const c of (res.body && res.body.value) || []) {
      const p = c.properties || {};
      const statuses = Array.isArray(p.statuses) ? p.statuses.map((s) => s && s.status).filter(Boolean) : [];
      out.push({
        connectionId: c.name,
        displayName: p.displayName || c.name,
        connectorId: p.apiId || connectorIdFromName(name),
        status: statuses[0] || 'Unknown',
        isConnected: statuses.includes('Connected'),
      });
    }
    const next = res.body && (res.body.nextLink || res.body['@odata.nextLink']);
    url = next && new URL(next).origin === new URL(base).origin ? next : null;
  }
  return out;
}

/**
 * Migrates custom connectors into the given (unmanaged) Dataverse solution.
 * Callers must have explicit user consent — this changes how the connector is
 * stored in the environment and cannot be undone from this plugin.
 * Returns { ok, results: [{ connectorName, status, error }] }.
 */
async function makeConnectorsSolutionAware({ environmentId, solutionId, connectorNames, cloud = 'Public', token, makeRequest }) {
  if (!GUID_RE.test(String(solutionId || ''))) throw new Error(`Invalid solutionId "${solutionId}".`);
  const names = (connectorNames || []).map(connectorNameFromId);
  if (names.length === 0) throw new Error('At least one connector name is required.');
  const base = buildEnvironmentApiBaseUrl(environmentId, cloud);
  const url = `${base}/connectivity/solutions/${solutionId}/makeConnectorsSolutionAware?api-version=${MIGRATE_API_VERSION}`;
  const res = await apiRequest({ method: 'POST', url, token, body: { apisToMigrate: names }, makeRequest });
  if (!res.ok) {
    return { ok: false, error: res.error, results: names.map((n) => ({ connectorName: n, status: 'Failed', error: res.error })) };
  }
  // Response: { "statuses": { "<connectorName>": { "status": "Success" } } }. Match keys
  // case-insensitively — the service echoes the name, but casing is not guaranteed.
  const statuses = (res.body && res.body.statuses) || {};
  const byLower = new Map(Object.entries(statuses).map(([k, v]) => [k.toLowerCase(), v]));
  const results = names.map((n) => {
    const entry = byLower.get(n.toLowerCase());
    const status = (entry && entry.status) || 'Unknown';
    const error = entry && entry.error ? (entry.error.message || JSON.stringify(entry.error)) : null;
    return { connectorName: n, status, error };
  });
  return { ok: results.every((r) => /^success/i.test(r.status)), results };
}

module.exports = {
  CLOUD_TO_ENVIRONMENT_API_SUFFIX,
  CONNECTOR_API_VERSION,
  MIGRATE_API_VERSION,
  buildEnvironmentApiBaseUrl,
  tokenResourceForCloud,
  connectorNameFromId,
  connectorIdFromName,
  looksLikeCustomConnector,
  getConnector,
  listConnections,
  makeConnectorsSolutionAware,
};
