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
  // The per-plugin transmission opt-out env var
  // (POWER_PLATFORM_SKILLS_TELEMETRY_<PLUGIN>_OPTOUT) is enforced inside the
  // DETACHED dispatcher child (it suppresses the POST only, after the local
  // mirror is written — so the hooks deliberately don't short-circuit on it).
  // The child env below is a deliberate minimal allowlist that drops everything
  // else, so we must forward this one var explicitly or the documented
  // highest-precedence opt-out silently never reaches the code that honors it.
  // Derive the exact var name from the event's pluginName and forward its value
  // when present; forwarding a single boolean-ish flag preserves the
  // no-secrets-to-the-child posture.
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
        // Forward the per-plugin opt-out flag under its real var name so the
        // dispatcher's isTransmissionOptedOut() (which reads the child's
        // process.env) can honor the env-var opt-out. Only added when actually
        // set in the parent, so it never re-creates an empty var the dispatcher
        // would treat as "present".
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
