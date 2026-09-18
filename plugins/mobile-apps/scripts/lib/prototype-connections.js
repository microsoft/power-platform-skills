'use strict';

const https = require('node:https');
const { revision } = require('./prototype-files');
const { getAuthToken } = require('./validation-helpers');
const { resolveEnvironment } = require('../resolve-environment');

const RESOURCE = 'https://api.powerplatform.com';
const MAX_BYTES = 8 * 1024 * 1024;

function environmentId(value) {
  if (typeof value !== 'string' || !/^(?:Default-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    || ![36, 44].includes(value.length)) throw new Error('An explicit environment GUID or Default-GUID is required');
  return value.toLowerCase();
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[^A-Za-z0-9_.-]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function apiId(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Connection response is missing a valid connector API ID');
  const qualified = /^\/providers\/Microsoft\.PowerApps\/apis\/([A-Za-z0-9_-]+)$/i.exec(value);
  const id = qualified ? qualified[1] : value;
  if (id.length > 160 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) throw new Error('Invalid connector API ID');
  return id;
}

function connectionName(value, api) {
  const qualified = typeof value === 'string' && (
    /^\/providers\/Microsoft\.PowerApps\/apis\/([^/]+)\/connections\/([^/]+)$/i.exec(value)
    || /^([A-Za-z][A-Za-z0-9_-]*)\/([A-Za-z0-9_.-]+)$/.exec(value)
  );
  if (!qualified) return identifier(value, 'connection ID');
  if (apiId(qualified[1]) !== api) throw new Error('Connection and connector API disagree');
  return identifier(qualified[2], 'connection ID');
}

function connectionsUrl(id, api) {
  const normalized = environmentId(id);
  const isDefault = normalized.startsWith('default-');
  const hex = normalized.replace(/^default-/, '').replaceAll('-', '');
  const host = `${isDefault ? 'default' : ''}${hex.slice(0, 30)}.${hex.slice(30)}.environment.api.powerplatform.com`;
  return `https://${host}/connectivity/${api ? `connectors/${encodeURIComponent(apiId(api))}/` : ''}connections?api-version=1`;
}

function readJsonGet(url, token, { transport = https } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error('Connection inventory requires a credential-free HTTPS URL');
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('Connection inventory authentication is unavailable');
  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 30000,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('error', () => reject(new Error('Read-only connection inventory response failed')));
      response.on('aborted', () => reject(new Error('Read-only connection inventory response was interrupted')));
      response.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > MAX_BYTES) { request.destroy(); reject(new Error('Connection inventory response exceeds its bound')); }
        else chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Read-only connection inventory failed (HTTP ${response.statusCode}); no connection was created`));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {
          reject(new Error('Connection inventory returned invalid JSON'));
        }
      });
    });
    request.on('error', () => reject(new Error('Read-only connection inventory request failed')));
    request.on('timeout', () => { request.destroy(); reject(new Error('Read-only connection inventory timed out')); });
    request.end();
  });
}

async function pages(first, token, requestJson) {
  const base = new URL(first);
  const visited = new Set();
  const rows = [];
  let size = 0;
  let next = first;
  while (next) {
    const url = new URL(next, first);
    if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash) {
      throw new Error('Connection inventory continuation changed its environment or resource');
    }
    if (visited.has(url.href) || visited.size >= 100) throw new Error('Connection inventory pagination did not terminate');
    visited.add(url.href);
    const value = await requestJson(url.href, token);
    if (!value || !Array.isArray(value.value)) throw new Error('Connection inventory is missing its value array');
    if (rows.length + value.value.length > 10000) throw new Error('Connection inventory exceeds its row bound');
    size += Buffer.byteLength(JSON.stringify(value.value));
    if (size > MAX_BYTES) throw new Error('Connection inventory exceeds its aggregate response bound');
    rows.push(...value.value);
    const links = [value.nextLink, value['@odata.nextLink']].filter((link) => link !== undefined && link !== null);
    if (links.some((link) => typeof link !== 'string' || !link.trim())) throw new Error('Invalid connection inventory continuation');
    if (links.length === 2 && links[0] !== links[1]) throw new Error('Ambiguous connection inventory continuation');
    next = links[0] || null;
  }
  return rows;
}

function label(value, fallback) {
  return typeof value === 'string' && value.trim()
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : fallback;
}

function normalizeConnection(row, id, scopedApi) {
  if (!row || typeof row !== 'object') throw new Error('Malformed connection inventory row');
  const resource = typeof row.id === 'string' && /^\/providers\/Microsoft\.PowerApps\/apis\/([^/]+)\/connections\/([^/]+)$/i.exec(row.id);
  const qualifiedName = typeof row.name === 'string' && /^([A-Za-z][A-Za-z0-9_-]*)\/([A-Za-z0-9_.-]+)$/.exec(row.name);
  const api = apiId(row.properties?.apiId || (resource && resource[1]) || (qualifiedName && qualifiedName[1]) || scopedApi);
  const connection = connectionName(row.name || (resource && resource[2]), api);
  if (resource && (apiId(resource[1]) !== api || resource[2] !== connection)) throw new Error('Connection ID and API resource disagree');
  const declaredEnvironment = row.properties?.environment?.name;
  if (declaredEnvironment && environmentId(declaredEnvironment) !== id) throw new Error('Connection inventory contains a different environment');
  const statuses = row.properties?.statuses;
  const connected = Array.isArray(statuses) && statuses.length > 0 && statuses.every((entry) => entry?.status === 'Connected');
  return {
    kind: 'connection', environmentId: id, apiId: api, connectionId: connection,
    displayName: label(row.properties?.displayName, connection),
    availability: connected ? 'available' : 'needs-sign-in',
  };
}

async function readConnectionCatalog(options, dependencies = {}) {
  const id = environmentId(options.environmentId);
  const api = options.apiId === undefined ? undefined : apiId(options.apiId);
  if (options.tenantId !== undefined && environmentId(options.tenantId).length !== 36) throw new Error('An explicit tenant GUID is required');
  if (options.references !== undefined && typeof options.references !== 'boolean') throw new Error('references must be boolean');
  const getToken = dependencies.getToken || getAuthToken;
  const requestJson = dependencies.requestJson || readJsonGet;
  const token = await getToken(RESOURCE, options.tenantId);
  if (!token) throw new Error('Connection inventory authentication is unavailable');
  // The environment-sharded PPAPI supports listing without a Dataverse database.
  const rows = await pages(connectionsUrl(id, api), token, requestJson);
  const connections = rows.map((row) => normalizeConnection(row, id, api));
  if (api && connections.some((entry) => entry.apiId !== api)) throw new Error('Connection inventory returned another connector');
  const items = [...connections];
  let references = 'not-requested';
  if (options.references === true) {
    const resolve = dependencies.resolveEnvironment || resolveEnvironment;
    const resolved = await resolve(options.environmentId, { noCache: true });
    if (environmentId(resolved.environmentId) !== id) throw new Error('Connection-reference environment resolution changed');
    const origin = new URL(resolved.environmentUrl);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname)) {
      throw new Error('Connection-reference environment URL is invalid');
    }
    const refToken = await getToken(origin.origin, resolved.tenantId || options.tenantId);
    if (!refToken) throw new Error('Connection-reference authentication is unavailable');
    const query = new URLSearchParams({
      '$select': 'connectionid,connectorid,connectionreferencedisplayname,connectionreferencelogicalname,statecode',
      '$filter': api ? `statecode eq 0 and connectorid eq '/providers/Microsoft.PowerApps/apis/${api}'` : 'statecode eq 0',
    });
    const refs = await pages(`${origin.origin}/api/data/v9.2/connectionreferences?${query}`, refToken, requestJson);
    for (const ref of refs) {
      const refApi = apiId(ref.connectorid);
      if (api && refApi !== api) throw new Error('Connection reference belongs to another connector');
      const connectionRef = identifier(ref.connectionreferencelogicalname, 'connection reference');
      const bound = ref.connectionid ? connectionName(ref.connectionid, refApi) : null;
      const actual = connections.find((entry) => entry.apiId === refApi && entry.connectionId === bound);
      items.push({
        kind: 'connection-ref', environmentId: id, apiId: refApi, connectionRef,
        boundConnectionId: bound, displayName: label(ref.connectionreferencedisplayname, connectionRef),
        availability: ref.statecode === 0 && actual?.availability === 'available' ? 'available' : 'unavailable',
      });
    }
    references = 'included';
  }
  const keys = new Set();
  if (items.length > 10000) throw new Error('Connection catalogue exceeds its item bound');
  for (const item of items) {
    item.id = revision([id, item.apiId, item.kind, item.connectionId || item.connectionRef]);
    if (keys.has(item.id)) throw new Error('Connection inventory contains duplicate identities');
    keys.add(item.id);
  }
  items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const catalog = { schemaVersion: 1, kind: 'connector', environmentId: id, references, items };
  catalog.catalogRevision = revision(catalog);
  return catalog;
}

function validateConnectorSelection(catalog, selection) {
  if (!catalog || catalog.schemaVersion !== 1 || catalog.kind !== 'connector'
    || !Array.isArray(catalog.items) || catalog.items.length > 10000
    || !['not-requested', 'included'].includes(catalog.references)
    || environmentId(catalog.environmentId) !== catalog.environmentId) throw new Error('Connection catalogue is missing or stale');
  const content = { ...catalog };
  delete content.catalogRevision;
  if (catalog.catalogRevision !== revision(content)) {
    throw new Error('Connection catalogue is missing or stale');
  }
  const keys = new Set();
  for (const item of catalog.items) {
    if (!item || !['connection', 'connection-ref'].includes(item.kind) || item.environmentId !== catalog.environmentId
      || apiId(item.apiId) !== item.apiId) throw new Error('Malformed connection catalogue item');
    const reference = item.kind === 'connection-ref';
    const name = identifier(reference ? item.connectionRef : item.connectionId, 'catalogue identity');
    if (Object.hasOwn(item, reference ? 'connectionId' : 'connectionRef')
      || item.id !== revision([catalog.environmentId, item.apiId, item.kind, name]) || keys.has(item.id)
      || !(reference ? ['available', 'unavailable'] : ['available', 'needs-sign-in']).includes(item.availability)) {
      throw new Error('Malformed or duplicate connection catalogue item');
    }
    keys.add(item.id);
    if (reference) {
      if (catalog.references !== 'included') throw new Error('Connection reference inventory was not requested');
      if (item.boundConnectionId !== null) identifier(item.boundConnectionId, 'bound connection ID');
      if (item.availability === 'available' && !catalog.items.some((connection) => connection.kind === 'connection'
        && connection.apiId === item.apiId && connection.connectionId === item.boundConnectionId && connection.availability === 'available')) {
        throw new Error('Connection reference has no available exact bound connection');
      }
    }
  }
  if (!selection || selection.kind !== 'connector' || selection.catalogRevision !== catalog.catalogRevision
    || environmentId(selection.environmentId) !== catalog.environmentId
    || Object.hasOwn(selection, 'connectionId') === Object.hasOwn(selection, 'connectionRef')
    || Object.keys(selection).some((key) => !['kind', 'apiId', 'environmentId', 'catalogRevision', 'connectionId', 'connectionRef'].includes(key))) {
    throw new Error('Connection selection requires the exact environment/catalogue and one ID or reference');
  }
  const selectedApi = apiId(selection.apiId);
  const key = typeof selection.connectionId === 'string' ? 'connectionId' : 'connectionRef';
  const selectedId = identifier(selection[key], key);
  const item = catalog.items.find((entry) => entry.apiId === selectedApi && entry[key] === selectedId);
  if (!item || item.availability !== 'available') throw new Error('Selected existing connection is unavailable; refresh the catalogue');
  return { ...selection, apiId: selectedApi, environmentId: catalog.environmentId, discoveryConnectionId: item.connectionId || item.boundConnectionId };
}

module.exports = { environmentId, connectionsUrl, readJsonGet, readConnectionCatalog, validateConnectorSelection };
