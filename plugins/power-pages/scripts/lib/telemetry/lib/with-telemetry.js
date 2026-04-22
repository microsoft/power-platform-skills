"use strict";

const crypto = require("node:crypto");
const { getSessionId } = require("./session");
const { buildScriptStarted, buildScriptCompleted } = require("./events");
const { fireAndForget } = require("./emit-spawn");

function commonFields({ pluginName, pluginVersion }) {
  return {
    plugin_name: pluginName,
    plugin_version: pluginVersion,
    session_id: getSessionId(),
    os_family: process.platform,
    node_version: "v" + String(process.versions.node).split(".")[0],
  };
}

function defaultEmitter(event, spawnOpts) {
  fireAndForget(event, spawnOpts);
}

async function withTelemetry(scriptName, asyncFn, opts = {}) {
  const pluginName = opts.pluginName;
  const pluginVersion = opts.pluginVersion;
  const emitter = opts.emitter || defaultEmitter;
  const spawnOpts = opts.spawnOpts || {};
  const correlationId = crypto.randomUUID();
  const startTs = Date.now();

  try {
    emitter(
      buildScriptStarted({
        ...commonFields({ pluginName, pluginVersion }),
        script_name: scriptName,
        correlation_id: correlationId,
      }),
      spawnOpts
    );
  } catch {
    // fail closed — never let telemetry throw
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
    const duration_ms = Date.now() - startTs;
    try {
      emitter(
        buildScriptCompleted({
          ...commonFields({ pluginName, pluginVersion }),
          script_name: scriptName,
          correlation_id: correlationId,
          outcome,
          duration_ms,
          error_class: errorClass,
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
