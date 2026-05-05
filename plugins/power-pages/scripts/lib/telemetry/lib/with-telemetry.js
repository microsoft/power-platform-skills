"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const { getSessionId } = require("./session");
const { buildScriptStarted, buildScriptCompleted } = require("./events");
const { fireAndForget } = require("./emit-spawn");

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

function commonFields({ pluginName, pluginVersion }) {
  return {
    pluginName,
    pluginVersion,
    sessionId: getSessionId(),
    osName: osFriendlyName(process.platform),
    osVersion: os.release(),
    nodeVersion: "v" + String(process.versions.node).split(".")[0],
  };
}

function defaultEmitter(event, spawnOpts) {
  fireAndForget(event, spawnOpts);
}

async function withTelemetry(scriptName, asyncFn, opts = {}) {
  const envelopeName = opts.envelopeName || "";
  const pluginName = opts.pluginName;
  const pluginVersion = opts.pluginVersion;
  const emitter = opts.emitter || defaultEmitter;
  const spawnOpts = opts.spawnOpts || {};
  const correlationId = crypto.randomUUID();
  const startTs = Date.now();

  try {
    emitter(
      buildScriptStarted(envelopeName, {
        ...commonFields({ pluginName, pluginVersion }),
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
  let caught;
  try {
    return await asyncFn();
  } catch (err) {
    outcome = "failure";
    errorClass = err && err.constructor ? err.constructor.name : "Error";
    caught = err;
  } finally {
    const durationMs = Date.now() - startTs;
    try {
      emitter(
        buildScriptCompleted(envelopeName, {
          ...commonFields({ pluginName, pluginVersion }),
          scriptName,
          correlationId,
          outcome,
          durationMs,
          errorClass,
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
