'use strict';
// The send-once request boundary of a protected create set (configuration rows, keyed commands).
//
// The plugin's HTTP client is made once per invocation (build-model-app.js makeSdk) and asks ONE gate before every
// request (lib/sdk-http-client.js createAzHttpClient `workflowEffectGate.screen`):
//   screen({ method, url, body, headers }) -> throw to refuse the request unsent, null to let it pass as any other, or a
//   send handle { dispatching(), answered(res) } that makes the request send-once: `dispatching()` runs synchronously
//   right before the send (a throw leaves it unsent) and `answered(res)` gets { statusCode, headers, body } or { error }.
// This module is that gate for the managed-binding row protocol (lib/managed-bindings.js `rowProtocol`):
//   - createDeferredManagedCreateGate() is made with the client, before the store is open, and bound ONCE to the
//     invocation's store later (as lib/deferred-workflow-gate.js is for workflow effects);
//   - runWithManagedCreateSet(set, fn) runs `fn` (the SDK operation) inside the scope of the attempts the set prepared
//     and marked sending; only inside such a scope does the gate do anything. Outside one it is inert (null), so every
//     build without a protected set sends exactly what it always sent;
//   - composeWriteGates(...gates) lets this gate and the workflow effect gate share the client's one gate slot.
// Inside a scope, every mutation must be one the driver's classifier names as a prepared row request or completion
// effect of the set; the row protocol is sealed and marked dispatched under the store's lease BEFORE the request leaves
// (managed-bindings.js sealRowDispatch / markRowEffectDispatch). Everything else that writes is refused unsent:
//   - an unbound gate, or a scope over another store (a wiring fault: there is no ungated or random-id fallback);
//   - any DELETE (a protected scope never removes a row; the set names the code, e.g.
//     configuration-protected-removal-unsupported);
//   - a `$batch` (no reviewed parser proves every constituent belongs to the set; v1 does not support them);
//   - a mutation the classifier does not recognise, a token outside the set, a row the protocol does not name under
//     that id and parent, or a row or effect already sent once in this scope or by an earlier run.
// Response facts are kept in memory only, per row and effect (see answerOf); they are evidence a driver turns into
// receipts after a fresh read (lib/managed-create-context.js), never a binding by themselves.
// Every local refusal or store failure is also recorded in the scope: the SDK may catch the thrown error and report its
// own (or nothing), so runWithManagedCreateSet answers the FIRST local failure as `localError`, and a caller must surface
// it as the typed local failure it is — never as a network error to retry, and never as a saved result.

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { canonicalJson, normalizeGuid } = require('./reconcile-common.js');
const { apiPath } = require('./workflow-effect-context.js');

const MISMATCH = 'managed-create-request-mismatch';
const HEX64 = /^[0-9a-f]{64}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_@.]{0,127}$/;
const als = new AsyncLocalStorage();

function mismatch(message, code = MISMATCH) {
  return Object.assign(new Error(message), { code });
}

const isRead = (method) => method === 'GET' || method === 'HEAD';

/**
 * The non-private projection a request carries for one row, as sealRowDispatch keeps it: the sorted field names and the
 * sha256 of the canonical JSON of those fields. A driver passes only the fields it may record (never a secret value or
 * a connection id); `fields` is a plain object of field name -> value.
 */
function sentProjection(fields) {
  const sentFields = Object.keys(fields || {}).sort();
  const picked = Object.fromEntries(sentFields.map((k) => [k, fields[k]]));
  return { sentFields, sentSha256: crypto.createHash('sha256').update(canonicalJson(picked), 'utf8').digest('hex') };
}

// The identity evidence of one answer to a create, in the three places the Web API may put it:
//   OData-EntityId: https://contoso.crm.dynamics.com/api/data/v9.2/customapis(5e4a0b1c-0000-4000-8000-000000000001)
//   Location:       the same URL (some gateways send it instead, or as well)
//   the body, under Prefer: return=representation: { "customapiid": "5e4a…", "CustomAPIRequestParameters": [{ … }] }
// EVERY value supplied must agree with the row the request prepared, never just the first one found. A header is read
// from any spelling of its name; Node folds a repeated header into one value joined by ", ", and some transports hand
// an array instead, so a comma or a second value is two identities, which cannot be told apart: unknown. An alternate-key
// URL — customapis(uniquename='contoso_api') — names no GUID, so it proves nothing about the id that was saved: unknown.
// A body is read only for the expected primary-key field and the children the descriptor names (never for any GUID in
// it: a lookup carries another row's id). A body whose key appears twice in its text (JSON.parse keeps the last one),
// that is not JSON, not an object or an OData error envelope is unknown.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-entity-web-api
const IDENTITY_HEADERS = ['odata-entityid', 'location'];
const KEYED_URL = /^([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)$/;

function headerIdentities(headers) {
  const out = [];
  let ambiguous = false;
  for (const name of IDENTITY_HEADERS) {
    const values = [];
    for (const [k, v] of Object.entries(headers || {})) {
      if (k.toLowerCase() !== name || v === null || v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) values.push(String(one));
    }
    if (values.length > 1) ambiguous = true;
    for (const raw of values) {
      if (raw.includes(',')) { ambiguous = true; continue; }
      const m = KEYED_URL.exec(apiPath(raw) || '');
      out.push(m ? { table: m[1].toLowerCase(), inner: m[2] } : { table: null, inner: null });
    }
  }
  return { ids: out, ambiguous };
}

function bodyOf(raw) {
  if (raw === undefined || raw === null) return { empty: true };
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return { empty: false, json: raw, text: null };
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!text.trim()) return { empty: true };
  try { return { empty: false, json: JSON.parse(text), text }; } catch { return { empty: false, json: undefined, text }; }
}

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What one answer says about a send-once request, kept in memory only:
 *   acknowledged  a 2xx (never a 202, which only says the request was queued) whose every identity agrees with the
 *                 request: each OData-EntityId and Location header names the expected table and row, the body's
 *                 primary key is the expected one, and each child the descriptor names is found once in the body under
 *                 its own expected id. An answer with no identity at all acknowledges only as the empty 204 the Web API
 *                 documents for a create without return=representation;
 *   conflict      a 2xx whose well-formed identity names ANOTHER row or table: the service did not save the row the
 *                 request prepared, and it is never taken as a receipt. It wins over anything unknown in the same answer;
 *   unknown       no status, a transport error (the request may still have been applied), any non-2xx or 202 answer, or
 *                 identity evidence that is malformed, duplicated, ambiguous or incomplete.
 * `expect`: null for a completion effect (only its status is read); otherwise { id, table?, key?, children? } — the
 * row the request prepared, its entity set and primary-key field, and [{ id, at, key, match }] for each deep-insert
 * child to find in the body's `at` array by its `match` fields. A string is taken as { id }.
 * A non-2xx answer is not treated as "not started" here: only a fresh read decides what is there.
 */
function answerOf(res, expect) {
  const status = res && Number.isInteger(res.statusCode) ? res.statusCode : res && Number.isInteger(res.status) ? res.status : null;
  if (!res || res.error || status === null) return { outcome: 'unknown', status };
  if (status < 200 || status >= 300) return { outcome: 'unknown', status };
  if (expect === null || expect === undefined) return { outcome: 'acknowledged', status };
  const want = typeof expect === 'string' ? { id: expect } : expect;
  const wantId = want.id ? normalizeGuid(want.id) : null;
  const table = typeof want.table === 'string' ? want.table.toLowerCase() : null;
  let conflict = false;
  let unknown = status === 202;
  let seen = 0;
  let answeredId;
  const compare = (id) => {
    seen += 1;
    if (!id) { unknown = true; return; }
    if (answeredId === undefined || id !== wantId) answeredId = id;
    if (wantId && id !== wantId) conflict = true;
  };
  const headers = headerIdentities(res.headers);
  if (headers.ambiguous) unknown = true;
  for (const h of headers.ids) {
    if (h.table === null) { seen += 1; unknown = true; continue; }
    if (table && h.table !== table) { seen += 1; conflict = true; continue; }
    // customapis(<guid>) or, as some answers spell it, customapis(customapiid=<guid>); any other name=value is an
    // alternate key and names no id.
    const named = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(h.inner);
    if (named && !(want.key && named[1].toLowerCase() === String(want.key).toLowerCase())) { seen += 1; unknown = true; continue; }
    compare(normalizeGuid(named ? named[2] : h.inner));
  }
  const body = bodyOf(res.body);
  if (!body.empty) {
    if (!isPlain(body.json) || body.json.error !== undefined) {
      unknown = true;
    } else if (want.key) {
      const key = String(want.key);
      if (body.text !== null && (body.text.match(new RegExp(`"${escapeRe(key)}"\\s*:`, 'g')) || []).length > 1) unknown = true;
      if (Object.prototype.hasOwnProperty.call(body.json, key)) compare(typeof body.json[key] === 'string' ? normalizeGuid(body.json[key]) : null);
      for (const c of want.children || []) {
        const list = body.json[c.at];
        if (list === undefined) continue;
        if (!Array.isArray(list)) { unknown = true; continue; }
        const found = list.filter((x) => isPlain(x) && Object.entries(c.match).every(([f, v]) => x[f] === v));
        if (found.length !== 1) { unknown = true; continue; }
        const raw = found[0][c.key];
        const id = typeof raw === 'string' ? normalizeGuid(raw) : null;
        if (!id) unknown = true;
        else if (id !== normalizeGuid(c.id)) conflict = true;
      }
    }
  }
  if (seen === 0 && !(status === 204 && body.empty)) unknown = true;
  const extra = answeredId ? { answeredId } : {};
  if (conflict) return { outcome: 'conflict', status, ...extra };
  if (unknown) return { outcome: 'unknown', status, ...extra };
  return { outcome: 'acknowledged', status, ...extra };
}

// The persisted attempt of `token` as the store last read or wrote it. The store re-checks everything under its lease
// when the request is sealed; this pre-check only refuses early, before any write.
function attemptOf(store, token) {
  const snap = store.snapshot();
  const a = snap && snap.envelope ? snap.envelope.attempts.find((x) => x.token === token) : null;
  if (!a || !a.rowProtocol) throw mismatch('the request names an attempt the store does not hold with a row protocol; it was not sent');
  return a;
}

function checkRows(scope, store, c) {
  if (!Array.isArray(c.rows) || c.rows.length === 0) throw mismatch('a row request names no row; it was not sent');
  const a = attemptOf(store, c.token);
  const rows = c.rows.map((r) => {
    if (!r || typeof r.kind !== 'string' || typeof r.key !== 'string') throw mismatch('a row request names a row without a kind and key; it was not sent');
    const id = normalizeGuid(r.id);
    const parentId = r.parentId === null || r.parentId === undefined ? null : normalizeGuid(r.parentId);
    const p = a.rowProtocol.rows.find((x) => x.kind === r.kind && x.key === r.key);
    const what = `the ${r.kind} "${r.key}" of the managed ${a.family} "${a.key}"`;
    if (!p || !id || p.id !== id) throw mismatch(`${what} is not prepared under the id ${r.id}; the request was not sent`);
    if ((p.parentId || null) !== parentId) throw mismatch(`${what} is sent under another parent than the one prepared; the request was not sent`);
    if (p.dispatched || scope.sent.has(`row\u0000${c.token}\u0000${id}`)) throw mismatch(`${what} was already sent once; it is not sent again`);
    if (!Array.isArray(r.sentFields) || !r.sentFields.every((f) => typeof f === 'string' && FIELD_NAME.test(f)) || !HEX64.test(String(r.sentSha256))) {
      throw mismatch(`${what} has no sealed projection of the request; it was not sent`);
    }
    if (r.answer !== undefined && !(isPlain(r.answer) && typeof r.answer.at === 'string' && FIELD_NAME.test(r.answer.at) && FIELD_NAME.test(String(r.answer.key)) && isPlain(r.answer.match) && Object.keys(r.answer.match).length > 0)) {
      throw mismatch(`${what} names no usable place to find it in the answer; the request was not sent`);
    }
    return { kind: r.kind, key: r.key, id, sentFields: [...new Set(r.sentFields)].sort(), sentSha256: r.sentSha256, mode: p.mode, ...(r.answer ? { answer: r.answer } : {}) };
  });
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw mismatch('a row request names one row twice; it was not sent');
  // Every identity an answer may carry is compared with the row the request prepared (answerOf), so the classifier
  // must say which table and primary-key field that row is: without them, a body or header naming another row could
  // not be told from one naming this row.
  if (typeof c.expectTable !== 'string' || !FIELD_NAME.test(c.expectTable) || typeof c.expectKey !== 'string' || !FIELD_NAME.test(c.expectKey)) {
    throw mismatch('a row request does not name the table and primary key its answer is read against; it was not sent');
  }
  return rows;
}

function rowHandle(scope, store, entry, c, rows) {
  for (const r of rows) scope.sent.add(`row\u0000${c.token}\u0000${r.id}`);
  const expectId = c.expectId === undefined ? rows[0].id : c.expectId === null ? null : normalizeGuid(c.expectId);
  const expect = { id: expectId, table: c.expectTable, key: c.expectKey, children: rows.filter((r) => r.answer).map((r) => ({ id: r.id, ...r.answer })) };
  const state = { dispatched: false, answered: false };
  const fact = (a) => rows.map((r) => ({ type: 'row', token: c.token, kind: r.kind, key: r.key, id: r.id, mode: r.mode, ...a }));
  scope.handles.push(() => (state.dispatched && !state.answered ? fact({ outcome: 'unknown', status: null, unanswered: true }) : []));
  return {
    dispatching() {
      guard(scope, () => {
        if (state.dispatched) throw mismatch('a send-once row request was about to be sent a second time; it was not sent');
        if (scope.closed) throw mismatch('a row request was sent after its create set ended; it was not sent');
        store.sealRowDispatch({ token: c.token, epoch: entry.epoch, rows: rows.map(({ kind, key, id, sentFields, sentSha256 }) => ({ kind, key, id, sentFields, sentSha256 })) });
        state.dispatched = true;
      });
    },
    answered(res) {
      // One answer per send: a second one (a transport that reports twice) adds nothing the first did not say.
      if (state.answered || scope.closed) return;
      state.answered = true;
      // The answer is to the whole request: a deep insert is one transaction, so every row it carried shares it.
      scope.facts.push(...fact(answerOf(res, expect)));
    },
  };
}

function effectHandle(scope, store, entry, c) {
  const id = normalizeGuid(c.id);
  if (c.kind !== 'membership' && c.kind !== 'rule-state') throw mismatch(`a completion effect of kind ${c.kind} is not one a create set prepares; it was not sent`);
  if (!id) throw mismatch('a completion effect names no row id; it was not sent');
  const a = attemptOf(store, c.token);
  const e = a.rowProtocol.effects.find((x) => x.kind === c.kind && x.id === id);
  if (!e) throw mismatch(`the ${c.kind} of ${id} is not an effect the managed ${a.family} "${a.key}" prepared; it was not sent`);
  const k = `effect\u0000${c.token}\u0000${c.kind}\u0000${id}`;
  if (e.dispatched || scope.sent.has(k)) throw mismatch(`the ${c.kind} of ${id} was already sent once; it is not sent again`);
  scope.sent.add(k);
  const state = { dispatched: false, answered: false };
  scope.handles.push(() => (state.dispatched && !state.answered ? [{ type: 'effect', token: c.token, kind: c.kind, id, outcome: 'unknown', status: null, unanswered: true }] : []));
  return {
    dispatching() {
      guard(scope, () => {
        if (state.dispatched) throw mismatch('a send-once completion effect was about to be sent a second time; it was not sent');
        if (scope.closed) throw mismatch('a completion effect was sent after its create set ended; it was not sent');
        store.markRowEffectDispatch({ token: c.token, epoch: entry.epoch, kind: c.kind, id });
        state.dispatched = true;
      });
    },
    answered(res) {
      if (state.answered || scope.closed) return;
      state.answered = true;
      scope.facts.push({ type: 'effect', token: c.token, kind: c.kind, id, ...answerOf(res, null) });
    },
  };
}

// Run `fn`; a throw is recorded as the scope's local failure before it propagates (into the SDK, which may swallow it).
function guard(scope, fn) {
  try {
    return fn();
  } catch (e) {
    latch(scope, e);
    throw e;
  }
}
// Keep `e` as one of the scope's local failures; the first one kept is the one the scope answers (localError).
function latch(scope, e) {
  if (!scope.errors.includes(e)) scope.errors.push(e);
}

/**
 * The deferred gate of one invocation: { screen(req), bind(store), boundTo(store) }. Inert outside a create-set scope;
 * inside one, unbound or bound to another store, every mutation is refused unsent (managed-create-request-mismatch).
 * Bound at most once, to the invocation's one store: a second, different store is a wiring fault and is refused.
 */
function createDeferredManagedCreateGate() {
  let store = null;
  return {
    screen({ method, url, body, headers } = {}) {
      const scope = als.getStore();
      if (!scope) return null;
      const m = String(method || 'GET').toUpperCase();
      if (isRead(m)) return null;
      return guard(scope, () => {
        if (scope.closed) throw mismatch(`a ${m} was not sent: its create set has ended`);
        if (scope.errors.length) throw mismatch(`a ${m} was not sent: an earlier request of this create set failed locally, and nothing further is sent`);
        if (!store) throw mismatch(`a ${m} was not sent: the managed create gate is not bound to the invocation's binding store`);
        if (scope.store && scope.store !== store) throw mismatch(`a ${m} was not sent: the create set belongs to another binding store than the gate's`);
        if (m === 'DELETE') throw mismatch(`a DELETE was not sent: a protected ${scope.label} never removes a row`, scope.deleteCode);
        if (m === 'POST' && apiPath(url) === '$batch') throw mismatch(`a $batch was not sent: a protected ${scope.label} sends each change on its own`);
        const c = scope.classify({ method: m, url, body, headers });
        if (!c) throw mismatch(`a ${m} was not sent: it is not a change the protected ${scope.label} prepared`);
        const entry = scope.entries.get(c.token);
        if (!entry) throw mismatch(`a ${m} was not sent: it names an attempt outside this create set`);
        if (c.type === 'rows') return rowHandle(scope, store, entry, c, checkRows(scope, store, c));
        if (c.type === 'effect') return effectHandle(scope, store, entry, c);
        throw mismatch(`a ${m} was not sent: the classifier answered an unknown request type`);
      });
    },
    bind(next) {
      if (!next || typeof next.snapshot !== 'function' || typeof next.sealRowDispatch !== 'function') throw new TypeError('the managed create gate binds to a managed binding store');
      if (store === next) return;
      if (store) throw new Error('the managed create gate is already bound to another managed binding store');
      store = next;
    },
    boundTo(candidate) {
      return Boolean(store) && store === candidate;
    },
  };
}

/**
 * Run `fn` (the SDK operation of a protected create set) inside its request scope:
 *   set = {
 *     store,                        the store the gate must be bound to (checked at each mutation);
 *     entries: [{ token, epoch }],  what markAttemptSetSending answered (the attempts this scope may send under);
 *     classify(req) -> descriptor,  the driver's classifier of one mutation { method, url, body, headers }:
 *         { type: 'rows', token, rows: [{ kind, key, id, parentId, sentFields, sentSha256, answer? }], expectTable, expectKey, expectId? }
 *             one request carrying those rows (a deep insert carries a root and its children). `expectTable` is the
 *             entity set the request's own row is answered under (customapis) and `expectKey` its primary-key field
 *             (customapiid); `expectId` is the id an answer must name (default: the first row's; null: none). A child
 *             the body returns names where it is found: answer: { at: '<navigation property>', key: '<its primary key>',
 *             match: { <field>: <value>, ... } }. See answerOf;
 *         { type: 'effect', token, kind: 'membership' | 'rule-state', id }
 *         null for anything else (refused);
 *     deleteCode?,                  the code a DELETE is refused with (default managed-create-request-mismatch);
 *     label?,                       how messages name the set (default 'create set');
 *   }
 * Answers { value, error, localError, facts } and never throws for `fn`: `error` is what `fn` threw (or null), `localError`
 * the first local refusal or store failure inside the scope (or null) — the one to surface when set — and `facts` the
 * in-memory answers [{ type: 'row', token, kind, key, id, mode, outcome, status, answeredId? } | { type: 'effect', token,
 * kind, id, outcome, status }]; a request dispatched and not answered when `fn` settled is an `unknown` fact with
 * `unanswered: true`. The scope closes when `fn` settles: a request it left running is refused after that, and an
 * answer that arrives after it is not read.
 */
async function runWithManagedCreateSet(set, fn) {
  if (!set || typeof set.classify !== 'function' || !Array.isArray(set.entries) || set.entries.length === 0) throw new TypeError('runWithManagedCreateSet needs the set\'s entries and its classifier');
  if (typeof fn !== 'function') throw new TypeError('runWithManagedCreateSet needs the operation to run');
  const entries = new Map();
  for (const e of set.entries) {
    if (!e || typeof e.token !== 'string' || entries.has(e.token)) throw new TypeError('runWithManagedCreateSet entries are distinct { token, epoch }');
    entries.set(e.token, { token: e.token, epoch: e.epoch === undefined ? null : e.epoch });
  }
  const scope = {
    store: set.store || null, entries, classify: set.classify, deleteCode: set.deleteCode || MISMATCH, label: set.label || 'create set',
    sent: new Set(), facts: [], errors: [], handles: [], closed: false,
  };
  let value;
  let error = null;
  try {
    value = await als.run(scope, fn);
  } catch (e) {
    error = e;
  }
  scope.closed = true;
  // A request that was dispatched and never answered before the operation settled (the SDK did not await it, or its
  // answer was lost) may still be applied: it is an unknown fact, never silence a later check could read as success.
  for (const pending of scope.handles) scope.facts.push(...pending());
  return { value, error, localError: scope.errors[0] || null, facts: scope.facts.slice() };
}

/** Is the caller inside a protected create-set scope? */
function inManagedCreateSet() {
  return Boolean(als.getStore());
}

/**
 * One gate for the client's one slot, from several (null entries are skipped). Every gate is asked; a throw from any
 * refuses the request unsent; a request two gates both claim (two send handles) is refused unsent — it would have two
 * owners; otherwise the one handle, or null. A request no gate claims is sent exactly as before.
 * Inside a protected create-set scope the WHOLE composed boundary is latched: whichever gate throws, in whatever order
 * the gates were composed (the workflow effect gate's refusal included), and a claimed handle's `dispatching()` refusal,
 * the first error is kept as the scope's local failure before it is rethrown. The SDK catches what the client throws and
 * may report a result of its own; without the latch, a request refused here could leave a scope that reads as saved.
 * Outside a scope nothing is latched and every gate and handle is used exactly as it was.
 */
function composeWriteGates(...gates) {
  const list = gates.filter(Boolean);
  for (const g of list) if (typeof g.screen !== 'function') throw new TypeError('composeWriteGates takes gates with a screen()');
  const screenAll = (req) => {
    let handle = null;
    for (const g of list) {
      const h = g.screen(req);
      if (!h) continue;
      if (handle) {
        const m = String((req && req.method) || 'GET').toUpperCase();
        throw mismatch(`a ${m} was not sent: two write gates both claim it`);
      }
      handle = h;
    }
    return handle;
  };
  return {
    screen(req) {
      const scope = als.getStore();
      if (!scope) return screenAll(req);
      let handle;
      try {
        handle = screenAll(req);
      } catch (e) {
        latch(scope, e);
        throw e;
      }
      if (!handle) return handle;
      const latched = Object.create(handle);
      latched.dispatching = (...args) => {
        try {
          return handle.dispatching(...args);
        } catch (e) {
          latch(scope, e);
          throw e;
        }
      };
      return latched;
    },
  };
}

module.exports = {
  MISMATCH,
  createDeferredManagedCreateGate,
  runWithManagedCreateSet,
  composeWriteGates,
  inManagedCreateSet,
  sentProjection,
  answerOf,
};
