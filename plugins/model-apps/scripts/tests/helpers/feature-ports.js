'use strict';
// Test doubles for the two ports the declared-reconciliation helpers are given by the build:
//   ctx.creates — the creation-identity port: `run({kind, key, identity, childKeys}, execute)`
//                 returns stable ids, records the intent BEFORE execute, and refuses while an
//                 earlier attempt for the same key is pending with an unknown outcome;
//   ctx.managed — the managed-binding port: `lookup(kind, key)` answers the stored binding.
// Both are coordinator-owned modules that do not exist on this branch, so the helpers are proven
// against these doubles and the contract records the exact signatures they rely on.

/**
 * @param {{ pendingUnknown?: string[], idPrefix?: string }} [opts]
 *   pendingUnknown — keys whose earlier attempt is pending with an unknown outcome (run refuses them)
 */
function fakeCreates(opts = {}) {
  const calls = [];
  const pending = new Set(opts.pendingUnknown || []);
  let n = 0;
  const mint = () => {
    n += 1;
    const hex = n.toString(16).padStart(12, '0');
    return `${opts.idPrefix || 'c0c0c0c0'}-0000-4000-8000-${hex}`;
  };
  return {
    calls,
    async run(op, execute) {
      if (pending.has(op.key)) {
        const err = new Error('an earlier creation attempt for this key has an unknown outcome');
        err.code = 'CREATION_PENDING_UNKNOWN';
        throw err;
      }
      const ids = { rootId: mint(), childIds: {} };
      for (const k of op.childKeys || []) ids.childIds[k] = mint();
      const record = { op, ids, executed: false };
      calls.push(record);
      const out = await execute(ids);
      record.executed = true;
      return { ids, result: out };
    },
  };
}

/** A managed-binding store: `lookup` answers what `seed`/`persist` put in. */
function fakeManaged(seed = []) {
  const byKey = new Map();
  const put = (b) => byKey.set(`${b.kind}\u0000${b.key}`, b);
  for (const b of seed) put(b);
  return {
    lookup: (kind, key) => byKey.get(`${kind}\u0000${key}`) || null,
    persist(bindings) { for (const b of bindings || []) put(b); },
    all: () => [...byKey.values()],
  };
}

/** A publication port that records what was queued. */
function fakePublication() {
  const queued = [];
  return { queued, queue: (scope) => { queued.push(scope); } };
}

module.exports = { fakeCreates, fakeManaged, fakePublication };
