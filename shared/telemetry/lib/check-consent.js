#!/usr/bin/env node
"use strict";

const consent = require("./consent");

const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || undefined;
const result = consent.read({ configDir });

// Default posture is enabled. Output is now binary: ENABLED or DISABLED.
const word = result.state === "disabled" ? "DISABLED" : "ENABLED";

process.stdout.write(word + "\n");
process.exit(0);
