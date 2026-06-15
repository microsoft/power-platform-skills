"use strict";

const { fetchGeo: defaultFetchGeo, normalizeCloud } = require("./artemis-service");
const defaultCache = require("./region-cache");

// Public-cloud geoName values → routing region. Anything not listed falls
// through to defaultRegion. Sovereign clouds short-circuit via the stamp.
const PUBLIC_US_GEOS = new Set(["us", "br", "jp", "in", "au", "ca", "as", "za", "ae", "kr"]);
const PUBLIC_EU_GEOS = new Set(["eu", "uk", "de", "fr", "no", "ch"]);

function mapToRegion(cloud, geoName, defaultRegion) {
  const stamp = normalizeCloud(cloud);
  if (stamp === "Gov") return "gov";
  if (stamp === "High") return "high";
  if (stamp === "Dod") return "dod";
  if (stamp === "Mooncake") return "mooncake";
  if (stamp === "Internal") return "internal";
  // stamp === "Public"
  const g = String(geoName || "").toLowerCase();
  if (PUBLIC_US_GEOS.has(g)) return "us";
  if (PUBLIC_EU_GEOS.has(g)) return "eu";
  return defaultRegion;
}

function entryFromMap(regionsMap, region) {
  const e = regionsMap && regionsMap[region];
  if (!e || !e.instrumentation_key) return null;
  return {
    region,
    iKey: e.instrumentation_key,
    collectorUrl: e.collector_url || "",
  };
}

async function resolve({
  orgId,
  cloud,
  regionsMap,
  defaultRegion,
  configDir,
  _fetchGeo,
  _cache,
}) {
  const cache = _cache || defaultCache;
  const fetchGeo = typeof _fetchGeo === "function" ? _fetchGeo : defaultFetchGeo;
  const fallback = entryFromMap(regionsMap, defaultRegion);

  if (!orgId) return fallback;

  const cached = cache.read(orgId, configDir);
  if (cached) return cached;

  let artemis;
  try {
    artemis = await fetchGeo(orgId, cloud);
  } catch {
    artemis = null;
  }
  if (!artemis) return fallback;

  const region = mapToRegion(cloud, artemis.geoName, defaultRegion);
  const entry = entryFromMap(regionsMap, region) || fallback;
  if (!entry) return null;
  try {
    cache.write(orgId, entry, configDir);
  } catch {
    // swallow
  }
  return entry;
}

module.exports = { resolve, mapToRegion };
