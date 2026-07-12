'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { buildTemplateOutcome } = require('./telemetry/lib/events');
const { fireAndForget } = require('./telemetry/lib/emit-spawn');
const { readPacAuth } = require('./telemetry/lib/pac-auth');

const EVENT_STREAM = 'PagesAIPluginEvent';
const FRAMEWORKS = new Set(['react', 'vue', 'angular', 'astro']);
const AUDIENCES = new Set(['internal', 'external']);
const OUTCOMES = new Set(['success', 'failure']);
const ACTIVATION_OUTCOMES = new Set(['success', 'failure', 'skipped']);

function normalizeBool(value) {
  return value === true || value === 'true' || value === '1';
}

function sanitizeTemplateOutcomeInfo(fields = {}) {
  const info = {};
  if (fields.mode === 'template' || fields.mode === 'scratch') info.mode = fields.mode;
  if (FRAMEWORKS.has(fields.framework)) info.framework = fields.framework;
  if (AUDIENCES.has(fields.audience)) info.audience = fields.audience;
  if (info.mode === 'template') {
    if (/^[a-z0-9][a-z0-9-]*$/.test(fields.templateId || '')) info.templateId = fields.templateId;
    if (OUTCOMES.has(fields.importOutcome)) info.importOutcome = fields.importOutcome;
    if (ACTIVATION_OUTCOMES.has(fields.activationOutcome)) info.activationOutcome = fields.activationOutcome;
    info.seedApplied = normalizeBool(fields.seedApplied);
  }
  return info;
}

function buildTemplateOutcomeEvent(fields = {}, deps = {}) {
  // Privacy boundary: eventInfo is restricted to fixed catalog IDs/enums and
  // booleans. Do not add site name, URL, subdomain, free-text prompt content,
  // or user data here. Transmission remains governed by the shared telemetry
  // dispatcher opt-out (`/power-pages:telemetry off` and the per-plugin env var)
  // and fail-closed fire-and-forget behavior.
  const pacAuth = (deps.readPacAuth || readPacAuth)({ _exec: deps.execPacAuth });
  const payload = {
    pluginName: 'power-pages',
    pluginVersion: fields.pluginVersion || 'unknown',
    sessionId: fields.sessionId || '',
    correlationId: fields.correlationId || (deps.randomUUID || crypto.randomUUID)(),
    osName: fields.osName || os.platform(),
    osVersion: fields.osVersion || os.release(),
    nodeVersion: fields.nodeVersion || `v${String(process.versions.node).split('.')[0]}`,
    skillName: 'create-site',
    outcome: fields.outcome || 'success',
    eventInfo: sanitizeTemplateOutcomeInfo(fields),
  };
  if (pacAuth && pacAuth.orgId) payload.orgId = pacAuth.orgId;
  if (pacAuth && pacAuth.tenantId) payload.tenantId = pacAuth.tenantId;

  return buildTemplateOutcome(EVENT_STREAM, payload);
}

function emitTemplateOutcome(fields = {}, deps = {}) {
  try {
    const pacAuth = deps.pacAuth || (deps.readPacAuth || readPacAuth)({ _exec: deps.execPacAuth });
    const event = buildTemplateOutcomeEvent(fields, { ...deps, readPacAuth: () => pacAuth });
    const emit = deps.fireAndForget || fireAndForget;
    emit(event, {
      cloud: (pacAuth && pacAuth.cloud) || '',
      configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || '',
      fakeProbe: process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || '',
      ikeyJsonPath: path.join(__dirname, 'telemetry', 'ikey.json'),
    });
    return { ok: true, event };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { buildTemplateOutcomeEvent, emitTemplateOutcome, normalizeBool, sanitizeTemplateOutcomeInfo };
