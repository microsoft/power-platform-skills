"use strict";

const { spawn } = require("node:child_process");
const https = require("node:https");
const os = require("node:os");
const { PLUGIN_NAME, STREAM_NAME, sanitizeData, buildEnvelope } = require("./schema");
const { readConfig, enabled, configDir } = require("./config");
const { appendLocal } = require("./lib/local-log");
const { isTransmissionOptedOut, telemetryOptOutEnvVarName } = require("./lib/user-config");
const { resolveDestination } = require("./routing");

function post(destination, envelope) {
  const body = JSON.stringify(envelope) + "\n";
  return new Promise(resolve => {
    let request;
    let timer;
    let settled = false;
    const finish = sent => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sent);
    };
    try {
      request = https.request(destination.collectorUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-json-stream; charset=utf-8",
          "x-apikey": destination.iKey,
          "Content-Length": Buffer.byteLength(body),
        },
      }, response => {
        response.resume();
        response.on("error", () => finish(false));
        response.on("end", () => finish(response.statusCode >= 200 && response.statusCode < 300));
      });
      request.on("error", () => finish(false));
      timer = setTimeout(() => { finish(false); request.destroy(); }, 4000);
      request.end(body);
    } catch { finish(false); }
  });
}

async function dispatch(input, options = {}) {
  const config = readConfig(options.configPath);
  if (!enabled(config)) return "disabled";
  if (!input || input.name !== STREAM_NAME) return "invalid";
  const data = sanitizeData(input.data);
  if (!data) return "invalid";
  const env = options.env || process.env;
  const directory = configDir(env);
  const time = new Date().toISOString();
  try { (options.appendLocal || appendLocal)({ time, name: STREAM_NAME, data }, { configDir: directory }); } catch {}
  if (isTransmissionOptedOut(directory, PLUGIN_NAME, env)) return "opted-out";
  let target;
  try { target = await resolveDestination(config, data, input.cloud, directory, options.routing); } catch { return "unresolved"; }
  if (!target) return "unresolved";
  const envelope = buildEnvelope(data, time, target.iKey);
  if (!envelope) return "invalid";
  try { return await (options.post || post)(target, envelope) ? "accepted" : "failed"; } catch { return "failed"; }
}

function fireAndForget(event, options = {}) {
  if (!enabled(readConfig(options.configPath))) return;
  const data = sanitizeData(event && event.data);
  if (!data || event.name !== STREAM_NAME) return;
  const env = options.env || process.env;
  const childEnv = {};
  for (const key of ["PATH", "SystemRoot", "HOME", "USERPROFILE", "APPDATA",
    "POWER_PLATFORM_SKILLS_CONFIG_DIR", telemetryOptOutEnvVarName(PLUGIN_NAME)]) {
    if (typeof env[key] === "string") childEnv[key] = env[key];
  }
  try {
    const child = (options.spawn || spawn)(process.execPath, [__filename], {
      cwd: os.tmpdir(), detached: true, stdio: ["pipe", "ignore", "ignore"], env: childEnv,
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    const cloud = event.cloud === "Public" ? "Public" : event.cloud ? "unsupported" : "";
    child.stdin.end(JSON.stringify({ name: STREAM_NAME, data, cloud }));
    child.unref();
  } catch {}
}

if (require.main === module) {
  if (!enabled(readConfig())) process.exit(0);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    input += chunk;
    if (input.length > 65536) process.exit(0);
  });
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("end", async () => {
    try { await dispatch(JSON.parse(input)); } catch {}
    process.exit(0);
  });
}

module.exports = { dispatch, fireAndForget };