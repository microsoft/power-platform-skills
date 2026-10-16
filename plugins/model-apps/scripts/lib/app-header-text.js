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
// What the refusal leaves behind: nothing was sent, and the SDK writes the header BEFORE the navigation, so the app is exactly as it was and the push wrote
// nothing of its sitemap either. The error is typed and marked `transient: false`: the build never runs a phase again on its own for it — the guard cannot tell
// a read that failed for a moment from one that will fail again, and three silent re-runs would hide the message — and the message tells the maker that
// running it again normally succeeds, which it does once the comparison read answers (the SDK then finds the copy equal to the row and sends no header at all).
// It is an `SdkError` (made by lib/maker-sdk.js, which hands this module the SDK's own class), which the bundle rethrows as it is: the SDK would otherwise
// wrap anything else a client throws in its ConnectionError ("Transport failure reaching <url>: …", code CONNECTION_ERROR), and the code this error carries
// would be one `cause` down.

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

// The row of an app module: `…/appmodules(<id>)`, and not what hangs below it (`…/appmodules(<id>)/appmoduleroles_association/$ref`). Matched on the path, before the query.
const APP_MODULE_ROW = /\/appmodules\(([^()/?#]+)\)\/?$/i;

const parsedBody = (body) => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

// The header texts a request body would send that are not strings, as `[{ key, have }]`; empty when the body is fine. The body is what the SDK hands the
// client — an object, which the client serializes — or text that is already JSON. A key that is absent, or `undefined` (JSON leaves it out), sends
// nothing; `''` is a string and is plain text. `null`, a list, an object, a number and a boolean are none of that.
function nonPlainHeaderTexts(body) {
  const sent = typeof body === 'string' ? parsedBody(body) : body;
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

// Set on a client this module has guarded, so one that is guarded twice (a caller hands the SDK factory a client it guarded itself) is not given a second layer.
const GUARDED = Symbol.for('model-apps.app-header-guard');

/**
 * `client` with one addition: a `patch` of an app module row whose body carries a `name` or `description` that is not a string is refused — it rejects with
 * `makeError(APP_HEADER_NOT_PLAIN_TEXT, message)`, marked never to be run again on its own (`transient: false`), and the client is never asked. Every other
 * request, and every answer, is the client's own, untouched.
 *
 * `Object.create` and not a copy, so the client is reached as it is at each call: a method it gains or is given later is seen (a test that wraps one after the SDK
 * is made, a member the SDK's HttpClient grows — it already has `postRaw` and `patchRaw`, which a client may lack), with no list of names here. The one own property
 * is defined, not assigned: assigning over a method of a frozen client throws. A client with no `patch`, or one that is guarded already, is returned as it is.
 * @param {object} client - the SDK's HttpClient
 * @param {(code: string, message: string) => Error} [makeError] - the error to refuse with; lib/maker-sdk.js passes the SDK's own SdkError
 */
function guardAppHeaderWrites(client, makeError = (code, message) => Object.assign(new Error(message), { code })) {
  if (!client || typeof client !== 'object' || typeof client.patch !== 'function' || client[GUARDED]) return client;
  const guarded = Object.create(client);
  Object.defineProperty(guarded, 'patch', {
    value: (url, body, options) => {
      const row = APP_MODULE_ROW.exec(String(url).split(/[?#]/, 1)[0]);
      const held = row ? nonPlainHeaderTexts(body) : [];
      if (!held.length) return client.patch(url, body, options);
      return Promise.reject(Object.assign(makeError(APP_HEADER_NOT_PLAIN_TEXT, refusalMessage(row[1], held)), { transient: false }));
    },
    enumerable: true, configurable: true, writable: true,
  });
  Object.defineProperty(guarded, GUARDED, { value: true });
  return guarded;
}

module.exports = { APP_HEADER_NOT_PLAIN_TEXT, guardAppHeaderWrites, nonPlainHeaderTexts, describeHeldAppText, isAppTextMap, appTextKind, localizedAppText };
