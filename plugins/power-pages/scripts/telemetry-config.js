#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--action" || !["on", "off", "status"].includes(args[1])) {
  console.error("Usage: telemetry-config.js --action <on|off|status>");
  process.exit(2);
}

// Keep the shared library byte-identical across plugins; only Power Pages
// adds this disclosure. Delegate preference changes so env opt-outs still win.
const result = spawnSync(
  process.execPath,
  [path.join(__dirname, "lib", "telemetry", "lib", "telemetry-config.js"), ...args, "--plugin", "power-pages"],
  { stdio: "inherit" }
);
if (result.error || result.signal) {
  console.error(`Could not run telemetry configuration: ${result.error ? result.error.message : result.signal}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(
  "   Non-SPA creation also records template_used and non_spa_creation_success\n" +
  "   or non_spa_creation_failure with a shared correlationId, public catalog\n" +
  "   eventInfo.templateId, eventInfo.templateKind (non-spa), optional\n" +
  "   eventInfo.audience (internal/external), and a fixed failure category.\n" +
  "   Success means a validated, committed downloaded baseline, not customization.\n" +
  "   Private correlation receipts remain in telemetry/power-pages/non-spa-creations\n" +
  "   under the config directory even when transmission is off. They contain the\n" +
  "   selected public catalog revision, common context and terminal marker; receipts\n" +
  "   older than 14 days are pruned on a later selection. Hard-off writes none."
);
