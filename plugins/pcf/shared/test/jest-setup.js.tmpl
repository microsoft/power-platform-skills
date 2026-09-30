"use strict";

const originalEmitWarning = process.emitWarning;
let installed = false;

function installPunycodeDeprecationFilter() {
  if (installed) return;
  installed = true;
  process.emitWarning = function emitWarningExceptPinnedJsdomPunycode(warning, ...args) {
    const options = args.find((arg) => arg && typeof arg === "object");
    const code = options?.code ?? (typeof args[1] === "string" ? args[1] : undefined);
    // Node 22 reports DEP0040 from a transitive jsdom dependency of the pinned
    // jest-environment-jsdom chain. It is harmless to the control under test.
    // Removal condition: when the compatibility matrix moves to a jsdom chain that no longer requires the core `punycode` module.
    if (code === "DEP0040") return;
    return originalEmitWarning.call(process, warning, ...args);
  };
}

installPunycodeDeprecationFilter();

module.exports = { installPunycodeDeprecationFilter };
