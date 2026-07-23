"use strict";

// Power-pages telemetry resolver: route by the cloud and environment-geo
// classifications returned by `pac auth who`.
const { mapToRegion } = require("./region/region-resolver");

async function resolve({ cfg, cloud, geoName }) {
  const regions = (cfg && cfg.regions) || {};
  const defaultRegion = (cfg && cfg.default_region) || "us";
  const region = mapToRegion(cloud, geoName, defaultRegion);
  const entry = regions[region] || regions[defaultRegion];
  if (!entry || !entry.instrumentation_key) return null;
  return {
    region,
    iKey: entry.instrumentation_key,
    collectorUrl: entry.collector_url || "",
  };
}

// Sync fast-gate: is the default region's key configured? Lets the hooks skip
// the ~3-5s pac shellout when the plugin isn't provisioned yet.
function isProvisioned(cfg) {
  const dr = (cfg && cfg.default_region) || "us";
  const entry = cfg && cfg.regions && cfg.regions[dr];
  return !!(entry && entry.instrumentation_key);
}

module.exports = { resolve, isProvisioned };
