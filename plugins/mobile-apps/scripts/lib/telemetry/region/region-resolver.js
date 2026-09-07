"use strict";

const appIdentity = require("../../app-identity");

const PUBLIC_US_GEOS = new Set(["us", "br", "jp", "in", "au", "ca", "as", "za", "ae", "kr",
  "unitedstates", "southamerica", "brazil", "japan", "india", "australia", "canada", "asia", "southafrica", "unitedarabemirates", "uae", "korea"]);
const PUBLIC_EU_GEOS = new Set(["eu", "uk", "de", "fr", "no", "ch", "europe", "unitedkingdom",
  "germany", "france", "norway", "switzerland", "sweden", "poland", "italy"]);

function deriveRegion(cloud, geoName) {
  const stamp = String(cloud || "").toLowerCase();
  if (["gccmoderate", "usgov"].includes(stamp)) return "gov";
  if (["gcchigh", "usgovhigh"].includes(stamp)) return "high";
  if (["dod", "usgovdod"].includes(stamp)) return "dod";
  if (["mooncake", "china"].includes(stamp)) return "mooncake";
  if (["test", "preprod", "tip1", "tip2"].includes(stamp)) return "internal";
  if (!["", "public", "prod", "preview"].includes(stamp)) return "";
  const geo = String(geoName || "").toLowerCase();
  if (PUBLIC_US_GEOS.has(geo)) return "us";
  if (PUBLIC_EU_GEOS.has(geo)) return "eu";
  return "";
}

function entryFromMap(regionsMap, cluster) {
  const entry = regionsMap && regionsMap[cluster];
  if (!entry || !entry.instrumentation_key || !entry.collector_url) return null;
  return { region: cluster, iKey: entry.instrumentation_key, collectorUrl: entry.collector_url };
}

async function resolve({ projectRoot, regionsMap }) {
  if (!projectRoot) return null;
  try {
    const cluster = appIdentity.readTelemetryCluster(projectRoot);
    return cluster ? entryFromMap(regionsMap, cluster) : null;
  } catch {
    return null;
  }
}

module.exports = { resolve, deriveRegion };
