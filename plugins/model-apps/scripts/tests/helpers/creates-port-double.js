'use strict';
// An in-memory double of the build's create-intent port, `creates.run({kind, key, identity, childKeys}, execute)` (DESIGN §2.0),
// with the port's own semantics rather than a pass-through:
//   - ids are allocated by the PORT (one root id, one per child slot) and the send is RECORDED (`sending`) BEFORE execute runs;
//   - execute gets `{id, childIds}` and is called at most once per run;
//   - the outcome is judged the way the port judges it (verdictOf* below): acknowledged -> complete, refused -> the SAME ids go
//     again next time, unknown -> the invocation is poisoned (every later run throws `create-outcome-unknown`, outcome 'not-sent')
//     and the next invocation refuses the key (`CREATION_PENDING_UNKNOWN`, outcome 'unknown') until a maker decision is recorded;
//   - a maker `adopt` decision makes the named ids the key's ids without calling execute; `allow-create` makes one new generation.
// `events` logs every record transition and every call into execute, so a test can assert that intent was recorded before a write.
// `newInvocation()` is the next build: the poison is cleared, the records stay (they are the durable part).
const crypto = require('node:crypto');

const KIND = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
};

function verdictOfFailure(err) {
  const chain = [];
  for (let e = err, i = 0; e && typeof e === 'object' && i < 8; e = e.cause, i++) chain.push(e);
  if (chain.some((e) => e.outcome === 'unknown' || e.code === 'CREATE_OUTCOME_UNKNOWN' || e.code === 'create-outcome-unknown')) return 'unknown';
  if (chain.some((e) => e.outcome === 'nothing' || e.outcome === 'refused' || e.outcome === 'not-sent')) return 'refused';
  const status = chain.map((e) => e.statusCode ?? e.status).find((s) => Number.isSafeInteger(s));
  if (status >= 400 && status < 500 && status !== 408) return 'refused';
  return 'unknown';
}

function verdictOfResult(result) {
  if (!result || typeof result !== 'object') return 'acknowledged';
  if (result.outcome === 'unknown') return 'unknown';
  if (result.outcome === 'refused' || result.outcome === 'nothing') return 'refused';
  const failed = result.success === false || (result.saved === false && result.adoptedExisting !== true);
  if (!failed) return 'acknowledged';
  const errs = Array.isArray(result.errors) ? result.errors : result.error ? [result.error] : [];
  return errs.length && errs.every((e) => verdictOfFailure(e) === 'refused') ? 'refused' : 'unknown';
}

const portError = (code, message, props) => Object.assign(new Error(message), { code, transient: false }, props);

function createCreatesPortDouble({ uuid = () => crypto.randomUUID() } = {}) {
  const records = new Map();
  const events = [];
  let poisoned = null;

  const entryOf = (kind, key) => JSON.stringify([kind, canonical(key)]);
  const idsOf = (rec, childKeys) => ({ id: rec.id, childIds: Object.fromEntries(childKeys.map((slot) => [slot, rec.children[slot]])) });
  const arm = (rec, childKeys) => {
    for (const slot of childKeys) if (!rec.children[slot]) rec.children[slot] = uuid();
    rec.state = 'sending';
    rec.sends += 1;
    events.push(['record', rec.label, 'sending', { id: rec.id, childIds: { ...rec.children } }]);
  };

  async function run(request, execute) {
    const { kind, key, identity, childKeys = [] } = request || {};
    if (typeof kind !== 'string' || !KIND.test(kind)) throw portError('CREATE_PORT_INVALID', `creates.run: '${kind}' is not a kind`);
    if (!(typeof key === 'string' && key) && !(key && typeof key === 'object')) throw portError('CREATE_PORT_INVALID', `creates.run: the ${kind} create has no key`);
    if (!Array.isArray(childKeys) || childKeys.some((c) => typeof c !== 'string' || !c) || new Set(childKeys).size !== childKeys.length) throw portError('CREATE_PORT_INVALID', 'creates.run: child keys must be distinct non-empty strings');
    if (typeof execute !== 'function') throw portError('CREATE_PORT_INVALID', 'creates.run: execute must be a function');
    const label = typeof key === 'string' ? key : JSON.stringify(key);
    if (poisoned) throw portError('create-outcome-unknown', `the ${kind} '${label}' was not created: an earlier create in this run lost its answer`, { outcome: 'not-sent' });
    const entry = entryOf(kind, key);
    const identitySha = JSON.stringify(canonical(identity === undefined ? null : identity));
    let rec = records.get(entry);
    if (!rec) {
      rec = { kind, label, id: uuid(), children: {}, state: 'reserved', identitySha, sends: 0, generation: 1, unknownSeen: false, decision: null };
      records.set(entry, rec);
    } else if (['sending', 'unknown', 'partial'].includes(rec.state)) {
      const z = rec.decision;
      if (!z || z.consumed) throw portError('CREATION_PENDING_UNKNOWN', `the ${kind} '${label}' has a create whose outcome is not known; a maker decides what it left behind`, { outcome: 'unknown' });
      z.consumed = true;
      if (z.decision === 'adopt') {
        rec.id = z.id;
        for (const [slot, id] of Object.entries(z.childIds || {})) rec.children[slot] = id;
        rec.state = 'complete';
        events.push(['record', label, 'adopted', idsOf(rec, childKeys)]);
        const ids = idsOf(rec, childKeys);
        return { outcome: 'adopted', ...ids, ids, entryKey: entry, result: undefined };
      }
      rec.generation += 1;
      rec.id = uuid();
      rec.children = {};
      rec.identitySha = identitySha;
    } else if (rec.identitySha !== identitySha && rec.unknownSeen) {
      throw portError('create-recovery-needed', `the ${kind} '${label}' would be created from another request than the one recorded before an unanswered send`, { outcome: 'intent-changed' });
    } else {
      rec.identitySha = identitySha;
    }
    arm(rec, childKeys);
    const ids = idsOf(rec, childKeys);
    let result;
    let failure;
    events.push(['execute', label]);
    try {
      result = await execute({ id: ids.id, childIds: { ...ids.childIds } });
    } catch (e) {
      failure = e;
    }
    const verdict = failure ? verdictOfFailure(failure) : verdictOfResult(result);
    rec.state = verdict === 'acknowledged' ? 'complete' : verdict === 'refused' ? 'refused' : 'unknown';
    if (verdict === 'unknown') rec.unknownSeen = true;
    events.push(['record', label, rec.state]);
    if (verdict === 'unknown') {
      poisoned = rec;
      if (failure) throw failure;
      return { outcome: 'unknown', ...ids, ids, entryKey: entry, result };
    }
    if (failure) throw failure;
    return { outcome: verdict === 'acknowledged' ? 'created' : 'refused', ...ids, ids, entryKey: entry, result };
  }

  return {
    run,
    events,
    records,
    stateOf: (kind, key) => (records.get(entryOf(kind, key)) || {}).state,
    // The next build: what the records say stays; the in-run poison does not.
    newInvocation() { poisoned = null; },
    // A maker's resolution of a pending key: { decision: 'adopt', id, childIds } or { decision: 'allow-create' }.
    decide(kind, key, decision) { records.get(entryOf(kind, key)).decision = { ...decision, consumed: false }; },
  };
}

module.exports = { createCreatesPortDouble, verdictOfFailure, verdictOfResult };
