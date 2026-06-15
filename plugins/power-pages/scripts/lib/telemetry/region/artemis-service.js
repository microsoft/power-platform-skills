"use strict";

const https = require("node:https");

const TIMEOUT_MS = 5000;

function normalizeCloud(cloud) {
  const c = String(cloud || "").toLowerCase();
  // "usgov" is the token `pac auth who` actually emits for GCC (see
  // validation-helpers.js CLOUD_TO_API). The other spellings are defensive
  // aliases. Exact `===` matching means this can't shadow usgovhigh/usgovdod.
  if (c === "usgov" || c === "usgovgcc" || c === "gcc" || c === "gov") return "Gov";
  if (c === "usgovhigh" || c === "high") return "High";
  if (c === "usgovdod" || c === "dod") return "Dod";
  if (c === "china" || c === "mooncake" || c === "chinacloud") return "Mooncake";
  if (c === "tip1" || c === "tip2" || c === "test" || c === "preprod") return "Internal";
  return "Public";
}

function urlFor(orgId, cloud) {
  const noDashes = String(orgId || "").replace(/-/g, "");
  const stamp = normalizeCloud(cloud);
  if (stamp === "Public") {
    const domain = noDashes.slice(0, -2);
    const suffix = noDashes.slice(-2);
    return `https://${domain}.${suffix}.organization.api.powerplatform.com/gateway/cluster?api-version=1`;
  }
  const domain = noDashes.slice(0, -1);
  const suffix = noDashes.slice(-1);
  if (stamp === "Gov") {
    return `https://${domain}.${suffix}.organization.api.gov.powerplatform.microsoft.us/gateway/cluster?api-version=1`;
  }
  if (stamp === "High") {
    return `https://${domain}.${suffix}.organization.api.high.powerplatform.microsoft.us/gateway/cluster?api-version=1`;
  }
  if (stamp === "Dod") {
    return `https://${domain}.${suffix}.organization.api.appsplatform.us/gateway/cluster?api-version=1`;
  }
  if (stamp === "Mooncake") {
    return `https://${domain}.${suffix}.organization.api.powerplatform.partner.microsoftonline.cn/gateway/cluster?api-version=1`;
  }
  // Internal
  return `https://${domain}.${suffix}.organization.api.test.powerplatform.com/gateway/cluster?api-version=1`;
}

function defaultHttpsGet(url) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + (u.search || ""),
        method: "GET",
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

async function fetchGeo(orgId, cloud, opts = {}) {
  if (!orgId) return null;
  const url = urlFor(orgId, cloud);
  const httpsGet = typeof opts._httpsGet === "function" ? opts._httpsGet : defaultHttpsGet;
  let resp;
  try {
    resp = await httpsGet(url);
  } catch {
    return null;
  }
  if (!resp || typeof resp.statusCode !== "number") return null;
  if (resp.statusCode < 200 || resp.statusCode >= 300) return null;
  let body;
  try {
    body = JSON.parse(resp.body || "");
  } catch {
    return null;
  }
  if (!body || typeof body.geoName !== "string" || !body.geoName) return null;
  return { geoName: body.geoName, stamp: normalizeCloud(cloud) };
}

module.exports = { fetchGeo, urlFor, normalizeCloud, TIMEOUT_MS };
