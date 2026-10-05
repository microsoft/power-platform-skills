"use strict";

// Power Automate telemetry resolver: region routing via Artemis geo + cloud
// stamp. Implements the shared dispatcher's resolver contract. All
// artemis/region code lives in ./region/ — shared/telemetry knows nothing
// about it.
const { resolve: resolveRegion } = require("./region/region-resolver");
const { normalizeCloud } = require("./region/artemis-service");

// Power Automate provisions public-cloud ingestion only (us/eu). The shared
// region resolver falls back to default_region whenever the derived region has
// no entry in regionsMap, which would route a sovereign-cloud org's events to
// the public US collector. Short-circuit instead: returning null leaves the
// event unresolved, so the dispatcher writes the local mirror and does not
// POST.
async function resolve({ event, cfg, cloud, configDir }) {
  if (normalizeCloud(cloud) !== "Public") return null;

  return resolveRegion({
    orgId: (event && event.data && event.data.orgId) || "",
    cloud,
    regionsMap: (cfg && cfg.regions) || {},
    defaultRegion: (cfg && cfg.default_region) || "us",
    configDir,
  });
}

// Sync fast-gate: is the default region's key configured? Lets the hooks skip
// the ~3-5s pac shellout when the plugin isn't provisioned yet.
function isProvisioned(cfg) {
  const dr = (cfg && cfg.default_region) || "us";
  const entry = cfg && cfg.regions && cfg.regions[dr];
  return !!(entry && entry.instrumentation_key);
}

module.exports = { resolve, isProvisioned };
