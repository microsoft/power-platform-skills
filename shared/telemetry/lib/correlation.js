"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// TTL for stale correlation files. PostToolUse normally clears the file
// immediately. If it never fires (Claude Code killed, skill timeout, etc.),
// the next PreToolUse sweep unlinks anything older than this.
const STALE_TTL_MS = 60 * 60 * 1000;

// Concurrent-same-skill race: if two invocations of the same skill overlap
// (extremely rare in single-agent Claude Code usage), the second write
// clobbers the first. Both posttool reads return the second's UUID.
// Documented, not structurally fixed.

function correlationPath({ skillName, tmpDir }) {
  const dir = tmpDir || os.tmpdir();
  const safe = String(skillName || "unknown").replace(/[^a-z0-9-]/gi, "_");
  return path.join(dir, `ppskills-corr-${safe}.json`);
}

function sweepStale(tmpDir) {
  const dir = tmpDir || os.tmpdir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TTL_MS;
  for (const name of entries) {
    if (!name.startsWith("ppskills-corr-") || !name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
      }
    } catch {
      // ignore: best-effort sweep
    }
  }
}

function write({ skillName, tmpDir }) {
  sweepStale(tmpDir);
  const record = {
    correlation_id: crypto.randomUUID(),
    start_ts: Date.now(),
  };
  try {
    fs.writeFileSync(
      correlationPath({ skillName, tmpDir }),
      JSON.stringify(record),
      "utf8"
    );
  } catch {
    // fail closed
  }
  return record;
}

function read({ skillName, tmpDir }) {
  try {
    const raw = fs.readFileSync(correlationPath({ skillName, tmpDir }), "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.correlation_id === "string" &&
      typeof parsed.start_ts === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clear({ skillName, tmpDir }) {
  try {
    fs.unlinkSync(correlationPath({ skillName, tmpDir }));
  } catch {
    // ignore
  }
}

module.exports = { correlationPath, write, read, clear, STALE_TTL_MS };
