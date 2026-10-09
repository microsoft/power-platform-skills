"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { STREAM_NAME } = require("./schema");

const CONFIG_PATH = path.join(__dirname, "ikey.json");
const COLLECTORS = Object.freeze({
  us: "https://browser.events.data.microsoft.com/OneCollector/1.0/",
  eu: "https://eu-mobile.events.data.microsoft.com/OneCollector/1.0/",
});

function readConfig(configPath = CONFIG_PATH) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config && typeof config === "object" && !Array.isArray(config) ? config : null;
  } catch {
    return null;
  }
}

function destination(config, region) {
  const entry = config && config.regions && config.regions[region];
  if (!entry || !COLLECTORS[region] || entry.collector_url !== COLLECTORS[region] ||
      typeof entry.instrumentation_key !== "string" ||
      !/^[0-9a-f]{32}-[0-9a-f-]{36}-\d+$/i.test(entry.instrumentation_key)) return null;
  return { region, iKey: entry.instrumentation_key, collectorUrl: entry.collector_url };
}

function enabled(config) {
  return !!(config && config.disabled === false && config.event_stream_name === STREAM_NAME &&
    config.default_region === "us" && destination(config, "us") && destination(config, "eu"));
}

function configDir(env = process.env) {
  return env.POWER_PLATFORM_SKILLS_CONFIG_DIR || path.join(os.homedir(), ".power-platform-skills");
}

module.exports = { CONFIG_PATH, COLLECTORS, readConfig, destination, enabled, configDir };