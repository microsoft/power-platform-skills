'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSkillStarted, buildSkillCompleted } = require('./telemetry/lib/events');
const { fireAndForget } = require('./telemetry/lib/emit-spawn');
const { readPacAuth } = require('./telemetry/lib/pac-auth');
const { readAiAgent, readPacCliVersion } = require('./telemetry/lib/agent-info');
const { getSessionId } = require('./telemetry/lib/session');
const { loadResolver } = require('./telemetry/lib/resolver-loader');
const {
  artifactCachePath, getDefaultCacheRoot, DEFAULT_CATALOG_PATH,
  isCreateWebsiteApiTemplate, validateCatalogShape,
} = require('./template-catalog');

const TELEMETRY_DIR = path.join(__dirname, 'telemetry');
const EVENT_NAMES = new Set(['template_used', 'non_spa_creation_success', 'non_spa_creation_failure']);
const ERROR_CLASSES = new Set([
  'Configuration', 'Authentication', 'TemplateCatalog', 'Provisioning',
  'ModelVerification', 'Download', 'Validation', 'GitBaseline', 'Unknown',
]);
const AUDIENCES = new Set(['internal', 'external']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEMPLATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
    throw new Error('Invalid telemetry state file.');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid telemetry state directory.');
}

function correlationId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('A creation correlation UUID is required.');
  return value.toLowerCase();
}

function templateIdFromCatalog(fields, cacheRoot) {
  if (typeof fields.templateId !== 'string' || fields.templateId.length > 120 || !TEMPLATE_ID.test(fields.templateId)) {
    throw new Error('Invalid public template identifier.');
  }
  // Reuse the manifest already fetched by list-site-templates. No catalog/PAC
  // query is added solely for telemetry. A display name or arbitrary slug is not
  // accepted just because it matches a regular expression.
  const file = artifactCachePath({
    cacheRoot, sha: fields.catalogSha, artifactPath: DEFAULT_CATALOG_PATH,
  });
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
    throw new Error('Invalid cached template catalog.');
  }
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (validateCatalogShape(catalog)) throw new Error('Invalid cached template catalog.');
  const matches = catalog.templates.filter((template) =>
    template.id === fields.templateId && isCreateWebsiteApiTemplate(template));
  if (matches.length !== 1) throw new Error('Template is not in the cached public non-SPA catalog.');
  return matches[0].id;
}

function normalizeContext(context = {}) {
  // Reuse the shared context picker without allowing arbitrary eventInfo from
  // persisted state. These are the existing approved context fields, not site data.
  const { eventName, eventType, severity, skillName, eventInfo, ...common } =
    buildSkillStarted('', { ...context, eventInfo: undefined, skillName: undefined }).data;
  return common;
}

function duplicateSelection(statePath, id, templateId, catalogSha) {
  const existing = readJson(statePath);
  if (existing.schemaVersion !== 1 || existing.correlationId !== id ||
      existing.templateId !== templateId || existing.catalogSha !== catalogSha) {
    throw new Error('Creation correlation already belongs to another selection.');
  }
  return { ok: true, skipped: 'duplicate', correlationId: id };
}

function buildNonSpaCreationEvent(eventName, state, streamName, errorClass) {
  if (!EVENT_NAMES.has(eventName)) throw new Error('Unsupported non-SPA telemetry event.');
  if (typeof state.templateId !== 'string' || !TEMPLATE_ID.test(state.templateId) || state.templateId.length > 120) {
    throw new Error('Invalid template identifier.');
  }
  const fields = {
    ...normalizeContext(state.context),
    pluginName: 'power-pages', skillName: 'create-site',
    correlationId: correlationId(state.correlationId),
    eventInfo: {
      templateId: state.templateId,
      templateKind: 'non-spa',
      ...(AUDIENCES.has(state.audience) ? { audience: state.audience } : {}),
    },
  };
  // Same envelope and eventInfo vocabulary as SPA template telemetry. Selection
  // is not completion; non-SPA outcomes must not masquerade as SPA import/clone.
  const event = eventName === 'template_used'
    ? buildSkillStarted(streamName, fields)
    : buildSkillCompleted(streamName, {
      ...fields, outcome: eventName === 'non_spa_creation_success' ? 'success' : 'failure',
      ...(eventName === 'non_spa_creation_failure' ? {
        errorClass: ERROR_CLASSES.has(errorClass) ? errorClass : 'Unknown',
      } : {}),
    });
  event.data.eventName = eventName;
  return event;
}

function readEmissionConfig(env) {
  const ikeyJsonPath = env.POWER_PLATFORM_SKILLS_IKEY_JSON || path.join(TELEMETRY_DIR, 'ikey.json');
  const cfg = readJson(ikeyJsonPath);
  if (cfg.disabled === true) return null;
  const resolver = loadResolver(path.dirname(ikeyJsonPath));
  const provisioned = resolver?.isProvisioned
    ? resolver.isProvisioned(cfg)
    : typeof cfg.instrumentationKey === 'string' && cfg.instrumentationKey &&
      cfg.instrumentationKey !== 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING';
  if (!provisioned || typeof cfg.event_stream_name !== 'string' || !cfg.event_stream_name) return null;
  return { ikeyJsonPath, streamName: cfg.event_stream_name };
}

function creationContext(fields, deps, env) {
  const pac = (deps.readPacAuth || readPacAuth)() || {};
  const agent = (deps.readAgentInfo || (() => ({ ...readAiAgent(env), pacCliVersion: readPacCliVersion() })))() || {};
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.plugin', 'plugin.json'), 'utf8'));
  return {
    cloud: ['Public', 'UsGov', 'UsGovHigh', 'UsGovDod', 'China'].includes(pac.cloud) ? pac.cloud : '',
    context: normalizeContext({
      pluginVersion: manifest.version,
      sessionId: getSessionId(fields.sessionId || env.COPILOT_AGENT_SESSION_ID || env.AGENCY_SESSION_ID || env.CLAUDE_SESSION_ID || ''),
      osName: { win32: 'Windows', darwin: 'Mac', linux: 'Linux' }[process.platform] || process.platform,
      osVersion: os.release(), nodeVersion: `v${process.versions.node.split('.')[0]}`,
      orgId: pac.orgId || undefined, tenantId: pac.tenantId || undefined,
      aiAgentName: agent.aiAgentName, aiAgentVersion: agent.aiAgentVersion, pacCliVersion: agent.pacCliVersion,
    }),
  };
}

function pruneRuns(root, now) {
  // Creation records have the same retention horizon as the diagnostic mirror.
  // Remove only this helper's two named files in UUID directories, never a site.
  for (const name of fs.readdirSync(root)) {
    if (!UUID.test(name)) continue;
    const directory = path.join(root, name);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs <= MAX_AGE_MS) continue;
      for (const file of ['state.json', 'finished.json']) {
        const target = path.join(directory, file);
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
      fs.rmdirSync(directory);
    } catch {
      // Retention is best-effort and must not break a new creation.
    }
  }
}

function recordNonSpaCreation(fields, deps = {}) {
  try {
    const env = deps.env || process.env;
    // Hard-off/unprovisioned is checked before context shellouts, state writes,
    // or spawning. User opt-out is left to the shared dispatcher so the existing
    // diagnostic mirror, transmission precedence, and regional routing remain.
    const config = readEmissionConfig(env);
    if (!config) return { ok: true, skipped: 'disabled' };
    if (!EVENT_NAMES.has(fields.eventName)) throw new Error('Unsupported event.');
    const id = correlationId(fields.correlationId === undefined && fields.eventName === 'template_used'
      ? crypto.randomUUID() : fields.correlationId);
    const configDir = env.POWER_PLATFORM_SKILLS_CONFIG_DIR || path.join(os.homedir(), '.power-platform-skills');
    const root = path.join(configDir, 'telemetry', 'power-pages', 'non-spa-creations');
    // Check each helper-owned level before descending through it.
    for (const directory of [
      configDir, path.join(configDir, 'telemetry'), path.join(configDir, 'telemetry', 'power-pages'), root,
    ]) privateDirectory(directory);
    const directory = path.join(root, id);
    const statePath = path.join(directory, 'state.json');
    let state;
    let event;
    if (fields.eventName === 'template_used') {
      const templateId = templateIdFromCatalog(fields, deps.cacheRoot || getDefaultCacheRoot());
      privateDirectory(directory);
      if (fs.existsSync(statePath)) {
        return duplicateSelection(statePath, id, templateId, fields.catalogSha);
      }
      state = {
        schemaVersion: 1, correlationId: id, templateId, catalogSha: fields.catalogSha,
        ...(AUDIENCES.has(fields.audience) ? { audience: fields.audience } : {}),
        ...creationContext(fields, deps, env),
      };
      event = buildNonSpaCreationEvent(fields.eventName, state, config.streamName);
      // Claim before dispatch: retries cannot double-count a selection. A crash
      // after the claim may lose an event; best-effort telemetry is not exactly-once.
      try { fs.writeFileSync(statePath, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code === 'EEXIST') return duplicateSelection(statePath, id, templateId, fields.catalogSha);
        throw error;
      }
      pruneRuns(root, Date.now());
    } else {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid creation state directory.');
      state = readJson(statePath);
      if (state.schemaVersion !== 1 || state.correlationId !== id ||
          typeof state.context?.sessionId !== 'string' || !state.context.sessionId) {
        throw new Error('Invalid creation correlation state.');
      }
      // The private receipt already binds the validated catalog selection. Do
      // not refetch/revalidate an evicted catalog just to finish a resumed run.
      event = buildNonSpaCreationEvent(fields.eventName, state, config.streamName, fields.errorClass);
      // One terminal outcome per attempt. In-flight retries/resume share an ID;
      // a new attempt after a recorded terminal failure needs a new selection ID.
      try {
        fs.writeFileSync(path.join(directory, 'finished.json'), JSON.stringify({ eventName: fields.eventName }),
          { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code === 'EEXIST') return { ok: true, skipped: 'finished', correlationId: id };
        throw error;
      }
    }
    (deps.fireAndForget || fireAndForget)(event, {
      cloud: state.cloud, configDir, ikeyJsonPath: config.ikeyJsonPath,
      fakeProbe: env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || '',
    });
    return { ok: true, correlationId: id };
  } catch {
    // Never expose raw errors, catalog text, paths, identifiers or credentials to
    // stdout. Failure to record telemetry cannot change provisioning behavior.
    return { ok: false };
  }
}

module.exports = { buildNonSpaCreationEvent, recordNonSpaCreation };
