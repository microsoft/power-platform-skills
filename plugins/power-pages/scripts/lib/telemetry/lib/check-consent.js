#!/usr/bin/env node
"use strict";

const consent = require("./consent");

const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || undefined;
const result = consent.read({ configDir });

const word =
  result.state === "enabled"
    ? "ENABLED"
    : result.state === "disabled"
    ? "DISABLED"
    : "NEEDS_PROMPT";

process.stdout.write(word + "\n");
process.exit(0);
