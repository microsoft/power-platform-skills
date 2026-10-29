'use strict';
// What an edit of an app that is not about its components may ADD to them — held at the SDK's transport, because the SDK offers no push that leaves them alone.
//
// WHAT THE SDK DOES. Every `pushArtifact('app', id)` of an app that exists (the bundle's `appApi.update`) PATCHes the sitemap and then posts ONE AddAppComponents whose
// list it DERIVES, not the list the caller edited:
//   every sub-area of type Entity    the table (by reference), EVERY active Main form of it (type 2, formactivationstate 1), EVERY active public view of it
//                                    (querytype 0, statecode 0) and EVERY chart of it — the app has them or not
//   every DashBoard sub-area         the dashboard
//   the artifact's own `components`  its forms, views, charts and dashboards
// Nothing in the artifact turns the derivation off. `components.mainFormsByTable` (applyAppMainForms, lib/app-components.js) narrows the Main forms and only them: the views and
// the charts always come. AddAppComponents only ADDS, so for an app that offers all of that the post is a no-op, and for one whose maker took a Main form, a view or a chart out
// of it in the designer the push puts it back — and the publish that follows makes it live. A page edit used to end that way, with no warning:
//   placing a page (`add-to-app`, an upload's `--add-to-sitemap`), taking one out (`remove-from-app`), and the pin of the default view of a page's tables that the build
//   and an upload that names an app make.
//
// WHAT A PAGE EDIT OWNS. A page is a GenPage sub-area of the navigation, which needs nothing from the app's components, so the edit changes the sitemap — the SDK's PATCH, kept
// as it is: its serialization of a sub-area is not to be copied — and adds the views it was asked to pin (the maker's "/" picker lists a page's tables from them): nothing else.
// Every component the SDK derives belongs to a sub-area that was in the navigation before the edit, so none of them is the edit's.
//
// WHAT THIS DOES. The bundle is never patched (the next re-vendor would silently undo it) and a push cannot be told to skip the derivation, so the SDK's own request is limited where
// it leaves the process: `wrap` returns an HttpClient — the SDK's documented transport seam — whose AddAppComponents, for an app with an edit open (`limit`), carries only the views
// that edit owns. The rest of the post is dropped; when nothing is left, nothing is sent (an empty list is not a request the service is known to accept) and the SDK is answered
// with the 204 the service gives. A post for an app with no edit open, and every other request, goes through untouched — the build owns the whole app (its spec says what the app holds,
// and `app.mainForms` narrows the Main forms the SDK derives for it), so it never opens an edit.
//
// WHAT IT READS, AND WHAT IT REFUSES. The limit knows the one request the bundle sends today (below). It finds the action by the PATH of the address, never by text elsewhere in it, and it decides on the request in its
// CANONICAL form — the request as the service will read it — and sends that form, in every case (the action it cuts, another app's request, a request to another address, a `$batch`), never what the caller happens to hold: the
// address as text, percent-decoded to be read (`AddAppComponents%2F` and `%41ddAppComponents` are the action in another spelling, not another action) and the body put into the plain JSON data the plugin's transport will put
// on the wire. While an edit is open, a request that IS the action but cannot be read in that form is REFUSED — the action in another spelling (lower case, a trailing slash, a namespace, an escape), an address that cannot be
// decoded, a `post` body that is JSON text (the SDK gives a `post` an object), a body that is not JSON or has no list, a view that is only a reference — and so is one that does not carry every view the edit pins. It is not
// forwarded: that would send the SDK's whole derived list, which is what this holds back.
// And it is not answered as done: a pin it could not read would be dropped and reported as made. It is refused with the bundle's SdkError (`APP_COMPONENTS_NOT_LIMITED`). The SDK catches every
// error of that request and reports it as a warning of the push ("one or more components were not pinned (…)"), so the navigation the edit saved stays saved, the warning says what was not added,
// and nothing unlimited reaches the app.
//
// WHAT IS RAW. `postRaw` is a real POST — the plugin's transport sends it with text it does not touch, and JSON-serializes any other body — and not only the way the SDK sends a `$batch`, so a request to the action's
// address could arrive that way too (a bundle that sent it so, or another caller). It is told by its ADDRESS exactly as a `post` is, and its body is read into the same canonical form: JSON text, the UTF-8 bytes of it
// (a byte order mark, another encoding and bytes that are not UTF-8 are not read) or an object. What goes on is that form, cut to what the edit owns, in a representation the transport sends as it is: the JSON text for
// text and for bytes (a Buffer would be sent as `{"type":"Buffer","data":[…]}`, which is not the action's parameters), the plain object for an object. A Content-Length the caller declared — in whatever spelling —
// becomes one header with the exact length of what is written, or the receiver would wait for bytes that never come.
//
// WHY A REQUEST IS READ ONCE. lib/sdk-http-client.js serializes an object with JSON.stringify, which runs a `toJSON` — own, inherited, on a component or on the list — and every getter, and it turns an address that is an
// object into text each time it needs the text, so what a limit inspected can read as another request when the transport reads it again. The limit therefore reads every POST it sees while an edit is open ONCE — the address
// as text, the body as the transport takes it: text as it is, bytes copied, anything else serialized as the transport would and read back as plain data — decides on that reading and sends THAT, in every branch: not only
// the action it cuts but the request it lets through (another app's, another address's, a batch's). A limit that let those go on as the object it had read would be undone by one that says another app's request, or an empty
// batch, the first time it is serialized and the whole request the second. Nothing in what is sent can answer differently again. A body that cannot be put in that form (a cycle, a BigInt, a serializer that throws) is refused;
// one that serializes to nothing sends nothing.
//
// A `$batch` cannot be limited part by part — its parts are text in a multipart envelope, or the entries of a JSON batch — so while an edit is open a POST to any other address whose body may carry the action is refused:
// the bundle does not send this action in one, and passing it on would send the SDK's whole derived list. `post` and `postRaw` are the same POST on the wire (the transport sends one and the other with the same bytes; the second
// only reads the answer as text), so ONE classifier reads the body of either, whichever way the batch is written: a multipart batch request line by line and a JSON batch entry by entry, each address read as an address is
// (percent-escapes decoded; one that cannot be read refuses the batch); a JSON batch, as text, bytes or an object, after its JSON is (`\u0041` is `A`); and the name is looked for in the rest of the text as it is and with its
// escapes decoded.
//
// THE SDK'S GUARDED PIN (bundles from model-apps 2.20.5 on). On an unpublished default-mode push that holds the app row's token, the bundle reads the app's current layer after the sitemap write, and when a component its
// derived list names is missing from it (every app whose maker took a form, view or chart out) it sends the AddAppComponents in ONE change set of its own instead of alone (`pinDefaultComponents`):
//   PATCH <api>/appmodules(<app>)                      If-Match: <held token>, body {}               the guard: the change set runs only on the version the push holds
//   POST  <api>/AddAppComponents                       { "AppId": "<app>", "Components": [ …the whole derived list… ] }
//   PATCH <api>/appmodules(<app>)?$select=appmoduleid  Prefer: return=representation, body {}       the echo: the app row's token after the change set, which the SDK keeps
// Its action carries the whole derived list, so it is not forwarded; and its parts are not cut either — the change set would then be a write this tool composed (two app-row writes no earlier release made), sent as the SDK's.
// For an app with an edit open, that change set (`guardedPinOf`: exactly those three parts, for that one app, and nothing else) is NOT sent, and the SDK is answered as the service answers a change set whose FIRST part
// was refused: the service rolls such a change set back whole, and the bundle then sends the plain action once (its documented fallback for a refused guard), which this limits as it limits every other — exactly what
// a page edit sent before 2.20.5. Nothing was sent, so the plain action is not the resend of a write whose outcome is unknown; the app's row is not written; and the SDK keeps the app token it held, as every bundle before
// did (a page edit reads the app again before each push, so it never depends on that token). Any other change set that names the action is refused, as above. Another app's guarded pin is not this edit's and goes on as it was read.
//
// The SDK reads the app's tables back after the post and reports a table its sitemap opens that is not a component (`APP_COMPONENTS_NOT_PERSISTED`) as a warning of the push — which is
// what a page edit of an app whose navigation opens a table the app does not hold still says: the edit does not add it.
// An SDK lent to a backend (`deps.sdk`) keeps the lender's transport, so a page edit through it is NOT limited. The bundle's request is pinned by genpage-app-edit-real-bundle.test.js:
// a re-vendor that changes its shape fails there, instead of letting a pin silently go missing.

// `isUtf8` is how a raw body of bytes is known to be text this can read (it needs no ICU, unlike a fatal TextDecoder); it is in Node 18.14 and later, and the plugin runs on 20 and 22.
const { isUtf8 } = require('node:buffer');

const guidKey = (id) => String(id || '').replace(/^\{|\}$/g, '').toLowerCase();

// The SDK posts to <instance>/api/data/v9.0/AddAppComponents — v9.0 is the API root its client uses — with no query string. The request, as it sends it:
//   { "AppId": "<guid>", "Components": [
//       { "@odata.id": "accounts(<table MetadataId>)" },                                                      a table, by reference
//       { "@odata.type": "Microsoft.Dynamics.CRM.systemform", "formid": "<guid>" },                           a form, or a dashboard
//       { "@odata.type": "Microsoft.Dynamics.CRM.savedquery", "savedqueryid": "<guid>" },                     a view
//       { "@odata.type": "Microsoft.Dynamics.CRM.savedqueryvisualization", "savedqueryvisualizationid": "<guid>" } ] }   a chart
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addappcomponents

// The action's address is told by its PATH. What follows the path — a query string, a fragment — is not part of it, so another request that merely mentions the name there is not the action:
//   https://contoso.crm.dynamics.com/api/data/v9.0/AddAppComponents          the SDK's address
//   https://contoso.crm.dynamics.com/api/data/v9.0/AddAppComponents?x=1      the same action, with a query string
//   https://contoso.crm.dynamics.com/api/data/v9.0/OtherAction?note=/AddAppComponents      not the action: its path is /api/data/v9.0/OtherAction
//   /AddAppComponents                                                         relative, as a client that adds the API root itself would send it
//   https://crm.contoso.com/org/api/data/v9.0/AddAppComponents               a deployment with a path before the API root
const ACTION_PATH = /^(?:.*\/api\/data\/v\d+(?:\.\d+)?)?\/AddAppComponents$/;
// The last segment of a path that is some other spelling of the action — `addappcomponents`, `%41ddAppComponents`, `Microsoft.Dynamics.CRM.AddAppComponents`, any of them with a trailing slash, written or escaped (`%2F`) — which
// the service may well accept as the action and this does not read. It is matched against the DECODED path (`kindOf`).
const ACTION_NAME = /(?:^|\.)addappcomponents$/i;

// The address of a request as text, READ ONCE: a text is itself, a URL its `href`, any other object what its `toString` says; an object with no text form (`Object.create(null)`, a `toString` that throws) has no address at all.
// What is decided on, and what is sent, is the text returned here — the transport asks an object that is an address for its text again each time it needs it, so one that says another address the second time would
// otherwise show the limit one request and the service another.
function addressOf(address) {
  try {
    return address instanceof URL ? address.href : String(address);
  } catch {
    return null;
  }
}

// The path of an address as text: relative addresses are read against a placeholder, and one that cannot be read is no path at all.
function pathOf(address) {
  try {
    return new URL(address, 'https://placeholder.invalid').pathname;
  } catch {
    return null;
  }
}

// 'action' (the address the SDK uses), 'lookalike' (the action in a spelling this does not read), 'unreadable' (an address, or a path, that cannot be read at all, so it cannot be told from the action's) or
// 'other' (not the action). `address` is the text `addressOf` made, or null.
function kindOf(address) {
  const path = address === null ? null : pathOf(address);
  if (path === null) return 'unreadable';
  if (ACTION_PATH.test(path)) return 'action';
  // The WHOLE path is percent-decoded first — every segment, so that an escaped separator is a separator — and only then are its trailing slashes dropped and its last segment compared with the action's name.
  // Dropping the slashes first read `AddAppComponents%2F` as the segment `AddAppComponents%2F`, which is not the name. An escaped unreserved character is the character itself
  // (https://www.rfc-editor.org/rfc/rfc3986#section-2.3: `%41` is `A`), and a server may read an escaped separator as one:
  //   /api/data/v9.0/AddAppComponents%2F                        is  /api/data/v9.0/AddAppComponents/
  //   /api/data/v9.0/Microsoft.Dynamics.CRM.%41ddAppComponents  is  /api/data/v9.0/Microsoft.Dynamics.CRM.AddAppComponents
  //   /api/data/v9.0%2FAddAppComponents                         is  /api/data/v9.0/AddAppComponents
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // `%ZZ`, a lone `%`, or escaped bytes that are not UTF-8 (`%C0%AF` is an overlong `/`): the path says something this cannot read, so it cannot be told from the action's. It is refused, not forwarded.
    return 'unreadable';
  }
  return ACTION_NAME.test(decoded.replace(/\/+$/, '').split('/').pop()) ? 'lookalike' : 'other';
}

// AddAppComponents answers 204 No Content; the SDK reads nothing but the status of the answer. A raw request (`postRaw`) is answered with the body as the text it arrived as, which for no content is ''.
const NO_CONTENT = (raw) => ({ status: 204, headers: {}, body: raw ? '' : undefined });

// The error of a request this will not send. It is the bundle's own class, loaded when the first one is made: the SDK's client passes an SdkError on as it is and re-wraps an error of any other class
// as a failure to reach the service (`Transport failure reaching …`), which this is not.
function refusal(why) {
  const { SdkError } = require('./maker-sdk.js');
  return new SdkError('APP_COMPONENTS_NOT_LIMITED', `the request to add components to the app was NOT sent: ${why}. A page edit adds only the views it pins, so a request this tool cannot limit is refused instead of being sent whole, and nothing was added to the app's components`);
}
const UNREADABLE_BODY = 'its body is not the { AppId, Components: [...] } object the SDK posts';

// A request line of a part of a multipart `$batch`, as the bundle writes one (renderChangeSet): the method, the address — absolute, or relative to the service root — and the HTTP version:
//   POST https://contoso.crm.dynamics.com/api/data/v9.0/AddAppComponents HTTP/1.1
// The parts are separated by CRLF; a bare LF is read too.
const REQUEST_LINE = /^[ \t]*[A-Za-z]+[ \t]+(\S+)[ \t]+HTTP\/\d(?:\.\d)?[ \t]*\r?$/gm;
const MENTIONS_ACTION = /addappcomponents/i;
// Decodes the runs of valid `%XX` escapes in a text and leaves everything else — a stray `%`, escapes that are not UTF-8 — as it is. A text is not an address: it is looked at for the name, and never refused for how it
// spells a `%`.
const decodeEscapes = (text) => text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
  try {
    return decodeURIComponent(run);
  } catch {
    return run;
  }
});

// A request body, READ ONCE as the transport takes it (lib/sdk-http-client.js `call` writes a text as it is and serializes everything else with JSON.stringify). This reading is what the limit decides on and what it sends, so
// nothing in it can answer differently when the transport reads it again. `kind` says what the body was and `send` is what goes on in its place:
//   none        `undefined` or `null`: no body                                  sent as it is
//   text        a string, which cannot change                                    sent as it is
//   bytes       a Buffer or a Uint8Array                                         sent as a COPY: one with no `toJSON` of its own (JSON.stringify would run it) that the caller cannot write to afterwards
//   data        anything else that serializes to text: `text` is what it serialized to and `data` what that reads back as — plain JSON data with no serializer or getter left to run. A plain object or list is sent as `data`,
//               which the transport serializes to that same text again (the text JSON.stringify made reads back and writes the same); anything else — a string, a number, `null` — is sent as the `text`, because the transport
//               writes a string as it is (`"abc"` would go as `abc`) and `null` as no body
//   nothing     a serializer that answers `undefined`: nothing is written, so nothing is sent
//   unreadable  a cycle, a BigInt, a serializer that throws, bytes that lie about their memory: it cannot be read, so it is refused where it matters
function readBody(body) {
  if (body === undefined || body === null) return { kind: 'none', send: body };
  if (typeof body === 'string') return { kind: 'text', text: body, send: body };
  try {
    if (body instanceof Uint8Array) {
      // A view of the caller's memory, then a copy of it: `Buffer.from(body)` would call a `valueOf` the caller put on the bytes.
      const bytes = Buffer.from(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
      return { kind: 'bytes', bytes, send: Buffer.isBuffer(body) ? bytes : new Uint8Array(bytes) };
    }
    const text = JSON.stringify(body);
    if (typeof text !== 'string') return { kind: 'nothing', send: undefined };
    const data = JSON.parse(text);
    return { kind: 'data', text, data, send: data !== null && typeof data === 'object' ? data : text };
  } catch {
    return { kind: 'unreadable' };
  }
}

// The address of every request a batch holds, in either of the forms a batch is written in:
//   multipart   a request line for each part, as the bundle writes one (renderChangeSet):        POST https://contoso.crm.dynamics.com/api/data/v9.0/uxagentprojects HTTP/1.1
//   JSON        the `url` of each entry of `requests`, an absolute path or one relative to the service root:   {"requests":[{"id":"1","method":"POST","url":"uxagentprojects","body":{…}}]}
//               https://docs.oasis-open.org/odata/odata-json-format/v4.01/odata-json-format-v4.01.html#_Toc19867124 (19.1 Batch Request)
// An entry that has no `url` (it is not an object, or its `url` is not text) names no address: the look for the name in the text (`batchProblem`) is all that reads it.
function batchAddresses(text, json) {
  const lines = [...text.matchAll(REQUEST_LINE)].map(([, address]) => address);
  const entries = json && Array.isArray(json.requests) ? json.requests.filter((entry) => entry && typeof entry.url === 'string').map((entry) => entry.url) : [];
  return [...lines, ...entries];
}

// Why a request to another address cannot be sent while an edit is open — its body is, or holds, a `$batch` that may carry the action — or null when nothing in it does. It is asked of a `post` and of a `postRaw` alike: the
// transport sends both as the same POST and only reads the answer differently. A part of a batch cannot be limited, so a batch that may carry the action is not sent, and a page's own writes, which never name it, are not
// affected. The body is read as `readBody` had it — the text it will be written as: a text as it is, bytes as the text they spell, an object as what it serialized to. What a batch can name, it can name in a spelling this reads:
//   multipart   every request line is an address, read as `kindOf` reads one — escapes decoded, a trailing separator and a namespace seen through — and a line that cannot be read refuses the batch
//   JSON        every entry of `requests` is an address, read the same way, whether the batch is text, bytes or an object — and read after its JSON is: `{"url":"\u0041ddAppComponents"}` names it
//   anywhere    in the text the name is looked for as it is written and with its escapes decoded
function batchProblem(read) {
  if (read.kind === 'unreadable') return 'its body cannot be read as the text it will be sent as, so it cannot be told from a $batch that names that action';
  // A body with nothing to write — none, or a serializer that answered nothing — holds no batch.
  const text = read.kind === 'text' || read.kind === 'data' ? read.text : read.kind === 'bytes' ? read.bytes.toString('latin1') : undefined;
  if (text === undefined) return null;
  const texts = [text];
  let json;
  try {
    json = JSON.parse(text);
    texts.push(JSON.stringify(json));
  } catch {
    // Not JSON text: a multipart envelope, say.
  }
  const names = 'it is part of a $batch that names that action, and a batch cannot be limited part by part';
  if (texts.some((one) => MENTIONS_ACTION.test(one) || MENTIONS_ACTION.test(decodeEscapes(one)))) return names;
  for (const address of batchAddresses(text, json)) {
    const kind = kindOf(address);
    if (kind === 'unreadable') return `it is part of a $batch with a request whose address (${address}) cannot be read, so it cannot be told from one that names that action, and a batch cannot be limited part by part`;
    if (kind !== 'other') return names;
  }
  return null;
}

// The plain JSON data the action's body reads as — what `decide` works on — or `undefined` when it cannot be read in the form the service takes, which the limit refuses as it refuses a `post` with no body. A `post` is given an
// object, which the plugin's transport serializes with JSON.stringify, and that is the `data` `readBody` made of it; a raw body is JSON text, or the UTF-8 bytes of it (JSON exchanged between systems is UTF-8 —
// https://www.rfc-editor.org/rfc/rfc8259#section-8.1), or an object. The SDK's request, as a raw body:
//   {"AppId":"<guid>","Components":[{"@odata.type":"Microsoft.Dynamics.CRM.savedquery","savedqueryid":"<guid>"}]}
// What is not such data is `undefined`: text that is not JSON, text or bytes with a byte order mark (`JSON.parse` does not read one), bytes that are not UTF-8 (they are not read leniently, with a replacement character in
// their place, because what is sent is what was read, re-encoded), no body, and a body `readBody` could not read — a cycle, a BigInt, a serializer that throws or answers nothing.
function canonicalOf(read, raw) {
  try {
    if (read.kind === 'data') return read.data;
    if (!raw) return undefined;
    if (read.kind === 'text') return JSON.parse(read.text);
    if (read.kind === 'bytes') return isUtf8(read.bytes) ? JSON.parse(read.bytes.toString('utf8')) : undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

// The options of a request whose body is `body` as the transport will write it: the text itself, or what it serializes an object to. The transport writes the headers it is given and does not count the body (a body
// written with `write` and `end` is sent chunked unless a Content-Length is declared), so a `Content-Length` the caller wrote for the WHOLE request is wrong for the cut one — the receiver would wait for bytes that never come,
// or read the rest as another request. Node's client keeps ONE header per name, whatever the case, and the later one wins, so a spelling that is left alone can restore the old length: every spelling that is declared
// becomes one header, with the exact length in bytes of what is written. When none is declared, or the one declared is already exact, the options are the caller's own. Everything else in them is the caller's as it was.
function optionsFor(body, options) {
  const headers = options && options.headers;
  if (!headers || typeof headers !== 'object') return options;
  const names = Object.keys(headers).filter((key) => key.toLowerCase() === 'content-length');
  if (!names.length) return options;
  const length = String(Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body)));
  if (names.length === 1 && String(headers[names[0]]) === length) return options;
  return { ...options, headers: { ...Object.fromEntries(Object.entries(headers).filter(([key]) => !names.includes(key))), [names[0]]: length } };
}

// The SDK's guarded pin (THE SDK'S GUARDED PIN, above), read from the text of a `$batch` exactly as the bundle renders one (renderChangeSet) — or null for anything else. Parts are separated by CRLF, the CRLF before a
// delimiter belongs to the delimiter, and each part is its MIME headers, a blank line, the embedded request line and headers, a blank line and the body:
//   --batch_<id>
//   Content-Type: multipart/mixed;boundary=changeset_<id>
//
//   --changeset_<id>
//   Content-Type: application/http
//   Content-Transfer-Encoding: binary
//   Content-ID: 1
//
//   PATCH https://contoso.crm.dynamics.com/api/data/v9.0/appmodules(<app>) HTTP/1.1
//   Content-Type: application/json;type=entry
//   MSCRM.SolutionUniqueName: contoso_solution                      (only when the SDK names a solution)
//   If-Match: W/"1234"
//
//   {}
//   --changeset_<id>
//   …Content-ID: 2…  POST …/AddAppComponents HTTP/1.1 … {"AppId":"<app>","Components":[…]}
//   --changeset_<id>
//   …Content-ID: 3…  PATCH …/appmodules(<app>)?$select=appmoduleid HTTP/1.1 … Prefer: return=representation … {}
//   --changeset_<id>--
//   --batch_<id>--
// Answers `{ appId, guardId }` (the app, lower case, and the Content-ID of the guard) only when the batch is exactly that: one change set of three parts in that order, every app id the same, the guard and the echo
// with empty bodies, the guard conditional, the echo asking for the row back, no header beyond the ones above, and the action's own body naming the same app with a list. A change set that differs in anything is not
// recognised, and is refused as any other batch that names the action is.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PART_HEADERS = new Set(['content-type', 'mscrm.solutionuniquename', 'if-match', 'prefer']);
function changeSetPartOf(segment) {
  // `\r\n<mime headers>\r\n\r\n<request line and headers>\r\n\r\n<body>\r\n`
  if (!segment.startsWith('\r\n') || !segment.endsWith('\r\n')) return null;
  const blocks = segment.slice(2, -2).split('\r\n\r\n');
  if (blocks.length !== 3 || /[\r\n]/.test(blocks[2])) return null;
  const mime = blocks[0].split('\r\n');
  const id = /^Content-ID: (\d+)$/.exec(mime[2] || '');
  if (mime.length !== 3 || mime[0] !== 'Content-Type: application/http' || mime[1] !== 'Content-Transfer-Encoding: binary' || !id) return null;
  const [line, ...headerLines] = blocks[1].split('\r\n');
  const request = /^(PATCH|POST) (\S+) HTTP\/1\.1$/.exec(line);
  if (!request) return null;
  const headers = {};
  for (const header of headerLines) {
    const named = /^([A-Za-z0-9.-]+): (.*)$/.exec(header);
    const name = named && named[1].toLowerCase();
    if (!named || !PART_HEADERS.has(name) || name in headers) return null;
    headers[name] = named[2];
  }
  return { contentId: id[1], method: request[1], address: request[2], headers, body: blocks[2] };
}
function guardedPinOf(read) {
  const text = read.kind === 'text' ? read.text : read.kind === 'bytes' && isUtf8(read.bytes) ? read.bytes.toString('utf8') : null;
  if (text === null) return null;
  const head = /^--(batch_[A-Za-z0-9-]+)\r\nContent-Type: multipart\/mixed;boundary=(changeset_[A-Za-z0-9-]+)\r\n\r\n/.exec(text);
  if (!head) return null;
  const segments = text.slice(head[0].length).split(`--${head[2]}`);
  if (segments.length !== 5 || segments[0] !== '' || segments[4] !== `--\r\n--${head[1]}--\r\n`) return null;
  const parts = segments.slice(1, 4).map(changeSetPartOf);
  if (parts.some((part) => part === null)) return null;
  const [guard, action, echo] = parts;
  // `<api>/appmodules(<guid>)`, with no query (the guard) or with exactly `?$select=appmoduleid` (the echo).
  const appOf = (part, query) => {
    const at = /^(.*\/api\/data\/v\d+(?:\.\d+)?)\/appmodules\(([^)]+)\)(\?.*)?$/.exec(part.address);
    return at && GUID.test(at[2]) && (at[3] || '') === query ? at[2].toLowerCase() : null;
  };
  const appId = appOf(guard, '');
  if (!appId || guard.method !== 'PATCH' || guard.body !== '{}' || !guard.headers['if-match'] || 'prefer' in guard.headers) return null;
  if (appOf(echo, '?$select=appmoduleid') !== appId || echo.method !== 'PATCH' || echo.body !== '{}' || echo.headers.prefer !== 'return=representation' || 'if-match' in echo.headers) return null;
  if (action.method !== 'POST' || kindOf(action.address) !== 'action' || 'if-match' in action.headers || 'prefer' in action.headers) return null;
  let body;
  try {
    body = JSON.parse(action.body);
  } catch {
    return null;
  }
  if (!body || typeof body.AppId !== 'string' || guidKey(body.AppId) !== appId || !Array.isArray(body.Components)) return null;
  return { appId, guardId: guard.contentId };
}

// The answer to a guarded pin that was NOT sent: a change-set answer, in the form the service gives one (its own boundaries, and the Content-ID it answers), whose one part refuses the guard. The bundle reads a refused
// first part as a change set the service rolled back whole, and sends the plain action once (`pinDefaultComponents`); the status and the error say what happened, though the bundle reports neither. A raw request is
// answered with its body as text.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#change-sets
function guardNotSent(guardId) {
  const { randomUUID } = require('node:crypto');
  const batch = `batchresponse_${randomUUID()}`;
  const changeSet = `changesetresponse_${randomUUID()}`;
  const error = JSON.stringify({ error: { code: 'APP_COMPONENTS_GUARD_NOT_SENT', message: 'this change set was not sent: a page edit adds only the views it pins, so the plain AddAppComponents is limited and sent instead' } });
  const body = [
    `--${batch}`,
    `Content-Type: multipart/mixed; boundary=${changeSet}`,
    '',
    `--${changeSet}`,
    'Content-Type: application/http',
    'Content-Transfer-Encoding: binary',
    `Content-ID: ${guardId}`,
    '',
    'HTTP/1.1 400 Bad Request',
    'Content-Type: application/json; odata.metadata=minimal',
    '',
    error,
    `--${changeSet}--`,
    `--${batch}--`,
    '',
  ].join('\r\n');
  return { status: 200, headers: { 'content-type': `multipart/mixed; boundary=${batch}` }, body };
}

function makeAppComponentScope() {
  // app id (lower case) -> the ids of the views the edit under way owns
  const open = new Map();
  // app id -> the end of the last edit queued for it; edits of one app run one after the other, so an edit never reads another's list
  const queue = new Map();

  // What to do with the action's request while some edit is open, given its body in canonical form (`canonicalOf`, which is `undefined` for one that cannot be put in it): `{ elsewhere: true }` for another app's request,
  // `{ send: null }` when nothing is left to send, `{ send }` — the body to send — or a throw, for a request that is the action and that this cannot limit. Only an entry that names a `savedqueryid` the edit pins stays:
  // a table, a form, a dashboard, a chart or any other view does not.
  function decide(read) {
    // Whose it is comes first: another app's request is not this edit's to limit, in any shape. A body this cannot even attribute to an app (JSON text through a `post`, no `AppId`) could be anyone's, so it is refused.
    if (!read || typeof read !== 'object' || Array.isArray(read) || typeof read.AppId !== 'string') throw refusal(UNREADABLE_BODY);
    const owned = open.get(guidKey(read.AppId));
    if (!owned) return { elsewhere: true };
    if (!Array.isArray(read.Components)) throw refusal(UNREADABLE_BODY);
    const kept = read.Components.filter((component) => component && typeof component.savedqueryid === 'string' && owned.has(guidKey(component.savedqueryid)));
    // Every pin the edit owns must be in what is sent. A view the request names another way (`{ "@odata.id": "savedqueries(<guid>)" }`), or leaves out, would otherwise be dropped with the rest and the SDK
    // told it was done: the no-op answer below is true only for an edit that owns nothing.
    const carried = new Set(kept.map((component) => guidKey(component.savedqueryid)));
    const missing = [...owned].filter((id) => !carried.has(id));
    if (missing.length) {
      const many = missing.length > 1;
      throw refusal(`its list does not carry the view${many ? 's' : ''} ${missing.join(', ')} the edit pins, as ${many ? 'entries' : 'an entry'} with a savedqueryid`);
    }
    if (!kept.length) return { send: null };
    return { send: kept.length === read.Components.length ? read : { ...read, Components: kept } };
  }

  return {
    // `client` as the SDK is given it: its own requests all go through, and its AddAppComponents for an app with an edit open is limited to what the edit owns. It is made by delegation — every
    // property is read from the client itself, and a method runs on it, so a client whose methods live on a prototype and keep state in `this` is wrapped as well as a plain object of closures
    // (which is what lib/sdk-http-client.js makes), and a frozen one: the proxy's own target is empty, so no property of the client constrains it.
    wrap(client) {
      if (!client || typeof client.post !== 'function') return client;
      // A POST — `post` with the object the SDK gives it, or `postRaw` with a body the transport does not touch — while some edit is open (`raw` says which). With no edit open nothing is read, below: the build owns
      // the whole app and sends what the SDK derives, in whatever shape the bundle gives it. With one open the request is read ONCE (WHY A REQUEST IS READ ONCE, above) — its address as text, its body as `readBody` has it — and
      // every branch decides on that reading and sends that: the address text and `read.send`, never the url or the body the caller handed over, which the transport would read again.
      const forward = async (method, raw, url, body, options) => {
        const address = addressOf(url);
        const kind = kindOf(address);
        if (kind === 'unreadable') throw refusal(`its address${address === null ? '' : ` (${address})`} cannot be read — a malformed percent-escape, or no URL at all — so it cannot be told from the AddAppComponents action`);
        if (kind === 'lookalike') throw refusal(`its address (${pathOf(address)}) is not the SDK's /api/data/v<version>/AddAppComponents, though it names that action`);
        const read = readBody(body);
        if (kind === 'other') {
          // The SDK's guarded pin, to the `$batch` address (THE SDK'S GUARDED PIN, above): not sent for an app with an edit open — the bundle then sends the plain action, limited below — and sent as it was read for another app.
          const pin = raw && /\/\$batch$/.test(pathOf(address) || '') ? guardedPinOf(read) : null;
          if (pin) return open.has(pin.appId) ? guardNotSent(pin.guardId) : client[method](address, read.send, options);
          // Not the action's address, so not the action's — but the body may be a `$batch` that NAMES the action, which cannot be limited, whichever method carries it. Anything else goes on as it was read.
          const problem = batchProblem(read);
          if (problem) throw refusal(problem);
          return client[method](address, read.send, options);
        }
        const { send, elsewhere } = decide(canonicalOf(read, raw));
        // Another app's request is not this edit's, so it goes on as it was read.
        if (elsewhere) return client[method](address, read.send, options);
        if (send === null) return NO_CONTENT(raw);
        // What goes on is the canonical form the decision was made on, in a representation the transport sends as it is: the JSON text for text and for bytes — it would send a Buffer as `{"type":"Buffer",…}` —
        // and the plain object for an object. Never the object, text or bytes that were handed over: another reading of them could be another request, and a Content-Length is the length of what is written.
        const onward = raw && (read.kind === 'text' || read.kind === 'bytes') ? JSON.stringify(send) : send;
        return client[method](address, onward, optionsFor(onward, options));
      };
      const post = async (url, body, options) => (open.size === 0 ? client.post(url, body, options) : forward('post', false, url, body, options));
      // A raw POST is told by its address as a `post` is (WHAT IS RAW, above).
      const postRaw = typeof client.postRaw === 'function' ? async (url, body, options) => (open.size === 0 ? client.postRaw(url, body, options) : forward('postRaw', true, url, body, options)) : undefined;
      return new Proxy({}, {
        get: (_, key) => {
          if (key === 'post') return post;
          if (key === 'postRaw' && postRaw) return postRaw;
          const value = client[key];
          return typeof value === 'function' ? value.bind(client) : value;
        },
        has: (_, key) => key in client,
      });
    },

    // Runs `work` — a push of the app — with the post limited to `owned.views`, the ids of the views the edit pins. It answers what `work` answers, and the limit is lifted when
    // `work` ends, by an answer or a failure.
    limit(appId, owned, work) {
      const key = guidKey(appId);
      const turn = (queue.get(key) || Promise.resolve()).then(async () => {
        open.set(key, new Set(((owned && owned.views) || []).map(guidKey)));
        try {
          return await work();
        } finally {
          open.delete(key);
        }
      });
      const end = turn.then(() => undefined, () => undefined);
      queue.set(key, end);
      end.then(() => { if (queue.get(key) === end) queue.delete(key); });
      return turn;
    },
  };
}

module.exports = { makeAppComponentScope };
