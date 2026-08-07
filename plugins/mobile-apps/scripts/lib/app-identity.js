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

function readAppInstanceId(projectRoot) {
  const appJson = readJsonFile(appJsonPath(projectRoot));
  if (!isPlainObject(appJson) || !isPlainObject(appJson.expo)) return '';

  const extra = appJson.expo.extra;
  const identity = isPlainObject(extra) && isPlainObject(extra.powerPlatformSkills)
    ? extra.powerPlatformSkills
    : null;
  const appInstanceId = identity && typeof identity.appInstanceId === 'string'
    ? identity.appInstanceId
    : '';

  return APP_INSTANCE_ID.test(appInstanceId) ? appInstanceId : '';
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

  const existing = readAppInstanceId(root);
  if (existing) return existing;

  const filePath = appJsonPath(root);
  const appJson = readJsonFile(filePath);
  const next = isPlainObject(appJson) ? appJson : {};
  next.expo = isPlainObject(next.expo) ? next.expo : {};
  next.expo.extra = isPlainObject(next.expo.extra) ? next.expo.extra : {};
  const skillIdentity = isPlainObject(next.expo.extra.powerPlatformSkills)
    ? next.expo.extra.powerPlatformSkills
    : {};

  const appInstanceId = crypto.randomUUID();
  next.expo.extra.powerPlatformSkills = {
    ...skillIdentity,
    schemaVersion: 1,
    appInstanceId,
  };

  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
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
