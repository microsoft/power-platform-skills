"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { PLUGIN_NAME, UUID } = require("./schema");
const { destination } = require("./config");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EU_GEOS = new Set(["eu", "uk", "de", "fr", "no", "ch"]);
const ROW_GEOS = new Set(["us", "br", "jp", "in", "au", "ca", "as", "za", "ae", "kr"]);

function fetchGeo(orgId) {
  const compact = orgId.replace(/-/g, "");
  const url = `https://${compact.slice(0, -2)}.${compact.slice(-2)}.organization.api.powerplatform.com/gateway/cluster?api-version=1`;
  return new Promise(resolve => {
    let request;
    let timer;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      request = https.get(url, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => {
          text += chunk;
          if (text.length > 16384) { finish(null); request.destroy(); }
        });
        response.on("error", () => finish(null));
        response.on("end", () => {
          if (response.statusCode !== 200) return finish(null);
          try { finish(JSON.parse(text).geoName || null); } catch { finish(null); }
        });
      });
      request.on("error", () => finish(null));
      timer = setTimeout(() => { finish(null); request.destroy(); }, 5000);
    } catch { finish(null); }
  });
}

function cachePath(directory, orgId) {
  return path.join(directory, "telemetry", PLUGIN_NAME, "region-cache", orgId.toLowerCase() + ".json");
}

function readCache(directory, orgId, now) {
  try {
    const file = cachePath(directory, orgId);
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    if (["us", "eu"].includes(entry.region) && Number.isFinite(entry.expiresAt) &&
        entry.expiresAt > now && entry.expiresAt <= now + CACHE_TTL_MS) return entry.region;
    fs.rmSync(file, { force: true });
  } catch {}
  return null;
}

function writeCache(directory, orgId, region, now) {
  const file = cachePath(directory, orgId);
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    const cacheDir = path.dirname(file);
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(cacheDir)) {
      const candidate = path.join(cacheDir, entry);
      if ((entry.endsWith(".json") || entry.endsWith(".tmp")) &&
          fs.statSync(candidate).mtimeMs < now - CACHE_TTL_MS) fs.rmSync(candidate, { force: true });
    }
    fs.writeFileSync(temporary, JSON.stringify({ region, expiresAt: now + CACHE_TTL_MS }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

async function resolveDestination(config, data, cloud, directory, options = {}) {
  const stamp = typeof cloud === "string" ? cloud.trim().toLowerCase() : "";
  if (stamp && stamp !== "public") return null;
  if (!data.orgId) {
    if (data.tenantId || data.eventInfo?.aadObjectId || stamp) return null;
    return destination(config, "us");
  }
  if (!UUID.test(data.orgId) || stamp !== "public") return null;
  const now = options.now ?? Date.now();
  const cached = readCache(directory, data.orgId, now);
  if (cached) return destination(config, cached);
  let geo;
  try { geo = await (options.fetchGeo || fetchGeo)(data.orgId); } catch { return null; }
  if (typeof geo !== "string") return null;
  const normalized = geo.toLowerCase();
  const region = EU_GEOS.has(normalized) ? "eu" : ROW_GEOS.has(normalized) ? "us" : null;
  if (!region) return null;
  writeCache(directory, data.orgId, region, now);
  return destination(config, region);
}

module.exports = { resolveDestination, CACHE_TTL_MS };