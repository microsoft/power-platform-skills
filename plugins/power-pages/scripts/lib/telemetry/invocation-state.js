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

function stateFile(skillName, sessionId, projectHashValue) {
  const invocationHash = crypto
    .createHash("sha256")
    .update(`${String(sessionId || "nosession")}\0${projectHashValue}`)
    .digest("hex");
  return path.join(stateDir(skillName), `${invocationHash}.json`);
}

function writeState(skillName, state) {
  const { file: previousFile, ...persistedState } = state;
  if (!persistedState.projectHash) return null;
  const file = stateFile(
    skillName,
    persistedState.sessionId,
    persistedState.projectHash
  );
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(persistedState), "utf8");
    fs.renameSync(tmp, file);
    if (previousFile && path.resolve(previousFile) !== path.resolve(file)) {
      try {
        fs.unlinkSync(previousFile);
      } catch {
        // A legacy timing record may already have been removed.
      }
    }
    return file;
  } catch {
    return null;
  }
}

function recordStart(skillName, sessionId, projectRoot, now = Date.now()) {
  if (!skillName || !sessionId) return null;
  const hash = projectHash(projectRoot);
  if (!hash) return null;
  prune(skillName, now);
  return writeState(skillName, {
    sessionId,
    startedAt: now,
    projectHash: hash,
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
        !/^[a-f0-9]{64}$/.test(state.projectHash) ||
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
  {
    requireConfigured = false,
    sessionId = "",
    allowLatestFallback = false,
    allowSessionOnly = false,
  } = {}
) {
  const states = readStates(skillName).filter(
    (state) => !requireConfigured || typeof state.configuredAt === "number"
  );
  const hash = projectHash(projectRoot);
  if (sessionId && hash) {
    return states.find(
      (state) =>
        state.sessionId === sessionId &&
        state.projectHash === hash
    ) || null;
  }
  if (sessionId) {
    if (!allowSessionOnly) return null;
    const sessionMatches = states.filter(
      (state) => state.sessionId === sessionId
    );
    return sessionMatches.length === 1 ? sessionMatches[0] : null;
  }
  if (!hash) return null;
  return states.find((state) => state.projectHash === hash) ||
    (allowLatestFallback ? states[0] : null);
}

function markConfigured(skillName, projectRoot, now = Date.now()) {
  const active = findActive(skillName, projectRoot);
  if (!active) return null;
  return writeState(skillName, { ...active, configuredAt: now });
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
