"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let pacCliVersionCache;

// Reads the PAC CLI version once per process via `pac --version`. Best-effort
// and fail-closed: missing executable, timeout, or unparseable output all
// resolve to "".
//
// PAC 2.x prints the version banner ("Version: X.Y.Z+...") to stdout as part
// of its preamble but then treats `--version` as an unknown command and
// exits with status 1. execFileSync throws on non-zero exit, attaching the
// captured stdout to err.stdout — so we parse that fallback path too.
function readPacCliVersion(opts = {}) {
  if (pacCliVersionCache !== undefined) return pacCliVersionCache;
  if (opts._exec === false) {
    pacCliVersionCache = "";
    return "";
  }
  const exec = typeof opts._exec === "function" ? opts._exec : execFileSync;
  let stdout = "";
  try {
    stdout = exec("pac", ["--version"], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    stdout = (err && err.stdout) ? String(err.stdout) : "";
  }
  const match = String(stdout || "").match(/Version:\s*(\d+\.\d+\.\d+(?:\.\d+)?)/);
  pacCliVersionCache = match ? match[1] : "";
  return pacCliVersionCache;
}

// Test seam.
function _resetCache() {
  pacCliVersionCache = undefined;
}

// Reads the Claude Code CLI version from its installed package.json. The
// hook subprocess inherits CLAUDE_CODE_EXECPATH from Claude Code; jumping
// one directory above the executable's bin/ lands on the npm package root.
function readClaudeCodeVersion(env) {
  const execPath = env.CLAUDE_CODE_EXECPATH;
  if (!execPath) return "";
  try {
    const pkgPath = path.join(path.dirname(execPath), "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg && typeof pkg.version === "string") return pkg.version;
  } catch {
    // pkg unreadable; fall through to empty
  }
  return "";
}

// Detects the AI agent host. Prefers explicit env vars; falls back to
// built-in detection for Claude Code (CLAUDECODE=1) and GitHub Copilot
// CLI (COPILOT_CLI=1). When AI_AGENT_NAME is set explicitly but
// AI_AGENT_VERSION is empty, backfill the version from whichever
// built-in detector matches — avoids emitting an empty aiAgentVersion
// just because the settings file only carried half the pair.
function readAiAgent(env = process.env) {
  const explicitName = env.AI_AGENT_NAME;
  const explicitVersion = env.AI_AGENT_VERSION;
  if (explicitName) {
    let version = explicitVersion || "";
    if (!version) {
      if (env.CLAUDECODE === "1") {
        version = readClaudeCodeVersion(env);
      } else if (env.COPILOT_CLI === "1") {
        version = env.COPILOT_CLI_BINARY_VERSION || "";
      }
    }
    return { aiAgentName: explicitName, aiAgentVersion: version };
  }
  if (env.CLAUDECODE === "1") {
    return {
      aiAgentName: "Claude Code",
      aiAgentVersion: readClaudeCodeVersion(env),
    };
  }
  if (env.COPILOT_CLI === "1") {
    return {
      aiAgentName: "Copilot CLI",
      aiAgentVersion: env.COPILOT_CLI_BINARY_VERSION || "",
    };
  }
  return { aiAgentName: "", aiAgentVersion: "" };
}

module.exports = { readPacCliVersion, readAiAgent, _resetCache };
