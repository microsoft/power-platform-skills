"use strict";

const { resolve: resolveRegion } = require("./region/region-resolver");

function resolve({ cfg, projectRoot }) {
  return resolveRegion({
    projectRoot: projectRoot || "",
    regionsMap: (cfg && cfg.regions) || {},
  });
}

function isProvisioned(cfg) {
  return Object.values((cfg && cfg.regions) || {}).some(
    (entry) => entry && entry.instrumentation_key && entry.collector_url,
  );
}

module.exports = { resolve, isProvisioned };
