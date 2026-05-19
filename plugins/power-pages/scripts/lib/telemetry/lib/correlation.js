"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function correlationPath({ skillName, tmpDir }) {
  const dir = tmpDir || os.tmpdir();
  const safe = String(skillName || "unknown").replace(/[^a-z0-9-]/gi, "_");
  return path.join(dir, `ppskills-corr-${safe}.json`);
}

function write({ skillName, tmpDir }) {
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

module.exports = { correlationPath, write, read, clear };
