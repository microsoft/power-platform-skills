"use strict";

const { execFileSync } = require("node:child_process");

// Reads PAC CLI auth state by shelling out to `pac auth who` and parsing the
// banner output. Matches the convention used by
// plugins/power-pages/scripts/lib/validation-helpers.js (getPacAuthInfo /
// getEnvironmentUrl) so telemetry stays consistent with the rest of the repo.
//
// PAC's JSON profile files are an internal/undocumented format that varies
// across versions. The banner output is stable and is what other code paths
// already parse via the AUTH_KEYS list documented in the VSCode 1DS extension.
//
// Best-effort and fail-closed: missing executable, timeout, non-zero exit, or
// unparseable output all resolve to null. The result is cached per process so
// repeated hook invocations only fork once.

// Cold-start `pac auth who` on Windows is consistently ~3.5-4s (.NET runtime
// startup + cached-token validation). 3s was too tight and produced silent
// timeouts that surfaced as missing orgId/tenantId in every event. 8s gives
// comfortable headroom while staying well under the hook's 30s budget.
const TIMEOUT_MS = 8000;

let cache;

function _resetCache() {
  cache = undefined;
}

function pickLine(text, label) {
  // Match "Label:    value" — case-insensitive, trims whitespace.
  const re = new RegExp("^\\s*" + label + "\\s*:\\s*(\\S.*?)\\s*$", "im");
  const match = text.match(re);
  return match ? match[1] : null;
}

function readPacAuth(opts = {}) {
  if (cache !== undefined) return cache;
  if (opts._exec === false) {
    cache = null;
    return null;
  }
  const exec = typeof opts._exec === "function" ? opts._exec : execFileSync;
  let output;
  try {
    output = exec("pac", ["auth", "who"], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    cache = null;
    return null;
  }
  if (typeof output !== "string" || !output) {
    cache = null;
    return null;
  }
  const tenantId = pickLine(output, "Tenant Id");
  const orgId = pickLine(output, "Organization Id");
  const cloud = pickLine(output, "Cloud");
  if (!tenantId && !orgId) {
    cache = null;
    return null;
  }
  cache = {
    orgId: orgId || "",
    tenantId: tenantId || "",
    cloud: cloud || "",
  };
  return cache;
}

module.exports = { readPacAuth, _resetCache };
