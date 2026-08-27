'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TELEMETRY_DIR = path.join(__dirname, 'telemetry');
const PLACEHOLDER_IKEY = 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING';

const agentInfo = require('./telemetry/lib/agent-info');
const events = require('./telemetry/lib/events');
const { fireAndForget } = require('./mobile-telemetry-dispatcher');
const { loadResolver } = require('./telemetry/lib/resolver-loader');
const session = require('./telemetry/lib/session');
const { findAppInstanceId } = require('./app-identity');

function readPluginVersion() {
  const manifestPath = path.resolve(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readIkey(env = process.env) {
  const configuredPath = typeof env.POWER_PLATFORM_SKILLS_IKEY_JSON === 'string'
    ? env.POWER_PLATFORM_SKILLS_IKEY_JSON.trim()
    : '';
  const ikeyPath = configuredPath
    ? path.resolve(configuredPath)
    : path.join(TELEMETRY_DIR, 'ikey.json');
  try {
    return { cfg: JSON.parse(fs.readFileSync(ikeyPath, 'utf8')), ikeyPath };
  } catch {
    return { cfg: null, ikeyPath };
  }
}

function isProvisioned(cfg, ikeyPath) {
  if (!cfg || cfg.disabled === true || !cfg.event_stream_name) return false;
  const resolver = loadResolver(path.dirname(ikeyPath));
  try {
    if (resolver && typeof resolver.isProvisioned === 'function') {
      return resolver.isProvisioned(cfg) === true;
    }
  } catch {
    return false;
  }
  return !!(
    cfg.instrumentationKey &&
    cfg.instrumentationKey !== PLACEHOLDER_IKEY &&
    cfg.collector_url
  );
}

function configDir(env = process.env) {
  return env.POWER_PLATFORM_SKILLS_CONFIG_DIR ||
    path.join(os.homedir(), '.power-platform-skills');
}

function readFileTail(filePath, maxBytes) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(descriptor);
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.allocUnsafe(size - start);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8', 0, bytesRead);
    // A bounded tail can begin inside a line, so drop that partial first record.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(descriptor);
  }
}

// GitHub Copilot CLI hands nested-agent hooks a transient `call_*` id instead of
// the CLI run's session UUID, which would scatter one run across many session
// ids. Resolve it to the session that owns the agent. Every other host, and any
// local state that cannot prove a single owner, returns `hostSessionId` as-is.
function resolveCopilotRootSessionId(hostSessionId, opts) {
  const NESTED_ID = /^call_[A-Za-z0-9_-]+$/;
  const ROOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_SESSION_AGE_MS = 5 * 60 * 1000;
  const MAX_TAIL_BYTES = 4 * 1024 * 1024;
  const ALIAS_TTL_MS = 30 * 60 * 1000;

  if (!NESTED_ID.test(hostSessionId)) return hostSessionId;

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const aliasDir = opts.copilotSessionAliasDir ||
    path.join(configDir(opts.env), 'telemetry', 'mobile-app', 'session-aliases');
  const aliasPath = path.join(
    aliasDir,
    `${crypto.createHash('sha256').update(hostSessionId).digest('hex')}.json`,
  );

  // Every hook is a fresh process, so the verified owner is cached on disk.
  const readAlias = () => {
    try {
      const alias = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
      if (
        alias.nestedSessionId === hostSessionId &&
        ROOT_ID.test(alias.rootSessionId) &&
        Number.isFinite(alias.expiresAt) &&
        alias.expiresAt > now
      ) {
        return alias.rootSessionId;
      }
      fs.rmSync(aliasPath, { force: true });
    } catch {
      // A cache miss or malformed entry falls through to the host-state lookup.
    }
    return '';
  };

  const writeAlias = (rootSessionId) => {
    const temporaryPath = `${aliasPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(aliasDir, { recursive: true, mode: 0o700 });
      for (const entry of fs.readdirSync(aliasDir)) {
        const stale = path.join(aliasDir, entry);
        if (entry.endsWith('.json') && fs.statSync(stale).mtimeMs <= now - ALIAS_TTL_MS) {
          fs.rmSync(stale, { force: true });
        }
      }
      fs.writeFileSync(temporaryPath, JSON.stringify({
        nestedSessionId: hostSessionId,
        rootSessionId,
        expiresAt: now + ALIAS_TTL_MS,
      }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryPath, aliasPath);
    } catch {
      // Concurrent writers resolve the same call id, so either file is valid.
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch { /* best effort */ }
    }
  };

  const ownsAgent = (eventsPath) => {
    let tail;
    try {
      tail = readFileTail(eventsPath, MAX_TAIL_BYTES);
    } catch {
      return false;
    }
    for (const line of tail.split('\n')) {
      if (!line) continue;
      try {
        if (JSON.parse(line).agentId === hostSessionId) return true;
      } catch {
        // A concurrently appended final record can be incomplete; ignore it.
      }
    }
    return false;
  };

  const cachedRootSessionId = readAlias();
  if (cachedRootSessionId) return cachedRootSessionId;

  // Copilot records the nested agent under the owning session's events.jsonl
  // before invoking the hook. Only structural agent ids are read from those
  // logs; prompts, cwd, and tool arguments never leave the file.
  const stateDir = opts.copilotSessionStateDir ||
    path.join(os.homedir(), '.copilot', 'session-state');
  let owner = '';
  try {
    for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ROOT_ID.test(entry.name)) continue;
      const eventsPath = path.join(stateDir, entry.name, 'events.jsonl');
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(eventsPath).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < now - MAX_SESSION_AGE_MS || !ownsAgent(eventsPath)) continue;
      // Duplicate ownership means corrupt or copied host state. Keeping the
      // transient id beats merging two unrelated debugging sessions.
      if (owner && owner !== entry.name) return hostSessionId;
      owner = entry.name;
    }
  } catch {
    return hostSessionId;
  }

  if (!owner) return hostSessionId;
  writeAlias(owner);
  return owner;
}

function resolveSessionId(payload, opts = {}) {
  const hostSessionId = session.resolveHostSessionId(payload);
  return session.getSessionId(resolveCopilotRootSessionId(hostSessionId, opts));
}

function createTelemetryContext(payload, opts = {}) {
  const env = opts.env || process.env;
  const { cfg, ikeyPath } = readIkey(env);
  if (!isProvisioned(cfg, ikeyPath)) return null;
  return {
    cfg,
    ikeyPath,
    eventStreamName: cfg.event_stream_name,
    configDir: configDir(env),
    env,
    sessionId: resolveSessionId(payload, opts),
  };
}

function osFriendlyName(platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'Mac';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function commonFields(context, invocation, opts = {}) {
  let ai = {};
  try {
    const readAiAgent = opts.readAiAgent || agentInfo.readAiAgent;
    ai = readAiAgent() || {};
  } catch {
    ai = {};
  }

  const fields = {
    pluginName: 'mobile-app',
    pluginVersion: readPluginVersion(),
    sessionId: context.sessionId,
    correlationId: opts.correlationId || crypto.randomUUID(),
    osName: osFriendlyName(process.platform),
    osVersion: os.release(),
    nodeVersion: `v${String(process.versions.node).split('.')[0]}`,
    skillName: invocation.skillName,
  };

  // `eventInfo` is the shared schema's caller-supplied JSON field, so app
  // identity rides here rather than needing a new allowlisted column.
  const eventInfo = {};
  if (invocation.source) eventInfo.invocationSource = invocation.source;
  const appInstanceId = findAppInstanceId(opts.cwd) || null;
  eventInfo.appInstanceId = appInstanceId;
  if (Object.keys(eventInfo).length) fields.eventInfo = eventInfo;

  if (ai.aiAgentName) fields.aiAgentName = ai.aiAgentName;
  if (ai.aiAgentVersion) fields.aiAgentVersion = ai.aiAgentVersion;
  return fields;
}

function dispatch(context, event, opts = {}) {
  const emit = opts.emit || fireAndForget;
  try {
    emit(event, {
      configDir: context.configDir,
      fakeProbe: context.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || '',
      ikeyJsonPath: context.ikeyPath,
      env: context.env,
    });
  } catch {
    // Telemetry is observational and must never affect a skill invocation.
  }
}

function emitSkillStarted(context, invocation, opts = {}) {
  const event = events.buildSkillStarted(
    context.eventStreamName,
    commonFields(context, invocation, opts),
  );
  dispatch(context, event, opts);
  return event;
}

module.exports = {
  createTelemetryContext,
  emitSkillStarted,
};