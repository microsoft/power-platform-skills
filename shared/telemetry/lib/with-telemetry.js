"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const { getSessionId } = require("./session");
const { buildScriptStarted, buildScriptCompleted } = require("./events");
const { fireAndForget } = require("./emit-spawn");
const { readPacCliVersion, readAiAgent } = require("./agent-info");

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

function commonFields({ pluginName, pluginVersion, agentInfo }) {
  const out = {
    pluginName,
    pluginVersion,
    sessionId: getSessionId(),
    osName: osFriendlyName(process.platform),
    osVersion: os.release(),
    nodeVersion: "v" + String(process.versions.node).split(".")[0],
  };
  if (agentInfo) {
    if (agentInfo.aiAgentName) out.aiAgentName = agentInfo.aiAgentName;
    if (agentInfo.aiAgentVersion) out.aiAgentVersion = agentInfo.aiAgentVersion;
    if (agentInfo.pacCliVersion) out.pacCliVersion = agentInfo.pacCliVersion;
  }
  return out;
}

function defaultEmitter(event, spawnOpts) {
  fireAndForget(event, spawnOpts);
}

function defaultAgentInfo() {
  return { ...readAiAgent(), pacCliVersion: readPacCliVersion() };
}

async function withTelemetry(scriptName, asyncFn, opts = {}) {
  const envelopeName = opts.envelopeName || "";
  const pluginName = opts.pluginName;
  const pluginVersion = opts.pluginVersion;
  const emitter = opts.emitter || defaultEmitter;
  const spawnOpts = opts.spawnOpts || {};
  const correlationId = crypto.randomUUID();
  const startTs = Date.now();

  const readAgentInfo =
    typeof opts._readAgentInfo === "function" ? opts._readAgentInfo : defaultAgentInfo;
  let agentInfo = {};
  try {
    agentInfo = readAgentInfo() || {};
  } catch {
    agentInfo = {};
  }

  try {
    emitter(
      buildScriptStarted(envelopeName, {
        ...commonFields({ pluginName, pluginVersion, agentInfo }),
        scriptName,
        correlationId,
      }),
      spawnOpts
    );
  } catch {
    // fail closed
  }

  let outcome = "success";
  let errorClass = "";
  let errorDescription = "";
  let caught;
  try {
    return await asyncFn();
  } catch (err) {
    outcome = "failure";
    errorClass = err && err.constructor ? err.constructor.name : "Error";
    // PII-safe: emit only err.code (short, non-PII metadata like "ENOENT"
    // or "ERR_INVALID_ARG_TYPE"). err.message is never emitted because it
    // may contain file paths, GUIDs, or other user context.
    errorDescription = err && err.code ? String(err.code) : "";
    caught = err;
  } finally {
    const durationMs = Date.now() - startTs;
    try {
      emitter(
        buildScriptCompleted(envelopeName, {
          ...commonFields({ pluginName, pluginVersion, agentInfo }),
          scriptName,
          correlationId,
          outcome,
          durationMs,
          errorClass,
          errorDescription,
        }),
        spawnOpts
      );
    } catch {
      // fail closed
    }
    if (caught) throw caught;
  }
}

module.exports = { withTelemetry };
