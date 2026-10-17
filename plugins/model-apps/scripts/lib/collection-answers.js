'use strict';
// The answer to a read of a COLLECTION, held to being one — at the HTTP client the bundled SDK is given.
//
// Dataverse answers a read of a collection as
//   { "@odata.context": "…", "value": [ … ], "@odata.nextLink": "…" }
// (https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query-data-web-api). Some of the SDK's readers take a 2xx answer with no `value` list for "no rows" — `findTables()`
// is `body.value ?? []` — and the plugin's HTTP client keeps a body that is not JSON as the text it is, so a sign-in page, a proxy's error page, `{}` or `null` read as an environment with
// no table at all. A script that turns "no rows" into a conclusion (`list-tables.js --exact`: every searched table is `missing`, which the planner reads as "create it") must not be handed
// that. The bundle is vendored and is not edited, so the shape is enforced here, on the one read, between the script and the SDK. `{ "value": [] }` is a real, empty answer and passes.
//
//   const client = requireCollectionAnswers(httpClient, {
//     reads: (url) => /\/EntityDefinitions\?/.test(url),            // the reads whose answer must be a collection (the SDK passes the full URL)
//     unreadable: ({ status, shape }) => new Error(`…HTTP ${status} with ${shape}…`),   // the failure to report, with the script's own code and words
//   });
//
// Only a 2xx answer is judged: any other status is the SDK's to report, with the platform's own words (a 403's message, a 400's error), and stays so.
//
// The SDK reports a rejection of its HTTP client as its own `ConnectionError` ("Transport failure reaching <url>: …", code CONNECTION_ERROR) and keeps ours as its `cause` — unless ours is an `SdkError`, which it
// rethrows as it is (the table-list guard below is made one by lib/maker-sdk.js, so a caller reads `error.code`). `unreadableAnswer` finds ours again either way, so a caller can fail with its own code and message
// instead of the SDK's wrapper.
const UNREADABLE = Symbol.for('model-apps.unreadable-collection-answer');
// Set on a client this module has already guarded, so guarding one twice (a caller that hands the SDK factory a client it guarded itself) is not a second layer.
const TABLE_LISTS_GUARDED = Symbol.for('model-apps.table-list-guard');
// How many `cause`s deep the SDK's wrapping is looked through: its own reader does the same (a ConnectionError wraps what it is given, once; a caller's wrapper may add one).
const MAX_CAUSE_DEPTH = 8;

/** Whether `body` is what the platform answers a collection read with: an object whose `value` is a list. */
function isCollection(body) {
  return body !== null && typeof body === 'object' && Array.isArray(body.value);
}

// What a body that is no collection is, in words — never its text: a page can be large, and what a gateway repeats back is not for a message.
const HTML_PAGE = /^\s*<(?:!doctype|html|head|body)\b/i;
function describeAnswer(body) {
  if (body === undefined) return 'an empty body';
  if (body === null) return 'JSON null';
  if (typeof body === 'string') return HTML_PAGE.test(body) ? 'an HTML page' : 'text that is not JSON';
  if (Array.isArray(body)) return 'a JSON array';
  if (typeof body === 'object') return Object.hasOwn(body, 'value') ? 'a JSON object whose "value" is not a list' : 'a JSON object with no "value" list';
  return `a JSON ${typeof body}`;
}

/**
 * `client` with one addition: a 2xx answer to a `get` that `reads(url)` selects must be a collection, or `get` throws what `unreadable({ status, shape, url })` returns.
 * Everything else — every other method, every other read, every other status, the answers themselves — is the client's own, untouched. A client with no `get` is returned as it is.
 * @param {object} client - the SDK's HttpClient
 * @param {{ reads: (url: string) => boolean, unreadable: (answer: { status: number, shape: string, url: string }) => Error, mark?: symbol }} policy - `mark` reads true on the wrapper
 */
function requireCollectionAnswers(client, { reads, unreadable, mark }) {
  if (!client || typeof client.get !== 'function') return client;
  const get = async (url, options) => {
    const response = await client.get(url, options);
    if (reads(url) && response && response.status >= 200 && response.status < 300 && !isCollection(response.body)) {
      throw Object.defineProperty(unreadable({ status: response.status, shape: describeAnswer(response.body), url }), UNREADABLE, { value: true });
    }
    return response;
  };
  // A delegating Proxy over an empty target, as lib/app-header-text.js's guard is: every other member is read from the client AT THE MOMENT it is read (a method it gains or is given later is seen,
  // one it lacks stays absent) and runs with the CLIENT as its receiver. `Object.create(client)` would run an inherited method with the wrapper as `this`, which breaks a client whose methods keep
  // private state (a class with `#fields`: "Receiver must be an instance of class …"); a copy would miss what the client gains later.
  return new Proxy({}, {
    get: (_, key) => {
      if (key === 'get') return get;
      if (mark !== undefined && key === mark) return true;
      const value = client[key];
      return typeof value === 'function' ? value.bind(client) : value;
    },
    has: (_, key) => key === 'get' || (mark !== undefined && key === mark) || key in client,
  });
}

/** The error `requireCollectionAnswers` threw, found in `error` or among its `cause`s; null when `error` is none of that. */
function unreadableAnswer(error) {
  let at = error;
  for (let depth = 0; at && typeof at === 'object' && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (at[UNREADABLE]) return at;
    at = at.cause;
  }
  return null;
}

// --- the table list ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The one collection the plugin's scripts turn into a conclusion about TABLES — one is missing, create it, nothing clashes, it is not a system table so delete it — is the one the SDK's findTables() reads:
//   GET <origin>/api/data/v9.x/EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,IsCustomEntity
// (the full URL, as the SDK sends it). It is the collection, not one table's definition (`EntityDefinitions(LogicalName='account')`) or a table's `…/Attributes`; no other read of the bundle matches. lib/maker-sdk.js
// guards it on every SDK a script makes, so a script that asks findTables() is answered with the table list or a failure — never with "no tables" from a page that is not one.
const TABLES_UNREADABLE = 'TABLES_UNREADABLE';
const TABLE_LIST_READ = /\/EntityDefinitions\?/;

// The words of the failure for a 2xx that is no list of tables: what the answer was (never its text), what that does and does not mean — it is not an empty environment — and the one cause a user can fix.
const tablesUnreadableMessage = ({ status, shape }) => `The environment's tables could not be read: the platform answered HTTP ${status} with ${shape}, which is not a list of tables. `
  + 'Nothing is known about which tables the environment holds — this is not an empty environment, so no table is missing, none should be created and none is safe to delete on the strength of it. '
  + 'If a sign-in or proxy page stands in front of the API, sign in again with the Azure CLI as the identity that owns the environment; then retry.';

/**
 * `client` with its table-list reads held to being a list (requireCollectionAnswers); a failure is `makeError(TABLES_UNREADABLE, message)`. The SDK factory makes it an SdkError, which the bundle rethrows as it is — any other
 * error a client throws, it wraps in a ConnectionError ("Transport failure reaching …") — so a caller reads `error.code`. A client that is already guarded is returned as it is.
 */
function guardTableLists(client, makeError = (code, message) => Object.assign(new Error(message), { code })) {
  if (!client || client[TABLE_LISTS_GUARDED]) return client;
  return requireCollectionAnswers(client, {
    reads: (url) => TABLE_LIST_READ.test(url),
    unreadable: (answer) => makeError(TABLES_UNREADABLE, tablesUnreadableMessage(answer)),
    mark: TABLE_LISTS_GUARDED,
  });
}

module.exports = { requireCollectionAnswers, unreadableAnswer, isCollection, describeAnswer, guardTableLists, TABLES_UNREADABLE, TABLE_LIST_READ, tablesUnreadableMessage };
