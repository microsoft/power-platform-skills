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
//     exactly once, marked dispatching before it leaves; any other mutation is refused unsent. The match is against
//     the persisted record, which the context must equal and whose attempt must still own it and be rooted at its
//     row: a context that is not the record sends nothing;
//   - a `$batch` is read whole (parseBatch); one the gate cannot read is refused inside a context;
//   - outside a context, a mutation passes as it always did, unless it targets a row whose persisted effect may have
//     been sent and is not yet confirmed (then an unreadable `$batch` is refused too, as it may target that row).
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
// The body is read strictly, because a part the gate cannot read is a part it cannot account for:
//   - the first non-blank line opens the batch (`--<boundary>`), and the batch must end with its close delimiter
//     (`--<boundary>--`); a delimiter is a line that is exactly one of those, so a body line that merely starts with
//     `--` is body;
//   - each part's MIME headers run to the first blank line. A `multipart/mixed` part is a change set: its content is
//     a nested batch with its own boundary, and nothing else. An `application/http` part's content is one request: a
//     request line (`METHOD url HTTP/1.x`), its headers to the next blank line, and the rest is its body. A part of
//     any other type, a request line the gate does not know, a part with no request, or a batch with no part at all is
//     an error;
//   - text after the outer close delimiter is ignored only when it is blank.
// Answers { parts, error }: `error` names the first thing that could not be read, and then `parts` is not to be used.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api
// and the multipart grammar of https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1
const REQUEST_LINE = /^(GET|HEAD|POST|PATCH|PUT|DELETE)\s+(\S+)\s+HTTP\/1\.[01]$/i;

function parseBatch(rawBody, headerBoundary = null) {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody == null ? '' : rawBody);
  const lines = text.split(/\r?\n/);
  const parts = [];
  const fail = (error) => ({ parts: [], error });
  const blank = (l) => l.trim() === '';

  // Read the multipart body in lines[from, to) whose boundary is `boundary`; answers an error string or null.
  function readMultipart(from, to, boundary, outer) {
    let i = from;
    while (i < to && blank(lines[i])) i += 1;
    if (i >= to) return 'the batch has no part';
    const open = /^--(\S+?)\s*$/.exec(lines[i]);
    if (!open || open[1].endsWith('--')) return 'the batch does not open with a boundary line';
    if (boundary !== null && open[1] !== boundary) return 'the batch opens with another boundary than its content type names';
    const b = open[1];
    const delim = `--${b}`;
    const close = `--${b}--`;
    let start = i + 1;
    let closedAt = -1;
    const segments = [];
    for (let j = start; j < to; j += 1) {
      const l = lines[j].replace(/\s+$/, '');
      if (l === delim) { segments.push([start, j]); start = j + 1; } else if (l === close) { segments.push([start, j]); closedAt = j; break; }
    }
    if (closedAt < 0) return 'the batch has no close delimiter';
    for (let j = closedAt + 1; j < to; j += 1) if (!blank(lines[j])) return outer ? 'text follows the close delimiter' : 'a change set holds more than its parts';
    for (const [s, e] of segments) {
      const headers = {};
      let k = s;
      for (; k < e && !blank(lines[k]); k += 1) {
        const c = lines[k].indexOf(':');
        if (c <= 0) return 'a part header is not a header';
        headers[lines[k].slice(0, c).trim().toLowerCase()] = lines[k].slice(c + 1).trim();
      }
      const type = (headers['content-type'] || '').toLowerCase();
      if (/^multipart\/mixed\b/.test(type)) {
        const nested = /boundary="?([^";]+)"?/i.exec(headers['content-type']);
        if (!nested) return 'a change set names no boundary';
        const err = readMultipart(k + 1, e, nested[1].trim(), false);
        if (err) return err;
        continue;
      }
      if (!/^application\/http\b/.test(type)) return `a part is ${type || 'untyped'}, not a request or a change set`;
      let r = k + 1;
      while (r < e && blank(lines[r])) r += 1;
      if (r >= e) return 'a part holds no request';
      const m = REQUEST_LINE.exec(lines[r].trim());
      if (!m) return 'a part\'s request line is not one the gate reads';
      const reqHeaders = {};
      let h = r + 1;
      for (; h < e && !blank(lines[h]); h += 1) {
        const c = lines[h].indexOf(':');
        if (c <= 0) return 'a request header is not a header';
        reqHeaders[lines[h].slice(0, c).trim()] = lines[h].slice(c + 1).trim();
      }
      parts.push({ method: m[1].toUpperCase(), url: m[2], headers: reqHeaders, body: lines.slice(h + 1, e).join('\n').trim() || null });
    }
    return null;
  }

  const error = readMultipart(0, lines.length, headerBoundary, true);
  if (error) return fail(error);
  if (parts.length === 0) return fail('the batch has no request');
  return { parts, error: null };
}

/** The request parts of a `$batch` body, or [] when it cannot be read whole (see parseBatch). */
function batchParts(rawBody) {
  return parseBatch(rawBody).parts;
}
const isRead = (method) => method === 'GET' || method === 'HEAD';

// The fields that say what an effect is: everything but its progress (state, dispatchToken). An absent optional field
// reads as null, as the store writes it.
const DESCRIPTOR = ['token', 'attemptToken', 'baseGeneration', 'family', 'key', 'rowId', 'effect', 'request', 'desiredSha256', 'desiredState', 'expectedVersion'];
const descriptor = (e) => Object.fromEntries(DESCRIPTOR.map((k) => [k, e[k] === undefined ? null : e[k]]));

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
      let parts;
      if (isBatch) {
        const ct = headerValue(headers, 'content-type');
        const declared = ct ? /boundary="?([^";]+)"?/i.exec(ct) : null;
        const parsed = parseBatch(body, declared ? declared[1].trim() : null);
        if (parsed.error) {
          // A batch the gate cannot read whole is refused inside a context: it could carry any write. Outside one,
          // the legacy client keeps sending what it always sent, unless a row's earlier write is uncertain — then
          // a batch whose rows cannot be listed may touch that row, so it is refused too.
          const why = `a $batch was not sent: ${parsed.error}`;
          if (ctx) throw mismatch(`${why}, so it cannot be held to the ${ctx.effect.effect} of ${ctx.effect.family} "${ctx.effect.key}"`);
          if (uncertainRows(store).size > 0) throw mismatch(`${why}, and a workflow's earlier change may have been sent and is not yet confirmed`);
          return null;
        }
        parts = parsed.parts.filter((x) => !isRead(x.method)).map((x) => ({ c: classify(x.method, x.url, x.body), ifMatch: headerValue(x.headers, 'if-match') }));
      } else {
        parts = [{ c: classify(m, url, body), ifMatch: headerValue(headers, 'if-match') }];
      }

      if (!ctx) {
        // Legacy: unchanged, but for a row whose outcome is unknown.
        refuseUncertain(parts.map((x) => x.c && x.c.row), `a ${m} of a workflow`);
        return null;
      }
      // A `$batch` of reads only is a read: it passes inside a context as a GET does.
      if (isBatch && parts.length === 0) return null;

      // The context is a copy; the persisted record is the authority. The context must be that record — every field
      // that says what the effect is, who owns it and which row it changes — and the request is matched against the
      // record, never against the copy, so a context altered after it was persisted sends nothing.
      const what = `the ${ctx.effect.effect} of ${ctx.effect.family} "${ctx.effect.key}"`;
      const snap = store.snapshot().envelope;
      const effect = snap.workflowEffects.find((e) => e.token === ctx.effect.token);
      if (!effect) throw mismatch(`${what} was not sent: no persisted effect has its token`);
      if (canonicalJson(descriptor(ctx.effect)) !== canonicalJson(descriptor(effect))) throw mismatch(`${what} was not sent: its context is not the persisted effect`);
      const attempt = snap.attempts.find((a) => a.token === effect.attemptToken);
      if (!attempt || attempt.family !== effect.family || attempt.key !== effect.key || attempt.baseGeneration !== effect.baseGeneration) {
        throw mismatch(`${what} was not sent: its attempt is no longer pending at that generation`);
      }
      if (!attempt.root || attempt.root.id !== effect.rowId) throw mismatch(`${what} was not sent: it changes another row than its attempt's root`);
      if (parts.length !== 1) throw mismatch(`a request inside ${what} was not sent: it carries ${parts.length} changes, and the effect is one`);
      if (ctx.sends > 0) throw mismatch(`a second change inside ${what} was not sent: the effect is sent once`);
      const why = matches(effect, parts[0].c, parts[0].ifMatch);
      if (why) throw mismatch(`a request inside ${what} was not sent: ${why}`);
      refuseUncertain([effect.rowId], `${what}`);
      if (effect.state !== 'definitely-unsent') throw mismatch(`${what} was not sent: its record is not waiting to be sent`);      ctx.sends += 1;
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
  parseBatch,
  apiPath,
  headerValue,
};
