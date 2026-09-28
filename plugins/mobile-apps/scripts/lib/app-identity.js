'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const APP_JSON_FILE = 'app.json';
const APP_INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

function guid(value) {
  return typeof value === 'string' && GUID.test(value) ? value.toLowerCase() : undefined;
}

function projectTarget(projectRoot) {
  const powerConfig = readJsonFile(path.join(projectRoot, 'power.config.json'));
  const resolved = readJsonFile(path.join(projectRoot, '.resolved-environment.json'));
  const auth = readJsonFile(path.join(projectRoot, 'auth.config.json'));
  if (powerConfig?.environmentId && !guid(powerConfig.environmentId)) return {};

  const environmentId = guid(powerConfig?.environmentId) ||
    guid(resolved?.environmentId) ||
    guid(auth?.environment?.environmentId);
  if (!environmentId) return {};
  const metadata = [resolved, auth?.environment]
    .find((value) => guid(value?.environmentId) === environmentId);
  return {
    environmentId,
    tenantId: guid(metadata?.tenantId),
    environmentUrl: metadata?.environmentUrl,
  };
}

function readProjectTelemetryContext(projectRoot, options = {}) {
  try {
    const target = projectTarget(projectRoot);
    const context = {};
    if (target.environmentId) context.environmentId = target.environmentId;
    if (target.tenantId) context.tenantId = target.tenantId;
    if (
      !options.lifecycle ||
      !options.runId ||
      !options.configDir ||
      !target.environmentId ||
      !target.tenantId
    ) {
      return context;
    }

    const { directory } = options.lifecycle.readRun({
      configDir: options.configDir,
      projectRoot,
      runId: options.runId,
    });
    const organization = readJsonFile(
      path.join(directory, `environment-${target.environmentId}.json`),
    );
    if (organization?.tenantId === target.tenantId && guid(organization.orgId)) {
      context.orgId = organization.orgId;
    }
    return context;
  } catch {
    return {};
  }
}

function writeAtomic(filename, value) {
  if (JSON.stringify(readJsonFile(filename)) === JSON.stringify(value)) return;
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, filename);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup must not change the verified Dataverse operation.
    }
  }
}

function recordVerifiedDataverseOrganization(options) {
  try {
    const {
      projectRoot,
      environmentUrl,
      lifecycle,
      token,
      whoAmI,
    } = options;
    const target = projectTarget(projectRoot);
    // This runs only after WhoAmI succeeds against the selected target. The
    // token, its user claims, and Dataverse UserId are never persisted.
    if (
      !target.environmentId ||
      !target.tenantId ||
      typeof target.environmentUrl !== 'string' ||
      target.environmentUrl.replace(/\/+$/, '').toLowerCase() !==
        environmentUrl.replace(/\/+$/, '').toLowerCase()
    ) {
      return false;
    }

    const { directory } = lifecycle.readRun(options);
    const claims = JSON.parse(
      Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'),
    );
    if (guid(claims.tid) !== target.tenantId) return false;

    const orgId = guid(whoAmI?.OrganizationId);
    if (orgId) {
      writeAtomic(path.join(directory, `environment-${target.environmentId}.json`), {
        environmentId: target.environmentId,
        tenantId: target.tenantId,
        orgId,
      });
    }
    return Boolean(orgId);
  } catch {
    return false;
  }
}

function captureSuccessfulDataverseRequest(environmentUrl, token, whoAmI, env = process.env) {
  try {
    if (!GUID.test(env.POWER_PLATFORM_SKILLS_MOBILE_RUN_ID || '')) return;
    const projectRoot = process.cwd();
    const telemetry = require('./mobile-telemetry');
    const context = telemetry.createTelemetryContext({}, {
      cwd: projectRoot,
      env,
      readProcessScope: () => '',
    });
    if (!context) return;
    recordVerifiedDataverseOrganization({
      projectRoot,
      configDir: context.configDir,
      runId: env.POWER_PLATFORM_SKILLS_MOBILE_RUN_ID,
      environmentUrl,
      lifecycle: telemetry.lifecycle,
      token,
      whoAmI,
    });
  } catch {
    // Organization enrichment is observational and cannot alter a successful request.
  }
}

module.exports = {
  APP_JSON_FILE,
  captureSuccessfulDataverseRequest,
  ensureAppInstanceId,
  findAppInstanceId,
  projectTarget,
  readProjectTelemetryContext,
  readTelemetryCluster,
  recordVerifiedDataverseOrganization,
  writeTelemetryCluster,
};

if (require.main === module) {
  process.stdout.write(`${ensureAppInstanceId(process.argv[2] || process.cwd())}\n`);
}
