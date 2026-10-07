#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

let telemetry = null;
try {
  telemetry = require("./lib/telemetry/power-pages-telemetry");
} catch {
  // Completion telemetry must never affect the completed localization workflow.
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function main() {
  if (!telemetry) return;
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.projectRoot !== "string" || !args.projectRoot.trim()) return;
  const projectRoot = path.resolve(args.projectRoot);
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(projectRoot, ".powerpages-localization.json"),
      "utf8"
    )
  );
  const readiness = manifest?.bidirectionalReadiness?.status;
  telemetry.emitLocalizationCompleted(projectRoot, {
    sessionId: "",
    outcome: "success",
    eventInfo: telemetry.buildLocalizationCompletionEventInfo({
      validationOutcome: "passed",
      bidirectionalReadiness:
        typeof readiness === "string" ? readiness : "not-required",
      unavailableLocaleCount: Array.isArray(manifest?.unavailableLocales)
        ? manifest.unavailableLocales.length
        : 0,
      configuredLocaleCount: Array.isArray(manifest?.locales)
        ? manifest.locales.length
        : 0,
      translationMethod:
        manifest?.translationMethod === "agent" ||
        manifest?.translationMethod === "blank"
          ? manifest.translationMethod
          : undefined,
    }),
  });
}

try {
  main();
} catch {
  // Completion telemetry is optional and must remain fail-closed.
}
