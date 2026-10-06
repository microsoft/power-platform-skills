#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

let emitFromPrompt, hookUtils, sessionLib;
try {
  // async-ext wraps lib/emit-from-prompt with non-blocking, disk-cached PAC
  // reads; lib/ itself is a byte-identical copy of the shared library.
  emitFromPrompt = require(path.join(TELEMETRY_DIR, "async-ext"));
  hookUtils = require(path.join(
    PLUGIN_ROOT,
    "scripts",
    "lib",
    "pa-hook-utils"
  ));
  sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
} catch {
  process.exit(0);
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"),
        "utf8"
      )
    );
    return manifest.version || "unknown";
  } catch {
    return "unknown";
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

(async () => {
  const raw = await readStdin();
  if (!raw) process.exit(0);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
  if (!prompt) process.exit(0);

  try {
    await emitFromPrompt.emitSkillStartedFromPromptAsync(prompt, {
      pluginName: "power-automate",
      pluginVersion: readPluginVersion(),
      trackedSkills: hookUtils.TRACKED_SKILLS,
      telemetryDir: TELEMETRY_DIR,
      sessionId: sessionLib.resolveHostSessionId(parsed),
    });
  } catch {
    // fail closed — telemetry never blocks the user's prompt
  }

  process.exit(0);
})().catch(() => process.exit(0));
