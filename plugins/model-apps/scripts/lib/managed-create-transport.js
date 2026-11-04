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
const { apiPath, headerValue } = require('./workflow-effect-context.js');

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

// The id the service says a write answered, from its OData-EntityId (or Location) header, e.g.
//   OData-EntityId: https://contoso.crm.dynamics.com/api/data/v9.2/customapis(5e4a0b1c-0000-4000-8000-000000000001)
// An alternate-key answer names no GUID — customapis(uniquename='contoso_api') — and is answered as null: it carries no
// id, so it neither confirms nor contradicts the one the request sent.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-entity-web-api
function answeredId(headers) {
  const raw = headerValue(headers, 'odata-entityid') || headerValue(headers, 'location');
  if (!raw) return null;
  const p = apiPath(raw);
  const m = p ? /\(([^()]*)\)\s*$/.exec(p) : null;
  return m ? normalizeGuid(m[1].replace(/^[a-z_]+id=/i, '')) : null;
}

/**
 * What one answer says about a send-once request, kept in memory only:
 *   acknowledged  a 2xx whose answer names no other id than the one expected (none named counts: a 204 with an
 *                 alternate-key header is a documented caller-key answer);
 *   conflict      a 2xx that names ANOTHER id: the service did not save the row the request prepared, and it is never
 *                 taken as a receipt;
 *   unknown       no status, a transport error (the request may still have been applied), or any non-2xx answer.
 * A non-2xx answer is not treated as "not started" here: only a fresh read decides what is there.
 */
function answerOf(res, expectId) {
  const status = res && Number.isInteger(res.statusCode) ? res.statusCode : res && Number.isInteger(res.status) ? res.status : null;
  if (!res || res.error || status === null) return { outcome: 'unknown', status };
  if (status < 200 || status >= 300) return { outcome: 'unknown', status };
  const id = answeredId(res.headers);
  if (id && expectId && id !== expectId) return { outcome: 'conflict', status, answeredId: id };
  return { outcome: 'acknowledged', status, ...(id ? { answeredId: id } : {}) };
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
    return { kind: r.kind, key: r.key, id, sentFields: [...new Set(r.sentFields)].sort(), sentSha256: r.sentSha256, mode: p.mode };
  });
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw mismatch('a row request names one row twice; it was not sent');
  return rows;
}

function rowHandle(scope, store, entry, c, rows) {
  for (const r of rows) scope.sent.add(`row\u0000${c.token}\u0000${r.id}`);
  const expectId = c.expectId === undefined ? rows[0].id : c.expectId === null ? null : normalizeGuid(c.expectId);
  let dispatched = false;
  return {
    dispatching() {
      guard(scope, () => {
        if (dispatched) throw mismatch('a send-once row request was about to be sent a second time; it was not sent');
        if (scope.closed) throw mismatch('a row request was sent after its create set ended; it was not sent');
        store.sealRowDispatch({ token: c.token, epoch: entry.epoch, rows: rows.map(({ kind, key, id, sentFields, sentSha256 }) => ({ kind, key, id, sentFields, sentSha256 })) });
        dispatched = true;
      });
    },
    answered(res) {
      const a = answerOf(res, expectId);
      for (const r of rows) scope.facts.push({ type: 'row', token: c.token, kind: r.kind, key: r.key, id: r.id, mode: r.mode, ...a });
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
  let dispatched = false;
  return {
    dispatching() {
      guard(scope, () => {
        if (dispatched) throw mismatch('a send-once completion effect was about to be sent a second time; it was not sent');
        if (scope.closed) throw mismatch('a completion effect was sent after its create set ended; it was not sent');
        store.markRowEffectDispatch({ token: c.token, epoch: entry.epoch, kind: c.kind, id });
        dispatched = true;
      });
    },
    answered(res) {
      scope.facts.push({ type: 'effect', token: c.token, kind: c.kind, id, ...answerOf(res, null) });
    },
  };
}

// Run `fn`; a throw is recorded as the scope's local failure before it propagates (into the SDK, which may swallow it).
function guard(scope, fn) {
  try {
    return fn();
  } catch (e) {
    if (!scope.errors.includes(e)) scope.errors.push(e);
    throw e;
  }
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
 *         { type: 'rows', token, rows: [{ kind, key, id, parentId, sentFields, sentSha256 }], expectId? }
 *             one request carrying those rows (a deep insert carries a root and its children); `expectId` is the id an
 *             answer may name (default: the first row's; null: none), see answerOf;
 *         { type: 'effect', token, kind: 'membership' | 'rule-state', id }
 *         null for anything else (refused);
 *     deleteCode?,                  the code a DELETE is refused with (default managed-create-request-mismatch);
 *     label?,                       how messages name the set (default 'create set');
 *   }
 * Answers { value, error, localError, facts } and never throws for `fn`: `error` is what `fn` threw (or null), `localError`
 * the first local refusal or store failure inside the scope (or null) — the one to surface when set — and `facts` the
 * in-memory answers [{ type: 'row', token, kind, key, id, mode, outcome, status, answeredId? } | { type: 'effect', token,
 * kind, id, outcome, status }]. The scope closes when `fn` settles: a request it left running is refused after that.
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
    sent: new Set(), facts: [], errors: [], closed: false,
  };
  let value;
  let error = null;
  try {
    value = await als.run(scope, fn);
  } catch (e) {
    error = e;
  }
  scope.closed = true;
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
 */
function composeWriteGates(...gates) {
  const list = gates.filter(Boolean);
  for (const g of list) if (typeof g.screen !== 'function') throw new TypeError('composeWriteGates takes gates with a screen()');
  return {
    screen(req) {
      let handle = null;
      for (const g of list) {
        const h = g.screen(req);
        if (!h) continue;
        if (handle) {
          const m = String((req && req.method) || 'GET').toUpperCase();
          const err = mismatch(`a ${m} was not sent: two write gates both claim it`);
          const scope = als.getStore();
          if (scope && !scope.errors.includes(err)) scope.errors.push(err);
          throw err;
        }
        handle = h;
      }
      return handle;
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
