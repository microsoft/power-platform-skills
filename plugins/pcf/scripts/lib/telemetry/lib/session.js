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

// Multi-host session-id resolver. Both Claude Code and GitHub Copilot CLI
// surface their session id through the hook stdin payload. Field-name
// convention may vary by host; check known variants in precedence order.
// Returns "" when no usable id is present so the caller's subsequent
// getSessionId("") falls back to a per-process UUID.
function resolveHostSessionId(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.session_id === "string" && payload.session_id) {
    return payload.session_id;
  }
  if (typeof payload.sessionId === "string" && payload.sessionId) {
    return payload.sessionId;
  }
  return "";
}

// Test seam.
function _resetCache() {
  cached = undefined;
}

module.exports = { getSessionId, resolveHostSessionId, _resetCache };
