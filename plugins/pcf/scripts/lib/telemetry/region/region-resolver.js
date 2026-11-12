"use strict";

const { fetchGeo: defaultFetchGeo, normalizeCloud } = require("./artemis-service");
const defaultCache = require("./region-cache");

// Public-cloud geoName values → routing region. Anything not listed falls
// through to defaultRegion. Sovereign clouds short-circuit via the stamp.
const PUBLIC_US_GEOS = new Set(["us", "br", "jp", "in", "au", "ca", "as", "za", "ae", "kr"]);
const PUBLIC_EU_GEOS = new Set(["eu", "uk", "de", "fr", "no", "ch"]);

// Derive the plugin-INDEPENDENT routing region from the org's cloud stamp + geo,
// or null when the public geo is unrecognized (caller falls back to its own
// defaultRegion). Only a non-null result is safe to cache: it's a property of
// the org, not of any plugin's config.
function deriveRegion(cloud, geoName) {
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
  return null;
}

function mapToRegion(cloud, geoName, defaultRegion) {
  return deriveRegion(cloud, geoName) || defaultRegion;
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

  // Cache holds only the plugin-independent org→region mapping; map it to THIS
  // plugin's iKey/collector from regionsMap on every hit, so a cache shared
  // across plugins can never hand one plugin another plugin's key.
  const cached = cache.read(orgId, configDir);
  if (cached && cached.region) {
    return entryFromMap(regionsMap, cached.region) || fallback;
  }

  let artemis;
  try {
    artemis = await fetchGeo(orgId, cloud);
  } catch {
    artemis = null;
  }
  if (!artemis) return fallback;

  // Only a region DERIVED from a recognized geo/stamp is plugin-independent and
  // cacheable; an unrecognized geo falls back to this plugin's defaultRegion,
  // which must NOT be cached (another plugin's default may differ).
  const derived = deriveRegion(cloud, artemis.geoName);
  const region = derived || defaultRegion;
  const entry = entryFromMap(regionsMap, region) || fallback;
  if (!entry) return null;
  if (derived) {
    try {
      cache.write(orgId, { region: derived }, configDir);
    } catch {
      // swallow
    }
  }
  return entry;
}

module.exports = { resolve, mapToRegion };
