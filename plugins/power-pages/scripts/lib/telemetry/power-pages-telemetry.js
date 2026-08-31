"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TELEMETRY_DIR = __dirname;
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const events = require("./lib/events");
const emitSpawn = require("./lib/emit-spawn");
const session = require("./lib/session");
const pacAuth = require("./lib/pac-auth");
const agentInfo = require("./lib/agent-info");
const resolverLoader = require("./lib/resolver-loader");
const invocationState = require("./invocation-state");

const PURPOSES = new Set([
  "company-portal",
  "blog-content",
  "dashboard",
  "landing-page",
  "other",
]);
const FRAMEWORKS = new Set(["react", "vue", "angular", "astro"]);
const LOCALIZATION_OPERATIONS = new Set([
  "create",
  "add-languages",
  "repair",
  "reconfigure",
]);
const LOCALIZATION_MODES = new Set(["runtime", "static"]);
const PACKAGE_SELECTIONS = new Set(["recommended", "alternative", "preserved"]);
const PACKAGE_VERIFICATIONS = new Set(["verified", "unverified", "not-approved"]);
const TRANSLATION_METHODS = new Set(["agent", "blank"]);
const VALIDATION_STATUSES = new Set(["supported", "unsupported", "inconclusive", "error"]);
const READINESS_STATUSES = new Set([
  "ready",
  "approved-with-limitations",
  "pending-remediation",
  "not-required",
]);
const PACKAGE_FAILURE_CODES = new Set([
  "package-not-resolvable",
  "package-deprecated",
  "prerelease-not-approved",
  "license-not-approved",
  "package-stale",
  "framework-not-supported",
  "framework-peer-incompatible",
  "angular-major-mismatch",
  "documentation-missing",
  "documentation-fetch-failed",
  "mode-unsupported",
  "mode-inconclusive",
  "npm-resolution-failed",
]);

function enumValue(value, allowed, fallback = undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function sanitizeLocale(value) {
  const raw = String(value || "").trim();
  if (!raw || /^x-/i.test(raw)) return null;
  const parts = raw.split("-");
  const extensionIndex = parts.findIndex(
    (part, index) => index > 0 && /^[0-9a-z]$/i.test(part)
  );
  const projected = (extensionIndex === -1 ? parts : parts.slice(0, extensionIndex)).join("-");
  try {
    return Intl.getCanonicalLocales(projected)[0] || null;
  } catch {
    return null;
  }
}

function sanitizeLocales(values) {
  const source = Array.isArray(values) ? values : String(values || "").split(",");
  return [...new Set(source.map(sanitizeLocale).filter(Boolean))];
}

function sanitizePackageName(value) {
  const packageName = String(value || "").trim().toLowerCase();
  if (
    packageName.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)
  ) {
    return undefined;
  }
  return packageName;
}

function sanitizeVersion(value) {
  const version = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._+-]{0,79}$/i.test(version) ? version : undefined;
}

function normalizePurpose(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\/\s]+/g, "-");
  const aliases = {
    portal: "company-portal",
    "company-portal": "company-portal",
    blog: "blog-content",
    content: "blog-content",
    "blog-content": "blog-content",
    dashboard: "dashboard",
    "landing-page": "landing-page",
    landing: "landing-page",
  };
  return enumValue(aliases[normalized] || "other", PURPOSES, "other");
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined && field !== null)
  );
}

function buildCreateSiteEventInfo(input) {
  return compactObject({
    configurationType: "create-site",
    framework: enumValue(input.framework, FRAMEWORKS),
    siteContentLocale: sanitizeLocale(input.siteContentLocale),
    purpose: normalizePurpose(input.purpose),
    audience: enumValue(input.audience, new Set(["internal", "external"])),
    choiceSource: enumValue(input.choiceSource, new Set(["prompt", "arguments"])),
  });
}

function buildLocalizationEventInfo(input) {
  return compactObject({
    configurationType: "localization",
    framework: enumValue(input.framework, FRAMEWORKS),
    operation: enumValue(input.operation, LOCALIZATION_OPERATIONS),
    invocationSource: enumValue(input.invocationSource, new Set(["direct", "create-site"])),
    existingLocalizationDetected:
      typeof input.existingLocalizationDetected === "boolean"
        ? input.existingLocalizationDetected
        : undefined,
    mode: enumValue(input.mode, LOCALIZATION_MODES),
    defaultLocale: sanitizeLocale(input.defaultLocale),
    addedLocales: sanitizeLocales(input.addedLocales),
    resultingLocales: sanitizeLocales(input.resultingLocales),
    packageName: sanitizePackageName(input.packageName),
    packageVersion: sanitizeVersion(input.packageVersion),
    packageSelection: enumValue(input.packageSelection, PACKAGE_SELECTIONS),
    packageVerification: enumValue(input.packageVerification, PACKAGE_VERIFICATIONS),
    translationMethod: enumValue(input.translationMethod, TRANSLATION_METHODS),
  });
}

function buildPackageValidationEventInfo(input) {
  return compactObject({
    framework: enumValue(input.framework, FRAMEWORKS),
    operation: enumValue(input.operation, LOCALIZATION_OPERATIONS),
    intendedLocales: sanitizeLocales(input.intendedLocales),
    packageName: sanitizePackageName(input.packageName),
    resolvedVersion: sanitizeVersion(input.resolvedVersion),
    packageSelection: enumValue(input.packageSelection, PACKAGE_SELECTIONS),
    mode: enumValue(input.mode, LOCALIZATION_MODES),
    validationStatus: enumValue(input.validationStatus, VALIDATION_STATUSES, "error"),
    failureCodes: [
      ...new Set(
        (Array.isArray(input.failureCodes) ? input.failureCodes : [])
          .map((code) => String(code || "").trim().toLowerCase())
          .filter((code) => PACKAGE_FAILURE_CODES.has(code))
      ),
    ],
    prerelease: typeof input.prerelease === "boolean" ? input.prerelease : undefined,
    unverifiedOverrideRequested:
      typeof input.unverifiedOverrideRequested === "boolean"
        ? input.unverifiedOverrideRequested
        : undefined,
  });
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function buildLocalizationCompletionEventInfo(input) {
  return compactObject({
    validationOutcome: enumValue(input.validationOutcome, new Set(["passed", "failed"])),
    bidirectionalReadiness: enumValue(
      input.bidirectionalReadiness,
      READINESS_STATUSES,
      "not-required"
    ),
    unavailableLocaleCount: nonNegativeInteger(input.unavailableLocaleCount),
    configuredLocaleCount: nonNegativeInteger(input.configuredLocaleCount),
    translationMethod: enumValue(input.translationMethod, TRANSLATION_METHODS),
  });
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    );
    return manifest.version || "unknown";
  } catch {
    return "unknown";
  }
}

function readIkey() {
  const override = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const ikeyPath =
    override && override.trim()
      ? override
      : path.join(TELEMETRY_DIR, "ikey.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(ikeyPath, "utf8"));
    return {
      cfg,
      ikeyPath,
      eventStreamName: cfg.event_stream_name || "",
      disabled: cfg.disabled === true,
    };
  } catch {
    return { cfg: null, ikeyPath, eventStreamName: "", disabled: true };
  }
}

function isProvisioned(cfg, ikeyPath) {
  try {
    const resolver = resolverLoader.loadResolver(path.dirname(ikeyPath));
    return resolver && typeof resolver.isProvisioned === "function"
      ? resolver.isProvisioned(cfg)
      : !!(cfg && cfg.instrumentationKey);
  } catch {
    return false;
  }
}

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

function commonFields(skillName, projectRoot, eventInfo, activeOverride) {
  const active =
    activeOverride || invocationState.findActive(skillName, projectRoot);
  let auth = null;
  let detectedAgent = {};
  try {
    auth = pacAuth.readPacAuth();
  } catch {
    auth = null;
  }
  try {
    detectedAgent = {
      ...agentInfo.readAiAgent(),
      pacCliVersion: agentInfo.readPacCliVersion(),
    };
  } catch {
    detectedAgent = {};
  }
  const mergedEventInfo = {
    ...(eventInfo || {}),
    ...(auth && auth.objectId ? { aadObjectId: auth.objectId } : {}),
  };
  return {
    fields: compactObject({
      pluginName: "power-pages",
      pluginVersion: readPluginVersion(),
      sessionId: session.getSessionId(active && active.sessionId),
      correlationId: crypto.randomUUID(),
      osName: osFriendlyName(process.platform),
      osVersion: os.release(),
      nodeVersion: "v" + String(process.versions.node).split(".")[0],
      skillName,
      orgId: auth && auth.orgId,
      tenantId: auth && auth.tenantId,
      eventInfo: mergedEventInfo,
      aiAgentName: detectedAgent.aiAgentName,
      aiAgentVersion: detectedAgent.aiAgentVersion,
      pacCliVersion: detectedAgent.pacCliVersion,
    }),
    cloud: (auth && auth.cloud) || "",
    active,
  };
}

function emit(
  kind,
  skillName,
  projectRoot,
  eventInfo,
  extraFields = {},
  { active } = {}
) {
  const { cfg, ikeyPath, eventStreamName, disabled } = readIkey();
  if (disabled || !isProvisioned(cfg, ikeyPath)) return false;
  const context = commonFields(skillName, projectRoot, eventInfo, active);
  const builders = {
    configured: events.buildSkillConfigured,
    packageValidation: events.buildLocalizationPackageValidation,
    completed: events.buildSkillCompleted,
  };
  const builder = builders[kind];
  if (!builder) return false;
  emitSpawn.fireAndForget(
    builder(eventStreamName, { ...context.fields, ...extraFields }),
    {
      cloud: context.cloud,
      configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "",
      fakeProbe: process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "",
      ikeyJsonPath: ikeyPath,
    }
  );
  return { active: context.active };
}

function emitSkillConfigured(skillName, projectRoot, eventInfo) {
  const emitted = emit("configured", skillName, projectRoot, eventInfo);
  if (emitted && skillName === "add-localization") {
    invocationState.markConfigured(skillName, projectRoot);
  }
  return Boolean(emitted);
}

function emitPackageValidation(projectRoot, eventInfo) {
  return Boolean(
    emit("packageValidation", "add-localization", projectRoot, eventInfo)
  );
}

function emitLocalizationCompleted(projectRoot, input) {
  const active = invocationState.findActive(
    "add-localization",
    projectRoot,
    {
      requireConfigured: true,
      sessionId: input.sessionId,
    }
  );
  if (!active) return false;
  const durationMs =
    Number.isFinite(active.startedAt) && Date.now() >= active.startedAt
      ? Date.now() - active.startedAt
      : undefined;
  const emitted = emit(
    "completed",
    "add-localization",
    projectRoot,
    input.eventInfo,
    compactObject({
      outcome: input.outcome,
      durationMs,
      errorClass: input.errorClass,
    }),
    { active }
  );
  if (emitted) invocationState.removeState(active);
  return Boolean(emitted);
}

module.exports = {
  PACKAGE_FAILURE_CODES,
  buildCreateSiteEventInfo,
  buildLocalizationCompletionEventInfo,
  buildLocalizationEventInfo,
  buildPackageValidationEventInfo,
  emitLocalizationCompleted,
  emitPackageValidation,
  emitSkillConfigured,
  sanitizeLocale,
  sanitizeLocales,
};
