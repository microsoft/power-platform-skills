'use strict';
// The one way the command-state feature talks to Dataverse: reads of the few resources it needs, by a path below the API root, and the one
// write it makes — a conditional PATCH of one command row's `hidden` / `isdisabled` (`patchRow`). It exposes no other write: no POST, no
// PublishXml, no DELETE, no `$batch`; publication stays on the build's own clients.
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

const { CommandStateError, ROW_VERSION, guidOf, serviceAnswerText } = require('./command-state-contract.js');

// The one write: PATCH <root>/appactions(<row id>), nothing after the parenthesis — no $select, no query.
const ROW_PATCH = /\/appactions\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/;

/**
 * The `sendOnce` of the raw client this feature writes with (createAzHttpClient's `deps.sendOnce`): the row PATCH is sent exactly once, whatever
 * answers it. A conditional PATCH answered 503 is otherwise sent again by the client (measured on the fake transport: two sends), and a second send
 * of a write that may have committed is refused 412 against the version the first one made, which reads exactly like another maker's edit.
 * Every read keeps the client's ordinary retries.
 */
function commandStateSendOnce(method, url) {
  return String(method).toUpperCase() === 'PATCH' && ROW_PATCH.test(String(url));
}

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
 * @param {{ get: Function, patch?: Function }} options.client - the raw client: absolute same-origin urls, `{ status, headers, body }` answers.
 *   Without `patch` the transport has no `patchRow`, and a build that needs one refuses before it writes anything.
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
  // Neither refusal says the path or link it refused: a continuation is the service's text (a link can carry anything), and a path is
  // refused only when a defect built it, so naming it helps no maker. The words of a refused continuation are serviceAnswerText's.
  const refusePath = () => new CommandStateError('command-state-transport-unavailable', 'command-state transport: refused a read of a resource this feature does not read');
  const refuseLink = () => new CommandStateError('command-state-transport-unavailable', `command-state transport: ${serviceAnswerText({ problem: 'link-outside' })}`);

  const get = async (path) => {
    if (typeof path !== 'string' || !allowed(path)) throw refusePath();
    return client.get(`${root}${path}`);
  };
  // A continuation is absolute: it must be under the same root (same origin, same API version) and name an allowed resource.
  const getAbsolute = async (url) => {
    if (typeof url !== 'string' || !url.startsWith(`${root}/`) || !allowed(url.slice(root.length))) throw refuseLink();
    return client.get(url);
  };
  const surface = { get, getAbsolute, apiUrl: (path) => `${root}${path}` };
  if (typeof client.patch === 'function') {
    // PATCH /appactions(<rowId>) with If-Match: the exact observed version, and a body of only the flags that change, e.g.
    //   If-Match: W/"4893215"
    //   {"hidden":true}
    // No upsert: with If-Match the platform answers 412 rather than create a row
    // (https://learn.microsoft.com/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api).
    // No MSCRM.SolutionUniqueName header: this must never put a reused row into a solution.
    surface.patchRow = async (rowId, ifMatch, body) => {
      const id = guidOf(rowId);
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
      // The values refused are not said: a row version is the service's tag, and the design keeps tags out of halts and journals.
      if (!id || id !== rowId) throw new CommandStateError('command-state-transport-unavailable', 'command-state transport: a row write names no row id');
      if (typeof ifMatch !== 'string' || !ROW_VERSION.test(ifMatch)) throw new CommandStateError('command-state-transport-unavailable', 'command-state transport: a row write carries no row version');
      if (!keys.length || keys.some((k) => (k !== 'hidden' && k !== 'isdisabled') || typeof body[k] !== 'boolean')) {
        throw new CommandStateError('command-state-transport-unavailable', 'command-state transport: a row write carries hidden and/or isdisabled, as true or false, and nothing else');
      }
      return client.patch(`${root}/appactions(${id})`, { ...body }, { headers: { 'If-Match': ifMatch } });
    };
  }
  return Object.freeze(surface);
}

module.exports = { createCommandStateTransport, commandStateSendOnce, READ_PATHS };
