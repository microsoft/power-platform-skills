"use strict";

const { fetchGeo: defaultFetchGeo, normalizeCloud } = require("./artemis-service");
const { readPacAuth: defaultReadPacAuth } = require("../lib/pac-auth");
const appIdentity = require("../../app-identity");

const PUBLIC_US_GEOS = new Set(["us", "br", "jp", "in", "au", "ca", "as", "za", "ae", "kr"]);
const PUBLIC_EU_GEOS = new Set(["eu", "uk", "de", "fr", "no", "ch"]);

function deriveRegion(cloud, geoName) {
  const stamp = normalizeCloud(cloud);
  if (stamp === "Gov") return "gov";
  if (stamp === "High") return "high";
  if (stamp === "Dod") return "dod";
  if (stamp === "Mooncake") return "mooncake";
  if (stamp === "Internal") return "internal";
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

async function clusterFromWhoAmI(readPacAuth, fetchGeo) {
  const auth = readPacAuth() || {};
  if (!auth.orgId) return "";
  let geo;
  try {
    geo = await fetchGeo(auth.orgId, auth.cloud);
  } catch {
    return "";
  }
  return geo ? deriveRegion(auth.cloud, geo.geoName) : "";
}

async function resolve({ projectRoot, regionsMap, _readPacAuth, _fetchGeo, _appIdentity }) {
  const identity = _appIdentity || appIdentity;
  let cluster = identity.readTelemetryCluster(projectRoot);

  if (!cluster) {
    cluster = await clusterFromWhoAmI(
      _readPacAuth || defaultReadPacAuth,
      typeof _fetchGeo === "function" ? _fetchGeo : defaultFetchGeo,
    );
    // Persisting here is what keeps this off the hot path: every later event in
    // this project reads the cluster from app.json instead of forking `pac`.
    if (cluster) identity.writeTelemetryCluster(projectRoot, cluster);
  }

  return cluster ? entryFromMap(regionsMap, cluster) : null;
}

module.exports = { resolve, deriveRegion };
