"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { telemetryOptOutEnvVarName } = require("./user-config");

const DISPATCHER = path.resolve(__dirname, "emit-dispatcher.js");

function fireAndForget(event, opts = {}) {
  const iKey = opts.iKey || "";
  const collectorUrl = opts.collectorUrl || "";
  const configDir = opts.configDir || "";
  const fakeProbe = opts.fakeProbe || "";
  const cloud = opts.cloud || "";
  const pluginName = event && event.data && event.data.pluginName;
  const optOutVarName = pluginName ? telemetryOptOutEnvVarName(pluginName) : "";
  const optOutValue =
    optOutVarName && process.env[optOutVarName] ? process.env[optOutVarName] : "";
  // Absolute path to the CALLING plugin's ikey.json. The dispatcher lives in
  // shared/telemetry/lib (reached via the per-plugin symlink), so its own
  // __dirname-based default would resolve to shared/'s placeholder, not the
  // plugin's real config. Passing the path explicitly makes the dispatcher
  // read the right file regardless of how lib/ is linked.
  const ikeyJsonPath = opts.ikeyJsonPath || "";

  try {
    const child = spawn(process.execPath, [DISPATCHER], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        // Pass only the minimum env the dispatcher needs. Avoid spreading
        // process.env so secrets (AZURE_CLIENT_SECRET, GITHUB_TOKEN, etc.)
        // never reach the telemetry child.
        PATH: process.env.PATH || "",
        SystemRoot: process.env.SystemRoot || "",
        HOME: process.env.HOME || "",
        USERPROFILE: process.env.USERPROFILE || "",
        APPDATA: process.env.APPDATA || "",
        POWER_PLATFORM_SKILLS_IKEY: iKey,
        POWER_PLATFORM_SKILLS_COLLECTOR: collectorUrl,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe,
        POWER_PLATFORM_SKILLS_CLOUD: cloud,
        // ikey.json path: an explicit env override (test seam) wins; otherwise
        // the calling plugin's ikey.json path so the dispatcher reads the
        // plugin's real config rather than shared/'s placeholder.
        POWER_PLATFORM_SKILLS_IKEY_JSON:
          process.env.POWER_PLATFORM_SKILLS_IKEY_JSON || ikeyJsonPath || "",
        // The opt-out is enforced in the detached dispatcher, which reads the
        // child's process.env — so the minimal allowlist must forward this var
        // explicitly or the highest-precedence opt-out never reaches it. Forward
        // only when actually set: an empty/unset value is a no-op for the
        // dispatcher's check (it trims and matches only "1"/"true"), so there's
        // no point planting an empty var in the child env.
        ...(optOutVarName && optOutValue
          ? { [optOutVarName]: optOutValue }
          : {}),
      },
    });
    try {
      child.stdin.write(JSON.stringify(event));
      child.stdin.end();
    } catch {
      // child may have already exited; swallow.
    }
    child.unref();
  } catch {
    // spawn failed — fail closed.
  }
}

module.exports = { fireAndForget };
