"use strict";

const https = require("node:https");

const TIMEOUT_MS = 5000;

function normalizeCloud(cloud) {
  const value = String(cloud || "").toLowerCase();
  if (value === "usgov" || value === "usgovgcc" || value === "gcc" || value === "gov") return "Gov";
  if (value === "usgovhigh" || value === "high") return "High";
  if (value === "usgovdod" || value === "dod") return "Dod";
  if (value === "china" || value === "mooncake" || value === "chinacloud") return "Mooncake";
  if (value === "tip1" || value === "tip2" || value === "test" || value === "preprod") return "Internal";
  return "Public";
}

function urlFor(orgId, cloud) {
  const noDashes = String(orgId || "").replace(/-/g, "");
  const stamp = normalizeCloud(cloud);
  if (stamp === "Public") {
    return `https://${noDashes.slice(0, -2)}.${noDashes.slice(-2)}.organization.api.powerplatform.com/gateway/cluster?api-version=1`;
  }
  const domain = noDashes.slice(0, -1);
  const suffix = noDashes.slice(-1);
  if (stamp === "Gov") return `https://${domain}.${suffix}.organization.api.gov.powerplatform.microsoft.us/gateway/cluster?api-version=1`;
  if (stamp === "High") return `https://${domain}.${suffix}.organization.api.high.powerplatform.microsoft.us/gateway/cluster?api-version=1`;
  if (stamp === "Dod") return `https://${domain}.${suffix}.organization.api.appsplatform.us/gateway/cluster?api-version=1`;
  if (stamp === "Mooncake") return `https://${domain}.${suffix}.organization.api.powerplatform.partner.microsoftonline.cn/gateway/cluster?api-version=1`;
  return `https://${domain}.${suffix}.organization.api.test.powerplatform.com/gateway/cluster?api-version=1`;
}

function defaultHttpsGet(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: "GET",
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on("error", reject);
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error("timeout")));
    request.end();
  });
}

async function fetchGeo(orgId, cloud, opts = {}) {
  if (!orgId) return null;
  const httpsGet = typeof opts._httpsGet === "function" ? opts._httpsGet : defaultHttpsGet;
  let response;
  try {
    response = await httpsGet(urlFor(orgId, cloud));
  } catch {
    return null;
  }
  if (!response || response.statusCode < 200 || response.statusCode >= 300) return null;
  try {
    const body = JSON.parse(response.body || "");
    return body && typeof body.geoName === "string" && body.geoName
      ? { geoName: body.geoName, stamp: normalizeCloud(cloud) }
      : null;
  } catch {
    return null;
  }
}

module.exports = { fetchGeo, urlFor, normalizeCloud, TIMEOUT_MS };
