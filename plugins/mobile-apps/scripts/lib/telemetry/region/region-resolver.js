"use strict";

const appIdentity = require("../../app-identity");
const { resolveEnvironment } = require("../../environment-resolution");

// BAP's `unitedstatesfirstrelease` is the public Preview (United States) region.
// See: https://learn.microsoft.com/en-us/power-platform/admin/preview-environments
const PUBLIC_US_GEOS = new Set(["us", "br", "jp", "in", "au", "ca", "as", "za", "ae", "kr",
  "unitedstates", "unitedstatesfirstrelease", "southamerica", "brazil", "japan", "india", "australia", "canada", "asia", "southafrica", "unitedarabemirates", "uae", "korea"]);
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

async function resolveClusterEnvironment(projectRoot, resolvedEnvironment = null) {
  if (!projectRoot) return null;
  try {
    const savedCluster = appIdentity.readTelemetryCluster(projectRoot);
    if (savedCluster) return savedCluster;
    const environment = resolvedEnvironment || await resolveEnvironment(null, projectRoot);
    const cluster = environment?.clusterEnvironment && environment?.clusterGeoName
      ? deriveRegion(environment.clusterEnvironment, environment.clusterGeoName) : "";
    if (!cluster) return null;
    const currentCluster = appIdentity.readTelemetryCluster(projectRoot);
    if (currentCluster) return currentCluster;
    appIdentity.writeTelemetryCluster(projectRoot, cluster);
    return appIdentity.readTelemetryCluster(projectRoot) || null;
  } catch {
    return null;
  }
}

async function resolve({ projectRoot, regionsMap, cluster }) {
  if (!projectRoot) return null;
  try {
    const resolvedCluster = cluster === undefined ? await resolveClusterEnvironment(projectRoot) : cluster;
    return resolvedCluster ? entryFromMap(regionsMap, resolvedCluster) : null;
  } catch {
    return null;
  }
}

module.exports = { resolve, deriveRegion, resolveClusterEnvironment };
