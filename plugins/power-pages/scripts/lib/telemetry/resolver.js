"use strict";

// Resolve the Dataverse organization through Artemis first. PAC cloud and
// environment geo remain a fallback when the org lookup is unavailable.
const { resolve: resolveRegion } = require("./region/region-resolver");

async function resolve({ event, cfg, cloud, geoName, configDir }) {
  return resolveRegion({
    orgId: (event && event.data && event.data.orgId) || "",
    cloud,
    geoName,
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
