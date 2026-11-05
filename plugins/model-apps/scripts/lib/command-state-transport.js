'use strict';
// The one way the command-state feature talks to Dataverse: reads of the few resources it needs, by a path below the API root. (A later
// change adds the one write it makes; this file exposes no other.)
//
// It is built over the plugin's raw az-token client (`createAzHttpClient`, lib/sdk-http-client.js), which takes ABSOLUTE urls on the
// environment's origin and refuses any other, and over the SDK's own `dataverse.apiUrl(path)`, which says what the API root is — so the root
// is never guessed or pinned to a version here. The shared readers in lib/app-components.js call it the way they call the SDK's client:
//   reader.get('/appmodules?$select=...')              -> GET https://contoso.crm.dynamics.com/api/data/v9.0/appmodules?$select=...
//   reader.getAbsolute('<the @odata.nextLink of a page>') -> the continuation, as the platform gave it
//   reader.apiUrl('/appactions(...)')                  -> the absolute url, for a message
// Each answer is the raw client's `{ status, headers, body }`, the body parsed from JSON.
//
// Only the paths below are read, so a bug elsewhere cannot turn this into a general reader of the environment, and a continuation the platform
// gives must be under the same API root and name one of the same resources: a link anywhere else is refused before it is sent.

const { CommandStateError } = require('./command-state-contract.js');

// The resources the feature reads, as the path below the API root starts.
const READ_PATHS = [
  /^\/appmodules\?/,
  /^\/appmodules\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?/,
  /^\/appmodulecomponents\?/,
  /^\/EntityDefinitions\(LogicalName='[a-z_][a-z0-9_]*'\)\?\$select=[A-Za-z,]+$/,
  /^\/EntityDefinitions\([0-9a-f-]{36}\)\?\$select=[A-Za-z,]+$/,
  /^\/appactions\?/,
  /^\/appactions\([0-9a-f-]{36}\)\?\$select=[a-z_,]+$/,
];

function unavailable(what) {
  return new CommandStateError('command-state-transport-unavailable', `command-state transport unavailable: ${what}`);
}

/**
 * @param {object} options
 * @param {{ get: Function }} options.client - the raw client: absolute same-origin urls, `{ status, headers, body }` answers
 * @param {(path: string) => string} options.apiUrl - the SDK's `dataverse.apiUrl`: a path below the API root -> its absolute url
 */
function createCommandStateTransport({ client, apiUrl } = {}) {
  if (!client || typeof client.get !== 'function') throw unavailable('no raw client to read with');
  if (typeof apiUrl !== 'function') throw unavailable('no API root to read under');
  // The API root, e.g. https://contoso.crm.dynamics.com/api/data/v9.0 — what every url this transport sends must start with.
  const root = String(apiUrl('/')).replace(/\/$/, '');
  let rootUrl;
  try {
    rootUrl = new URL(root);
  } catch {
    throw unavailable(`the API root '${root}' is not an absolute url`);
  }
  if (rootUrl.protocol !== 'https:') throw unavailable(`the API root '${root}' is not https`);

  const allowed = (path) => READ_PATHS.some((re) => re.test(path));
  const refuse = (path) => new CommandStateError('command-state-transport-unavailable', `command-state transport: refusing to read '${path}', which is not one of the resources this feature reads`);

  const get = async (path) => {
    if (typeof path !== 'string' || !allowed(path)) throw refuse(path);
    return client.get(`${root}${path}`);
  };
  // A continuation is absolute: it must be under the same root (same origin, same API version) and name an allowed resource.
  const getAbsolute = async (url) => {
    if (typeof url !== 'string' || !url.startsWith(`${root}/`) || !allowed(url.slice(root.length))) throw refuse(url);
    return client.get(url);
  };
  return Object.freeze({ get, getAbsolute, apiUrl: (path) => `${root}${path}` });
}

module.exports = { createCommandStateTransport, READ_PATHS };
