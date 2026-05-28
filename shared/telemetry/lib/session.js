"use strict";

const crypto = require("node:crypto");

// Hooks run as fresh Node processes, so a module-level UUID would be unique
// per hook invocation — every event in a Claude Code session would carry a
// different sessionId, breaking session-scoped analysis. Each hook reads
// Claude Code's session_id from the stdin payload and primes this cache
// with it so all events emitted from that hook (and within that process)
// share a single sessionId.
let cached;

function getSessionId(override) {
  if (typeof override === "string" && override) {
    cached = override;
    return cached;
  }
  if (!cached) cached = crypto.randomUUID();
  return cached;
}

// Test seam.
function _resetCache() {
  cached = undefined;
}

module.exports = { getSessionId, _resetCache };
