"use strict";

// model-apps telemetry resolver: picks THIS plugin's instrumentation key + OneCollector URL for an
// event. Implements the shared dispatcher's resolver contract (shared/telemetry/lib/resolver-loader.js):
//   resolve({ event, cfg, cloud, configDir }) → { region, iKey, collectorUrl } | null
//   isProvisioned(cfg)                         → boolean (sync gate before the pac shell-outs)
//   formatEnvelope({ time, data, iKey, ... })  → the wire envelope (Power Apps client `event` shape)
//
// ./region/ is a VERBATIM copy of power-pages' Artemis geo + cloud-stamp router. Keep it byte-identical
// so a refresh is a plain copy; the model-apps-specific routing lives here instead. Its org→region cache
// (~/.power-platform-skills/region-cache/<orgId>.json) is shared with power-pages on purpose: it stores
// only the plugin-independent region, and each plugin maps that to its own key from its own ikey.json.
const { resolve: resolveRegion, mapToRegion } = require("./region/region-resolver");

// `cloud` is the "Cloud:" value from `pac auth who`. PAC documents Public, UsGov, UsGovHigh, UsGovDod and
// China (https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/auth#pac-auth-create);
// Microsoft-internal stamps surface as Tip1/Tip2/Test/Preprod. An empty value is public only when there
// is also no org (PAC signed out): nothing identifies a region then, so the event takes the public default
// like power-pages does. A signed-in org with no cloud line is handled in resolve() below.
const PUBLIC_CLOUDS = new Set(["", "public"]);
const STAMPED_CLOUDS = new Set([
  "usgov", "usgovgcc", "gcc", "gov",
  "usgovhigh", "high",
  "usgovdod", "dod",
  "china", "mooncake", "chinacloud",
  "tip1", "tip2", "test", "preprod",
]);

function entryFromMap(regionsMap, region) {
  const e = regionsMap && regionsMap[region];
  if (!e || !e.instrumentation_key || !e.collector_url) return null;
  return { region, iKey: e.instrumentation_key, collectorUrl: e.collector_url };
}

async function resolve({ event, cfg, cloud, configDir }) {
  const regionsMap = (cfg && cfg.regions) || {};
  const defaultRegion = (cfg && cfg.default_region) || "us";
  const c = String(cloud || "").trim().toLowerCase();
  const orgId = (event && event.data && event.data.orgId) || "";

  // Deliberate deviation from power-pages: a sovereign or internal cloud is routed from the PAC
  // stamp ALONE. The stamp already decides the region (the geo is ignored for these), and the region
  // router only falls back to the PUBLIC default when its Artemis lookup fails — so a GCC/High/DoD/
  // China org whose gateway call timed out would otherwise have its event sent to the US public
  // collector. Returning null when this plugin has no entry for the stamp leaves the dispatcher with
  // no key (ikey.json carries no top-level static key), so nothing is sent — fail closed.
  if (STAMPED_CLOUDS.has(c)) {
    return entryFromMap(regionsMap, mapToRegion(cloud, "", defaultRegion));
  }

  // An unrecognized stamp (a future PAC value, an air-gapped cloud) has no key here, and the shared
  // normalizer would treat it as Public. Send nothing rather than leak it to a public collector; the
  // local diagnostic mirror is still written by the dispatcher.
  if (!PUBLIC_CLOUDS.has(c)) return null;

  // A signed-in org whose `pac auth who` output had no "Cloud:" line (the parser returns "" then) could be
  // a sovereign org. Treating it as public would query the public Artemis gateway, fail, and fall back to
  // the US public collector — so send nothing instead.
  if (!c && orgId) return null;

  // Public cloud: US vs EU data boundary comes from the org's geo (Artemis gateway), cached per org.
  return resolveRegion({
    orgId,
    cloud,
    regionsMap,
    defaultRegion,
    configDir,
  });
}

// Sync fast-gate: is the default region's key configured? Lets the hooks skip the ~3-5s pac shell-out
// when the config is unprovisioned. A placeholder key counts as unprovisioned, matching the
// dispatcher's own PLACEHOLDER_IKEY guard, so flipping `disabled: false` early cannot emit.
function isProvisioned(cfg) {
  const dr = (cfg && cfg.default_region) || "us";
  const entry = cfg && cfg.regions && cfg.regions[dr];
  return !!(
    entry &&
    entry.instrumentation_key &&
    entry.instrumentation_key !== "PLACEHOLDER_REPLACE_BEFORE_SHIPPING" &&
    entry.collector_url
  );
}

// Reshape the shared skill_started payload into the Power Apps client `event` schema. model-apps' 1DS
// tenants (shared with the mobile-apps plugin) ingest ONLY the `event` stream, into the Power Apps
// client `event` table — a stream named anything else is accepted by the collector (HTTP 200) and then
// silently dropped, because no table is mapped for it. This mirrors mobile-apps'
// scripts/lib/mobile-telemetry-dispatcher.js buildEnvelope(), with one deliberate difference:
// clientType is "ModelAppsAIPlugin", not "PowerAppsNative", so these rows can never be counted as Power
// Apps native-client traffic by queries that filter on clientType.
//
// Wire shape (one line of the x-json-stream body):
//   { ver: "4.0", name: "event", time, iKey: "o:<tenant token>",
//     data: { app_Name: "powerappsclient", clientType: "ModelAppsAIPlugin", event_Name: "skill_started",
//             session_Id, tenantId?, severity, timestamp,
//             customDimensions: "{\"pluginName\":\"model-apps\",\"skillName\":\"genpage\",...}" },
//     ext: { app: { sesId, ver }, os: { name, ver } } }
// `data` arrives already sanitized against the shared FIELD_TYPES allowlist, so this only rearranges
// approved fields. Query: event | where clientType == "ModelAppsAIPlugin"
//   | extend d = parse_json(customDimensions) | where d.pluginName == "model-apps"
function formatEnvelope({ time, data, iKey, eventStreamName }) {
  const d = data || {};
  const dimensions = { ...d };
  delete dimensions.eventName;
  delete dimensions.eventType;
  delete dimensions.severity;
  return {
    ver: "4.0",
    name: eventStreamName || "event",
    time,
    iKey: "o:" + String(iKey || "").split("-")[0],
    data: {
      app_Name: "powerappsclient",
      clientType: "ModelAppsAIPlugin",
      event_Name: d.eventName || "",
      session_Id: d.sessionId || "",
      ...(d.tenantId ? { tenantId: d.tenantId } : {}),
      severity: d.severity || "Info",
      timestamp: time,
      customDimensions: JSON.stringify(dimensions),
    },
    // Common Schema Part A extensions, kept outside customDimensions so the ingestion mapping fills the
    // standard app/session/OS columns (same as mobile-apps).
    ext: {
      app: { sesId: d.sessionId || "", ver: d.pluginVersion || "" },
      os: { name: d.osName || "", ver: d.osVersion || "" },
    },
  };
}

module.exports = { resolve, isProvisioned, formatEnvelope };
