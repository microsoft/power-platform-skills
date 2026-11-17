'use strict';

// Runs `fn` as if no stable-id create module were part of the plugin, and reports every attempt to load one.
// The configuration kinds use the plain create path (lib/creates-passthrough.js) in this release, so the default build
// port and the standalone CLI must work when those modules do not exist at all, and must not try to load them. A
// require of any of these names (the stable-id port, its plan, its local record, its reader, its capability catalog,
// its id derivation) is recorded and fails as a missing module does, whatever is on disk:
//   require('./creates-port.js')        -> recorded; throws { code: 'MODULE_NOT_FOUND' }
//   require('./creates-passthrough.js') -> loaded as usual (the plain port is part of the plugin)
// Module.prototype.require is what every module's own `require` calls, so a lazy require inside a function is caught.

const Module = require('node:module');

const STABLE_CREATE_MODULE = /(^|[\\/])creates-(port|plan|local|read|capabilities|identity)(\.js)?$/;

async function withoutStableCreateModules(fn) {
  const requested = [];
  const original = Module.prototype.require;
  Module.prototype.require = function requireWithoutStableCreates(id) {
    if (typeof id === 'string' && STABLE_CREATE_MODULE.test(id)) {
      requested.push(id);
      throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
    }
    return original.apply(this, arguments);
  };
  try {
    return { result: await fn(), requested };
  } finally {
    Module.prototype.require = original;
  }
}

module.exports = { withoutStableCreateModules };
