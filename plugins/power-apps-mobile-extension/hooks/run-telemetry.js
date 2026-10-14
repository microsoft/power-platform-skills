"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runNative } = require("../scripts/lib/telemetry/lib/native-exec");
const { PLUGIN_NAME, STREAM_NAME, TRACKED_SKILLS, sanitizeData } = require("../scripts/lib/telemetry/schema");
const { readConfig, enabled } = require("../scripts/lib/telemetry/config");
const { fireAndForget } = require("../scripts/lib/telemetry/dispatcher");
const { readPacAuth } = require("../scripts/lib/telemetry/lib/pac-auth");
const { readAiAgent, readPacCliVersion } = require("../scripts/lib/telemetry/lib/agent-info");
const { getSessionId, resolveHostSessionId } = require("../scripts/lib/telemetry/lib/session");

function identify(value, pluginHint) {
  if (typeof value !== "string" || (pluginHint && pluginHint !== PLUGIN_NAME)) return null;
  const token = value.trim().replace(/^\//, "");
  const parts = token.split(":");
  if (parts.length === 2) {
    if (parts[0] !== PLUGIN_NAME) return null;
    return TRACKED_SKILLS.includes(parts[1]) ? parts[1] : null;
  }
  if (parts.length !== 1) return null;
  return TRACKED_SKILLS.includes(token) ? token : null;
}

function invocation(mode, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (mode === "prompt") {
    if (typeof payload.prompt !== "string") return null;
    const match = payload.prompt.match(/^\s*\/([^\s]+)(?:\s|$)/);
    return match ? identify(match[1], payload.pluginName || payload.plugin_name) : null;
  }
  if (mode !== "pretool") return null;
  const tool = payload.tool_name || payload.toolName;
  if (tool && !["Skill", "skill"].includes(tool)) return null;
  let input = payload.tool_input || payload.toolInput || payload.toolArgs;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { return null; }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return identify(input.skill || input.skill_name || input.skillName || input.name,
    input.pluginName || input.plugin_name || payload.pluginName || payload.plugin_name);
}

function pacExec(executable, args, options, dependencies) {
  if (executable !== "pac" || !["auth who", "--version"].includes(args.join(" "))) throw new Error("Unsupported PAC command");
  return runNative(executable, args, options, dependencies);
}

function handle(mode, payload, options = {}) {
  if (!enabled(readConfig(options.configPath))) return false;
  const skillName = invocation(mode, payload);
  if (!skillName) return false;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../.plugin/plugin.json"), "utf8")); } catch { return false; }
  let auth = null;
  let agent = {};
  let pacCliVersion = "";
  try { auth = (options.readAuth || (() => readPacAuth({ _exec: pacExec })))(); } catch {}
  try { agent = (options.readAgent || (() => readAiAgent(options.env || process.env)))() || {}; } catch {}
  try { pacCliVersion = (options.readPacVersion || (() => readPacCliVersion({ _exec: pacExec })))(); } catch {}
  const hostId = resolveHostSessionId(payload);
  const sessionId = getSessionId(/^[A-Za-z0-9_-]{1,128}$/.test(hostId) ? hostId : "");
  const data = sanitizeData({
    eventName: "skill_started", eventType: "Trace", severity: "Info",
    pluginName: PLUGIN_NAME, pluginVersion: manifest.version, skillName,
    sessionId, correlationId: crypto.randomUUID(),
    osName: { win32: "Windows", darwin: "Mac", linux: "Linux" }[process.platform],
    osVersion: os.release(), nodeVersion: "v" + process.versions.node.split(".")[0],
    aiAgentName: agent.aiAgentName, aiAgentVersion: agent.aiAgentVersion, pacCliVersion,
    orgId: auth && auth.orgId, tenantId: auth && auth.tenantId,
    eventInfo: auth && { aadObjectId: auth.objectId },
  });
  if (!data) return false;
  const rawCloud = auth && typeof auth.cloud === "string" ? auth.cloud.trim().toLowerCase() : "";
  const cloud = rawCloud === "public" ? "Public" : rawCloud ? "unsupported" : "";
  try {
    (options.emit || fireAndForget)({ name: STREAM_NAME, data, cloud }, options);
    return true;
  } catch { return false; }
}

function start(mode) {
  if (!enabled(readConfig())) return;
  let text = "";
  const timer = setTimeout(() => process.exit(0), 25000);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    text += chunk;
    if (text.length > 65536) process.exit(0);
  });
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("end", () => {
    clearTimeout(timer);
    try { handle(mode, JSON.parse(text)); } catch {}
  });
}

if (require.main === module) start(process.argv[2]);
module.exports = { start, handle, invocation, pacExec };