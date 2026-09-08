"use strict";

const path = require("node:path");

// Discover an optional, plugin-provided resolver module that owns iKey/collector
// selection (region routing, tenant routing, etc.). Convention: a `resolver.js`
// next to the plugin's ikey.json. The shared library never imports a resolver
// directly — it loads whatever the plugin drops here and calls the documented
// contract: { resolve({event, cfg, cloud, configDir}), isProvisioned(cfg) }.
//
// Returns the resolver module, or null when none is present or it fails to load
// (callers then fall back to static config / a generic gate — fail open).
function loadResolver(dir) {
  if (!dir) return null;
  try {
    // path.resolve (not path.join): require() treats a non-"./"-prefixed
    // relative path as a module ID and searches node_modules. A relative `dir`
    // (e.g. from a relative POWER_PLATFORM_SKILLS_IKEY_JSON override) would then
    // miss the intended resolver.js. Resolve to an absolute path first.
    return require(path.resolve(dir, "resolver.js"));
  } catch {
    return null;
  }
}

module.exports = { loadResolver };
