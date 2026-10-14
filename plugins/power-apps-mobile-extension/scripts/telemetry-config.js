"use strict";

const { PLUGIN_NAME } = require("./lib/telemetry/schema");
const { readConfig, enabled, configDir } = require("./lib/telemetry/config");
const { effectiveTelemetryChoice, setTelemetryChoice, telemetryOptOutEnvVarName } = require("./lib/telemetry/lib/user-config");
const { pluginLogDir, latestSessionLog } = require("./lib/telemetry/lib/local-log");

function run(action = "status", options = {}) {
  const selected = ["on", "off", "status"].includes(action) ? action : "status";
  const env = options.env || process.env;
  const directory = configDir(env);
  if (selected !== "status" && !setTelemetryChoice(directory, PLUGIN_NAME, selected)) {
    return { code: 1, output: "Could not save the telemetry preference: configuration is not writable." };
  }
  const active = enabled(readConfig(options.configPath));
  const preference = effectiveTelemetryChoice(directory, PLUGIN_NAME, env);
  const lines = [];
  if (selected !== "status") lines.push(`Saved transmission preference: ${selected.toUpperCase()}.`);
  if (!active) {
    lines.push("Telemetry: HARD-DISABLED by plugin configuration. No event collection, local telemetry logging or transmission.");
    lines.push("A saved ON preference cannot override the maintainer-controlled release switch.");
  } else if (preference === "off") {
    lines.push("Telemetry transmission: OFF. Local diagnostic logging continues, including available identity fields.");
  } else {
    lines.push("Telemetry transmission: ON (default). Sending requires a supported, resolved destination.");
  }
  lines.push(`Transmission choice after the release gate: ${active && preference !== "off" ? "ON" : "OFF"}.`);
  lines.push(`Environment override: ${telemetryOptOutEnvVarName(PLUGIN_NAME)}=1 or true forces transmission OFF, even after the on command.`);
  lines.push("When enabled, events include skill/plugin, OS/Node, agent/PAC versions, session/correlation IDs and available organization, tenant and Entra user object IDs.");
  lines.push("No prompts, arguments, source code, paths, credentials, free-text errors, outcomes, durations or build targets are recorded.");
  lines.push("Opt-out stops transmission only, not the local mirror. Neither off nor hard-disable deletes previously collected data.");
  lines.push(`Logs directory: ${pluginLogDir(directory, PLUGIN_NAME)}`);
  const latest = latestSessionLog(directory, PLUGIN_NAME);
  if (latest) lines.push(`Most recent session log: ${latest}`);
  lines.push(`Control with /${PLUGIN_NAME}:telemetry on|off|status.`);
  return { code: 0, output: lines.join("\n") };
}

if (require.main === module) {
  const index = process.argv.indexOf("--action");
  try {
    const result = run(index >= 0 ? process.argv[index + 1] : process.argv[2]);
    process.stdout.write(result.output + "\n");
    process.exitCode = result.code;
  } catch {
    process.stderr.write("Unable to read or update the telemetry preference.\n");
    process.exitCode = 1;
  }
}

module.exports = { run };