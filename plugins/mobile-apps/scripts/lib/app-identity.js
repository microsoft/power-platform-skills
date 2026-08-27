'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const APP_JSON_FILE = 'app.json';
const APP_INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function ensureAppInstanceId(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('Cannot create app identity outside an existing directory');
  }

  const filePath = appJsonPath(root);
  const appJson = readJsonFile(filePath);
  // The create workflow gates on the supported Expo template before calling
  // this helper. Refuse to manufacture a minimal config when that invariant is
  // broken because doing so would hide scaffold damage and overwrite evidence.
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
};

if (require.main === module) {
  process.stdout.write(`${ensureAppInstanceId(process.argv[2] || process.cwd())}\n`);
}
