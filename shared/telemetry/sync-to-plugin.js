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

function copyDir(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copyFile(src, dst);
  }
}

const PLACEHOLDER_IKEY = "PLACEHOLDER_REPLACE_BEFORE_SHIPPING";

// The shared ikey.json ships the placeholder template; each adopting plugin's
// synced copy carries that plugin's real (or real-but-disabled) iKey. Copying
// it unconditionally would clobber the target's real key with the placeholder
// on every re-sync. So preserve a target that has already been provisioned —
// only seed ikey.json when the target is missing or still on the placeholder.
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

// Library + iKey config → <target>/scripts/lib/telemetry/
const telemetryDst = path.join(target, "scripts", "lib", "telemetry");
fs.mkdirSync(telemetryDst, { recursive: true });

copyDir(path.join(source, "lib"), path.join(telemetryDst, "lib"));
const ikeyOutcome = syncIkey(
  path.join(source, "ikey.json"),
  path.join(telemetryDst, "ikey.json")
);

process.stdout.write(
  `Synced shared/telemetry → ${telemetryDst} (ikey.json ${ikeyOutcome})\n`
);
process.exit(0);
