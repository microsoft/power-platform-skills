import{createRequire}from'module';const require=createRequire(import.meta.url);

// packages/core/dist/telemetry/session.js
import { randomUUID } from "node:crypto";
var SESSION_ID = randomUUID();

// packages/core/dist/telemetry/events.js
var FIELD_TYPES = {
  // Envelope / common
  schemaVersion: "string",
  eventName: "string",
  time: "string",
  pluginName: "string",
  pluginVersion: "string",
  sessionId: "string",
  correlationId: "string",
  osName: "string",
  osVersion: "string",
  nodeVersion: "string",
  tenantId: "string",
  aiAgentName: "string",
  aiAgentVersion: "string",
  surface: "string",
  // "mcp" | "cli"
  // Tool / command identity
  toolName: "string",
  commandName: "string",
  // Outcome
  outcome: "string",
  // "success" | "failure"
  durationMs: "number",
  errorClass: "string",
  errorCode: "string",
  // MCP transport
  mcpTransport: "string",
  // "stdio" | "http"
  mcpClientName: "string",
  // Sizing / shape
  responseBytes: "number",
  actionCount: "number",
  // Flow creation
  templateId: "string",
  envId: "string",
  envLocation: "string",
  envRegion: "string"
};
function pick(input) {
  const out = {};
  for (const [key, type] of Object.entries(FIELD_TYPES)) {
    const v = input[key];
    if (v === void 0 || v === null)
      continue;
    if (type === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n))
        out[key] = n;
    } else {
      out[key] = typeof v === "string" ? v : String(v);
    }
  }
  return out;
}

// packages/core/dist/telemetry/envelope.js
var PA_EVENT_NAME = "paintegrations.event";
var PA_OWNING_TEAM = "PowerAutomateIntegrations";
var PA_OWNING_TEAM_PRIORITY = "0";
function eventModifier(name, failed) {
  if (name.endsWith("_started"))
    return "Start";
  return failed ? "Failure" : "Complete";
}
function eventSubtype(name) {
  return name === "flow_created" ? "Create" : "Other";
}
var PROMOTED = /* @__PURE__ */ new Set([
  "eventName",
  "correlationId",
  "sessionId",
  "tenantId",
  "pluginName",
  "pluginVersion",
  "outcome",
  "durationMs",
  "errorClass",
  "errorCode",
  "time",
  "envId",
  "envLocation",
  "envRegion"
]);
function str(v) {
  return v === void 0 || v === null ? "" : String(v);
}
function toBodyIKey(fullKey) {
  return `o:${fullKey.split("-")[0]}`;
}
function toPaIntegrationsEnvelope(input, opts) {
  const record = pick(input);
  const now = (opts.now ?? (() => /* @__PURE__ */ new Date()))().toISOString();
  const time = str(record.time) || now;
  const extra = {};
  for (const [k, v] of Object.entries(record)) {
    if (!PROMOTED.has(k) && v !== void 0)
      extra[k] = v;
  }
  const failed = record.outcome === "failure";
  const version = `${str(record.pluginName)}=${str(record.pluginVersion)}`;
  const name = str(record.eventName);
  const body = {
    name: PA_EVENT_NAME,
    time,
    ver: "4.0",
    iKey: toBodyIKey(opts.ikey),
    ext: { sdk: { ver: version } },
    data: {
      baseData: { properties: { version } },
      // Distinct from the envelope `time` above. Required.
      time,
      appName: str(record.pluginName),
      eventName: name,
      eventType: "Scenario",
      eventModifier: eventModifier(name, failed),
      eventSubtype: eventSubtype(name),
      message: name,
      // eventInfo and context are JSON strings, not objects.
      eventInfo: JSON.stringify(extra),
      context: "{}",
      severity: failed ? "Error" : "Information",
      activityId: str(record.correlationId),
      clientSessionId: str(record.sessionId),
      tenantId: str(record.tenantId),
      // durationInMs is a string in this schema; empty on start events.
      durationInMs: record.durationMs === void 0 ? "" : String(record.durationMs),
      errorName: str(record.errorClass),
      errorCode: str(record.errorCode),
      team: PA_OWNING_TEAM,
      teamPriority: PA_OWNING_TEAM_PRIORITY,
      buildNumber: str(record.pluginVersion),
      appLocale: "en-US",
      environmentId: str(record.envId),
      userRegion: str(record.envRegion),
      country: str(record.envLocation),
      appEnvironment: opts.appEnvironment ?? "prod"
    }
  };
  return {
    url: opts.collectorUrl,
    headers: {
      "content-type": "application/x-json-stream",
      apikey: opts.ikey,
      "Client-Id": "NO_AUTH",
      "client-version": version,
      "upload-time": String(Date.now()),
      "cache-control": "no-cache, no-store"
    },
    body: JSON.stringify(body)
  };
}

// packages/core/dist/telemetry/emit-dispatcher.js
async function main() {
  const b64 = process.env.FLOWAGENT_TELEMETRY_PAYLOAD;
  const ikey = process.env.FLOWAGENT_TELEMETRY_IKEY;
  const collector = process.env.FLOWAGENT_TELEMETRY_COLLECTOR;
  const appEnvironment = process.env.FLOWAGENT_TELEMETRY_APP_ENVIRONMENT;
  if (!b64 || !ikey || !collector)
    return;
  let record;
  try {
    record = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return;
  }
  const req = toPaIntegrationsEnvelope(record, { ikey, collectorUrl: collector, appEnvironment });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5e3);
  try {
    const response = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: controller.signal
    });
    await response.body?.cancel();
  } catch {
  } finally {
    clearTimeout(timeout);
  }
}
void main();
