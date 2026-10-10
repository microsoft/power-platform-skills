'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const APP_JSON_FILE = 'app.json';
const APP_INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TELEMETRY_CLUSTERS = new Set(['us', 'eu', 'gov', 'high', 'dod', 'mooncake', 'internal']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function appJsonPath(projectRoot) {
  return path.join(path.resolve(projectRoot), APP_JSON_FILE);
}

function appInstanceIdFromConfig(appJson) {
  if (!isPlainObject(appJson) || !isPlainObject(appJson.expo)) return '';

  const extra = appJson.expo.extra;
  const telemetry = isPlainObject(extra) && isPlainObject(extra.telemetry)
    ? extra.telemetry
    : null;
  const appInstanceId = telemetry && typeof telemetry.appInstanceId === 'string'
    ? telemetry.appInstanceId
    : '';

  return APP_INSTANCE_ID.test(appInstanceId) ? appInstanceId : '';
}

function readAppInstanceId(projectRoot) {
  return appInstanceIdFromConfig(readJsonFile(appJsonPath(projectRoot)));
}

function findAppInstanceId(projectRoot = process.cwd()) {
  if (!projectRoot) return '';
  return readAppInstanceId(projectRoot);
}

function telemetrySection(appJson) {
  if (!isPlainObject(appJson) || !isPlainObject(appJson.expo)) return null;
  const extra = appJson.expo.extra;
  return isPlainObject(extra) && isPlainObject(extra.telemetry) ? extra.telemetry : null;
}

function readTelemetryCluster(projectRoot = process.cwd()) {
  if (!projectRoot) return '';
  const telemetry = telemetrySection(readJsonFile(appJsonPath(projectRoot)));
  const cluster = telemetry && typeof telemetry.cluster === 'string' ? telemetry.cluster : '';
  return TELEMETRY_CLUSTERS.has(cluster) ? cluster : '';
}

function writeTelemetryCluster(projectRoot, cluster) {
  if (!projectRoot || (cluster !== null && !TELEMETRY_CLUSTERS.has(cluster))) return;
  const filePath = appJsonPath(projectRoot);
  // Re-read to keep the write window small when other project tooling updates app.json.
  const appJson = readJsonFile(filePath);
  if (!isPlainObject(appJson) || !isPlainObject(appJson.expo)) return;
  const extra = isPlainObject(appJson.expo.extra) ? appJson.expo.extra : {};
  const telemetry = isPlainObject(extra.telemetry) ? extra.telemetry : {};
  if (telemetry.cluster === cluster) return;

  appJson.expo.extra = { ...extra, telemetry: { ...telemetry, cluster } };
  const temporary = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(appJson, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, filePath);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function ensureAppInstanceId(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('Cannot create app identity outside an existing directory');
  }

  const filePath = appJsonPath(root);
  const appJson = readJsonFile(filePath);
  // Telemetry must not manufacture project configuration outside a valid Expo app.
  if (!isPlainObject(appJson) || !isPlainObject(appJson.expo)) {
    throw new Error('Cannot create app identity without an existing, valid Expo app.json');
  }

  const existing = appInstanceIdFromConfig(appJson);
  if (existing) return existing;

  appJson.expo.extra = isPlainObject(appJson.expo.extra) ? appJson.expo.extra : {};
  const telemetry = isPlainObject(appJson.expo.extra.telemetry)
    ? appJson.expo.extra.telemetry
    : {};

  const appInstanceId = crypto.randomUUID();
  appJson.expo.extra.telemetry = {
    ...telemetry,
    appInstanceId,
  };

  fs.writeFileSync(filePath, `${JSON.stringify(appJson, null, 2)}\n`, 'utf8');
  return appInstanceId;
}

module.exports = {
  APP_JSON_FILE,
  ensureAppInstanceId,
  findAppInstanceId,
  readTelemetryCluster,
  writeTelemetryCluster,
};

if (require.main === module) {
  process.stdout.write(`${ensureAppInstanceId(process.argv[2] || process.cwd())}\n`);
}
