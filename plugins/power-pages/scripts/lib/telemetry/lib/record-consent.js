#!/usr/bin/env node
"use strict";

const consent = require("./consent");

const args = process.argv.slice(2);
const answerIdx = args.indexOf("--answer");
const answer = answerIdx !== -1 ? args[answerIdx + 1] : null;

if (answer !== "yes" && answer !== "no") {
  process.stderr.write('Usage: record-consent.js --answer yes|no\n');
  process.exit(2);
}

const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || undefined;
consent.write({ configDir, enabled: answer === "yes" });
process.exit(0);
