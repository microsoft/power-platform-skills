'use strict';

// A test-local double of a stable create port (mode 'stable'): the call shape the configuration helper consumes from
// any port that plans each create's id. The plugin ships no such port in this release (its default is the plain
// pass-through, lib/creates-passthrough.js); this double proves the helper's consuming side on its own:
//
//   run({kind, key, identity, childKeys}, execute)
//     -> {outcome: 'created', id, childIds, ids, result, evidence}
//   - a root id is the bound id (`bound['<kind>|<key>']`) or uuid(seed|kind|key);
//   - a child id is uuid(seed|<its parent's id>|childKind|slot): keyed on the PARENT'S ID, so a child the root's
//     create makes and the same child a later run adds are one id, and the same child under another parent is
//     another id;
//   - a child sent as its own run names its parent (identity {parentKind, parentKey, slot, parentId?}); a parentId
//     other than the planned parent's id is the port's typed stop create-identity-conflict, sent nothing;
//   - execute is called exactly once with {id, childIds}; whatever it throws reaches the caller unchanged;
//   - `answer(request, reply)` (optional) may rewrite the reply, to model a port that answers 'matched' or
//     something nobody can vouch for.
//   resolve({kind, key, identity}) -> {state: 'present', id} | {state: 'absent', id}
//   - reads the planned id through `read(kind, id)` (true/false); a throw from `read` propagates, which the helper
//     must treat as "not verified", never as absent.
//   protects(kind) -> whether the kind (or its parent kind) is protected (`protectedKinds`, default every kind);
//   identityFor(kind, key) -> {id, childIds: {}} for a protected root, else null.
//
// Test-only surface: `calls` (every run and resolve, in order), `idOf(kind, key)` (a child kind takes the key
// '<parent key>|<slot>'), `childIdOf(parentKey, slot)` and `childIdUnder(parentId, childKind, slot)`.
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

// A child kind's parent kind, and the child kind a parent's slot names (the slots configuration-artifacts.js sends).
const PARENT_OF = Object.freeze({
  environmentVariableValue: 'environmentVariable',
  customApiRequestParameter: 'customApi',
  customApiResponseProperty: 'customApi',
  duplicateRuleCondition: 'duplicateRule',
});
const childKindOf = (parentKind, slot) => {
  if (parentKind === 'environmentVariable') return 'environmentVariableValue';
  if (parentKind === 'customApi') return slot.startsWith('request:') ? 'customApiRequestParameter' : 'customApiResponseProperty';
  if (parentKind === 'duplicateRule') return 'duplicateRuleCondition';
  throw new Error(`stable-create-port: ${parentKind} has no children`);
};
// The parent kind a slot belongs to, for the test-only `childIdOf(parentKey, slot)`.
const parentKindOfSlot = (slot) => (slot === 'value' ? 'environmentVariable' : /^(request|response):/.test(slot) ? 'customApi' : 'duplicateRule');

function readFromOrg(org) {
  return async (kind, id) => {
    const set = SET_OF[kind];
    if (!set) throw new Error(`stable-create-port: no set for ${kind}`);
    return org.sets.get(set).has(String(id).toLowerCase());
  };
}

function stop(code, create) {
  const error = new Error(`creates: ${code}`);
  error.code = code;
  error.create = create;
  return error;
}

function createStableCreatePort({ seed = 'stable', read = null, answer = null, bound = {}, protectedKinds = null } = {}) {
  const calls = [];
  const rootIdOf = (kind, key) => (bound[`${kind}|${key}`] ? String(bound[`${kind}|${key}`]).toLowerCase() : uuidOf(`${seed}|${kind}|${key}`));
  const childIdUnder = (parentId, childKind, slot) => uuidOf(`${seed}|${String(parentId).toLowerCase()}|${childKind}|${slot}`);
  const childIdOf = (parentKey, slot) => {
    const parentKind = parentKindOfSlot(slot);
    return childIdUnder(rootIdOf(parentKind, parentKey), childKindOf(parentKind, slot), slot);
  };
  const idOf = (kind, key) => {
    const parentKind = PARENT_OF[kind];
    if (!parentKind) return rootIdOf(kind, key);
    const cut = key.indexOf('|');
    return childIdUnder(rootIdOf(parentKind, key.slice(0, cut)), kind, key.slice(cut + 1));
  };
  const protectsRoot = (kind) => (protectedKinds ? protectedKinds.includes(kind) : !PARENT_OF[kind]);
  const protects = (kind) => protectsRoot(kind) || (PARENT_OF[kind] !== undefined && protectsRoot(PARENT_OF[kind]));
  return {
    mode: 'stable',
    calls,
    idOf,
    childIdOf,
    childIdUnder,
    protects,
    identityFor: (kind, key) => (protectsRoot(kind) && !PARENT_OF[kind] ? { id: rootIdOf(kind, key), childIds: {} } : null),
    async run(request, execute) {
      const { kind, key, identity, childKeys = [] } = request || {};
      if (typeof kind !== 'string' || !kind) throw new TypeError('creates.run: kind must be a non-empty string');
      if (typeof key !== 'string' || !key) throw new TypeError('creates.run: key must be a non-empty string');
      if (!Array.isArray(childKeys) || childKeys.some((k) => typeof k !== 'string' || !k)) throw new TypeError('creates.run: childKeys must be an array of non-empty strings');
      if (new Set(childKeys).size !== childKeys.length) throw new TypeError('creates.run: childKeys must be unique');
      if (typeof execute !== 'function') throw new TypeError('creates.run: execute must be a function');
      let id;
      if (PARENT_OF[kind]) {
        const { parentKind, parentKey, slot, parentId } = identity || {};
        if (parentKind !== PARENT_OF[kind] || !parentKey || !slot) throw stop('create-identity-invalid', { kind, key });
        const planned = rootIdOf(parentKind, parentKey);
        if (parentId !== undefined && parentId !== null && String(parentId).toLowerCase() !== planned) {
          calls.push({ op: 'refuse', kind, key, identity });
          throw stop('create-identity-conflict', { kind, key, parentId: planned });
        }
        id = childIdUnder(planned, kind, slot);
      } else {
        id = rootIdOf(kind, key);
      }
      const childIds = Object.fromEntries(childKeys.map((slot) => [slot, childIdUnder(id, childKindOf(kind, slot), slot)]));
      calls.push({ op: 'run', kind, key, identity, childKeys: [...childKeys], id });
      const result = await execute({ id, childIds: { ...childIds } });
      const reply = { outcome: 'created', id, childIds, ids: { id, childIds }, result, evidence: { kind: 'acknowledged' } };
      return answer ? answer(request, reply) : reply;
    },
    async resolve({ kind, key, identity } = {}) {
      const id = rootIdOf(kind, key);
      calls.push({ op: 'resolve', kind, key, identity, id });
      if (!read) return { state: 'absent', id };
      return (await read(kind, id)) ? { state: 'present', id } : { state: 'absent', id };
    },
  };
}

// A test-local double of the three stable-id functions a caller may inject into the configuration helper (its
// `fence`: createCreatesPortForSpec, intentFor, resolveProtectedTarget; no plugin module provides them), with the
// rules the helper relies on:
//   - intentFor(kind, args) -> {kind, ...args} (the scope is kept, so a test can see it);
//   - createCreatesPortForSpec(spec, {intents, shippedKinds, featureKinds}) protects the featureKinds that have an
//     intent and only them (a spec without createIdentity protects no shippedKinds); none -> a pass-through port
//     (mode 'passthrough', protects nothing). A protected root's id is derived from its kind, key AND the scope's
//     solution, so one declaration under two scopes is two ids;
//   - resolveProtectedTarget({kind, id}) reads that id through `read(kind, id)`: present or absent.
// Test-only surface: `calls` (each createCreatesPortForSpec argument) and `port` (the last stable port built).
function createFakeFence({ read = null } = {}) {
  const fence = {
    calls: [],
    port: null,
    intentFor: (kind, args) => ({ kind, ...args }),
    createCreatesPortForSpec(spec, { intents = [], shippedKinds = [], featureKinds = [] } = {}) {
      fence.calls.push({ intents, shippedKinds, featureKinds });
      const kinds = featureKinds.filter((k) => intents.some((i) => i.kind === k));
      if (!kinds.length) {
        const { createPassthroughCreates } = require('../../lib/creates-passthrough.js');
        return { ...createPassthroughCreates(), mode: 'passthrough', protects: () => false, identityFor: () => null };
      }
      const scopes = [...new Set(intents.map((i) => String(i.scope && i.scope.solution).toLowerCase()))].sort();
      fence.port = createStableCreatePort({ seed: `fence|${scopes.join(',')}`, read, protectedKinds: kinds });
      return fence.port;
    },
    async resolveProtectedTarget({ kind, id }) {
      return read && (await read(kind, id)) ? { state: 'present', id } : { state: 'absent', id };
    },
  };
  return fence;
}

module.exports = { createStableCreatePort, readFromOrg, createFakeFence };
