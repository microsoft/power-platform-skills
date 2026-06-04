#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const target = getArg("target");
if (!target) {
  process.stderr.write("Usage: sync-to-plugin.js --target <plugin-dir>\n");
  process.exit(1);
}

const source = path.resolve(__dirname);

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

const PLACEHOLDER_IKEY = "PLACEHOLDER_REPLACE_BEFORE_SHIPPING";

// The library CODE is NOT copied into the plugin — adopting plugins require it
// directly from shared/telemetry/lib (single source of truth, no duplication).
// This script only seeds the per-plugin ikey.json config for a NEW adopter and
// preserves an already-provisioned config on re-run: the shared ikey.json ships
// the placeholder template, so seed only when the target is missing or still on
// the placeholder, never clobbering a target's real key.
function syncIkey(from, to) {
  if (fs.existsSync(to)) {
    try {
      const targetCfg = JSON.parse(fs.readFileSync(to, "utf8"));
      if (targetCfg.instrumentationKey && targetCfg.instrumentationKey !== PLACEHOLDER_IKEY) {
        return "preserved";
      }
    } catch {
      // Unreadable/garbage target → fall through and overwrite with the template.
    }
  }
  copyFile(from, to);
  return "seeded";
}

// Per-plugin iKey config only → <target>/scripts/lib/telemetry/ikey.json.
// No lib/ is copied; the plugin's hooks require shared/telemetry/lib directly.
const telemetryDst = path.join(target, "scripts", "lib", "telemetry");
fs.mkdirSync(telemetryDst, { recursive: true });

const ikeyOutcome = syncIkey(
  path.join(source, "ikey.json"),
  path.join(telemetryDst, "ikey.json")
);

process.stdout.write(
  `Seeded ${telemetryDst}/ikey.json (${ikeyOutcome}); library required directly from shared/telemetry/lib\n`
);
process.exit(0);
