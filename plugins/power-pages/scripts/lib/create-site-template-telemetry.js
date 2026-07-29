'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pick } = require('./telemetry/lib/events');
const { fireAndForget } = require('./telemetry/lib/emit-spawn');
const { readPacAuth } = require('./telemetry/lib/pac-auth');
const { readPacCliVersion, readAiAgent } = require('./telemetry/lib/agent-info');
const { getSessionId } = require('./telemetry/lib/session');

const EVENT_STREAM = 'PagesAIPluginEvent';
const TEMPLATE_KINDS = new Set(['spa', 'traditional']);
const FRAMEWORKS = new Set(['react', 'vue', 'angular', 'astro']);
const AUDIENCES = new Set(['internal', 'external']);
const OUTCOMES = new Set(['success', 'failure']);
const ACTIVATION_OUTCOMES = new Set(['success', 'failure', 'skipped']);
const COMMON_FIELDS = [
  'pluginName',
  'pluginVersion',
  'sessionId',
  'correlationId',
  'osName',
  'osVersion',
  'nodeVersion',
  'orgId',
  'tenantId',
  'pacCliVersion',
  'aiAgentName',
  'aiAgentVersion',
  'eventInfo',
];
const SKILL_FIELDS = ['skillName'];
const COMPLETED_FIELDS = ['outcome', 'durationMs', 'errorClass', 'errorDescription'];

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
    if (TEMPLATE_KINDS.has(fields.templateKind)) info.templateKind = fields.templateKind;
    if (OUTCOMES.has(fields.importOutcome)) info.importOutcome = fields.importOutcome;
    if (ACTIVATION_OUTCOMES.has(fields.activationOutcome)) info.activationOutcome = fields.activationOutcome;
    info.seedApplied = normalizeBool(fields.seedApplied);
  }
  return info;
}

function osFriendlyName(platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'Mac';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function readPluginVersion(deps = {}) {
  if (deps.pluginVersion) return deps.pluginVersion;
  const pluginJsonPath = deps.pluginJsonPath || path.join(__dirname, '..', '..', '.plugin', 'plugin.json');
  try {
    const parsed = JSON.parse((deps.fs || fs).readFileSync(pluginJsonPath, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveSessionId(fields = {}, env = process.env) {
  return fields.sessionId ||
    env.COPILOT_AGENT_SESSION_ID ||
    env.AGENCY_SESSION_ID ||
    env.CLAUDE_SESSION_ID ||
    '';
}

function buildTemplateOutcomeEvent(fields = {}, deps = {}) {
  // Privacy boundary: eventInfo is restricted to fixed catalog IDs/enums and
  // booleans. Do not add site name, URL, subdomain, free-text prompt content,
  // or user data here. Transmission remains governed by the shared telemetry
  // dispatcher opt-out (`/power-pages:telemetry off` and the per-plugin env var)
  // and fail-closed fire-and-forget behavior.
  const pacAuth = (deps.readPacAuth || readPacAuth)({ _exec: deps.execPacAuth });
  const agentInfo = typeof deps.readAgentInfo === 'function'
    ? deps.readAgentInfo()
    : { ...readAiAgent(deps.env || process.env), pacCliVersion: readPacCliVersion() };
  const payload = {
    pluginName: 'power-pages',
    pluginVersion: readPluginVersion({ ...deps, pluginVersion: fields.pluginVersion }),
    sessionId: getSessionId(resolveSessionId(fields, deps.env || process.env)),
    correlationId: fields.correlationId || (deps.randomUUID || crypto.randomUUID)(),
    osName: fields.osName || osFriendlyName(os.platform()),
    osVersion: fields.osVersion || os.release(),
    nodeVersion: fields.nodeVersion || `v${String(process.versions.node).split('.')[0]}`,
    skillName: 'create-site',
    outcome: fields.outcome || 'success',
    eventInfo: sanitizeTemplateOutcomeInfo(fields),
  };
  if (pacAuth && pacAuth.orgId) payload.orgId = pacAuth.orgId;
  if (pacAuth && pacAuth.tenantId) payload.tenantId = pacAuth.tenantId;
  if (agentInfo.aiAgentName) payload.aiAgentName = agentInfo.aiAgentName;
  if (agentInfo.aiAgentVersion) payload.aiAgentVersion = agentInfo.aiAgentVersion;
  if (agentInfo.pacCliVersion) payload.pacCliVersion = agentInfo.pacCliVersion;

  const severity = payload.outcome === 'failure' ? 'Error' : 'Info';
  return {
    name: EVENT_STREAM,
    data: {
      eventName: 'template_used',
      eventType: 'Trace',
      severity,
      ...pick(payload, [...COMMON_FIELDS, ...SKILL_FIELDS, ...COMPLETED_FIELDS]),
    },
  };
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
