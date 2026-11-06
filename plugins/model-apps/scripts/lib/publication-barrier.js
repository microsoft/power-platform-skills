'use strict';
// The run-wide table publication barrier for declared views, charts and Quick Find lists.
//
// A Dataverse table publish (PublishXml naming the table, or the SDK's publish of any one view, form
// or chart of it) ships EVERYTHING saved on that table, whoever saved it. So when a declared artifact
// on table T ends refused or unknown after something was saved — a created chart whose title was not
// stored, a created view that could not be read back, a write whose outcome was not reported — no
// publish of T may run for the rest of the build: not the artifact's own, and not one that other work
// owes T (a sibling view's reconcile, the default-view enrichment, the tables published before the app,
// the publish phase, the settle of a halt). The saved rows stay saved and unpublished, with their
// solution and undo bookkeeping; nothing is deleted or rolled back. The build reports each withheld
// table and what blocked it, and the run stays incomplete (nonzero) through the artifact's own
// refusal or unknown.
//
// The barrier is created once per run and handed to every attempt, so a retry after a transient halt
// cannot publish a table an earlier attempt withheld. It is inert until `noteResult` blocks a table:
// every `allow*` call then answers exactly what it was given, so a run that never meets one of these
// failures sends the same requests as before.
//
// Which results block: a result with a refusal or an unknown that still carries `pendingPublish`
// entries (marked `withheld` by commitPublication, reconcile-common.js). The helpers record such an
// entry at every point where a write was sent and may have been stored (saved, created, or a write
// whose outcome was not reported), and never for a refusal or unknown that is reached before anything
// is sent, so a plan-level refusal does not block its table. That rule is for the table results noted
// here. A declared dashboard settles through runManagedFeature (lib/managed-feature-contract.js)
// instead: a preflight stop of a dashboard an id already names (bound, pinned, found by name, or
// retained by its creation record) quarantines that id for the run, before anything is sent, so its
// earlier owed publish and an app publish that holds it are withheld. Only a new dashboard that no id
// names yet stays unscoped: there is no row to withhold.

//
// Two checks sit at the edges of a run, past every per-path guard:
//   gateRequest   the HTTP transport. A publish request is checked when it is DISPATCHED, synchronously, after
//                 every asynchronous step of its preparation (the SDK reads its workspace and takes its locks
//                 first; the HTTP client may wait out a throttle and send it again). A sibling that blocks the
//                 table while a publish of it is being prepared therefore still stops it.
//   checkAppWrite a write or publish of the app. An app publish puts live the saved forms the app holds, so an
//                 app that holds, or whose write adds, a form of a blocked table is not written in this run.
//
// Declared forms, dashboards, business rules and process flows (lib/managed-bindings.js, lib/managed-feature-contract.js) add
// the following, all unused by a build that has no managed store, so such a build sends the same requests as before:
//   dashboard scopes  a dashboard publishes by its own id (`<dashboard>` in the ParameterXml), never as a table: `blockScope`,
//                     `allowScope`, `allowTarget` and `checkAppWrite` (`addedDashboards`, `heldDashboards`) withhold it apart.
//   holds             `hold(token, …)` withholds a managed attempt's scopes until `release(token)`, after that attempt is proved
//                     and committed. Only that token is released: a sibling's success never frees a scope another attempt holds.
//   quarantine        a block for the rest of the run, set by a required failure; nothing releases it.
//   registerKnown     maps a managed artifact's ids to the scopes they publish. It is not a block.
//   routes            `route(table)` sends every PLAIN publish of a table a committed managed group publishes in to the
//                     managed coverage protocol: the plain path is refused and remembered as wanted (routedWanted), and
//                     lib/managed-scope-publisher.js publishes the table once its covered groups are shown safe. Not a
//                     withhold: nothing is reported, and the app write is not stopped by it.
//   send permits      `withSendPermit({ token, scope, onDispatch, onWithheld, onRefused }, fn)` lets the one publish request of
//                     a managed publication through `token`'s own hold, and through nothing else: inside `fn`, a publish
//                     request is screened as if that hold were absent (every block and every other hold still applies).
//                     A request whose complete publish target set is not exactly `scope` (a publish of everything, of
//                     another or one more scope, a change set, an unreadable body) is refused unsent and `onRefused()`
//                     is told. If the permit's own scope is withheld, nothing is sent and `onWithheld()` is told; otherwise
//                     `onDispatch()` runs synchronously at the send, so the dispatch is recorded where it happens (a throw
//                     there sends nothing), and a second publish request under the same permit is not sent. A publish
//                     outside the permit stays withheld by the hold, so a sibling cannot overlap the managed send.
//   create pins       `pinCreate({ collection, idField, id, matches })` ties the one create request of a row to the content the
//                     caller expects it to carry (lib/creates-stable-build.js: the body the SDK serialises from the draft the
//                     build made). While the pin is held, the row's whole write boundary is closed but for that one request:
//                     a POST to the collection naming the row is sent only when `matches(body)`; every other write that
//                     could create, change or remove the row — a PATCH, PUT or DELETE of it (the SDK pushes as a PATCH a
//                     draft another process has saved meanwhile), any write addressed to it or below it, a write whose body
//                     names it, a `$batch` with any part that touches it (its parts read the way the service reads them,
//                     lib/batch-request.js) or that cannot be read — is answered 409 `create-local-draft-changed` before
//                     the transport. So a local draft edited after the build made it is never sent, as a create or as an
//                     update. Reads (GET, HEAD) and writes that do not touch the row go as they came. Checked at the
//                     dispatch, after every asynchronous step of the push, which is what a check of the workspace before the
//                     push cannot be. Each pin is its own: its release ends that pin only. `gatesTransport()` says whether a
//                     transport is gated at all: a pin holds only then.

const { AsyncLocalStorage } = require('node:async_hooks');
const { readXmlElements } = require('./strict-xml.js');
const { readBatchRequest } = require('./batch-request.js');

// The permit a managed publication runs under (withSendPermit). Module-wide because an async context crosses every
// barrier, but each permit names its barrier, and a gate honours only its own.
const permits = new AsyncLocalStorage();

/** Lowercased table logical name, or '' for anything that is not a non-empty string. */
function tableKey(table) {
  return typeof table === 'string' ? table.trim().toLowerCase() : '';
}

/** Lowercased dashboard (systemform) id without braces, or '' for anything that is not a non-empty string. */
function dashboardKey(id) {
  return typeof id === 'string' ? id.trim().replace(/^\{|\}$/g, '').toLowerCase() : '';
}

/** A row id as a pinned create names it: lowercased, without braces, or '' (dashboardKey's rule). */
const guidKey = dashboardKey;

// The publish actions, as lib/sdk-http-client.js (isPublishRequest) recognises them:
//   POST https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml                            { "ParameterXml": "<importexportxml>…</importexportxml>" }
//   POST https://contoso.crm.dynamics.com/api/data/v9.2/Microsoft.Dynamics.CRM.PublishAllXml  {}
// See https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/publishxml
const PUBLISH_XML = /\/(?:Microsoft\.Dynamics\.CRM\.)?PublishXml$/i;
const PUBLISH_ALL_XML = /\/(?:Microsoft\.Dynamics\.CRM\.)?PublishAllXml$/i;
const BATCH = /\/\$batch$/i;
// The paths gateRequest and checkAppWrite record a withheld table as skipped by.
const AT_SEND = 'publish request (checked when sent)';
const APP_WRITE = 'app write or publish (the app holds or adds a form of the table)';
// A table in a ParameterXml is one `entity` element of the `entities` list, its logical name as text:
//   <importexportxml><entities><entity>contoso_task</entity><entity>account</entity></entities><nodes/>…</importexportxml>
// Logical names are [a-z0-9_], so they carry no markup or entity references to decode.
const ENTITY_ELEMENT = /<entity>\s*([^<]*?)\s*<\/entity>/gi;
// A dashboard in a ParameterXml is one `dashboard` element of the `dashboards` list, its form id as text (the SDK's
// publish of one dashboard, measured with the real bundle):
//   <importexportxml><dashboards><dashboard>55555555-5555-4555-8555-555555555555</dashboard></dashboards></importexportxml>
// A dashboard id is never encoded as a table name: the two lists are screened apart.
const DASHBOARD_ELEMENT = /<dashboard>\s*([^<]*?)\s*<\/dashboard>/gi;
// An element left with nothing in it once its tables are cut (`<entities></entities>`, `<nodes/>`).
const EMPTY_ELEMENT = /<([A-Za-z_][\w.-]*)(\s[^<>]*)?>\s*<\/\1>|<[A-Za-z_][\w.-]*(\s[^<>]*)?\/>/g;

// The two target lists of a ParameterXml and the one kind of leaf each holds (names compared lowercased).
const TARGET_LISTS = Object.freeze({ entities: 'entity', dashboards: 'dashboard' });

/**
 * The complete publish target set of one ParameterXml, read as ONE strict XML document (lib/strict-xml.js), or null when it
 * is not one this reads whole. A permit's request is sent only when this is exactly the permit's one scope, so every doubt
 * is a null, never a smaller set: a part this does not understand could publish something the scope check never saw.
 *
 * THE SUPPORTED SUBSET — what the plugin's own writers send (lib/table-publish.js, the SDK's dashboard publish):
 *   <importexportxml><entities><entity>account</entity><entity>contoso_task</entity></entities><nodes/></importexportxml>  -> ['account', 'contoso_task']
 *   <importexportxml><dashboards><dashboard>{5555…}</dashboard></dashboards></importexportxml>                            -> ['dashboard 5555…']
 *   - the document is the `importexportxml` root alone: no declaration, comment or text around it;
 *   - each child of the root is an `entities` or `dashboards` list, or an EMPTY container (`<nodes/>`, `<nodes />`,
 *     `<nodes></nodes>`), which publishes nothing; a list with no leaf is such a container too;
 *   - a list holds only its own leaf — `entity` in `entities`, `dashboard` in `dashboards` — and a leaf is written exactly
 *     `<entity>name</entity>`, its text a table name or a dashboard id with white space around it at most;
 *   - names are matched case-insensitively (an uppercase `<ENTITY>ACCOUNT</ENTITY>` reads), each tag closes as it opened.
 * Refused (null): a document that is not well-formed or mismatched; an empty leaf in any spelling (`<entity/>`, `<entity />`,
 * `<entity> </entity>`); a leaf outside its own list; a container holding anything (`<appmodules><appmodule>…`, text);
 * any attribute (so any namespace declaration) or prefixed name; a comment, CDATA section, processing instruction or
 * reference in the document; and other spellings of a target tag (`<entity >`), which are well-formed but not what any
 * writer here sends — a conservative refusal of a request that is then not sent, never a guess.
 */
function parameterTargets(xml) {
  // A ParameterXml nests three deep at most (importexportxml / entities / entity): anything deeper is not read.
  const read = readXmlElements(xml, () => true, { spans: true, maxDepth: 3 });
  if (!read.ok) return null;
  const els = read.elements.slice().sort((a, b) => a.start - b.start);
  const root = els[0];
  if (!root || root.path !== '' || xml.slice(0, root.start).trim() || xml.slice(root.end).trim()) return null;
  const childPath = (e) => (e.path ? `${e.path}/${e.name}` : e.name);
  const selfClosing = (e) => xml.charCodeAt(e.end - 2) === 0x2F && xml.charCodeAt(e.end - 1) === 0x3E;
  // A paired element's content, between `<name>` and `</name>` written exactly so; null for any other spelling.
  const inner = (e) => {
    const open = `<${e.name}>`;
    const close = `</${e.name}>`;
    if (!xml.startsWith(open, e.start) || xml.slice(e.end - close.length, e.end) !== close) return null;
    return { from: e.start + open.length, to: e.end - close.length };
  };
  // The text directly in `e` (its children cut out) is white space only: no text, comment, CDATA or reference.
  const onlySpaceAround = (e, kids) => {
    const box = inner(e);
    if (!box) return false;
    let at = box.from;
    for (const k of kids) {
      if (xml.slice(at, k.start).trim()) return false;
      at = k.end;
    }
    return !xml.slice(at, box.to).trim();
  };
  const childrenOf = (e) => els.filter((k) => k.path === childPath(e) && k.start > e.start && k.end <= e.end);
  for (const e of els) {
    if (e.name.includes(':') || Object.keys(e.attrs).length) return null;
  }
  if (root.name.toLowerCase() !== 'importexportxml') return null;
  const targets = [];
  const add = (name) => { if (!targets.includes(name)) targets.push(name); };
  if (selfClosing(root)) return els.length === 1 ? targets : null;
  const top = childrenOf(root);
  if (!onlySpaceAround(root, top)) return null;
  for (const list of top) {
    const leafName = TARGET_LISTS[list.name.toLowerCase()];
    // A target leaf straight under the root, outside its list, is not read — in any spelling, empty or not.
    if (Object.values(TARGET_LISTS).includes(list.name.toLowerCase())) return null;
    const leaves = childrenOf(list);
    if (selfClosing(list)) continue;
    if (!onlySpaceAround(list, leaves)) return null;
    if (!leaves.length) continue;
    // A leaf in a container that is not its list (`<appmodules><appmodule>…`), or in the other list.
    if (!leafName) return null;
    for (const leaf of leaves) {
      if (leaf.name.toLowerCase() !== leafName || selfClosing(leaf)) return null;
      const box = inner(leaf);
      if (!box) return null;
      const text = xml.slice(box.from, box.to);
      // A leaf's text is a name or an id and nothing else: a comment, CDATA section or reference inside it is not read.
      if (/[<&]/.test(text)) return null;
      if (leafName === 'entity') {
        const t = tableKey(text);
        if (!t) return null;
        add(t);
      } else {
        const d = dashboardKey(text);
        if (!d) return null;
        add(`dashboard ${d}`);
      }
    }
  }
  return targets;
}

function pathnameOf(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url || '');
  }
}

function bodyText(body) {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return body == null ? '' : null;
}

// What a request the gate does not dispatch is answered with, in the transport's own shape (makeRequest,
// lib/dataverse-auth.js: { statusCode, headers, body }). `nothingLeft`: every table it named is withheld,
// so it would publish nothing — answered as an accepted publish of nothing (204). Otherwise the request
// cannot be cut down (a publish of everything, a change set) and is refused with a status the build's
// retry policy reads as final (409, lib/retry-policy.js), so it is never sent again in this run.
function withheldAnswer(nothingLeft, message) {
  if (nothingLeft) return { statusCode: 204, headers: {}, body: '' };
  return {
    statusCode: 409,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error: { code: 'publication-withheld', message } }),
  };
}

// What a send permit answers a publish request it refuses because the request does not publish exactly the permit's
// scope: a final status (409, lib/retry-policy.js), so the client does not send it again.
function refusedAnswer(message) {
  return {
    statusCode: 409,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error: { code: 'publication-refused', message } }),
  };
}

// --- create pins (pinCreate): reading a write the way the service does ---------------------------------------------------
const READ_METHODS = new Set(['GET', 'HEAD']);
const BATCH_ENDPOINT = /(?:^|\/)\$batch\/*$/i;
const PLAIN_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The transport sends the path `new URL(address)` makes (lib/dataverse-auth.js), which resolves dot segments, so an address
// is read the same way; a relative one (a batch part writes `savedqueries` or `/api/data/v9.2/savedqueries`) is resolved
// against a root that serves only to resolve it. Escapes are decoded once, as the service decodes them (`savedquer%69es` is
// the collection), and the path is lowercased (logical names and ids are case-insensitive). A path that still holds an
// escape after that cannot be read with confidence: undefined, and refused while a pin is held.
const PIN_RESOLVE_AGAINST = 'https://service-root.invalid/api/data/v9.2/';
function pinPathOf(address) {
  let path;
  try {
    path = new URL(String(address), PIN_RESOLVE_AGAINST).pathname;
  } catch {
    return undefined;
  }
  const decoded = path.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
  return decoded.includes('%') ? undefined : decoded.toLowerCase();
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [k, v] of Object.entries(headers)) if (String(k).toLowerCase() === name) return v == null ? undefined : String(v);
  return undefined;
}

function readJsonText(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

// Whether a text names the pinned row's id: hyphenated (as OData writes a Guid) or as its 32 digits alone, in any case.
function namesPinnedId(pin, text) {
  const lower = String(text).toLowerCase();
  return lower.includes(pin.id) || lower.replace(/-/g, '').includes(pin.compact);
}

// Whether a parsed JSON value names the pinned id in any key or string at any depth. Parsed first, so a JSON escape
// (`"\u0061…"`) is read as the character it stands for, never matched as written.
function jsonNamesPinnedId(pin, value) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (namesPinnedId(pin, v)) return true;
    } else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        if (namesPinnedId(pin, k)) return true;
        stack.push(item);
      }
    }
  }
  return false;
}

// Why one write is refused under `pin`, or null when it does not touch the pinned row. `inBatch`: a part of a $batch, where
// even the matching create is refused (the pinned create is the SDK's plain POST; a change set carrying the row is not the
// request the build made).
//   POST <collection>                 a create: passes when it names another row by a readable id and the pinned one nowhere,
//                                     or when it is the matching create; refused otherwise (no id, unreadable, other content);
//   any write of <collection>(<key>)  the row, or anything addressed below it (`savedqueries(<id>)/…`): refused when the key
//                                     is the pinned id or is not a plain id (an alternate key may name the same row);
//   any other write                   refused when its address or its body names the pinned id (a JSON body parsed first).
function screenPinnedWrite(pin, method, path, text, inBatch) {
  if (path === undefined) return `a ${method} whose address could not be read`;
  if (text === null) return `a ${method} whose body could not be read`;
  if (path.endsWith(`/${pin.collection}`) || path.endsWith(`/${pin.collection}/`) || path === pin.collection) {
    if (method !== 'POST') return `a ${method} of the ${pin.collection} collection`;
    const parsed = readJsonText(text);
    const body = parsed && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : null;
    if (!body) return 'a create whose body could not be read';
    const named = guidKey(body[pin.idField]);
    if (!named) return 'a create that names no id';
    if (named !== pin.id) return jsonNamesPinnedId(pin, body) ? 'a create of another row that names this one' : null;
    if (inBatch) return 'a create of the row inside a change set';
    let same = false;
    try { same = pin.matches(body) === true; } catch { same = false; }
    if (!same) return 'a create whose content is not the draft this build made';
    pin.checked = true;
    return null;
  }
  const at = path.indexOf(`/${pin.collection}(`);
  if (at >= 0) {
    const open = at + pin.collection.length + 2;
    const close = path.indexOf(')', open);
    const raw = close < 0 ? '' : path.slice(open, close);
    const key = guidKey(raw.startsWith(`${pin.idField.toLowerCase()}=`) ? raw.slice(pin.idField.length + 1) : raw);
    if (!PLAIN_GUID.test(key)) return `a ${method} of a ${pin.collection} row named by a key that is not a plain id`;
    if (key === pin.id) return `a ${method} of the row`;
  }
  if (namesPinnedId(pin, path)) return `a ${method} addressed to the row`;
  if (text === '') return null;
  const parsed = readJsonText(text);
  if (parsed ? jsonNamesPinnedId(pin, parsed.value) : namesPinnedId(pin, text)) return `a ${method} whose body names the row`;
  return null;
}

// Why a $batch is refused under `pin`, or null when it is shown not to touch the pinned row: every part is read the way the
// service reads it (lib/batch-request.js: the boundary the Content-Type's boundary parameter declares, read quote-aware at the batch and at each change set, change sets opened, each part one request
// with its body text) and screened as a write of its own. A body that cannot be read as a batch is refused: what it would
// write cannot be shown. A part addressed to an earlier part's row by its Content-ID (`$1/…`) touches the row that part
// creates, and every create part is screened itself (one that names the pinned row, or no id, is refused), so such a
// reference needs no rule of its own.
function screenPinnedBatch(pin, text, contentType) {
  if (text === null) return 'a change set whose body could not be read';
  const batch = readBatchRequest(text, contentType);
  if (batch.problem) return `a change set that could not be read (${batch.problem}), which may carry it`;
  for (const op of batch.operations) {
    const method = String(op.method || '').toUpperCase();
    if (READ_METHODS.has(method)) continue;
    const path = pinPathOf(op.target);
    if (path !== undefined && BATCH_ENDPOINT.test(path)) return 'a change set that holds another batch';
    const why = screenPinnedWrite(pin, method, path, op.body == null ? '' : op.body, true);
    if (why) return `${why}, in a change set`;
  }
  return null;
}

function createPublicationBarrier() {
  // table -> { table, blockedBy: [label], skipped: [path] }: blocked for the rest of the run.
  const blocked = new Map();
  // dashboard id -> { dashboard, blockedBy: [label], skipped: [path] }: blocked for the rest of the run.
  const dashboardsBlocked = new Map();
  // token -> { tables: Set, dashboards: Set, label }: withheld while a managed attempt is unproved; `release(token)`
  // ends only that token's hold, so one artifact's success never frees what a sibling holds.
  const holds = new Map();
  // `table:<name>` / `dashboard:<id>` -> the entry a held scope reports and records skips on.
  const heldEntries = new Map();
  // id -> { tables: Set, dashboards: Set }: the scopes a managed artifact's ids publish (registerKnown; not a block).
  const knownIds = new Map();
  // `type:id` -> table, for owed publish targets ([type, id, names?]) that carry no table of their own.
  const targetTables = new Map();
  // table -> { table, blockedBy: [label], skipped: [path], route: true, wanted }: a ROUTED table (route), one a committed
  // managed group of the store publishes in. Not a withhold: a plain publish of it is refused here and remembered as
  // `wanted`, and the managed publisher (lib/managed-scope-publisher.js) sends it through the coverage protocol instead.
  const routes = new Map();
  const skip = (entry, path) => {
    if (path && !entry.skipped.includes(path)) entry.skipped.push(path);
    if (entry.route === true) entry.wanted = true;
  };
  // Pinned creates (pinCreate): each { collection, idField, id, matches, checked, refused, released }. Empty unless a
  // store-backed declared create is being pushed, so every other request skips the pin check entirely.
  const pins = new Set();
  // Whether gateRequest has wrapped a transport (gatesTransport): a pin can only hold where the gate sees the request.
  let gated = false;
  // The hold a permitted publish is screened past, set only while gatedRequest screens that one request; null otherwise.
  // `exceptRoute` the same way: the permit's own table, which its one request publishes although the table is routed.
  let exceptToken = null;
  let exceptRoute = null;
  const liveHolds = () => [...holds].filter(([t]) => t !== exceptToken).map(([, h]) => h);
  const isHeld = (kind, name) => {
    for (const h of liveHolds()) if ((kind === 'table' ? h.tables : h.dashboards).has(name)) return true;
    return false;
  };
  const heldEntry = (kind, name) => {
    const k = `${kind}:${name}`;
    if (!heldEntries.has(k)) heldEntries.set(k, kind === 'table' ? { table: name, blockedBy: [], skipped: [] } : { dashboard: name, blockedBy: [], skipped: [] });
    const entry = heldEntries.get(k);
    for (const h of liveHolds()) if ((kind === 'table' ? h.tables : h.dashboards).has(name) && h.label && !entry.blockedBy.includes(h.label)) entry.blockedBy.push(h.label);
    return entry;
  };
  // The entry that withholds a table or dashboard now — a run-long block, else a live hold — or undefined.
  const withholdEntry = (table) => {
    const t = tableKey(table);
    return blocked.get(t) || (t && isHeld('table', t) ? heldEntry('table', t) : undefined);
  };
  const routedNow = () => [...routes.keys()].filter((t) => t !== exceptRoute);
  // The entry that stops a PLAIN publish of a table now: a withhold, else a route — or undefined.
  const tableEntry = (table) => {
    const t = tableKey(table);
    return withholdEntry(t) || (t && t !== exceptRoute ? routes.get(t) : undefined);
  };
  const dashboardEntry = (id) => {
    const d = dashboardKey(id);
    return dashboardsBlocked.get(d) || (d && isHeld('dashboard', d) ? heldEntry('dashboard', d) : undefined);
  };
  const activeTables = () => {
    const list = [...blocked.keys()];
    for (const h of liveHolds()) for (const t of h.tables) if (!list.includes(t)) list.push(t);
    return list;
  };
  const activeDashboards = () => {
    const list = [...dashboardsBlocked.keys()];
    for (const h of liveHolds()) for (const d of h.dashboards) if (!list.includes(d)) list.push(d);
    return list;
  };
  // Whether anything is withheld. While nothing is, the app check answers ok.
  const anyActive = () => blocked.size > 0 || dashboardsBlocked.size > 0 || liveHolds().some((h) => h.tables.size || h.dashboards.size);
  // Whether a plain publish can be stopped at all: a withhold or a route. While neither is, every publish check below
  // answers exactly what it was given — a build with no managed store and no failure sends the same requests as before.
  const anyGated = () => anyActive() || routedNow().length > 0;
  const scopesOf = (scopes) => {
    const out = { tables: new Set(), dashboards: new Set() };
    for (const s of Array.isArray(scopes) ? scopes : [scopes]) {
      if (!s || typeof s !== 'object') continue;
      if (s.type === 'table' && tableKey(s.table)) out.tables.add(tableKey(s.table));
      if (s.type === 'dashboard' && dashboardKey(s.id)) out.dashboards.add(dashboardKey(s.id));
    }
    return out;
  };

  const barrier = {
    /** True once any table or dashboard is blocked or held. */
    get active() {
      return anyActive();
    },
    /** Block `table` because `label` ended refused or unknown with saved or possibly-saved state. */
    block(table, label) {
      const t = tableKey(table);
      if (!t) return false;
      let entry = blocked.get(t);
      if (!entry) {
        entry = { table: t, blockedBy: [], skipped: [] };
        blocked.set(t, entry);
      }
      if (label && !entry.blockedBy.includes(label)) entry.blockedBy.push(label);
      return true;
    },
    /**
     * Note one declared artifact's settled FeatureResult. A clean result, or one whose refusal/unknown
     * came before anything was sent (no `pendingPublish` entry), blocks nothing. Returns the tables
     * this result blocked. Declared dashboards are not noted here: runManagedFeature quarantines a
     * known dashboard's id when it stops, a preflight stop included (see the header).
     */
    noteResult(result, label) {
      if (!result) return [];
      if (!(result.refused || []).length && !(result.unknown || []).length) return [];
      const codes = [...(result.refused || []), ...(result.unknown || [])].map((x) => x && x.code).filter(Boolean);
      const what = codes.length ? `${label} (${[...new Set(codes)].join(', ')})` : String(label || 'a declared artifact');
      const tables = [];
      for (const p of result.pendingPublish || []) {
        const t = tableKey(p && p.scope && p.scope.table);
        if (t && barrier.block(t, what) && !tables.includes(t)) tables.push(t);
      }
      return tables;
    },
    /** Whether `table` is blocked or held. Records nothing. A routed table is not withheld (route). */
    blocks(table) {
      return !!withholdEntry(table);
    },
    /** The blocked and held tables, in the order they were blocked. */
    blockedTables() {
      return activeTables();
    },
    /** May `table` be published by `path`? A refusal is recorded against the table as skipped by `path`. */
    allow(table, path) {
      const entry = tableEntry(table);
      if (!entry) return true;
      skip(entry, path);
      return false;
    },
    /** The tables of `tables` that may be published by `path`, in their order; the list itself when nothing is blocked. */
    allowTables(tables, path) {
      const list = Array.isArray(tables) ? tables : [...(tables || [])];
      if (!anyGated()) return list;
      return list.filter((t) => barrier.allow(t, path));
    },
    /** Remember that the owed publish `target` ([type, id, names?]) publishes `table`. */
    noteTarget(table, target) {
      const t = tableKey(table);
      if (t && Array.isArray(target) && target[0] && target[1]) targetTables.set(`${target[0]}:${String(target[1]).toLowerCase()}`, t);
    },
    /**
     * May the owed publish `target` run? False when the table it was noted for is blocked, when it is a dashboard whose
     * id is blocked or held, or when its id was registered (registerKnown) for a scope that is.
     */
    allowTarget(target, path) {
      if (!anyGated() || !Array.isArray(target)) return true;
      const id = String(target[1]).toLowerCase();
      if (target[0] === 'dashboard') {
        const entry = dashboardEntry(id);
        if (entry) { skip(entry, path); return false; }
      }
      const t = targetTables.get(`${target[0]}:${id}`);
      if (t && !barrier.allow(t, path)) return false;
      const known = knownIds.get(dashboardKey(id));
      if (known) {
        let ok = true;
        for (const k of known.tables) if (!barrier.allow(k, path)) ok = false;
        for (const d of known.dashboards) {
          const entry = dashboardEntry(d);
          if (entry) { skip(entry, path); ok = false; }
        }
        return ok;
      }
      return true;
    },
    /**
     * May the MANAGED publish of `scope` ({ type: 'table', table } or { type: 'dashboard', id }) run? Records a refusal as
     * allow does. Its caller is the managed coverage protocol (publishManagedScope), so a route — which hands a plain
     * publish to that protocol — does not stop it; every block and hold does.
     */
    allowScope(scope, path) {
      if (scope && scope.type === 'dashboard') {
        const entry = dashboardEntry(scope.id);
        if (!entry) return true;
        skip(entry, path);
        return false;
      }
      const entry = withholdEntry(scope && scope.table);
      if (!entry) return true;
      skip(entry, path);
      return false;
    },
    /**
     * Route `table`: a committed managed group of the store publishes in it, so only the managed coverage protocol may
     * put its saved layer live (lib/managed-scope-publisher.js). From now on a plain publish of the table — allow,
     * allowTables, allowTarget, a publish request at send — is refused and remembered as wanted (routedWanted), and the
     * managed publisher sends it. A route is not a withhold: it is not reported (withheld), is no block (blocks,
     * blockedTables) and does not stop an app write (checkAppWrite).
     */
    route(table, label) {
      const t = tableKey(table);
      if (!t) return false;
      let entry = routes.get(t);
      if (!entry) {
        entry = { table: t, blockedBy: [], skipped: [], route: true, wanted: false };
        routes.set(t, entry);
      }
      if (label && !entry.blockedBy.includes(label)) entry.blockedBy.push(label);
      return true;
    },
    /** The routed tables, in the order they were routed. */
    routedTables() {
      return [...routes.keys()];
    },
    /** The routed tables a plain publish asked for since they were last paid (routePaid), in route order. */
    routedWanted() {
      return [...routes.values()].filter((e) => e.wanted).map((e) => e.table);
    },
    /** The managed publisher settled `table`: what plain publishes wanted of it is paid. */
    routePaid(table) {
      const entry = routes.get(tableKey(table));
      if (entry) entry.wanted = false;
    },
    /** Block one scope for the rest of the run, because `label` may have left it saved and unproved. */
    blockScope(scope, label) {
      if (scope && scope.type === 'dashboard') {
        const d = dashboardKey(scope.id);
        if (!d) return false;
        let entry = dashboardsBlocked.get(d);
        if (!entry) {
          entry = { dashboard: d, blockedBy: [], skipped: [] };
          dashboardsBlocked.set(d, entry);
        }
        if (label && !entry.blockedBy.includes(label)) entry.blockedBy.push(label);
        return true;
      }
      return barrier.block(scope && scope.table, label);
    },
    /**
     * Remember which scopes the ids of a managed artifact publish (a form id -> its table, a dashboard id -> itself).
     * Not a block: a registered scope stays publishable until something holds or blocks it.
     */
    registerKnown(scopes, ids) {
      const { tables, dashboards } = scopesOf(scopes || []);
      for (const raw of ids || []) {
        const id = dashboardKey(String(raw));
        if (!id) continue;
        const entry = knownIds.get(id) || { tables: new Set(), dashboards: new Set() };
        for (const t of tables) entry.tables.add(t);
        for (const d of dashboards) entry.dashboards.add(d);
        knownIds.set(id, entry);
      }
    },
    /** Withhold `scopes` under `token` until `release(token)`: a managed attempt that is not yet proved and committed. */
    hold(token, scopes, ids, label) {
      if (!token) throw new TypeError('hold: a token is required');
      barrier.registerKnown(scopes, ids);
      const { tables, dashboards } = scopesOf(scopes || []);
      const h = holds.get(token) || { tables: new Set(), dashboards: new Set(), label: label || 'a managed artifact that is not yet proved' };
      for (const t of tables) h.tables.add(t);
      for (const d of dashboards) h.dashboards.add(d);
      holds.set(token, h);
    },
    /** End the hold of `token` only. Run-long blocks and other tokens' holds stay. */
    release(token) {
      return holds.delete(token);
    },
    /** Block `scopes` for the rest of the run: a required failure (preflight, proof, membership, creation record). */
    quarantine(scopes, ids, label) {
      barrier.registerKnown(scopes, ids);
      for (const s of Array.isArray(scopes) ? scopes : [scopes]) barrier.blockScope(s, label);
    },
    /** What was withheld: [{ table, blockedBy: [label], skipped: [path] }] and [{ dashboard, … }], copies. */
    withheld() {
      const out = [];
      for (const t of activeTables()) {
        const e = withholdEntry(t);
        out.push({ table: e.table, blockedBy: e.blockedBy.slice(), skipped: e.skipped.slice() });
      }
      for (const d of activeDashboards()) {
        const e = dashboardEntry(d);
        out.push({ dashboard: e.dashboard, blockedBy: e.blockedBy.slice(), skipped: e.skipped.slice() });
      }
      return out;
    },
    /**
     * Wrap the HTTP transport (`request` of createAzHttpClient, lib/sdk-http-client.js; makeRequest by
     * default) so that a publish naming a blocked table is checked at the moment it is dispatched. A
     * PublishXml is sent without the blocked tables' `entity` elements, or not at all when nothing else is
     * left in it; a publish of everything, or a `$batch` that holds a publish of a blocked table, is not
     * sent. Every other request, and every request while nothing is blocked, goes to the transport as it
     * came.
     */
    gateRequest(request = require('./dataverse-auth.js').makeRequest) {
      if (typeof request !== 'function') throw new TypeError('gateRequest: the transport to wrap must be a function');
      gated = true;
      return function gatedRequest(req) {
        if (pins.size) {
          const pinned = screenPins(req);
          if (pinned) return Promise.resolve(pinned);
        }
        const permit = permits.getStore();
        if (permit && permit.barrier === barrier && isPublish(req)) return permitted(permit, req, request);
        if (!anyGated()) return request(req);
        const screened = screenPublish(req);
        return screened.answer ? Promise.resolve(screened.answer) : request(screened.req);
      };
    },
    /** Whether a transport is gated by this barrier (gateRequest was called): a pinCreate holds only then. */
    gatesTransport() {
      return gated;
    },
    /**
     * Pin the one create request of a row (see the header, "create pins"): until `release()`, a POST to `/<collection>`
     * whose JSON body names `id` in `idField` is sent only when `matches(body)` answers true; every other write that
     * touches the row — a different create body, a body that does not parse, a POST to that collection that names no id,
     * a PATCH, PUT or DELETE of the row or of anything below it, a write whose body names the id, a `$batch` with a part
     * that touches it or that cannot be read — is answered 409 `create-local-draft-changed` here, unsent, and the pin is
     * marked `refused`. A request that passed is marked `checked`. Answers the pin: { checked, refused, release() }; each
     * pin is its own, and its release ends that pin only.
     */
    pinCreate({ collection, idField, id, matches } = {}) {
      const key = guidKey(id);
      if (typeof collection !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(collection) || typeof idField !== 'string' || !idField || !key || typeof matches !== 'function') {
        throw new TypeError('pinCreate: a collection, an id field, an id and a body check are required');
      }
      const pin = { collection: collection.toLowerCase(), idField, id: key, compact: key.replace(/-/g, ''), matches, checked: false, refused: false };
      pins.add(pin);
      pin.release = () => { pins.delete(pin); };
      return pin;
    },
    /**
     * Run `fn` with a send permit for one managed publication (see the header): `token` is the hold the publication
     * placed on `scope` ({ type: 'table', table } / { type: 'dashboard', id }); `onDispatch()` is called synchronously
     * just before the one publish request is sent, and may throw to stop it; `onWithheld()` when the request is not
     * sent because the scope is withheld by something else; `onRefused()` when a request is refused unsent because its
     * publish targets are not exactly `scope`. Answers what `fn` answers.
     */
    withSendPermit({ token, scope, onDispatch, onWithheld, onRefused } = {}, fn) {
      if (!token || !scope || typeof onDispatch !== 'function' || typeof fn !== 'function') throw new TypeError('withSendPermit: a token, a scope, onDispatch and the publish to run are required');
      const own = scope.type === 'dashboard' ? (dashboardKey(scope.id) && `dashboard ${dashboardKey(scope.id)}`) : tableKey(scope.table);
      if (!own) throw new TypeError('withSendPermit: the scope names no table or dashboard');
      return permits.run({ barrier, token, own, onDispatch, onWithheld, onRefused, dispatched: false, refused: false }, fn);
    },
    /**
     * May the build write or publish the app? `added`: the tables whose Main forms this write adds;
     * `held`: the tables whose forms or charts the app holds on the server (a Set or array), or
     * undefined when that could not be read; `existingApp`: whether the app exists on the server. An
     * app publish puts live what the app holds, so an app that holds or adds a form of a blocked table —
     * or an existing app whose holdings could not be read while a table is blocked — is not written:
     * { ok: false, tables, unknownHoldings, blockedBy }, recorded against each table as skipped by the
     * app write. { ok: true } otherwise, and always while nothing is blocked.
     *
     * Dashboards the same way: `addedDashboards`, the dashboard ids this write adds; `heldDashboards`, the ids the app
     * holds (undefined when unread). An app that holds or adds a blocked or held dashboard, or an existing app whose
     * dashboards could not be read while any dashboard is withheld, is not written; the verdict then also lists
     * `dashboards`.
     */
    checkAppWrite({ added = [], held, existingApp = false, addedDashboards = [], heldDashboards } = {}) {
      if (!anyActive()) return { ok: true };
      const heldList = held instanceof Set || Array.isArray(held) ? [...held] : null;
      const tables = [];
      for (const name of [...(added || []), ...(heldList || [])]) {
        const entry = withholdEntry(name);
        if (entry && !tables.includes(entry.table)) tables.push(entry.table);
      }
      const heldDashList = heldDashboards instanceof Set || Array.isArray(heldDashboards) ? [...heldDashboards] : null;
      const dashboards = [];
      for (const id of [...(addedDashboards || []), ...(heldDashList || [])]) {
        const entry = dashboardEntry(id);
        if (entry && !dashboards.includes(entry.dashboard)) dashboards.push(entry.dashboard);
      }
      const withheldTables = activeTables();
      const withheldDashboards = activeDashboards();
      const unknownTables = !tables.length && !!existingApp && !heldList && withheldTables.length > 0;
      const unknownDashboards = !dashboards.length && !!existingApp && !heldDashList && withheldDashboards.length > 0;
      if (!tables.length && !dashboards.length && !unknownTables && !unknownDashboards) return { ok: true };
      const hit = tables.length ? tables : unknownTables ? withheldTables : [];
      const hitDashboards = dashboards.length ? dashboards : unknownDashboards ? withheldDashboards : [];
      const blockedBy = [];
      const note = (entry) => {
        skip(entry, APP_WRITE);
        for (const label of entry.blockedBy) if (!blockedBy.includes(label)) blockedBy.push(label);
      };
      for (const t of hit) note(withholdEntry(t));
      for (const d of hitDashboards) note(dashboardEntry(d));
      const verdict = { ok: false, tables: hit, unknownHoldings: unknownTables || unknownDashboards, blockedBy };
      if (hitDashboards.length) verdict.dashboards = hitDashboards;
      return verdict;
    },
  };

  // A request a pinned create stops (pinCreate), or null to go on. A request is read as the transport carries it, text
  // (makeRequest's { method, url, headers, body }). The one request a pin lets through is the row's create, e.g.
  //   POST https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries?$select=savedqueryid
  //   {"name":"Declared Items","fetchxml":"<fetch …>","layoutxml":"<grid …>","returnedtypecode":"contoso_item","querytype":0,"savedqueryid":"a1d1e2a3-…"}
  // and every other write that touches the row is refused, among them the PATCH the SDK pushes instead once another process
  // has saved the draft:
  //   PATCH https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(a1d1e2a3-…)?$select=savedqueryid
  // Reads (GET, HEAD) are never stopped: they change nothing, and the push and the proof read the row.
  function screenPins(req) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (READ_METHODS.has(method)) return null;
    const path = pinPathOf(req && req.url);
    const text = bodyText(req && req.body);
    for (const pin of pins) {
      const why = path !== undefined && BATCH_ENDPOINT.test(path)
        ? screenPinnedBatch(pin, text, headerValue(req && req.headers, 'content-type'))
        : screenPinnedWrite(pin, method, path, text, false);
      if (why) return refusePin(pin, why);
    }
    return null;
  }

  // The 409 a pinned create is refused with, before the transport: a final status (lib/retry-policy.js), so the client
  // does not send it again, and the attempt send observer inside the gate never counts it as dispatched.
  function refusePin(pin, what) {
    pin.refused = true;
    return {
      statusCode: 409,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: { code: 'create-local-draft-changed', message: `${what} at ${pin.id} was not sent: the create of that row is pinned to the draft this build made` } }),
    };
  }

  function isPublish(req) {
    if (String((req && req.method) || 'GET').toUpperCase() !== 'POST') return false;
    const path = pathnameOf(req.url);
    if (PUBLISH_XML.test(path) || PUBLISH_ALL_XML.test(path)) return true;
    if (!BATCH.test(path)) return false;
    const text = bodyText(req.body);
    return text === null || /Publish(?:All)?Xml/i.test(text);
  }

  // A publish request inside a send permit: screened past the permit's own hold only, sent at most once, with the
  // dispatch recorded by `onDispatch` at the moment it is sent. Before anything else, its complete publish target set
  // must be exactly the permit's one scope (permitTargets): a publish of everything, of another scope, of the scope plus
  // anything more, or a request whose targets cannot be read is refused unsent — `onRefused()` is told, `onDispatch`
  // never runs, and every later publish request under the permit is refused too. A request that would not publish the
  // permit's own scope (something else withholds it) is not sent at all — not even the rest of it — so the publication
  // is either sent whole or recorded withheld, never half of each.
  function permitted(permit, req, request) {
    if (permit.dispatched) return Promise.resolve(withheldAnswer(false, `a second publish request of the managed publication of ${permit.own} was not sent: it is sent once`));
    const targets = permit.refused ? null : permitTargets(req);
    if (!targets || targets.length !== 1 || targets[0] !== permit.own) {
      if (!permit.refused && typeof permit.onRefused === 'function') permit.onRefused();
      permit.refused = true;
      return Promise.resolve(refusedAnswer(`a publish request under the managed publication of ${permit.own} was not sent: it ${targets ? `names ${targets.length ? targets.join(', ') : 'nothing'}` : 'cannot be shown to publish only that scope'}`));
    }
    let screened;
    exceptToken = permit.token;
    exceptRoute = permit.own;
    try {
      screened = anyGated() ? screenPublish(req) : { req, hit: [] };
    } finally {
      exceptToken = null;
      exceptRoute = null;
    }
    if (screened.answer || (screened.hit || []).includes(permit.own)) {
      if (typeof permit.onWithheld === 'function') permit.onWithheld();
      return Promise.resolve(screened.answer || withheldAnswer(false, `the managed publish of ${permit.own} was not sent: it is withheld in this run`));
    }
    try {
      permit.onDispatch();
    } catch (e) {
      return Promise.reject(e);
    }
    permit.dispatched = true;
    return request(screened.req);
  }

  // The complete publish target set of one request, in the names a permit's own scope is written in (`account`,
  // `dashboard <id>`), or null when it cannot be read whole. Only a PublishXml is read; a PublishAllXml publishes
  // everything and a $batch is a change set of parts, so both are null. See parameterTargets for the subset read.
  function permitTargets(req) {
    if (!PUBLISH_XML.test(pathnameOf(req && req.url))) return null;
    let payload = null;
    try {
      payload = JSON.parse(bodyText(req.body));
    } catch {
      return null;
    }
    if (!payload || typeof payload.ParameterXml !== 'string') return null;
    return parameterTargets(payload.ParameterXml);
  }

  // The synchronous check of one request at dispatch (gateRequest). Returns { req } to send (the same
  // object when it names no blocked table or dashboard; `hit` lists what was cut from a PublishXml) or
  // { answer } for a request that is not sent.
  function screenPublish(req) {
    if (String((req && req.method) || 'GET').toUpperCase() !== 'POST') return { req };
    const path = pathnameOf(req.url);
    // Every withheld scope, recorded as skipped at send: the tables by name, the dashboards as `dashboard <id>`.
    const all = () => {
      const names = [];
      for (const t of [...new Set([...activeTables(), ...routedNow()])]) { skip(tableEntry(t), AT_SEND); names.push(t); }
      for (const d of activeDashboards()) { skip(dashboardEntry(d), AT_SEND); names.push(`dashboard ${d}`); }
      return names;
    };
    if (PUBLISH_ALL_XML.test(path)) {
      const tables = all();
      return { answer: withheldAnswer(false, `a publish of every table was not sent: the publish of ${tables.join(', ')} is withheld in this run`) };
    }
    if (BATCH.test(path)) {
      const text = bodyText(req.body);
      if (text === null || !/Publish(?:All)?Xml/i.test(text)) return { req };
      // A change set is sent whole or not at all, so one that publishes a blocked table is not sent.
      const tables = /PublishAllXml/i.test(text) ? all() : namedBlocked(text);
      if (!tables.length) return { req };
      return { answer: withheldAnswer(false, `a batch that publishes ${tables.join(', ')} was not sent: the publish of those tables is withheld in this run`) };
    }
    if (!PUBLISH_XML.test(path)) return { req };
    let payload = null;
    try {
      payload = JSON.parse(bodyText(req.body));
    } catch {
      payload = null;
    }
    if (!payload || typeof payload.ParameterXml !== 'string') {
      // Unreadable, so it cannot be shown not to name a blocked table: fail closed.
      const tables = all();
      return { answer: withheldAnswer(false, `a publish request that could not be read was not sent: the publish of ${tables.join(', ')} is withheld in this run`) };
    }
    const hit = [];
    const cutTables = payload.ParameterXml.replace(ENTITY_ELEMENT, (whole, name) => {
      const entry = tableEntry(name);
      if (!entry) return whole;
      skip(entry, AT_SEND);
      if (!hit.includes(entry.table)) hit.push(entry.table);
      return '';
    });
    const cut = cutTables.replace(DASHBOARD_ELEMENT, (whole, id) => {
      const entry = dashboardEntry(id);
      if (!entry) return whole;
      skip(entry, AT_SEND);
      if (!hit.includes(`dashboard ${entry.dashboard}`)) hit.push(`dashboard ${entry.dashboard}`);
      return '';
    });
    if (!hit.length) return { req, hit };
    const xml = cut.replace(/<entities>\s*<\/entities>/gi, '').replace(/<dashboards>\s*<\/dashboards>/gi, '');
    let rest = xml;
    for (let before = null; before !== rest;) {
      before = rest;
      rest = rest.replace(EMPTY_ELEMENT, '');
    }
    if (!rest.trim()) return { answer: withheldAnswer(true) };
    const body = JSON.stringify({ ...payload, ParameterXml: xml });
    const headers = { ...((req && req.headers) || {}) };
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-length') headers[name] = String(Buffer.byteLength(body));
    return { req: { ...req, headers, body }, hit };
  }

  function namedBlocked(text) {
    const tables = [];
    for (const m of String(text).matchAll(ENTITY_ELEMENT)) {
      const entry = tableEntry(m[1]);
      if (entry && !tables.includes(entry.table)) {
        skip(entry, AT_SEND);
        tables.push(entry.table);
      }
    }
    for (const m of String(text).matchAll(DASHBOARD_ELEMENT)) {
      const entry = dashboardEntry(m[1]);
      if (entry && !tables.includes(`dashboard ${entry.dashboard}`)) {
        skip(entry, AT_SEND);
        tables.push(`dashboard ${entry.dashboard}`);
      }
    }
    return tables;
  }

  return barrier;
}

/** The line a build reports for one withheld table or dashboard (an entry of `withheld()`). */
function describeWithheld(entry) {
  const by = (entry.blockedBy || []).join('; ') || 'a declared artifact';
  if (entry.dashboard) {
    return `dashboard ${entry.dashboard} was not published: ${by} did not settle after saving, and a publish of the dashboard would put that saved state live — its saved changes stay saved and unpublished; repair and rerun`;
  }
  return `table ${entry.table} was not published: ${by} ended refused or unknown after saving, and a publish of the table would put that saved state live — its saved changes stay saved and unpublished; repair and rerun`;
}

/** The message of the halt a build raises for an app write checkAppWrite refused (a verdict with ok: false). */
function describeWithheldApp(verdict) {
  const names = [...(verdict.tables || []), ...(verdict.dashboards || []).map((d) => `dashboard ${d}`)];
  const tables = names.join(', ');
  const by = (verdict.blockedBy || []).join('; ') || 'a declared artifact';
  const why = verdict.unknownHoldings
    ? `the forms the app holds could not be read, so it may hold a form of ${tables}`
    : `the app holds, or this write of it adds, a form of ${tables}`;
  return `the app was not written or published: ${why}, whose publish is withheld because ${by} ended refused or unknown after saving. An app publish puts the saved changes of the forms it holds live ahead of their table's publish, which would leave them unpublished for good. Everything saved stays saved and unpublished; repair and rerun`;
}

module.exports = { createPublicationBarrier, describeWithheld, describeWithheldApp };
