'use strict';
// The one `$batch` a protected create set may send: a Custom API change set of an API the set already binds.
//
// The managed create gate (lib/managed-create-transport.js) refuses every `$batch` unsent unless the set opts in with
// `batch: { apiBase, solution }` (runWithManagedCreateSet). With it, the gate asks this module to read the request, and
// admits it only when it is EXACTLY the change set the SDK writes for a Custom API push that edits the bound API and adds
// new children (cds-maker-sdk `renderChangeSet` over the Custom API operations, root PATCH -> new request parameters ->
// new response properties). Anything else — another table, a GET or DELETE, a child PATCH, a create of a root, another
// framing, a header or field the SDK does not write — is refused unsent. This module only parses and judges; the gate
// classifies every constituent through the driver, seals them in ONE store write and reads the answer per constituent.
//
// The request, as the SDK writes it (CRLF; LF is read the same way when it is used throughout):
//   --batch_<uuid>
//   Content-Type: multipart/mixed;boundary=changeset_<uuid>
//   <blank>
//   --changeset_<uuid>
//   Content-Type: application/http
//   Content-Transfer-Encoding: binary
//   Content-ID: 1
//   <blank>
//   PATCH https://contoso.crm.dynamics.com/api/data/v9.0/customapis(<bound id>)?$select=customapiid HTTP/1.1
//   Content-Type: application/json;type=entry
//   MSCRM.SolutionUniqueName: <solution>          only when the SDK context has a solution
//   If-Match: W/"14860046"                        the held version token; the root PATCH only
//   Prefer: return=representation
//   <blank>
//   {"isprivate":true}
//   --changeset_<uuid>
//   ... Content-ID: 2 ...
//   POST https://contoso.crm.dynamics.com/api/data/v9.0/customapirequestparameters?$select=customapirequestparameterid HTTP/1.1
//   ... (the same headers, no If-Match) ...
//   {"customapirequestparameterid":"<new id>","uniquename":"Extra",...,"CustomAPIId@odata.bind":"/customapis(<bound id>)"}
//   --changeset_<uuid>--
//   --batch_<uuid>--
//   <the one final line ending>
// The answer, as the service sends it (note the space after ';' in the nested Content-Type):
//   --batchresponse_<uuid>
//   Content-Type: multipart/mixed; boundary=changesetresponse_<uuid>
//   <blank>
//   --changesetresponse_<uuid>
//   Content-Type: application/http
//   Content-Transfer-Encoding: binary
//   Content-ID: 1
//   <blank>
//   HTTP/1.1 200 OK
//   ETag: W/"14863812"
//   ... (other headers, which grant nothing) ...
//   <blank>
//   {"@odata.context":"<api base>/$metadata#customapis(customapiid)/$entity","@odata.etag":"W/\"14863812\"","customapiid":"<bound id>"}
//   --changesetresponse_<uuid>
//   ... Content-ID: 2 ... HTTP/1.1 201 Created ...
//   {"@odata.context":"<api base>/$metadata#customapirequestparameters(customapirequestparameterid)/$entity","@odata.etag":"W/\"…\"",
//    "customapirequestparameterid":"<new id>","_customapiid_value":"<bound id>"}
//   --changesetresponse_<uuid>--
//   --batchresponse_<uuid>--
// A change set is atomic: when one operation fails, the service rolls every one back and answers the outer request with
// that operation's status and a change set holding only the failed part (observed: outer 412, one part, Content-ID 2,
// `HTTP/1.1 412 Precondition Failed`, an OData error envelope). Such an answer, like every answer that is not a complete
// success, acknowledges nothing; nothing is ever re-sent from here.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api
//
// Neither the request nor the answer text is kept, logged or put in an error message: the errors name only part numbers
// and fixed table names, and an answer is reduced to outcomes, statuses and a safe error code.

const { canonicalJson, normalizeGuid } = require('./reconcile-common.js');

// The gate's refusal code (managed-create-transport.js MISMATCH). It is spelled here, not imported, because the gate
// loads this module.
const MISMATCH = 'managed-create-request-mismatch';
// The SDK's own bound on one change set (cds-maker-sdk MAX_BATCH_PARTS) — and the gate passes a smaller one, the rows the
// set prepared, so no answer or request is read past what could belong to the set.
const MAX_BATCH_PARTS = 1000;
const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
const GUID = new RegExp(`^${UUID}$`);
// A held version token as the service issues it (`W/"<row version>"`); `*` or any other form is never a held token.
const HELD_ETAG = /^W\/"\d+"$/;
// One header line: an RFC 9110 token name, a colon, optional spaces and a value that neither starts nor ends with a
// space. A folded continuation line starts with a space and does not match; tabs and other controls are refused for the
// whole text before any line is read.
const HEADER_LINE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+):[ ]*([^ ](?:.*[^ ])?)$/;
const CONTROLS = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_HEADERS = 64;

const BIND = 'CustomAPIId@odata.bind';
/** The three constituents a Custom API change set may carry: the bound root's PATCH and the two kinds of new child. */
const ROLES = Object.freeze({
  root: Object.freeze({ kind: 'customApi', table: 'customapis', key: 'customapiid', method: 'PATCH', status: 200, rank: 0 }),
  requestParameter: Object.freeze({ kind: 'customApiRequestParameter', table: 'customapirequestparameters', key: 'customapirequestparameterid', method: 'POST', status: 201, rank: 1 }),
  responseProperty: Object.freeze({ kind: 'customApiResponseProperty', table: 'customapiresponseproperties', key: 'customapiresponsepropertyid', method: 'POST', status: 201, rank: 2 }),
});
// The root fields the SDK may PATCH (cds-maker-sdk's Custom API diff: everything else of a root is immutable or a label
// the SDK refuses to write).
const ROOT_FIELDS = new Set(['name', 'displayname', 'description', 'isprivate', 'executeprivilegename']);
// A new child's body, field for field as the SDK builds it: its caller-chosen primary key, the normalized declaration
// and the bind to its API.
const childFields = (role) => [ROLES[role].key, 'uniquename', 'name', 'displayname', 'description', 'type', 'logicalentityname', ...(role === 'requestParameter' ? ['isoptional'] : []), BIND];

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function mismatch(message) {
  return Object.assign(new Error(message), { code: MISMATCH });
}

// A framing fault while reading; the request side turns it into a refusal, the answer side into `unknown`.
class Malformed extends Error {}
const malformed = (why) => new Malformed(why);

/**
 * The batch option of a create set: { apiBase, solution }. `apiBase` is the SDK's configured API root — the origin and
 * `/api/data/v<major>.<minor>` exactly as the SDK prefixes every URL (the bundle uses v9.0) — and `solution` the unique
 * name the SDK context sends as MSCRM.SolutionUniqueName, or null when it sends none. Both are required: a constituent
 * must carry exactly the solution header the prepared SDK context emits, never one added or stripped.
 */
function batchConfig(cfg) {
  if (!isPlain(cfg)) throw new TypeError('the batch option of a create set is { apiBase, solution }');
  let u;
  try {
    u = new URL(String(cfg.apiBase));
  } catch {
    throw new TypeError('the batch option names no API base URL');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !/^\/api\/data\/v\d+\.\d+$/.test(u.pathname) || cfg.apiBase !== `${u.origin}${u.pathname}`) {
    throw new TypeError('the batch option\'s API base is https://<host>/api/data/v<major>.<minor>, with nothing else');
  }
  if (!own(cfg, 'solution') || !(cfg.solution === null || (typeof cfg.solution === 'string' && /^[A-Za-z0-9_]{1,128}$/.test(cfg.solution)))) {
    throw new TypeError('the batch option names the solution its SDK context sends (a unique name), or null for none');
  }
  return Object.freeze({ apiBase: cfg.apiBase, solution: cfg.solution });
}

// The lines of a multipart text, with one line ending used throughout: CRLF, or LF when no CR appears at all. A bare CR,
// a mix of the two or any other control character refuses the whole text. The one final line ending is dropped; any
// more is an epilogue the walk below refuses.
function linesOf(text) {
  if (typeof text !== 'string' || CONTROLS.test(text)) return null;
  const crlf = text.includes('\r');
  if (crlf && /\r(?!\n)|(?<!\r)\n/.test(text)) return null;
  const lines = text.split(crlf ? '\r\n' : '\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// `multipart/mixed;boundary=X`, with ordinary spaces around ';' and X quoted or not; any other type, a second parameter,
// an escape or an empty boundary answers null.
function multipartBoundary(value) {
  const m = /^multipart\/mixed[ ]*;[ ]*boundary=("?)([A-Za-z0-9_-]+)\1[ ]*$/i.exec(String(value));
  return m ? m[2] : null;
}

// One header block, up to and including its blank line: names are compared case-insensitively and may appear once.
function headerBlock(lines, i, collides) {
  const list = [];
  const map = new Map();
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') return { list, map, next: i + 1 };
    const m = HEADER_LINE.exec(line);
    if (!m || collides(line)) throw malformed('a header line is not one well-formed header');
    const lower = m[1].toLowerCase();
    if (map.has(lower)) throw malformed('a header appears twice');
    if (list.length >= MAX_HEADERS) throw malformed('too many headers');
    map.set(lower, m[2]);
    list.push({ name: m[1], value: m[2] });
  }
  throw malformed('a header block has no end');
}

/**
 * Walk one batch holding exactly one change set: `--<outer>_<uuid>`, its one Content-Type header naming the
 * `<inner>_<uuid>` boundary, the change set's parts, `--<inner>_<uuid>--`, `--<outer>_<uuid>--` and nothing after it.
 * Each part is its three MIME headers, one start line, an HTTP header block and the body lines up to the next delimiter
 * line. A delimiter is matched only as a whole line; a boundary anywhere else in the text is a collision and refuses it.
 * Answers { boundary, parts: [{ contentId, start, headers, bodyLines }] } or throws Malformed.
 */
function walk(text, { outer, inner, limit, ordered }) {
  const lines = linesOf(text);
  if (!lines) throw malformed('its line endings are not one kind throughout, or it holds a control character');
  const open = new RegExp(`^--(${outer}_${UUID})$`).exec(lines[0] || '');
  if (!open) throw malformed('it does not open with its batch boundary');
  const B = open[1];
  const top = headerBlock(lines, 1, (line) => line.includes(`--${B}`));
  const C = top.list.length === 1 && top.map.has('content-type') ? multipartBoundary(top.map.get('content-type')) : null;
  if (!C || !new RegExp(`^${inner}_${UUID}$`).test(C)) throw malformed('its one part is not exactly one change set');
  const delim = `--${C}`;
  const close = `--${C}--`;
  const collides = (line) => line.includes(delim) || line.includes(`--${B}`);
  let i = top.next;
  if (lines[i] !== delim) throw malformed('the change set does not open with its boundary');
  i += 1;
  const parts = [];
  for (;;) {
    if (parts.length >= limit) throw malformed('it holds more parts than the set prepared');
    const mime = headerBlock(lines, i, collides);
    const id = mime.map.get('content-id');
    if (mime.list.length !== 3 || String(mime.map.get('content-type')).toLowerCase() !== 'application/http'
      || String(mime.map.get('content-transfer-encoding')).toLowerCase() !== 'binary' || !/^[1-9][0-9]{0,3}$/.test(String(id))) {
      throw malformed('a part does not have exactly the MIME headers of one HTTP operation');
    }
    const contentId = Number(id);
    if (ordered && contentId !== parts.length + 1) throw malformed('its Content-IDs are not 1..N in order');
    i = mime.next;
    const start = lines[i];
    if (start === undefined || start === '' || collides(start)) throw malformed('a part has no start line');
    const http = headerBlock(lines, i + 1, collides);
    i = http.next;
    const bodyLines = [];
    while (i < lines.length && lines[i] !== delim && lines[i] !== close) {
      if (collides(lines[i])) throw malformed('a body holds a boundary');
      bodyLines.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) throw malformed('the change set has no end');
    parts.push({ contentId, start, headers: http, bodyLines });
    i += 1;
    if (lines[i - 1] === close) break;
  }
  if (lines[i] !== `--${B}--` || i + 1 !== lines.length) throw malformed('the batch does not end right after its one change set');
  return { boundary: B, parts };
}

// A JSON scanner for one flat object: `{ "key": scalar, ... }` with unique keys and string, number, boolean or null
// values. JSON.parse alone keeps the last of two equal keys, which would let a request or an answer say two things at
// once, and would accept nested values the shapes below never carry. Answers the object (own properties only, a key
// such as "__proto__" included as data) or null.
const JSON_WS = /[ \t\n\r]*/y;
const JSON_STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"/y;
const JSON_SCALAR = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;
function flatJson(text) {
  if (typeof text !== 'string') return null;
  let at = 0;
  const take = (re) => {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) return null;
    at = re.lastIndex;
    return m[0];
  };
  const ch = (c) => {
    take(JSON_WS);
    if (text[at] !== c) return false;
    at += 1;
    return true;
  };
  const out = {};
  if (!ch('{')) return null;
  take(JSON_WS);
  if (!ch('}')) {
    for (;;) {
      take(JSON_WS);
      const k = take(JSON_STRING);
      if (k === null || !ch(':')) return null;
      take(JSON_WS);
      const v = take(JSON_SCALAR);
      if (v === null) return null;
      const key = JSON.parse(k);
      if (own(out, key)) return null;
      Object.defineProperty(out, key, { value: JSON.parse(v), enumerable: true, writable: true, configurable: true });
      if (ch(',')) continue;
      if (ch('}')) break;
      return null;
    }
  }
  take(JSON_WS);
  return at === text.length ? out : null;
}

const stringOrNull = (v) => v === null || typeof v === 'string';

// The body of one constituent, judged against the fields the SDK writes for its role. Answers a reason, or null.
function bodyFault(role, json, boundId) {
  if (role === 'root') {
    const keys = Object.keys(json);
    if (keys.length === 0 || !keys.every((k) => ROOT_FIELDS.has(k))) return 'patches nothing, or a field of the API the SDK never edits';
    for (const k of keys) if (k === 'isprivate' ? typeof json[k] !== 'boolean' : !stringOrNull(json[k])) return `carries a ${k} that is not of its type`;
    return null;
  }
  const want = childFields(role);
  const keys = Object.keys(json);
  if (keys.length !== want.length || !want.every((k) => own(json, k))) return 'does not carry exactly the fields of a new child';
  const pk = ROLES[role].key;
  if (typeof json[pk] !== 'string' || !GUID.test(json[pk])) return 'names no caller id for the new child';
  if (typeof json.uniquename !== 'string' || json.uniquename === '') return 'names no unique name';
  for (const k of ['name', 'displayname', 'description', 'logicalentityname']) if (!stringOrNull(json[k])) return `carries a ${k} that is not of its type`;
  if (!Number.isSafeInteger(json.type) || json.type < 0) return 'carries a type that is not a type code';
  if (role === 'requestParameter' && typeof json.isoptional !== 'boolean') return 'carries an isoptional that is not a boolean';
  const bind = /^\/customapis\(([^()]*)\)$/.exec(typeof json[BIND] === 'string' ? json[BIND] : '');
  if (!bind || !GUID.test(bind[1]) || normalizeGuid(bind[1]) !== boundId) return 'is not bound to the API the change set edits';
  return null;
}

/**
 * Read one `$batch` request { url, body, headers } (what the gate is asked with) as the Custom API change set the SDK
 * writes, against `config` (batchConfig) and `limit` (the most parts the set can account for). Throws
 * managed-create-request-mismatch for anything else. Answers {
 *   boundId,                    the one API every constituent targets (the root PATCH's id, every child's bind);
 *   constituents: [{ contentId, role: 'root' | 'requestParameter' | 'responseProperty', method, url, headers, body,
 *                    json, id, ifMatch? }]
 * } in request order: `headers` the constituent's HTTP headers as written, `body` its JSON text, `json` that object,
 * `id` the row it writes (the root's URL id, a child's caller id) and `ifMatch` the root PATCH's version token.
 */
function parseCustomApiChangeset({ url, body, headers } = {}, config, { limit = MAX_BATCH_PARTS } = {}) {
  const fail = (why) => { throw mismatch(`a $batch was not sent: ${why}`); };
  if (url !== `${config.apiBase}/$batch`) fail('it is not posted to the configured API $batch endpoint');
  // The SDK sends one request header of its own on a batch, the multipart Content-Type; it must name the body's boundary.
  const outer = Object.entries(isPlain(headers) ? headers : {});
  if (outer.length !== 1 || outer[0][0].toLowerCase() !== 'content-type') fail('its request headers are not exactly its multipart Content-Type');
  const outerBoundary = multipartBoundary(outer[0][1]);
  let framed;
  try {
    framed = walk(body, { outer: 'batch', inner: 'changeset', limit: Math.min(limit, MAX_BATCH_PARTS), ordered: true });
  } catch (e) {
    if (e instanceof Malformed) fail(`its framing is not one change set as the SDK writes it (${e.message})`);
    throw e;
  }
  if (outerBoundary !== framed.boundary) fail('its Content-Type names another boundary than its body');
  let boundId = null;
  let rank = -1;
  const constituents = framed.parts.map((p) => {
    const what = `its part ${p.contentId}`;
    const line = /^([A-Z]+) (\S+) HTTP\/1\.1$/.exec(p.start);
    if (!line) fail(`${what} is not one HTTP/1.1 request`);
    const [, method, partUrl] = line;
    const prefix = `${config.apiBase}/`;
    const rest = partUrl.startsWith(prefix) ? partUrl.slice(prefix.length) : null;
    let role = null;
    let id = null;
    const root = rest === null ? null : /^customapis\(([^()]*)\)\?\$select=customapiid$/.exec(rest);
    if (method === 'PATCH' && root && GUID.test(root[1])) {
      role = 'root';
      id = normalizeGuid(root[1]);
    } else if (method === 'POST' && rest === 'customapirequestparameters?$select=customapirequestparameterid') {
      role = 'requestParameter';
    } else if (method === 'POST' && rest === 'customapiresponseproperties?$select=customapiresponsepropertyid') {
      role = 'responseProperty';
    }
    if (!role) fail(`${what} is not the bound API's PATCH or a new request parameter or response property under the configured API base`);
    if (ROLES[role].rank < rank || (role === 'root' && p.contentId !== 1)) fail(`${what} is out of the SDK's order (the API, then request parameters, then response properties)`);
    rank = ROLES[role].rank;
    const h = p.headers.map;
    const allowed = ['content-type', 'prefer', ...(config.solution !== null ? ['mscrm.solutionuniquename'] : []), ...(role === 'root' ? ['if-match'] : [])];
    if (h.size !== allowed.length || !allowed.every((k) => h.has(k))) fail(`${what} does not carry exactly the headers the SDK writes for it`);
    if (h.get('content-type') !== 'application/json;type=entry' || h.get('prefer') !== 'return=representation') fail(`${what} does not ask for a JSON entry and its representation`);
    if (config.solution !== null && h.get('mscrm.solutionuniquename') !== config.solution) fail(`${what} names another solution than the set's`);
    const ifMatch = role === 'root' ? h.get('if-match') : undefined;
    if (role === 'root' && !HELD_ETAG.test(ifMatch)) fail(`${what} is not conditional on a held version of the API`);
    const json = p.bodyLines.length === 1 ? flatJson(p.bodyLines[0]) : null;
    if (!json) fail(`${what} is not one flat JSON object with unique keys`);
    if (role !== 'root') id = normalizeGuid(json[ROLES[role].key]);
    const target = role === 'root' ? id : (/^\/customapis\(([^()]*)\)$/.exec(typeof json[BIND] === 'string' ? json[BIND] : '') || [])[1];
    if (boundId === null && target && GUID.test(target)) boundId = normalizeGuid(target);
    const fault = bodyFault(role, json, boundId);
    if (fault) fail(`${what} ${fault}`);
    return {
      contentId: p.contentId, role, method, url: partUrl, headers: Object.fromEntries(p.headers.list.map((x) => [x.name, x.value])),
      body: p.bodyLines[0], json, id, ...(role === 'root' ? { ifMatch } : {}),
    };
  });
  const children = constituents.filter((k) => k.role !== 'root').length;
  if (children === 0 || (children === constituents.length && children < 2)) {
    fail('it is not an edit of the API with new children, nor two or more new children (one change goes on its own)');
  }
  return { boundId, constituents };
}

/**
 * Why a driver's descriptor of one constituent does not describe it (null when it does). A constituent's descriptor
 * is the gate's `rows` descriptor for exactly one row of the constituent's own table, plus what this boundary checks
 * the constituent against: { type: 'rows', token, expectTable, expectKey, rows: [{ kind, key, id, parentId, sentFields,
 * sentSha256 }], prepared, ifMatch? } — `prepared` the exact JSON object the driver prepared for it (compared with what
 * the request carries, key for key and value for value), and `ifMatch` the version token the driver holds for the bound
 * API (the root PATCH only).
 */
function constituentFault(c, k, boundId) {
  const role = ROLES[k.role];
  if (!isPlain(c) || c.type !== 'rows') return 'is not a change the set prepared';
  if (!Array.isArray(c.rows) || c.rows.length !== 1 || c.expectId !== undefined || c.expectTable !== role.table || c.expectKey !== role.key) {
    return `is not described as one row of ${role.table}`;
  }
  const r = c.rows[0];
  if (!isPlain(r) || r.kind !== role.kind || r.answer !== undefined || normalizeGuid(r.id) !== k.id) return 'is described as another row than the one it writes';
  const parent = r.parentId === null || r.parentId === undefined ? null : normalizeGuid(r.parentId);
  if (parent !== (k.role === 'root' ? null : boundId)) return 'is described under another parent than the API it is bound to';
  if (!isPlain(c.prepared) || canonicalJson(c.prepared) !== canonicalJson(k.json)) return 'does not carry exactly the change prepared for it';
  if (k.role === 'root' ? !(typeof c.ifMatch === 'string' && HELD_ETAG.test(c.ifMatch) && c.ifMatch === k.ifMatch) : c.ifMatch !== undefined) {
    return 'is not conditional on the version the set holds';
  }
  if (!Array.isArray(r.sentFields) || !r.sentFields.every((f) => typeof f === 'string' && own(k.json, f))) return 'seals a field it does not carry';
  return null;
}

const statusOf = (res) => (res && Number.isInteger(res.statusCode) ? res.statusCode : res && Number.isInteger(res.status) ? res.status : null);

// One header of an answer, read under any spelling of its name: undefined when absent, null when given more than once.
function oneHeader(headers, name) {
  const values = [];
  for (const [k, v] of Object.entries(isPlain(headers) ? headers : {})) {
    if (k.toLowerCase() !== name || v === null || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) values.push(String(one));
  }
  return values.length === 0 ? undefined : values.length === 1 ? values[0] : null;
}

// `<api base>/$metadata#<entity set>(<selected columns>)/$entity` -> { table, select } or null. The base is the
// service's own spelling of the configured API base, compared case-insensitively.
function contextOf(value, apiBase) {
  if (typeof value !== 'string') return null;
  const m = /^(.*)\/\$metadata#([A-Za-z_][A-Za-z0-9_]*)(?:\(([^()]*)\))?\/\$entity$/.exec(value);
  if (!m || m[1].toLowerCase() !== apiBase.toLowerCase()) return null;
  return { table: m[2].toLowerCase(), select: m[3] === undefined ? null : m[3] };
}

/**
 * What one answered part says about its constituent, by the gate's identity rules applied to the part as an answer of
 * its own (answerOf: every identity header and the body's primary key must name the constituent's row) and by what the
 * captured success carries: the role's status (the API's PATCH 200, a new child 201), a well-formed `@odata.etag`, an
 * `@odata.context` naming the constituent's own table, the root's ETag header (when present) equal to its body token,
 * and each child's `_customapiid_value` naming the bound API. Anything naming another row, table or API is a conflict;
 * anything missing, malformed or unexpected is unknown.
 */
function judgePart(part, k, admitted, answerOf) {
  const role = ROLES[k.role];
  const headers = Object.fromEntries(part.headers.list.map((x) => [x.name, x.value]));
  const body = part.bodyLines.join('\n');
  const ident = answerOf({ statusCode: part.status, headers, body }, { id: k.id, table: role.table, key: role.key });
  let conflict = ident.outcome === 'conflict';
  let unknown = ident.outcome === 'unknown' || part.status !== role.status || part.bodyLines.length !== 1;
  const json = flatJson(part.bodyLines.length === 1 ? part.bodyLines[0] : null);
  if (!json) {
    unknown = true;
  } else {
    const ctx = contextOf(json['@odata.context'], admitted.apiBase);
    if (!ctx) unknown = true;
    else if (ctx.table !== role.table) conflict = true;
    else if (ctx.select !== null && ctx.select !== role.key) unknown = true;
    const etag = json['@odata.etag'];
    if (typeof etag !== 'string' || !HELD_ETAG.test(etag)) unknown = true;
    if (k.role === 'root') {
      const header = oneHeader(headers, 'etag');
      if (header !== undefined && header !== etag) unknown = true;
    } else {
      const parent = typeof json._customapiid_value === 'string' ? normalizeGuid(json._customapiid_value) : '';
      if (!parent) unknown = true;
      else if (parent !== admitted.boundId) conflict = true;
    }
  }
  const extra = ident.answeredId ? { answeredId: ident.answeredId } : {};
  if (conflict) return { outcome: 'conflict', status: part.status, ...extra };
  if (unknown) return { outcome: 'unknown', status: part.status, ...extra };
  return { outcome: 'acknowledged', status: part.status, ...extra };
}

/**
 * Read the answer to an admitted change set, per constituent. `admitted` = { apiBase, boundId, constituents:
 * [{ contentId, role, id }] } (parseCustomApiChangeset's, with the configured base). Answers {
 *   batchStatus,       the outer status, or null;
 *   parts,             one { outcome, status, answeredId? } per constituent, in request order: `status` is its own part's
 *                      status, or null when no part answered it;
 *   failure?           { contentId, status, code? }: the service reported this one constituent failed and the change set
 *                      rolled back (the shape captured above); `code` only when it is a platform code such as 0x80040333.
 *                      A diagnostic, never evidence of what exists.
 * }
 * Every constituent is acknowledged only when the whole change set is: outer 200, complete framing, one part for every
 * Content-ID and none else, and every part acknowledged. A part naming another row is a conflict and stays one; every
 * other constituent is then unknown, as is every constituent of a failed, partial, malformed or lost answer.
 */
function readChangesetAnswer(res, admitted) {
  // Loaded here, not at the top: the gate loads this module, and answerOf is the gate's (one identity rule for a
  // request on its own and for a constituent).
  const { answerOf } = require('./managed-create-transport.js');
  const batchStatus = statusOf(res);
  const n = admitted.constituents.length;
  const every = (outcome) => ({ batchStatus, parts: admitted.constituents.map(() => ({ outcome, status: null })) });
  if (!res || res.error || batchStatus === null) return every('unknown');
  const raw = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.body;
  let framed;
  try {
    framed = walk(raw, { outer: 'batchresponse', inner: 'changesetresponse', limit: n, ordered: false });
  } catch (e) {
    if (e instanceof Malformed) return every('unknown');
    throw e;
  }
  const contentType = oneHeader(res.headers, 'content-type');
  if (contentType !== undefined && multipartBoundary(contentType) !== framed.boundary) return every('unknown');
  const byId = new Map(admitted.constituents.map((k, i) => [k.contentId, i]));
  const seen = new Map();
  for (const p of framed.parts) {
    const line = /^HTTP\/1\.1 ([1-5][0-9]{2})(?: [^\r\n]*)?$/.exec(p.start);
    if (!line || !byId.has(p.contentId) || seen.has(p.contentId)) return every('unknown');
    p.status = Number(line[1]);
    seen.set(p.contentId, p);
  }
  let failure;
  if (batchStatus < 200 || batchStatus >= 300) {
    // The atomic failure the service reports: the outer status repeated by ONE part of the set, with its error envelope.
    const [p] = framed.parts;
    if (framed.parts.length === 1 && p.status === batchStatus) {
      let code;
      try {
        const env = JSON.parse(p.bodyLines.join('\n'));
        if (isPlain(env) && isPlain(env.error) && typeof env.error.code === 'string' && /^0x[0-9A-Fa-f]{8}$/.test(env.error.code)) code = env.error.code.toLowerCase();
      } catch {
        code = undefined;
      }
      failure = { contentId: p.contentId, status: p.status, ...(code ? { code } : {}) };
    }
  }
  const parts = admitted.constituents.map((k) => {
    const p = seen.get(k.contentId);
    return p ? judgePart(p, k, admitted, answerOf) : { outcome: 'unknown', status: null };
  });
  const complete = batchStatus === 200 && seen.size === n && parts.every((p) => p.outcome === 'acknowledged');
  const out = parts.map((p) => (complete || p.outcome === 'conflict' ? p : { ...p, outcome: 'unknown' }));
  return { batchStatus, parts: out, ...(failure ? { failure } : {}) };
}

module.exports = {
  MAX_BATCH_PARTS,
  ROLES,
  batchConfig,
  parseCustomApiChangeset,
  constituentFault,
  readChangesetAnswer,
};
