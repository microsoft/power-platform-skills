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
      !GUID.test(options.spanId || '') ||
      !options.configDir ||
      !target?.environmentId ||
      !target.tenantId
    ) {
      return {};
    }

    const lifecycleOptions = { ...options, projectRoot };
    let current = options.lifecycle.readSpan(lifecycleOptions);
    const visited = new Set();
    while (current.record && !visited.has(current.record.spanId)) {
      visited.add(current.record.spanId);
      const organization = readJsonFile(
        path.join(current.directory, `${current.record.spanId}.environment.json`),
      );
      if (
        organization?.spanId === current.record.spanId &&
        organization.environmentId === target.environmentId &&
        organization.tenantId === target.tenantId &&
        guid(organization.orgId)
      ) {
        return {
          environmentId: target.environmentId,
          tenantId: target.tenantId,
          orgId: organization.orgId,
        };
      }
      if (!current.record.parentSpanId) break;
      current = options.lifecycle.readSpan({
        ...lifecycleOptions,
        spanId: current.record.parentSpanId,
      });
    }
    return {};
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
      spanId,
      token,
      whoAmI,
    } = options;
    const target = readProjectEnvironment(projectRoot);
    // WhoAmI supplies the organization ID while the token proves the selected
    // tenant. User claims and the Dataverse UserId are never persisted.
    if (
      !target?.environmentId ||
      !target.tenantId ||
      !GUID.test(spanId || '') ||
      typeof target.environmentUrl !== 'string' ||
      target.environmentUrl.replace(/\/+$/, '').toLowerCase() !==
        environmentUrl.replace(/\/+$/, '').toLowerCase()
    ) {
      return false;
    }

    const { directory, record: span } = lifecycle.readSpan(options);
    const claims = JSON.parse(
      Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'),
    );
    if (guid(claims.tid) !== target.tenantId) return false;

    const orgId = guid(whoAmI?.OrganizationId);
    if (orgId) {
      writeAtomic(path.join(directory, `${span.spanId}.environment.json`), {
        spanId: span.spanId,
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
