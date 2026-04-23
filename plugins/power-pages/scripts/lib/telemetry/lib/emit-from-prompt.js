"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { detectSlashCommand } = require("./prompt-detector");
const { buildSkillStarted } = require("./events");
const { getSessionId } = require("./session");
const { fireAndForget } = require("./emit-spawn");

function readIkey(telemetryDir) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(telemetryDir, "ikey.json"), "utf8")
    );
    return { ikey: cfg.ikey || "", collectorUrl: cfg.collector_url || "" };
  } catch {
    return { ikey: "", collectorUrl: "" };
  }
}

function emitSkillStartedFromPrompt(promptText, opts = {}) {
  const {
    pluginName,
    pluginVersion,
    trackedSkills,
    telemetryDir,
    _emit, // test seam; defaults to fireAndForget
  } = opts;

  const skillName = detectSlashCommand(promptText, { pluginName, trackedSkills });
  if (!skillName) return { emitted: false, skillName: null };

  const { ikey, collectorUrl } = readIkey(telemetryDir);

  const event = buildSkillStarted({
    plugin_name: pluginName,
    plugin_version: pluginVersion || "unknown",
    session_id: getSessionId(),
    os_family: process.platform,
    node_version: "v" + String(process.versions.node).split(".")[0],
    skill_name: skillName,
    correlation_id: crypto.randomUUID(),
  });

  const emit = typeof _emit === "function" ? _emit : fireAndForget;
  try {
    emit(event, {
      iKey: ikey,
      collectorUrl,
      configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "",
      fakeProbe: process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "",
    });
  } catch {
    // fail closed — telemetry never propagates errors
  }

  return { emitted: true, skillName };
}

module.exports = { emitSkillStartedFromPrompt };
