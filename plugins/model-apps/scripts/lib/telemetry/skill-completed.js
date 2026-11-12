"use strict";

// `skill_completed` usage telemetry for the scripts that change a Power Platform environment: the
// model-apps app build (build-model-app.js), the generative-page upload (genpage-upload.js) and the pcf
// control push (pcf-push.js). The skill_started hooks only say a skill BEGAN; this event says what the
// run did to the environment — its outcome, how long it took, and how many artifacts of each kind it
// created, reused or failed on — so usage can be tied to the apps, pages and controls it produced.
//
// plugins/pcf/scripts/lib/telemetry/skill-completed.js is a VERBATIM copy of this file
// (scripts/validate-plugin-copies.js fails on drift): edit this one, then copy it over. That is why it
// reads its plugin's name and version from the manifest beside it instead of naming a plugin.
//
// Privacy contract (shared/telemetry/README.md, "Model Apps and PCF"): every nested `eventInfo` value is
// a fixed enum, a boolean or a bounded count — sanitizeEventInfo() drops anything else, so no table,
// app, page, control, solution or environment NAME, no URL and no error text can reach the wire. The
// only identifiers are the Dataverse organization GUID and the Entra tenant GUID of the environment the
// run targeted, as skill_started already carries; never the signed-in user's object ID.
//
// Fail closed throughout: telemetry must never change a script's result or exit code, so every path
// here swallows its own errors and the caller's `await` resolves either way.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const events = require("./lib/events");
const emitSpawn = require("./lib/emit-spawn");
const agentInfo = require("./lib/agent-info");
const resolverLoader = require("./lib/resolver-loader");
const { isTransmissionOptedOut } = require("./lib/user-config");

const TELEMETRY_DIR = __dirname;
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const PLACEHOLDER_IKEY = "PLACEHOLDER_REPLACE_BEFORE_SHIPPING";
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".power-platform-skills");
// The WhoAmI that names the target organization runs while the user waits for the script's result, so it
// gets a short budget; a slow or failing read only drops the IDs from the event.
const IDENTITY_TIMEOUT_MS = 3000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Not a PAC cloud token, so resolver.js routes it nowhere; see the emit below.
const UNROUTABLE_CLOUD = "Unrecognized";

// ---- The approved eventInfo schema --------------------------------------------------------------------
// Keep in step with shared/telemetry/README.md. Adding a key or a value needs the privacy review that
// file describes, plus its disclosure and the tests in scripts/tests/skill-completed.test.js.
const OPERATIONS = new Set(["app-build", "page-upload", "control-push"]);
// The app build's engine phases (scripts/lib/stages.js PHASES, pinned by a test) and the two the build
// reports outside them: `preflight` (checks before any write) and `push` (the pcf deploy).
const PHASES = new Set([
  "preflight", "solution", "data-model", "sample-data", "web-resources", "views", "charts", "forms",
  "business-rules", "business-process-flows", "commands", "dashboards", "app-shell", "pages",
  "ai-features", "security", "publish", "push",
]);
const SCOPES = new Set(["full", "staged", "changed-only"]);
const VERIFY_RESULTS = new Set(["passed", "failed", "not-run"]);
const PAGE_ACTIONS = new Set(["created", "updated", "unchanged"]);
const REGISTRATION = new Set(["verified", "not-verified", "skipped"]);
const STEP_STATUSES = ["ok", "skip", "error"];
// Top-level `errorClass` on a failure. Stable class names, never an error message.
const ERROR_CLASSES = new Set([
  "auth", "invalid-input", "locked", "halted", "verify-failed", "deploy-failed", "timeout", "unexpected",
]);
// A step count above this is not a real run; clamp rather than send an implausible number.
const MAX_COUNT = 100000;

function count(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), MAX_COUNT);
}

function enumOf(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function bool(value) {
  return typeof value === "boolean" ? value : undefined;
}

// Allowlist-only: what is not named here is dropped. `steps` is { <phase>: { ok, skip, error } }.
function sanitizeEventInfo(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = { schemaVersion: 1 };
  const set = (key, value) => { if (value !== undefined) out[key] = value; };
  set("operation", enumOf(src.operation, OPERATIONS));
  set("scope", enumOf(src.scope, SCOPES));
  set("publish", bool(src.publish));
  set("verify", enumOf(src.verify, VERIFY_RESULTS));
  set("haltPhase", enumOf(src.haltPhase, PHASES));
  set("page", enumOf(src.page, PAGE_ACTIONS));
  set("placedInApp", bool(src.placedInApp));
  set("addedToSolution", bool(src.addedToSolution));
  set("incremental", bool(src.incremental));
  set("registration", enumOf(src.registration, REGISTRATION));
  if (src.steps && typeof src.steps === "object" && !Array.isArray(src.steps)) {
    const steps = {};
    for (const [phase, tally] of Object.entries(src.steps)) {
      if (!PHASES.has(phase) || !tally || typeof tally !== "object") continue;
      const row = {};
      for (const status of STEP_STATUSES) row[status] = count(tally[status]);
      if (row.ok + row.skip + row.error > 0) steps[phase] = row;
    }
    if (Object.keys(steps).length) out.steps = steps;
  }
  return out;
}

// ---- Step tally ---------------------------------------------------------------------------------------
// Fed the build engine's progress events ({ phase, status, replaces? }). A step the engine takes up again
// names the outcome it replaces (build-model-app.js cliEmit), so each step is counted once, by its final
// outcome — the same rule as the build's closing "N created, N skipped, N failed" line.
function createStepTally() {
  const byPhase = {};
  return {
    record(e) {
      if (!e || typeof e.phase !== "string" || !STEP_STATUSES.includes(e.status)) return;
      const row = byPhase[e.phase] || (byPhase[e.phase] = { ok: 0, skip: 0, error: 0 });
      if (STEP_STATUSES.includes(e.replaces) && row[e.replaces] > 0) row[e.replaces] -= 1;
      row[e.status] += 1;
    },
    // The engine restarts every phase on an automatic retry; the summary reflects the final attempt.
    reset() { for (const key of Object.keys(byPhase)) delete byPhase[key]; },
    snapshot() { return JSON.parse(JSON.stringify(byPhase)); },
  };
}

// ---- Routing context ----------------------------------------------------------------------------------
// The cloud of the TARGET environment, from its host, as the PAC cloud token the plugin's resolver.js
// routes on. Hooks read `pac auth who`, whose active profile can be a different environment from the
// `--env` a script was given; the host is the target's own. Host families as lib/dataverse-auth.js
// DATAVERSE_HOST accepts them (GCC is the `crm9` region of the commercial family):
//   https://learn.microsoft.com/power-platform/admin/new-datacenter-regions
//   https://learn.microsoft.com/power-platform/admin/powerapps-us-government#power-apps-us-government-service-urls
// lib/sdk-first.js connectivityCloudOf reads hosts too, but answers a different question (which route
// the SDK can take, so GCC is "Unsupported" there); this one must name every cloud a key exists for.
// An unknown host returns "". The emitter never hands "" to the resolver for a run that had a target: with
// no organization ID, "" reads as a signed-out PAC and routes to the public US default (resolver.js).
function cloudOfEnvironment(envUrl) {
  let host = "";
  try { host = new URL(String(envUrl)).host.toLowerCase(); } catch { return ""; }
  if (/\.(?:api\.)?crmtest\.dynamics\.com$/.test(host)) return "Test";
  if (/\.(?:api\.)?crm9\.dynamics\.com$/.test(host)) return "UsGov";
  if (/\.(?:api\.)?crm\d*\.dynamics\.com$/.test(host)) return "Public";
  if (/\.(?:api\.)?crm\.microsoftdynamics\.us$/.test(host)) return "UsGovHigh";
  if (/\.(?:api\.)?crm\.appsplatform\.us$/.test(host)) return "UsGovDod";
  if (/\.(?:api\.)?crm\.dynamics\.cn$/.test(host)) return "China";
  return "";
}

// The Entra tenant GUID from an access token's `tid` claim. Only `tid` is read — never `oid`, `upn` or any
// other user claim — and nothing is verified: the token was just issued to this process by the Azure CLI,
// and a wrong value only mislabels a usage event.
// JWT layout (RFC 7519): base64url(header).base64url(payload).signature, payload e.g. {"tid":"<guid>",...}
function tenantIdFromToken(token) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof claims.tid === "string" && GUID.test(claims.tid) ? claims.tid.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

// { orgId, tenantId } of the target environment, or {} — never throws, and never starts the Azure CLI: the
// token is read from dataverse-auth's per-process memo (peekAuthToken), which the script filled when it
// talked to the environment. A script that never got that far — a refused sign-in, a lock refusal, a failed
// push — has no token there, and its event simply goes without the IDs; reading one would cost the user a
// CLI start of seconds (up to the Azure CLI budget) for telemetry. The one request is a WhoAmI.
// Both IDs come from an ACCEPTED WhoAmI, or neither is sent: the token's `tid` names the tenant the Azure
// CLI signed in to, which is the environment's only if the environment accepted the token. (Observed live:
// a CLI signed in to another tenant gets a token, and the environment answers 401.)
// WhoAmI: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/whoami
async function resolveEnvironmentIdentity(envUrl, deps = {}) {
  try {
    const auth = deps.auth || require("../dataverse-auth.js");
    if (typeof auth.peekAuthToken !== "function") return {};
    const origin = auth.dataverseOrigin(envUrl);
    if (!origin) return {};
    const token = auth.peekAuthToken(origin);
    if (!token) return {};
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), deps.timeoutMs || IDENTITY_TIMEOUT_MS); });
    const who = auth.dataverseRequest(origin, "GET", "WhoAmI", null, { token, timeout: deps.timeoutMs || IDENTITY_TIMEOUT_MS, refreshOn401: false })
      .catch(() => null);
    const res = await Promise.race([who, timeout]);
    clearTimeout(timer);
    const orgId = res && res.status >= 200 && res.status < 300 && res.data && res.data.OrganizationId;
    if (typeof orgId !== "string" || !GUID.test(orgId)) return {};
    const tenantId = tenantIdFromToken(token);
    return { orgId: orgId.toLowerCase(), ...(tenantId ? { tenantId } : {}) };
  } catch {
    return {};
  }
}

// ---- Gates --------------------------------------------------------------------------------------------
function readIkey() {
  const override = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const ikeyPath = override && override.trim() ? override : path.join(TELEMETRY_DIR, "ikey.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(ikeyPath, "utf8"));
    return { cfg, ikeyPath, eventStreamName: cfg.event_stream_name || "", disabled: cfg.disabled === true };
  } catch {
    // Unreadable config is the repo kill switch, as in emit-dispatcher.js: fail closed.
    return { cfg: null, ikeyPath, eventStreamName: "", disabled: true };
  }
}

function isProvisioned(cfg, ikeyPath) {
  try {
    const resolver = resolverLoader.loadResolver(path.dirname(ikeyPath));
    if (resolver && typeof resolver.isProvisioned === "function") return !!resolver.isProvisioned(cfg);
    return !!(cfg && cfg.instrumentationKey && cfg.instrumentationKey !== PLACEHOLDER_IKEY);
  } catch {
    return false;
  }
}

function readManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    return { name: typeof m.name === "string" ? m.name : "", version: m.version || "unknown" };
  } catch {
    return { name: "", version: "unknown" };
  }
}

// node:test marks every process it runs (and their children inherit it) with NODE_TEST_CONTEXT. The
// scripts this module serves are exercised by hundreds of tests with stand-in environments; without this
// gate each of them would spawn a dispatcher, write a mirror in the developer's home and — on a machine
// with no opt-out set — post an event about a fake build. A test that means to check emission sets
// POWER_PLATFORM_SKILLS_TELEMETRY_TEST_EMIT=1 and routes it to a POWER_PLATFORM_SKILLS_FAKE_HTTPS probe.
function suppressedUnderTest(env) {
  return !!env.NODE_TEST_CONTEXT && env.POWER_PLATFORM_SKILLS_TELEMETRY_TEST_EMIT !== "1";
}

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

// ---- Emit ---------------------------------------------------------------------------------------------
// input: { skillName, outcome: "success"|"failure", durationMs, errorClass?, eventInfo?, envUrl?,
//          orgId?, tenantId?, resolveIdentity? (default true) }
// Resolves true when an event was handed to the dispatcher, false otherwise. Never rejects.
async function emitSkillCompleted(input, deps = {}) {
  try {
    const env = deps.env || process.env;
    if (suppressedUnderTest(env)) return false;
    if (!input || typeof input.skillName !== "string" || !input.skillName) return false;
    const outcome = input.outcome === "success" || input.outcome === "failure" ? input.outcome : null;
    if (!outcome) return false;

    const { cfg, ikeyPath, eventStreamName, disabled } = readIkey();
    if (disabled || !isProvisioned(cfg, ikeyPath)) return false;
    const manifest = readManifest();
    if (!manifest.name) return false;

    const configDir = env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";
    // A user who opted out of transmission still gets the local mirror (the dispatcher writes it), but no
    // network request is made on telemetry's behalf: the organization lookup is skipped, so their mirror
    // records the event without the organization and tenant IDs.
    const optedOut = isTransmissionOptedOut(configDir || DEFAULT_CONFIG_DIR, manifest.name, env);
    let identity = {
      ...(typeof input.orgId === "string" && GUID.test(input.orgId) ? { orgId: input.orgId.toLowerCase() } : {}),
      ...(typeof input.tenantId === "string" && GUID.test(input.tenantId) ? { tenantId: input.tenantId.toLowerCase() } : {}),
    };
    if (!optedOut && input.resolveIdentity !== false && input.envUrl && !(identity.orgId && identity.tenantId)) {
      const resolved = await (deps.resolveIdentity || resolveEnvironmentIdentity)(input.envUrl);
      identity = { ...resolved, ...identity };
    }

    let agent = {};
    try { agent = agentInfo.readAiAgent(env) || {}; } catch { agent = {}; }
    const durationMs = Number.isFinite(input.durationMs) && input.durationMs >= 0 ? Math.round(input.durationMs) : undefined;
    const errorClass = outcome === "failure" ? (enumOf(input.errorClass, ERROR_CLASSES) || "unexpected") : undefined;

    const fields = {
      pluginName: manifest.name,
      pluginVersion: manifest.version,
      // Scripts run outside the hooks that see the agent's session, so a completion carries its own random
      // run ID; it is tied to the environment through orgId, not to the skill_started that preceded it.
      sessionId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      osName: osFriendlyName(process.platform),
      osVersion: os.release(),
      nodeVersion: "v" + String(process.versions.node).split(".")[0],
      skillName: input.skillName,
      outcome,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(errorClass ? { errorClass } : {}),
      ...identity,
      eventInfo: sanitizeEventInfo(input.eventInfo),
      ...(agent.aiAgentName ? { aiAgentName: agent.aiAgentName } : {}),
      ...(agent.aiAgentVersion ? { aiAgentVersion: agent.aiAgentVersion } : {}),
    };
    (deps.fireAndForget || emitSpawn.fireAndForget)(events.buildSkillCompleted(eventStreamName, fields), {
      // A host outside the known Dataverse families gets a cloud no resolver recognizes, so the event is mirrored locally and sent
      // nowhere — never to the public default a blank cloud would select when the run has no organization ID (a lookup skipped,
      // refused or timed out). resolver.js: an unrecognized non-empty cloud resolves to null.
      cloud: cloudOfEnvironment(input.envUrl) || UNROUTABLE_CLOUD,
      configDir,
      fakeProbe: env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "",
      ikeyJsonPath: ikeyPath,
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  emitSkillCompleted,
  createStepTally,
  sanitizeEventInfo,
  cloudOfEnvironment,
  tenantIdFromToken,
  resolveEnvironmentIdentity,
  ERROR_CLASSES,
  PHASES,
};
