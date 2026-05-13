"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let pacCliVersionCache;

// Reads the PAC CLI version once per process via `pac --version`. Best-effort
// and fail-closed: missing executable, timeout, or unparseable output all
// resolve to "".
function readPacCliVersion(opts = {}) {
  if (pacCliVersionCache !== undefined) return pacCliVersionCache;
  if (opts._exec === false) {
    pacCliVersionCache = "";
    return "";
  }
  const exec = typeof opts._exec === "function" ? opts._exec : execFileSync;
  try {
    const out = exec("pac", ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = String(out || "").match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
    pacCliVersionCache = match ? match[1] : "";
  } catch {
    pacCliVersionCache = "";
  }
  return pacCliVersionCache;
}

// Test seam.
function _resetCache() {
  pacCliVersionCache = undefined;
}

// Detects the AI agent host. Prefers explicit env vars; falls back to the
// Claude Code package.json version when CLAUDECODE=1.
function readAiAgent(env = process.env) {
  const explicitName = env.AI_AGENT_NAME;
  const explicitVersion = env.AI_AGENT_VERSION;
  if (explicitName) {
    return {
      aiAgentName: explicitName,
      aiAgentVersion: explicitVersion || "",
    };
  }
  if (env.CLAUDECODE === "1") {
    let version = "";
    const execPath = env.CLAUDE_CODE_EXECPATH;
    if (execPath) {
      try {
        const pkgPath = path.join(path.dirname(execPath), "..", "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg && typeof pkg.version === "string") version = pkg.version;
      } catch {
        // pkg unreadable; leave version empty
      }
    }
    return { aiAgentName: "Claude Code", aiAgentVersion: version };
  }
  return { aiAgentName: "", aiAgentVersion: "" };
}

module.exports = { readPacCliVersion, readAiAgent, _resetCache };
