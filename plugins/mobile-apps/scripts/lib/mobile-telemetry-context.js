'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readProjectEnvironment } = require('./environment-resolution');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function guid(value) {
  return typeof value === 'string' && GUID.test(value) ? value.toLowerCase() : undefined;
}

function readProjectTelemetryContext(projectRoot, options = {}) {
  try {
    const target = readProjectEnvironment(projectRoot);
    if (
      !options.lifecycle ||
      !options.runId ||
      !options.configDir ||
      !target?.environmentId ||
      !target.tenantId
    ) {
      return {};
    }

    const { directory } = options.lifecycle.readRun({
      configDir: options.configDir,
      projectRoot,
      runId: options.runId,
    });
    const organization = readJsonFile(
      path.join(directory, `environment-${target.environmentId}.json`),
    );
    if (
      organization?.environmentId !== target.environmentId ||
      organization.tenantId !== target.tenantId ||
      !guid(organization.orgId)
    ) {
      return {};
    }
    return {
      environmentId: target.environmentId,
      tenantId: target.tenantId,
      orgId: organization.orgId,
    };
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
      // Best-effort cleanup cannot alter a successful Dataverse operation.
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
    const target = readProjectEnvironment(projectRoot);
    // WhoAmI supplies the organization ID while the token proves the selected
    // tenant. User claims and the Dataverse UserId are never persisted.
    if (
      !target?.environmentId ||
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

module.exports = {
  GUID,
  readProjectTelemetryContext,
  recordVerifiedDataverseOrganization,
};
