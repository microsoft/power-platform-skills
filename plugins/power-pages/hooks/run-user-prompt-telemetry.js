#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

let emitFromPrompt, hookUtils, sessionLib, detectFramework;
try {
  emitFromPrompt = require(path.join(
    TELEMETRY_DIR,
    "lib",
    "emit-from-prompt"
  ));
  hookUtils = require(path.join(
    PLUGIN_ROOT,
    "scripts",
    "lib",
    "powerpages-hook-utils"
  ));
  sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
  detectFramework = require(path.join(
    PLUGIN_ROOT,
    "scripts",
    "lib",
    "detect-site-framework"
  ));
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
    emitFromPrompt.emitSkillStartedFromPrompt(prompt, {
      pluginName: "power-pages",
      pluginVersion: readPluginVersion(),
      trackedSkills: hookUtils.TRACKED_SKILLS,
      telemetryDir: TELEMETRY_DIR,
      sessionId: sessionLib.resolveHostSessionId(parsed),
      // Thunk, not a value: this hook fires on EVERY user prompt, but the
      // library invokes this only after the prompt is confirmed to be a tracked
      // slash command AND the plugin is enabled + provisioned. Detecting eagerly
      // here would walk the filesystem on every keystroke-level prompt for no
      // reason. Claude Code supplies the host cwd on the payload; fall back to
      // this process's cwd for hosts that don't.
      eventInfo: () => {
        const framework = detectFramework.detectSiteFramework(
          typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : process.cwd()
        );
        return framework ? { framework } : null;
      },
    });
  } catch {
    // fail closed — telemetry never blocks the user's prompt
  }

  process.exit(0);
})().catch(() => process.exit(0));
