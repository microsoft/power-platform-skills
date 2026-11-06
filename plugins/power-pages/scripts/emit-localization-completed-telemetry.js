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
  const outcome = String(args.outcome || "success").trim().toLowerCase();
  const validationOutcome = String(
    args.validationOutcome || (outcome === "failure" ? "failed" : "passed")
  ).trim().toLowerCase();
  if (!new Set(["success", "failure"]).has(outcome)) return;
  if (!new Set(["passed", "failed"]).has(validationOutcome)) return;
  if (
    outcome === "failure" &&
    !telemetry.LOCALIZATION_COMPLETION_ERROR_CLASSES.has(args.errorClass)
  ) {
    return;
  }
  let manifest = null;
  try {
    manifest = JSON.parse(
      fs.readFileSync(
        path.join(projectRoot, ".powerpages-localization.json"),
        "utf8"
      )
    );
  } catch {
    if (outcome === "success") return;
  }
  const readiness = manifest?.bidirectionalReadiness?.status;
  telemetry.emitLocalizationCompleted(projectRoot, {
    sessionId: "",
    outcome,
    errorClass: outcome === "failure" ? args.errorClass : undefined,
    eventInfo: telemetry.buildLocalizationCompletionEventInfo({
      validationOutcome,
      bidirectionalReadiness:
        typeof readiness === "string"
          ? readiness
          : manifest
            ? "not-required"
            : undefined,
      unavailableLocaleCount: Array.isArray(manifest?.unavailableLocales)
        ? manifest.unavailableLocales.length
        : undefined,
      configuredLocaleCount: Array.isArray(manifest?.locales)
        ? manifest.locales.length
        : undefined,
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
