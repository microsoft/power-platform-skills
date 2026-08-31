"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function configDir() {
  return (
    process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR ||
    path.join(os.homedir(), ".power-platform-skills")
  );
}

function safeSkillName(skillName) {
  return String(skillName || "").replace(/[^a-z0-9-]/gi, "_") || "unknown";
}

function projectHash(projectRoot) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) return "";
  const resolved = path.resolve(projectRoot);
  return crypto
    .createHash("sha256")
    .update(process.platform === "win32" ? resolved.toLowerCase() : resolved)
    .digest("hex");
}

function stateDir(skillName) {
  return path.join(
    configDir(),
    "telemetry",
    "power-pages",
    "invocations",
    safeSkillName(skillName)
  );
}

function stateFile(skillName, sessionId) {
  const sessionHash = crypto
    .createHash("sha256")
    .update(String(sessionId || "nosession"))
    .digest("hex");
  return path.join(stateDir(skillName), `${sessionHash}.json`);
}

function writeState(skillName, state) {
  const file = stateFile(skillName, state.sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

function recordStart(skillName, sessionId, projectRoot, now = Date.now()) {
  if (!skillName || !sessionId) return null;
  prune(skillName, now);
  return writeState(skillName, {
    sessionId,
    startedAt: now,
    projectHash: projectHash(projectRoot),
  });
}

function readStates(skillName, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(stateDir(skillName), { withFileTypes: true });
  } catch {
    return [];
  }
  const states = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(stateDir(skillName), entry.name);
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        typeof state.sessionId !== "string" ||
        typeof state.startedAt !== "number" ||
        now - state.startedAt > MAX_AGE_MS
      ) {
        continue;
      }
      states.push({ ...state, file });
    } catch {
      // Ignore a partial or malformed best-effort timing record.
    }
  }
  return states.sort((a, b) => b.startedAt - a.startedAt);
}

function findActive(
  skillName,
  projectRoot,
  { requireConfigured = false, sessionId = "" } = {}
) {
  const states = readStates(skillName).filter(
    (state) => !requireConfigured || typeof state.configuredAt === "number"
  );
  if (sessionId) {
    return states.find((state) => state.sessionId === sessionId) || null;
  }
  const hash = projectHash(projectRoot);
  return states.find((state) => hash && state.projectHash === hash) || states[0] || null;
}

function markConfigured(skillName, projectRoot, now = Date.now()) {
  const active = findActive(skillName, projectRoot);
  if (!active) return null;
  const { file, ...state } = active;
  return writeState(skillName, { ...state, configuredAt: now });
}

function removeState(state) {
  if (!state || !state.file) return;
  try {
    fs.unlinkSync(state.file);
  } catch {
    // A missing timing record only means duration cannot be correlated again.
  }
}

function prune(skillName, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(stateDir(skillName), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(stateDir(skillName), entry.name);
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof state.startedAt !== "number" || now - state.startedAt > MAX_AGE_MS) {
        fs.unlinkSync(file);
      }
    } catch {
      try {
        fs.unlinkSync(file);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

module.exports = {
  MAX_AGE_MS,
  findActive,
  markConfigured,
  projectHash,
  recordStart,
  removeState,
};
