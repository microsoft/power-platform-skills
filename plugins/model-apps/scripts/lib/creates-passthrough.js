'use strict';
// The create port every feature helper sends its creates through:
//   creates.run({ kind, key, identity, childKeys }, execute)
// (field-security.js's applyFieldSecurity is the first caller; the build hands the port to the engine as `opts.creates`).
//
// This implementation is a PLAIN PASS-THROUGH, and deliberately nothing more:
//   - it mints the ids the caller asks for before the create is sent — one root id, and one per `childKeys` entry — so a create the
//     SDK accepts a client-minted id for (a field security profile and its permissions, as one deep insert) carries them;
//   - it calls `execute` exactly once, and answers `{ outcome: 'created', id, childIds, ids: { id, childIds }, result }`;
//   - it keeps no journal, adopts nothing, and never sends a create again. An error from `execute` (including an answer that was
//     lost, so the create's outcome is unknown) is rethrown as the same object, so the build's existing halt and retry policy treats
//     it exactly as it treats any other create (retry-policy.js).
// It therefore gives NO fence: ids are minted afresh on every run, so a whole-build retry after a lost answer to a create can create a
// second row of the same name — the same known limit every other create in the build has (plugins/model-apps/AGENTS.md).
//
// Seam: a durable port (one that records intent before `execute`, resolves an earlier unknown attempt by its reserved id, and can
// answer `outcome: 'unknown'`) is meant to plug in behind this same call shape. Callers already treat any outcome other than
// 'created' as unknown, so they need no change when it does.

const { randomUUID } = require('node:crypto');

function createPassthroughCreates({ newId = randomUUID } = {}) {
  if (typeof newId !== 'function') throw new TypeError('creates port: newId must be a function');
  return {
    async run(request, execute) {
      const { kind, key, childKeys = [] } = request || {};
      if (typeof kind !== 'string' || !kind) throw new TypeError('creates.run: kind must be a non-empty string');
      if (typeof key !== 'string' || !key) throw new TypeError('creates.run: key must be a non-empty string');
      if (!Array.isArray(childKeys) || childKeys.some((k) => typeof k !== 'string' || !k)) throw new TypeError('creates.run: childKeys must be an array of non-empty strings');
      if (new Set(childKeys).size !== childKeys.length) throw new TypeError('creates.run: childKeys must be unique');
      if (typeof execute !== 'function') throw new TypeError('creates.run: execute must be a function');
      const id = newId();
      const childIds = Object.fromEntries(childKeys.map((k) => [k, newId()]));
      // Exactly once, and never inside a catch: whatever execute throws reaches the caller unchanged.
      const result = await execute({ id, childIds });
      return { outcome: 'created', id, childIds, ids: { id, childIds }, result };
    },
  };
}

module.exports = { createPassthroughCreates };
