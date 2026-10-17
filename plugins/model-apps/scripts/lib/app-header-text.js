'use strict';
// The text of an app's header — its `name` and `description` — held to being PLAIN TEXT, at the HTTP client the bundled SDK is given.
//
// Both are String columns of the app module table
// (https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodule). The build edits them on the workspace copy of
// an existing app (sdk-build.js `applyAppHeaderText`) and never edits a text that is not plain — a text per language held as an LCID map, a list, a
// number — because the SDK writes the header from the whole copy and cannot be told to leave one field out. That hold is on the COPY, though, and the
// SDK decides for itself whether the header is written. Its push of an app makes two requests about the header (the vendored bundle, `pushArtifact('app')`):
//
//   GET   …/api/data/v9.0/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename,description,aiappdescription&$filter=appmoduleid eq <id>&$top=1
//         (the commas and the spaces are percent-encoded on the wire)
//   PATCH …/api/data/v9.0/appmodules(<id>)?$select=appmoduleid            If-Match: W/"<the row's token>"
//         { "name": "Help Desk", "description": "Track tickets" }          (plus "aiappdescription" when the copy carries one)
//
// The PATCH is made when that comparison read finds the copy's header different from the row's — and also when the read CANNOT be made: the SDK's "write
// needed" flag starts true and only a 2xx answer sets it, so a read that answers 503 or 403, or that throws, leaves it true; a 200 with no row is compared
// with an empty header, which differs, so it comes out true as well. The header is then written from the copy as it is, a text that is not plain included.
// "The build made no header edit" has therefore never meant "no header PATCH". The one place that sees
// every request is the client, so the last line of defence is there: a PATCH of an app module row whose body carries a `name` or a `description` that is not
// a string is not sent. It fails before any byte leaves, with APP_HEADER_NOT_PLAIN_TEXT. (Pinned against the real bundle, for each way the comparison read
// can fail, in tests/app-header-text-real-bundle.test.js.)
//
// THE OTHER DOORS. The SDK's own `patch` is not the only way that PATCH can leave the process. `sdk.dataverse` is a public surface, and three more of its methods reach the client with a body this module
// does not see as an object:
//   postBatch(body, boundary)     →  client.postRaw(<api>/$batch, body, { headers: { 'Content-Type': 'multipart/mixed;boundary=<boundary>' } })     a change set the CALLER rendered
//   post(path, text, options)     →  client.post(…): the plugin's client sends a string body as it is, so the same multipart text reaches `$batch` this way as well
//   patchRaw(path, bytes, opts)   →  client.patchRaw(…): a PATCH whose body is bytes — a File column takes those, and an app module row would take them as JSON
// A PATCH of an app module row that rides in any of them is the same write, so it is judged the same way. The SDK's own atomic writes (a table's columns, an app's delete, a page's rows) go through
// `postRaw` as well, which is why what a batch WRITES is what is read, and nothing else: lib/batch-request.js reads the batch the way the service does (the parts of the boundary the Content-Type declares,
// each a request) and each PATCH of an app module row in it is judged as a `patch` of it is. A body that does not name the app module table at all is not read, so every other write goes to the client as the
// very text it was handed. One that names it and cannot be read — it is cut short, its boundary is not the declared one, a part is not a request — is refused with the same typed error, because a guard
// exists to say what a request writes and cannot say it of that one. A body this module is handed only as TEXT — a part of a change set, the bytes of a raw PATCH — has to read as JSON: one that does not
// is refused too, because the service's reader is not JSON.parse (a parser MAY skip a byte order mark, which JSON.parse refuses: RFC 8259 8.1, https://www.rfc-editor.org/rfc/rfc8259#section-8.1), so text
// this cannot read is not known to be harmless. The SDK hands `patch` an object and it is judged as the object it is.
//
// What the refusal leaves behind: nothing was sent, and the SDK writes the header BEFORE the navigation, so the app is exactly as it was and the push wrote
// nothing of its sitemap either. The error is typed and marked `transient: false`: the build never runs a phase again on its own for it — the guard cannot tell
// a read that failed for a moment from one that will fail again, and three silent re-runs would hide the message — and the message tells the maker that
// running it again normally succeeds, which it does once the comparison read answers (the SDK then finds the copy equal to the row and sends no header at all).
// It is an `SdkError` (made by lib/maker-sdk.js, which hands this module the SDK's own class), which the bundle rethrows as it is: the SDK would otherwise
// wrap anything else a client throws in its ConnectionError ("Transport failure reaching <url>: …", code CONNECTION_ERROR), and the code this error carries
// would be one `cause` down.

const { readBatchRequest } = require('./batch-request.js');

const APP_HEADER_NOT_PLAIN_TEXT = 'APP_HEADER_NOT_PLAIN_TEXT';

// The two texts of the header. The routing description (`aiappdescription`) is the spec's own string or what the row holds, and is not judged here.
const HEADER_TEXTS = Object.freeze(['name', 'description']);

// How a header text that is not plain reads in a message: "localized (2 languages: 1033, 1036)" for a text per language, an LCID map; otherwise what came
// back, as a kind.
const isAppTextMap = (have) => have !== null && typeof have === 'object' && !Array.isArray(have);
const appTextKind = (have) => (have === null ? 'null' : have === undefined ? 'no value' : Array.isArray(have) ? 'a list' : `a ${typeof have}`);
const localizedAppText = (have) => {
  const languages = Object.keys(have);
  return `localized (${languages.length} language${languages.length === 1 ? '' : 's'}: ${languages.join(', ')})`;
};
// The header's texts that are not plain, as the start of a sentence: "the app's name is localized (2 languages: 1033, 1036) and its
// description could not be read as plain text (it came back as a list)". `held` is `[{ key, have }]`.
function describeHeldAppText(held) {
  return held.map(({ key, have }, i) => `${i === 0 ? 'the app\'s' : 'its'} ${key} ${isAppTextMap(have) ? `is ${localizedAppText(have)}` : `could not be read as plain text (it came back as ${appTextKind(have)})`}`).join(' and ');
}

// What the service reads an address as: percent-escapes decoded — `%61ppmodules(<id>)` is `appmodules(<id>)` to it, as `%41` is `A` (RFC 3986 2.3, https://www.rfc-editor.org/rfc/rfc3986#section-2.3) —
// and with the query string and the fragment off. Only runs of valid escapes are decoded; a stray `%` stays what it is.
const decodeEscapes = (text) => text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
  try {
    return decodeURIComponent(run);
  } catch {
    // Escapes that are not UTF-8 (`%C0%AF`) are left as written: nothing here depends on them, and a text is never refused for how it spells a `%`.
    return run;
  }
});
// `undefined` for an address that cannot be turned into text (an object whose `toString` throws): the client refuses such a request itself.
// The transport sends the path `new URL(address)` makes of it (lib/dataverse-auth.js), and that resolves dot segments — `/$batch/.`, `/x/..`, and their `%2e` spellings — and reads `\` as `/` in an https
// address. So the address is read the same way here, or a spelling the service takes for the batch endpoint or an app module's row would be classified as something else and go out unread. A
// relative address (a part of a batch writes one) is resolved against a service root that only serves to resolve it; one `new URL` cannot read is read as it is written.
// See: https://url.spec.whatwg.org/#concept-basic-url-parser (single-dot and double-dot path segments, and `\` in a special scheme's path)
const RESOLVE_AGAINST = 'https://service-root.invalid/api/data/v9.0/';
function pathOf(address) {
  let text;
  try {
    text = String(address);
  } catch {
    return undefined;
  }
  try {
    return decodeEscapes(new URL(text, RESOLVE_AGAINST).pathname);
  } catch {
    return literalPathOf(text);
  }
}
// The address as it is written — escapes decoded, query and fragment off, nothing resolved — for what only the written form says: a part of a change set that addresses the row an earlier part
// created by its Content-ID (`$1`), which no base may be resolved against.
function literalPathOf(address) {
  try {
    return decodeEscapes(String(address).split(/[?#]/, 1)[0]);
  } catch {
    return undefined;
  }
}

// The row of an app module: `…/appmodules(<id>)`, and not what hangs below it (`…/appmodules(<id>)/appmoduleroles_association/$ref`). The address is absolute, as the SDK writes one, or — as a part
// of a batch may write it — relative to the host (`/api/data/v9.0/appmodules(<id>)`) or to the service root (`appmodules(<id>)`).
const APP_MODULE_ROW = /(?:^|\/)appmodules\(([^()/?#]+)\)\/?$/i;
// The collection a new app is created in, and the endpoint of a batch.
const APP_MODULE_COLLECTION = /(?:^|\/)appmodules\/?$/i;
const BATCH_ENDPOINT = /(?:^|\/)\$batch\/*$/i;

function appModuleRowId(address) {
  const path = pathOf(address);
  const row = path === undefined ? null : APP_MODULE_ROW.exec(path);
  return row ? row[1] : undefined;
}

// `{ value }` of a text that is JSON, and undefined for one that is not.
function readJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

// The header texts a request body would send that are not strings, as `[{ key, have }]`; empty when the body is fine. The body is what the SDK hands the
// client — an object, which the client serializes — or text that is already JSON. A key that is absent, or `undefined` (JSON leaves it out), sends
// nothing; `''` is a string and is plain text. `null`, a list, an object, a number and a boolean are none of that. Text that is not JSON has no key to judge.
function nonPlainHeaderTexts(body) {
  const sent = typeof body === 'string' ? (readJson(body) || {}).value : body;
  if (sent === null || typeof sent !== 'object' || Array.isArray(sent)) return [];
  return HEADER_TEXTS.filter((key) => sent[key] !== undefined && typeof sent[key] !== 'string').map((key) => ({ key, have: sent[key] }));
}

function refusalMessage(appId, held) {
  return `Refused before anything was sent: the write of app ${appId}'s header would have carried a text that is not plain — ${describeHeldAppText(held)}. `
    + 'Nothing was sent, so the app is as it was, and the push stopped before it wrote the app\'s navigation. '
    + 'The SDK writes an app\'s header when the one it holds differs from the server\'s, and also when its own read of the server\'s header fails; this plugin never edits a header text that is not plain, '
    + 'so that read most likely failed just now (the service was unavailable or throttled, or answered with nothing usable). '
    + 'Run it again: a re-run normally succeeds. If the same refusal comes back, make the app\'s name and description plain text in Power Apps.';
}

// The same refusal for a write that is not the SDK's own push of an app — a raw change set, a raw PATCH — where the sentences about the SDK's comparison read do not apply: the caller wrote the request.
const RAW_REQUESTS = Object.freeze({ batch: 'a $batch request', patch: 'a raw PATCH' });
function rawRefusalMessage(what, appId, read) {
  const lead = `Refused before anything was sent: ${what} would have written app ${appId}'s header with`;
  if (read.unreadable) return `${lead} a body that is not JSON this plugin can read, so it cannot be told from one whose name or description is not plain text. Nothing was sent.`;
  return `${lead} a text that is not plain — ${describeHeldAppText(read.held)}. ${what === RAW_REQUESTS.batch ? 'Nothing in the batch was sent, so no operation in it ran.' : 'Nothing was sent.'} Send the app's name and description as plain text.`;
}

function unreadableBatchMessage(problem) {
  return `Refused before anything was sent: a $batch request that names the app module table could not be read as a multipart batch (${problem}), so it cannot be told from one that writes an app's name or description as something that is not plain text. `
    + 'Nothing was sent. Send a well-formed multipart/mixed batch, or write the header with a PATCH of the app module row.';
}

// The text a body is sent as, to be read: text as it is, bytes as the UTF-8 they spell, anything else as the JSON it serializes to. `undefined` when there is no body, or when it cannot be turned into
// text — the plugin's client could not send such a body either, and its own refusal is the one to see.
function bodyText(body) {
  try {
    if (typeof body === 'string') return body;
    if (body === undefined || body === null) return undefined;
    if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
    const json = JSON.stringify(body);
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
}

// What a body that is only TEXT to the guard — the body of a part of a change set, the bytes of a raw PATCH — says about the header: `{ held }`, the texts it carries that are not strings (none when it
// is fine, or when it has nothing in it), or `{ unreadable: true }` for text that is not JSON.
function readRawHeaderBody(text) {
  if (text.trim() === '') return { held: [] };
  const json = readJson(text);
  return json ? { held: nonPlainHeaderTexts(json.value) } : { unreadable: true };
}

// The Content-Type of a request, whatever the case of the header's name (the SDK writes `Content-Type`); `undefined` when it has none.
function contentTypeOf(options) {
  const headers = options && options.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const name = Object.keys(headers).find((key) => key.toLowerCase() === 'content-type');
  return name === undefined ? undefined : String(headers[name]);
}

// Whether a request body names the app module table at all, spelled as it is, with escapes (`%61ppmodules`), or — for a JSON text, which is no batch the service reads but is not one this reads either — with
// JSON escapes (`\u0061ppmodules`). A body that does not is none of this guard's business and is not read any further.
const NAMES_APP_MODULE = /appmodule/i;
function namesAppModules(text) {
  if (NAMES_APP_MODULE.test(text)) return true;
  if (text.includes('%') && NAMES_APP_MODULE.test(decodeEscapes(text))) return true;
  const json = readJson(text);
  return !!json && NAMES_APP_MODULE.test(JSON.stringify(json.value));
}

// What a judge says of a request is the message to refuse it with, or undefined when it is the client's. A judge is told the request as the SDK makes it — the address, the body, the options — and
// decides on that alone.

// A `patch`, as the SDK makes one: the body is an object (or JSON text) and is judged as it is.
function judgePatch(url, body) {
  const appId = appModuleRowId(url);
  if (appId === undefined) return undefined;
  const held = nonPlainHeaderTexts(body);
  return held.length ? refusalMessage(appId, held) : undefined;
}

// A PATCH of the row with a body of bytes.
function judgeRawPatch(url, body) {
  const appId = appModuleRowId(url);
  const text = appId === undefined ? undefined : bodyText(body);
  if (text === undefined) return undefined;
  const read = readRawHeaderBody(text);
  return read.unreadable || read.held.length ? rawRefusalMessage(RAW_REQUESTS.patch, appId, read) : undefined;
}

// A POST to the batch endpoint — `postRaw` as the SDK's `postBatch` sends a change set, or `post` with the same text — judged by what the batch writes.
function judgeBatch(url, body, options) {
  const path = pathOf(url);
  if (path === undefined || !BATCH_ENDPOINT.test(path)) return undefined;
  const text = bodyText(body);
  if (text === undefined || !namesAppModules(text)) return undefined;
  const batch = readBatchRequest(text, contentTypeOf(options));
  if (batch.problem) return unreadableBatchMessage(batch.problem);
  // The parts that create an app module, by Content-ID: a later part of the change set may address the row they make as `$1` (OData 4.0, 11.7.3.1 Referencing Requests in a Change Set,
  // http://docs.oasis-open.org/odata/odata/v4.0/os/part1-protocol/odata-v4.0-os-part1-protocol.html#_Toc372793752), and a PATCH of that is a PATCH of an app module row like any other.
  const created = new Set();
  for (const operation of batch.operations) {
    const verb = operation.method.toUpperCase();
    const targetPath = pathOf(operation.target);
    if (verb === 'POST' && targetPath !== undefined && APP_MODULE_COLLECTION.test(targetPath) && operation.contentId !== undefined) created.add(operation.contentId);
    if (verb !== 'PATCH') continue;
    const literal = literalPathOf(operation.target);
    const reference = literal === undefined ? null : /^\$([^/?#]+)\/?$/.exec(literal);
    const appId = appModuleRowId(operation.target) || (reference && created.has(reference[1]) ? `$${reference[1]}` : undefined);
    if (appId === undefined) continue;
    const read = readRawHeaderBody(operation.body);
    if (read.unreadable || read.held.length) return rawRefusalMessage(RAW_REQUESTS.batch, appId, read);
  }
  return undefined;
}

// The methods of the client that are judged before they are called, and by which judge. Every other member is the client's.
const JUDGES = Object.freeze({ patch: judgePatch, patchRaw: judgeRawPatch, post: judgeBatch, postRaw: judgeBatch });

// Set on a client this module has guarded, so one that is guarded twice (a caller hands the SDK factory a client it guarded itself) is not given a second layer.
const GUARDED = Symbol.for('model-apps.app-header-guard');

/**
 * `client` with one addition: a PATCH of an app module row whose body carries a `name` or `description` that is not a string — however it is sent: `patch`, `patchRaw`, or a change set through `postRaw`
 * or `post` — is refused. It rejects with `makeError(APP_HEADER_NOT_PLAIN_TEXT, message)`, marked never to be run again on its own (`transient: false`), and the client is never asked. Every other
 * request, and every answer, is the client's own, untouched: the very arguments, and the client's own answer back.
 *
 * It is a delegating Proxy, and every member it does not judge is the client's own AT THE MOMENT it is read — a method the client gains or is given later is seen (a test that wraps one after the SDK is
 * made, a member the SDK's HttpClient grows — it already has `postRaw` and `patchRaw`, which a client may lack, and the SDK reads their absence), with no list of names here — and runs with the CLIENT as its
 * receiver, an accessor included. `Object.create(client)` would run them with the guard as `this`, which breaks a client whose methods keep private state (a class with `#fields`: its methods throw "Receiver
 * must be an instance of class …" on anything else). The Proxy's own target is empty, so that no property of the client constrains it — a frozen client is guarded as well. A client with no `patch`, or
 * one that is guarded already, is returned as it is.
 * @param {object} client - the SDK's HttpClient
 * @param {(code: string, message: string) => Error} [makeError] - the error to refuse with; lib/maker-sdk.js passes the SDK's own SdkError
 */
function guardAppHeaderWrites(client, makeError = (code, message) => Object.assign(new Error(message), { code })) {
  if (!client || typeof client !== 'object' || typeof client.patch !== 'function' || client[GUARDED]) return client;
  const refuse = (message) => Promise.reject(Object.assign(makeError(APP_HEADER_NOT_PLAIN_TEXT, message), { transient: false }));
  return new Proxy({}, {
    get: (_, key) => {
      if (key === GUARDED) return true;
      const member = client[key];
      if (typeof member !== 'function') return member;
      const judge = Object.hasOwn(JUDGES, key) ? JUDGES[key] : undefined;
      if (!judge) return member.bind(client);
      // Three arguments always, as the SDK passes them; a judge that fails on something it did not expect has no verdict, and the request is the client's: it was never refused before this guard existed.
      return (url, body, options) => {
        let message;
        try {
          message = judge(url, body, options);
        } catch {
          message = undefined;
        }
        return message === undefined ? member.call(client, url, body, options) : refuse(message);
      };
    },
    has: (_, key) => key === GUARDED || key in client,
    // `guarded instanceof TheClientsClass` stays true, as it was when the guard inherited from the client: no invariant of the empty target constrains the prototype it reports.
    getPrototypeOf: () => Object.getPrototypeOf(client),
  });
}

module.exports = { APP_HEADER_NOT_PLAIN_TEXT, guardAppHeaderWrites, nonPlainHeaderTexts, describeHeldAppText, isAppTextMap, appTextKind, localizedAppText };
