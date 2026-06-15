"use strict";

// Power-pages telemetry resolver: region routing via Artemis geo + cloud stamp.
// Implements the shared dispatcher's resolver contract. All artemis/region code
// lives in ./region/ — shared/telemetry knows nothing about it.
const { resolve: resolveRegion } = require("./region/region-resolver");

// Resolve the destination iKey/collector for THIS event's org region.
async function resolve({ event, cfg, cloud, configDir }) {
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
