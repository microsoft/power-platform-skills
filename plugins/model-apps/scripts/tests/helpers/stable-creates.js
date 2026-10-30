'use strict';
// A creation-port double with STABLE ids: the same (kind, key, child key) answers the same id in every instance, as the
// recomputable-identity port does across runs. It calls execute exactly once and answers the port envelope
//   { outcome: 'created'|'matched'|'refused'|'unknown', id, childIds, ids, result, evidence }
// - 'matched' when execute saved and its SDK result says the SDK adopted an exact existing row (`adoptedExisting: true`),
//   with evidence 'sdk-adopted-exact';
// - opts.failAfterExecute: execute runs (and may save), then the port itself throws (an EIO settling its answer) —
//   the case where a callback's success must not be taken as the port's.
// - opts.malformedMatched: answer 'matched' without the exact-match evidence.
// - opts.underParent: derive child ids under the operation's ROOT id, as the recomputable-identity port does
//   (stableChildIdV1(rootOrBoundId, ...)): the root is `identity.parentId` (lowercased) when the request names the row
//   it adds children to, else the stable root id; each child is stableId(namespace, 'child', root, childKey). So the
//   same child key gets the same id whether it is created with its root or added under that root on a later run.
//   Without it (the default) ids are exactly as before.
// It keeps no journal and adopts nothing without execute.
const crypto = require('node:crypto');

function stableId(namespace, ...parts) {
  const h = crypto.createHash('sha256').update([namespace, ...parts].join('\u0000')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function stableCreates(opts = {}) {
  const namespace = opts.namespace || 'stable-test';
  const calls = [];
  async function run(request, execute) {
    const { kind, key, childKeys = [] } = request || {};
    const label = typeof key === 'string' ? key : JSON.stringify(key);
    const parentId = opts.underParent && request && request.identity && request.identity.parentId;
    const id = parentId ? String(parentId).toLowerCase() : stableId(namespace, kind, label);
    const childIds = Object.fromEntries(childKeys.map((k) => [k, opts.underParent ? stableId(namespace, 'child', id, k) : stableId(namespace, kind, label, k)]));
    const ids = { id, childIds };
    const record = { op: request, ids, executed: false };
    calls.push(record);
    const answer = await execute({ id, childIds: { ...childIds } });
    record.executed = true;
    record.answer = answer;
    if (opts.failAfterExecute) {
      const err = new Error('the creation port could not settle its answer');
      err.code = 'EIO';
      throw err;
    }
    if (answer && answer.outcome === 'saved') {
      const adopted = answer.sdkResult && answer.sdkResult.adoptedExisting === true;
      if (adopted || opts.malformedMatched) {
        return { outcome: 'matched', id, childIds, ids, result: answer, evidence: opts.malformedMatched ? undefined : 'sdk-adopted-exact' };
      }
      return { outcome: 'created', id, childIds, ids, result: answer, evidence: 'sdk-acknowledged' };
    }
    return { outcome: answer && answer.outcome === 'refused' ? 'refused' : 'unknown', id, childIds, ids, result: answer };
  }
  return { calls, run };
}

module.exports = { stableCreates, stableId };
