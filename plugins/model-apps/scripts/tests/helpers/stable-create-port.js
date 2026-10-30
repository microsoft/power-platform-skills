'use strict';

// A test double of the build's create port with STABLE ids: the same kind and key always get the same id, so a
// second run of a build finds its own row at that id (the identity the shared resolver gives in production).
//
//   run({kind, key, identity, childKeys}, execute)
//     -> {outcome: 'created', id, childIds, ids, result, evidence}
//   - the root id is derived from sha256(seed|kind|key), each child id from sha256(seed|key|slot);
//   - execute is called exactly once with {id, childIds}; whatever it throws reaches the caller unchanged;
//   - `answer(request, reply)` (optional) may rewrite the reply, to model a port that answers 'matched' or
//     something nobody can vouch for.
//   resolve({kind, key, identity}) -> {state: 'present', id} | {state: 'absent', id}
//   - reads the derived id through `read(kind, id)` (true/false); a throw from `read` propagates, which the helper
//     must treat as "not verified", never as absent.
//
// Test-only surface: `calls` (every run and resolve, in order) and `idOf(kind, key)` / `childIdOf(key, slot)`.
// Deliberately NOT a journal: it records nothing between runs and never re-sends anything.

const { createHash } = require('node:crypto');

const uuidOf = (text) => {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// Row sets of the fake org (tests/helpers/fake-config-org.js) by kind, for `readFromOrg`.
const SET_OF = Object.freeze({
  environmentVariable: 'environmentvariabledefinitions',
  connectionReference: 'connectionreferences',
  customApi: 'customapis',
  duplicateRule: 'duplicaterules',
});

function readFromOrg(org) {
  return async (kind, id) => {
    const set = SET_OF[kind];
    if (!set) throw new Error(`stable-create-port: no set for ${kind}`);
    return org.sets.get(set).has(String(id).toLowerCase());
  };
}

function createStableCreatePort({ seed = 'stable', read = null, answer = null } = {}) {
  const calls = [];
  const idOf = (kind, key) => uuidOf(`${seed}|${kind}|${key}`);
  const childIdOf = (key, slot) => uuidOf(`${seed}|${key}|${slot}`);
  return {
    calls,
    idOf,
    childIdOf,
    async run(request, execute) {
      const { kind, key, identity, childKeys = [] } = request || {};
      if (typeof kind !== 'string' || !kind) throw new TypeError('creates.run: kind must be a non-empty string');
      if (typeof key !== 'string' || !key) throw new TypeError('creates.run: key must be a non-empty string');
      if (!Array.isArray(childKeys) || childKeys.some((k) => typeof k !== 'string' || !k)) throw new TypeError('creates.run: childKeys must be an array of non-empty strings');
      if (new Set(childKeys).size !== childKeys.length) throw new TypeError('creates.run: childKeys must be unique');
      if (typeof execute !== 'function') throw new TypeError('creates.run: execute must be a function');
      const id = idOf(kind, key);
      const childIds = Object.fromEntries(childKeys.map((slot) => [slot, childIdOf(key, slot)]));
      calls.push({ op: 'run', kind, key, identity, childKeys: [...childKeys], id });
      const result = await execute({ id, childIds: { ...childIds } });
      const reply = { outcome: 'created', id, childIds, ids: { id, childIds }, result, evidence: { kind: 'acknowledged' } };
      return answer ? answer(request, reply) : reply;
    },
    async resolve({ kind, key, identity } = {}) {
      const id = idOf(kind, key);
      calls.push({ op: 'resolve', kind, key, identity, id });
      if (!read) return { state: 'absent', id };
      return (await read(kind, id)) ? { state: 'present', id } : { state: 'absent', id };
    },
  };
}

module.exports = { createStableCreatePort, readFromOrg };
