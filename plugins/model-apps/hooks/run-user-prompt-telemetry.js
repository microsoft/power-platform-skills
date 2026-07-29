#!/usr/bin/env node
"use strict";

/**
 * UserPromptSubmit telemetry hook for the model-apps plugin.
 *
 * Emits `skill_started` when the submitted prompt is a tracked `/model-apps:<skill>`
 * (or bare `/<skill>`) slash command. This complements the PreToolUse(Skill) hook:
 * some hosts surface a slash-command skill as a prompt rather than a Skill tool call.
 *
 * Delegates all gating (repo kill switch, provisioned check, opt-out, local mirror,
 * POST) to the shared emit-from-prompt helper. Fail-closed: any error exits 0 so
 * telemetry never blocks the user's prompt.
 */

const path = require("node:path");
const fs = require("node:fs");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

// Master kill-switch: MODEL_APPS_DISABLE_HOOKS=1 disables every model-apps hook
// (validators + telemetry emit) — an operator escape hatch. Checked before any
// requires/stdin/work so it is a clean no-op (exit 0). Telemetry also has its own
// finer-grained opt-out (ikey.json disabled, /model-apps:telemetry off, *_OPTOUT).
if (process.env.MODEL_APPS_DISABLE_HOOKS === "1" || process.env.MODEL_APPS_DISABLE_HOOKS === "true") {
  process.exit(0);
}

let emitFromPrompt, hookUtils, sessionLib, pacAuthLib;
try {
  emitFromPrompt = require(path.join(TELEMETRY_DIR, "lib", "emit-from-prompt"));
  hookUtils = require(path.join(PLUGIN_ROOT, "scripts", "lib", "modelapps-hook-utils"));
  sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
  pacAuthLib = require(path.join(TELEMETRY_DIR, "lib", "pac-auth"));
} catch {
  process.exit(0);
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
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
      pluginName: "model-apps",
      pluginVersion: readPluginVersion(),
      trackedSkills: hookUtils.TRACKED_SKILLS,
      telemetryDir: TELEMETRY_DIR,
      sessionId: sessionLib.resolveHostSessionId(parsed),
      // Drop the Entra directory object id before the shared helper attaches it as
      // eventInfo — model-apps telemetry carries no user-level identifier (an
      // intentional drift from power-pages). Org/tenant GUIDs still flow via the
      // helper's own pacAuth reads.
      _readPacAuth: () => {
        const a = pacAuthLib.readPacAuth();
        if (a && a.objectId) delete a.objectId;
        return a;
      },
    });
  } catch {
    // fail closed — telemetry never blocks the user's prompt
  }

  process.exit(0);
})().catch(() => process.exit(0));
