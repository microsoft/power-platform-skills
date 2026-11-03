'use strict';
// An in-memory double of the build's create port, `creates.run({kind, key, identity, childKeys}, execute)`, as the build wires it: a plain
// pass-through. It allocates the ids the caller asks for (one root id, one per child slot), calls execute ONCE with `{id, childIds}` and
// returns `{ids, result}`. It keeps no record, adopts nothing and never sends again; an execute that throws is rethrown unchanged, so a
// failed create is the caller's to report the way any other failed write is.
// `events` logs each allocation and each call into execute, so a test can assert the ids an add was sent under.
const crypto = require('node:crypto');

const KIND = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const portError = (code, message) => Object.assign(new Error(message), { code, transient: false });

function createCreatesPortDouble({ uuid = () => crypto.randomUUID() } = {}) {
  const events = [];

  async function run(request, execute) {
    const { kind, key, childKeys = [] } = request || {};
    if (typeof kind !== 'string' || !KIND.test(kind)) throw portError('CREATE_PORT_INVALID', `creates.run: '${kind}' is not a kind`);
    if (!(typeof key === 'string' && key) && !(key && typeof key === 'object')) throw portError('CREATE_PORT_INVALID', `creates.run: the ${kind} create has no key`);
    if (!Array.isArray(childKeys) || childKeys.some((c) => typeof c !== 'string' || !c) || new Set(childKeys).size !== childKeys.length) throw portError('CREATE_PORT_INVALID', 'creates.run: child keys must be distinct non-empty strings');
    if (typeof execute !== 'function') throw portError('CREATE_PORT_INVALID', 'creates.run: execute must be a function');
    const label = typeof key === 'string' ? key : JSON.stringify(key);
    const ids = { id: uuid(), childIds: Object.fromEntries(childKeys.map((slot) => [slot, uuid()])) };
    events.push(['allocate', label, { id: ids.id, childIds: { ...ids.childIds } }]);
    events.push(['execute', label]);
    const result = await execute({ id: ids.id, childIds: { ...ids.childIds } });
    return { ids, result };
  }

  return { run, events, idsOf: (label) => (events.find((e) => e[0] === 'allocate' && e[1] === label) || [])[2] };
}

module.exports = { createCreatesPortDouble };