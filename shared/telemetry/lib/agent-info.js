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

// Parses a dotted semver out of the AI_AGENT env var. Claude Code sets
// AI_AGENT=claude-code_<maj>-<min>-<patch>_agent (e.g.
// "claude-code_2-1-156_agent"); the version segment uses dashes, so we
// normalize separators to dots. The "claude-code" name prefix carries no
// digits, so the first numeric run is the version.
function parseVersionFromAiAgent(aiAgent) {
  if (typeof aiAgent !== "string") return "";
  const match = aiAgent.match(/\d+(?:[._-]\d+)+/);
  return match ? match[0].replace(/[._-]/g, ".") : "";
}

// Reads the Claude Code CLI version. Primary source is the installed
// package.json: the hook subprocess inherits CLAUDE_CODE_EXECPATH from Claude
// Code, and jumping one directory above the executable's bin/ lands on the npm
// package root. That layout only exists for npm-global installs — the native
// installer ships a standalone binary with no sibling package.json — so when
// the read yields nothing, fall back to the version carried in AI_AGENT, which
// Claude Code sets regardless of install method.
function readClaudeCodeVersion(env) {
  const execPath = env.CLAUDE_CODE_EXECPATH;
  if (execPath) {
    try {
      const pkgPath = path.join(path.dirname(execPath), "..", "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg && typeof pkg.version === "string") return pkg.version;
    } catch {
      // pkg unreadable; fall through to the AI_AGENT fallback
    }
  }
  return parseVersionFromAiAgent(env.AI_AGENT);
}

function isTruthyEnv(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function firstEnv(env, keys) {
  for (const key of keys) {
    if (typeof env[key] === "string" && env[key]) return env[key];
  }
  return "";
}

function normalizeAgentName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const AGENT_DETECTORS = [
  {
    name: "Claude Code",
    aliases: ["claude", "claudecode"],
    isPresent: (env) => isTruthyEnv(env.CLAUDECODE),
    version: readClaudeCodeVersion,
  },
  {
    name: "Copilot CLI",
    aliases: ["copilot", "copilotcli", "githubcopilot", "githubcopilotcli"],
    isPresent: (env) => isTruthyEnv(env.COPILOT_CLI),
    version: (env) =>
      firstEnv(env, ["COPILOT_CLI_BINARY_VERSION", "COPILOT_CLI_VERSION"]),
  },
  {
    name: "Codex",
    aliases: ["codex", "codexcli", "openaicodex"],
    isPresent: (env) => isTruthyEnv(env.CODEX_CLI) || isTruthyEnv(env.CODEX),
    version: (env) =>
      firstEnv(env, [
        "CODEX_CLI_BINARY_VERSION",
        "CODEX_CLI_VERSION",
        "CODEX_VERSION",
      ]) || parseVersionFromAiAgent(env.AI_AGENT),
  },
  {
    name: "OpenCode",
    aliases: ["opencode", "opencodecli", "open_code"],
    isPresent: (env) => isTruthyEnv(env.OPENCODE_CLI) || isTruthyEnv(env.OPENCODE),
    version: (env) =>
      firstEnv(env, [
        "OPENCODE_CLI_BINARY_VERSION",
        "OPENCODE_CLI_VERSION",
        "OPENCODE_VERSION",
      ]) || parseVersionFromAiAgent(env.AI_AGENT),
  },
  {
    name: "Hermes",
    aliases: ["hermes", "hermescli", "hermesagent"],
    isPresent: (env) =>
      isTruthyEnv(env.HERMES_CLI) ||
      isTruthyEnv(env.HERMES) ||
      isTruthyEnv(env.HERMES_AGENT),
    version: (env) =>
      firstEnv(env, [
        "HERMES_CLI_BINARY_VERSION",
        "HERMES_CLI_VERSION",
        "HERMES_AGENT_VERSION",
        "HERMES_VERSION",
      ]) || parseVersionFromAiAgent(env.AI_AGENT),
  },
  {
    name: "OpenClaw",
    aliases: ["openclaw", "openclawcli"],
    isPresent: (env) =>
      isTruthyEnv(env.OPENCLAW_CLI) || isTruthyEnv(env.OPENCLAW),
    version: (env) =>
      firstEnv(env, [
        "OPENCLAW_CLI_BINARY_VERSION",
        "OPENCLAW_CLI_VERSION",
        "OPENCLAW_VERSION",
      ]) || parseVersionFromAiAgent(env.AI_AGENT),
  },
];

function detectorForName(name) {
  const normalized = normalizeAgentName(name);
  return AGENT_DETECTORS.find((detector) =>
    detector.aliases.some((alias) => normalizeAgentName(alias) === normalized)
  );
}

function detectFromAiAgent(env) {
  const aiAgent = env.AI_AGENT;
  if (typeof aiAgent !== "string" || !aiAgent) return null;
  const normalized = normalizeAgentName(aiAgent);
  const detector = AGENT_DETECTORS.find((candidate) =>
    candidate.aliases.some((alias) => normalized.includes(normalizeAgentName(alias)))
  );
  if (!detector) return null;
  return {
    aiAgentName: detector.name,
    aiAgentVersion: detector.version(env) || parseVersionFromAiAgent(aiAgent),
  };
}

function detectKnownAgent(env) {
  for (const detector of AGENT_DETECTORS) {
    if (detector.isPresent(env)) {
      return {
        aiAgentName: detector.name,
        aiAgentVersion: detector.version(env) || "",
      };
    }
  }
  return detectFromAiAgent(env);
}

// Detects the AI agent host. Prefers explicit env vars; falls back to
// built-in detection for known CLI hosts. When AI_AGENT_NAME is set explicitly
// but AI_AGENT_VERSION is empty, backfill the version from whichever detector
// matches — avoids emitting an empty aiAgentVersion just because the settings
// file only carried half the pair.
function readAiAgent(env = process.env) {
  const explicitName = env.AI_AGENT_NAME;
  const explicitVersion = env.AI_AGENT_VERSION;
  if (explicitName) {
    let version = explicitVersion || "";
    if (!version) {
      const explicitDetector = detectorForName(explicitName);
      const detected = detectKnownAgent(env);
      if (explicitDetector) version = explicitDetector.version(env) || "";
      if (!version && detected) version = detected.aiAgentVersion || "";
    }
    return { aiAgentName: explicitName, aiAgentVersion: version };
  }
  const detected = detectKnownAgent(env);
  if (detected) return detected;
  return { aiAgentName: "", aiAgentVersion: "" };
}

module.exports = { readPacCliVersion, readAiAgent, _resetCache };
