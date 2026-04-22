"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const DISPATCHER = path.resolve(__dirname, "emit-dispatcher.js");

function fireAndForget(event, opts = {}) {
  const iKey = opts.iKey || "";
  const collectorUrl = opts.collectorUrl || "";
  const configDir = opts.configDir || "";
  const fakeProbe = opts.fakeProbe || "";

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
