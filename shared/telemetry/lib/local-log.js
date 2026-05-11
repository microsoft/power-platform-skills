"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LOG_FILE_NAME = "events.jsonl";
const ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB

function rotationName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  return `events.${stamp}.old`;
}

function rotateIfNeeded(dir, logFile) {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > ROTATE_BYTES) {
      try {
        fs.renameSync(logFile, path.join(dir, rotationName()));
      } catch {
        // best effort: if rename fails (file locked, etc.), keep appending.
      }
    }
  } catch {
    // no existing log — nothing to rotate
  }
}

function appendLocal(event, { configDir } = {}) {
  if (!configDir) return;
  try {
    fs.mkdirSync(configDir, { recursive: true });
  } catch {
    return;
  }
  const logFile = path.join(configDir, LOG_FILE_NAME);
  rotateIfNeeded(configDir, logFile);
  try {
    fs.appendFileSync(logFile, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // swallow — fail closed
  }
}

module.exports = { appendLocal, LOG_FILE_NAME, ROTATE_BYTES };
