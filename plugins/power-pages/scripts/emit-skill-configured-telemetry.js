#!/usr/bin/env node
"use strict";

const telemetry = require("./lib/telemetry/power-pages-telemetry");

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

function parseBoolean(value) {
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  return undefined;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const skillName = args.skillName;
  if (skillName === "create-site") {
    telemetry.emitSkillConfigured(
      skillName,
      args.projectRoot,
      telemetry.buildCreateSiteEventInfo({
        framework: args.framework,
        siteContentLocale: args.siteContentLocale,
        purpose: args.purpose,
        audience: args.audience,
        choiceSource: args.choiceSource,
      })
    );
  } else if (skillName === "add-localization") {
    telemetry.emitSkillConfigured(
      skillName,
      args.projectRoot,
      telemetry.buildLocalizationEventInfo({
        framework: args.framework,
        operation: args.operation,
        invocationSource: args.invocationSource,
        existingLocalizationDetected: parseBoolean(args.existingLocalizationDetected),
        mode: args.mode,
        defaultLocale: args.defaultLocale,
        addedLocales: args.addedLocales,
        resultingLocales: args.resultingLocales,
        packageName: args.packageName,
        packageVersion: args.packageVersion,
        packageSelection: args.packageSelection,
        packageVerification: args.packageVerification,
        translationMethod: args.translationMethod,
      })
    );
  }
}

try {
  main();
} catch {
  // Configuration telemetry must never change a skill's behavior or exit code.
}
