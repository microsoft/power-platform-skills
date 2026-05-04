"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const TENANT_KEYS = ["tenantId", "tenantID", "tenant"];
const ORG_KEYS = ["organizationId", "orgId", "OrgId", "organizationID"];

function defaultProfileDirs() {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), "AppData", "Local");
    return [path.join(localAppData, "Microsoft", "PowerAppsCLI", "auth")];
  }
  return [
    path.join(os.homedir(), ".local", "share", "Microsoft", "PowerAppsCLI", "auth"),
    path.join(os.homedir(), ".config", "Microsoft", "PowerAppsCLI", "auth"),
  ];
}

function pickKey(obj, keys) {
  for (const k of keys) {
    if (typeof obj[k] === "string" && obj[k]) return obj[k];
  }
  return null;
}

function readProfile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listProfileFiles(dir) {
  try {
    const entries = fs.readdirSync(dir);
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => path.join(dir, e));
  } catch {
    return [];
  }
}

function readPacAuth(opts = {}) {
  const dirs = opts.profileDir ? [opts.profileDir] : defaultProfileDirs();
  for (const dir of dirs) {
    const files = listProfileFiles(dir);
    for (const file of files) {
      const parsed = readProfile(file);
      if (!parsed || typeof parsed !== "object") continue;
      const tenantId = pickKey(parsed, TENANT_KEYS);
      const orgId = pickKey(parsed, ORG_KEYS);
      if (tenantId || orgId) {
        return {
          orgId: orgId || "",
          tenantId: tenantId || "",
        };
      }
    }
  }
  return null;
}

module.exports = { readPacAuth };
