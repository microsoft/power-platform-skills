"use strict";

// Power-pages telemetry resolver: region routing via Artemis geo + cloud stamp.
// Implements the shared dispatcher's resolver contract. All artemis/region code
// lives in ./region/ — shared/telemetry knows nothing about it.
const { resolve: resolveRegion } = require("./region/region-resolver");

// Resolve the destination iKey/collector from local routing context. The org ID
// is passed separately from event.data so it cannot enter the diagnostic mirror
// or transmitted telemetry envelope.
async function resolve({ cfg, cloud, routingOrgId, configDir }) {
  return resolveRegion({
    orgId: routingOrgId || "",
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
