'use strict';

// workflow-effect-context.js — the transport side of a declared business rule's or process flow's workflow write.
//
// A workflow write cannot be told apart by its URL: a rule body update is
//   POST /api/data/v9.2/workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.UpdateProcessWithWfomJson
// whatever the rule, and the row it changes is `body.Entity.workflowid`. So the write is identified by the effect it
// carries out, not by a URL: lib/managed-feature-contract.js `withWorkflowEffect` persists one effect record
// (lib/managed-bindings.js `workflowEffects`) as definitely-unsent and runs the write inside an AsyncLocalStorage
// context that holds that record. The client (lib/sdk-http-client.js, `deps.workflowEffectGate`) asks the gate this
// module builds before every request:
//   - a read (GET, HEAD) always passes with its ordinary retry and spends nothing, even for a row whose earlier
//     write is uncertain: the fresh proof that settles an uncertain write needs those reads;
//   - inside a context, the one mutation that matches the effect (shape, row, body hash or state, `If-Match`) is sent
//     exactly once, marked dispatching before it leaves; any other mutation is refused unsent;
//   - outside a context, a mutation passes as it always did, unless it targets a row whose persisted effect may have
//     been sent and is not yet confirmed.
// Nothing builds a gate or opens a context until a rule or process flow is declared, so no request changes before then.

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { canonicalJson, normalizeGuid } = require('./reconcile-common.js');

const MISMATCH = 'managed-workflow-effect-mismatch';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const UNCERTAIN = new Set(['dispatching', 'unconfirmed']);
// The state a `state` effect asks for, as the workflow row's statecode/statuscode pair.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/workflow#statecode-choicesstates
const WORKFLOW_STATES = Object.freeze({
  Draft: Object.freeze({ statecode: 0, statuscode: 1 }),
  Active: Object.freeze({ statecode: 1, statuscode: 2 }),
});

const als = new AsyncLocalStorage();

function mismatch(message) {
  return Object.assign(new Error(message), { code: MISMATCH });
}

/** The sha256 a `create` or `body` effect records as `desiredSha256`: of the canonical JSON of the request body. */
function requestBodySha256(body) {
  return crypto.createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

/** The effect record of the context the caller runs in, or null. */
function currentWorkflowEffect() {
  const ctx = als.getStore();
  return ctx ? ctx.effect : null;
}

/** Run `fn` inside the context of the persisted effect `effect` (a workflowEffects record). */
function runWithWorkflowEffect(effect, fn) {
  return als.run({ effect: Object.freeze({ ...effect, request: Object.freeze({ ...effect.request }) }), sends: 0 }, fn);
}

function headerValue(headers, name) {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return v == null ? null : String(v);
  return null;
}

function parseJson(text) {
  if (text == null) return null;
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  if (!s.trim()) return null;
  try { return JSON.parse(s); } catch { return undefined; }
}

// The Web API path after the version segment: `https://contoso.crm.dynamics.com/api/data/v9.2/workflows(…)` -> `workflows(…)`.
function apiPath(url) {
  let p;
  try { p = new URL(url, 'https://contoso.crm.dynamics.com').pathname; } catch { return null; }
  const m = /\/api\/data\/v\d+(?:\.\d+)?\/(.*)$/i.exec(p);
  return decodeURIComponent(m ? m[1] : p.replace(/^\//, ''));
}

const keyOf = (raw) => normalizeGuid(String(raw).replace(/^workflowid=/i, ''));

/**
 * Classify one mutation against the frozen workflow shapes. Answers { shape, row, body } for a workflow mutation
 * that is one of them, { shape: null, row } for one that touches a workflow row in another way (row may be null), or
 * null for a request that touches no workflow row. `body` is the parsed JSON body (undefined when not JSON).
 */
function classify(method, url, rawBody) {
  const p = apiPath(url);
  if (p === null) return { shape: null, row: null };
  const body = parseJson(rawBody);
  let m = /^workflows\(([^)]*)\)\/Microsoft\.Dynamics\.CRM\.(CreateProcessWithWfomJson|UpdateProcessWithWfomJson)$/i.exec(p);
  if (m) {
    const row = body && body.Entity ? normalizeGuid(body.Entity.workflowid) || null : null;
    if (method !== 'POST' || keyOf(m[1]) !== ZERO_GUID) return { shape: null, row };
    return { shape: /^Create/i.test(m[2]) ? 'rule-create' : 'rule-update', row, body };
  }
  if (/^workflows$/i.test(p)) {
    const row = body ? normalizeGuid(body.workflowid) || null : null;
    return method === 'POST' ? { shape: 'bpf-create', row, body } : { shape: null, row };
  }
  m = /^workflows\(([^)]*)\)(\/.*)?$/i.exec(p);
  if (m) {
    const row = keyOf(m[1]) || null;
    return method === 'PATCH' && !m[2] ? { shape: 'workflow-patch', row, body } : { shape: null, row };
  }
  return null;
}

// The parts of a `$batch` body (OData multipart/mixed, change sets nested in it), e.g.:
//   --batch_1
//   Content-Type: multipart/mixed; boundary=changeset_1
//
//   --changeset_1
//   Content-Type: application/http
//   Content-Transfer-Encoding: binary
//   Content-ID: 1
//
//   PATCH https://contoso.crm.dynamics.com/api/data/v9.2/workflows(<id>) HTTP/1.1
//   Content-Type: application/json
//   If-Match: W/"3"
//
//   {"statecode":1,"statuscode":2}
//   --changeset_1--
//   --batch_1--
// Every line that starts with `--` is a boundary of the batch or of a change set; a segment with an HTTP request
// line is one part. Its headers run to the first blank line, and its body is the rest of the segment.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api
function batchParts(rawBody) {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody == null ? '' : rawBody);
  const segments = text.split(/\r?\n(?=--)/).map((s) => s.replace(/^--[^\r\n]*\r?\n?/, ''));
  const parts = [];
  for (const seg of segments) {
    const lines = seg.split(/\r?\n/);
    const at = lines.findIndex((l) => /^(GET|HEAD|POST|PATCH|PUT|DELETE)\s+\S+\s+HTTP\/1\.[01]\s*$/i.test(l));
    if (at < 0) continue;
    const [, method, url] = /^(\S+)\s+(\S+)/.exec(lines[at]);
    const headers = {};
    let i = at + 1;
    for (; i < lines.length && lines[i].trim() !== ''; i++) {
      const c = lines[i].indexOf(':');
      if (c > 0) headers[lines[i].slice(0, c).trim()] = lines[i].slice(c + 1).trim();
    }
    parts.push({ method: method.toUpperCase(), url, headers, body: lines.slice(i + 1).join('\n').trim() || null });
  }
  return parts;
}

const isRead = (method) => method === 'GET' || method === 'HEAD';

function uncertainRows(store) {
  const rows = new Set();
  for (const e of store.snapshot().envelope.workflowEffects) if (UNCERTAIN.has(e.state)) rows.add(e.rowId);
  return rows;
}

// Does the classified mutation `c` (with its If-Match) carry out the effect `effect` exactly?
function matches(effect, c, ifMatch) {
  if (!c || !c.shape) return 'it is not one of the workflow write shapes';
  if (c.shape !== effect.request.shape) return `it is a ${c.shape}, not the effect's ${effect.request.shape}`;
  if (c.row !== effect.rowId) return 'it targets another workflow row';
  if (effect.effect === 'state') {
    const want = WORKFLOW_STATES[effect.desiredState];
    const keys = c.body && typeof c.body === 'object' ? Object.keys(c.body).sort() : null;
    if (!want || !keys || keys.join(',') !== 'statecode,statuscode' || c.body.statecode !== want.statecode || c.body.statuscode !== want.statuscode) {
      return 'its body is not exactly the state the effect asks for';
    }
  } else if (c.body === undefined || c.body === null || requestBodySha256(c.body) !== effect.desiredSha256) {
    return 'its body is not the one the effect records';
  }
  if ((effect.expectedVersion || null) !== (ifMatch || null)) return 'its If-Match is not the version the effect records';
  return null;
}

/**
 * The gate the client asks before each request (`deps.workflowEffectGate` of createAzHttpClient). `store` is the
 * managed binding handle (lib/managed-bindings.js) that holds the effects.
 */
function createWorkflowEffectGate({ store } = {}) {
  if (!store || typeof store.snapshot !== 'function') throw new TypeError('createWorkflowEffectGate: a managed binding store is required');

  function refuseUncertain(rows, what) {
    const uncertain = uncertainRows(store);
    for (const row of rows) {
      if (row && uncertain.has(row)) throw mismatch(`${what} was not sent: an earlier change of workflow ${row} may have been sent and is not yet confirmed`);
    }
  }

  return {
    screen({ method, url, body, headers } = {}) {
      const m = String(method || 'GET').toUpperCase();
      if (isRead(m)) return null;
      const ctx = als.getStore();
      const isBatch = m === 'POST' && apiPath(url) === '$batch';
      const parts = isBatch
        ? batchParts(body).filter((p) => !isRead(p.method)).map((p) => ({ c: classify(p.method, p.url, p.body), ifMatch: headerValue(p.headers, 'if-match') }))
        : [{ c: classify(m, url, body), ifMatch: headerValue(headers, 'if-match') }];

      if (!ctx) {
        // Legacy: unchanged, but for a row whose outcome is unknown.
        refuseUncertain(parts.map((p) => p.c && p.c.row), `a ${m} of a workflow`);
        return null;
      }
      // A `$batch` of reads only is a read: it passes inside a context as a GET does.
      if (isBatch && parts.length === 0) return null;

      const { effect } = ctx;
      const what = `the ${effect.effect} of ${effect.family} "${effect.key}"`;
      if (parts.length !== 1) throw mismatch(`a request inside ${what} was not sent: it carries ${parts.length} changes, and the effect is one`);
      if (ctx.sends > 0) throw mismatch(`a second change inside ${what} was not sent: the effect is sent once`);
      const why = matches(effect, parts[0].c, parts[0].ifMatch);
      if (why) throw mismatch(`a request inside ${what} was not sent: ${why}`);
      refuseUncertain([effect.rowId], `${what}`);
      const persisted = store.snapshot().envelope.workflowEffects.find((e) => e.token === effect.token);
      if (!persisted || persisted.state !== 'definitely-unsent') throw mismatch(`${what} was not sent: its record is not waiting to be sent`);
      const attempt = store.snapshot().envelope.attempts.find((a) => a.token === effect.attemptToken);
      if (!attempt || attempt.baseGeneration !== effect.baseGeneration) throw mismatch(`${what} was not sent: its attempt is no longer pending at that generation`);
      ctx.sends += 1;
      const conditional = parts[0].ifMatch !== null;
      return {
        dispatching() {
          store.markEffectDispatching(effect.token, crypto.randomUUID());
        },
        answered(res) {
          const status = res && Number.isInteger(res.statusCode) ? res.statusCode : res && Number.isInteger(res.status) ? res.status : null;
          if (!res || res.error || status === null) return store.noteEffectOutcome(effect.token, 'unconfirmed');
          // A success stays dispatching until a fresh read proves it (confirmEffect). A 412 to a conditional write is
          // the service saying the version did not match, so the write was not applied: the effect is recorded unsent
          // again (a later plan may send it at the new version, under a new context; this one has spent its send).
          // Every other answer — a 5xx, a 429, any other refusal — may sit in front of a write that ran, so it is
          // unconfirmed and never sent again.
          // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api
          if (status >= 200 && status < 300) return undefined;
          if (status === 412 && conditional) return store.noteEffectOutcome(effect.token, 'definite-no-start');
          return store.noteEffectOutcome(effect.token, 'unconfirmed');
        },
      };
    },
  };
}

module.exports = {
  MISMATCH,
  WORKFLOW_STATES,
  requestBodySha256,
  currentWorkflowEffect,
  runWithWorkflowEffect,
  createWorkflowEffectGate,
  classifyWorkflowRequest: classify,
  batchParts,
};
