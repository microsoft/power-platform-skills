#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const { FIELD_TYPES, pick } = require('./telemetry/lib/events');
const { appendLocal, pluginLogDir } = require('./telemetry/lib/local-log');
const { findAppInstanceId, readTelemetryCluster } = require('./app-identity');
const { lifecycle } = require('./mobile-lifecycle');
const { readProjectTelemetryContext } = require('./mobile-telemetry-context');
const { resolveClusterEnvironment } = require('./telemetry/region/region-resolver');
const { loadResolver } = require('./telemetry/lib/resolver-loader');
const {
  isTransmissionOptedOut,
  telemetryOptOutEnvVarName,
} = require('./telemetry/lib/user-config');
const {
  TELEMETRY_ERROR_CLASSES,
  TELEMETRY_STATES,
  TRACKED_SKILL_NAMES,
  isKnownTelemetryEvent,
  isTelemetryStaticInfo,
} = require('./mobileapp-hook-utils');

const PLACEHOLDER_IKEY = 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING';
const DEFAULT_LOCAL_DIR = path.join(os.homedir(), '.power-platform-skills');
const RESERVED_META_FIELDS = new Set(['eventName', 'eventType', 'severity']);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = new Set(['prompt', 'pretool', 'checkpoint']);
const ID_FIELDS = ['appInstanceId', 'runId', 'spanId', 'parentSpanId'];
const AGENT_NAMES = new Set([
  'GitHub Copilot',
  'Copilot CLI',
  'Claude Code',
  'Codex',
  'OpenCode',
  'Hermes',
  'OpenClaw',
]);
const TRACKED_SKILLS = new Set(TRACKED_SKILL_NAMES);
const ERROR_CLASSES = new Set(TELEMETRY_ERROR_CLASSES);
const STATES = new Set(TELEMETRY_STATES);

function readPriorEvents(projectRoot, env = process.env) {
  const configDir = env.POWER_PLATFORM_SKILLS_CONFIG_DIR || DEFAULT_LOCAL_DIR;
  const { cfg } = readIkeyConfig(env);
  const appInstanceId = findAppInstanceId(projectRoot);
  if (!appInstanceId || !cfg || cfg.disabled === true || isTransmissionOptedOut(configDir, 'mobile-app', env)) return [];
  const records = [];
  const sessionsRoot = pluginLogDir(configDir, 'mobile-app');
  // Carry each parent directory explicitly so nested logs do not depend on
  // Dirent.parentPath or the deprecated Dirent.path metadata.
  const directories = [sessionsRoot];
  while (directories.length) {
    const directory = directories.pop();
    try {
      for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, file.name);
        if (file.isDirectory()) {
          directories.push(filePath);
          continue;
        }
        if (!file.isFile() || !/^events(?:\.jsonl|\.\d{14}\.old)$/.test(file.name)) continue;
        let contents;
        try { contents = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
        for (const line of contents.split('\n')) {
          try {
            const record = JSON.parse(line);
            if (record.data?.pluginName === 'mobile-app' && record.data?.eventInfo?.appInstanceId === appInstanceId &&
                Number.isFinite(Date.parse(record.time))) records.push(record);
          } catch { /* Skip malformed or incomplete JSONL records. */ }
        }
      }
    } catch { /* Missing or pruned logs must not block environment resolution. */ }
  }
  return records.sort((first, second) => Date.parse(first.time) - Date.parse(second.time));
}

async function prepareTelemetryBatch(projectRoot, env, environment = null) {
  // Snapshot before resolution can publish a cluster, excluding events sent afterward.
  const replay = readTelemetryCluster(projectRoot) ? [] : readPriorEvents(projectRoot, env);
  const cluster = await resolveClusterEnvironment(projectRoot, environment);
  return { cluster, replay: cluster ? replay : [] };
}

async function flushPriorEvents(projectRoot, environment, env = process.env) {
  const { cluster, replay } = await prepareTelemetryBatch(projectRoot, env, environment);
  if (!cluster || !replay.length) return;
  fireAndForget({ data: { pluginName: 'mobile-app' }, replay }, {
    projectRoot, env,
    configDir: env.POWER_PLATFORM_SKILLS_CONFIG_DIR,
    ikeyJsonPath: env.POWER_PLATFORM_SKILLS_IKEY_JSON,
    fakeProbe: env.POWER_PLATFORM_SKILLS_FAKE_HTTPS,
  });
}

function fireAndForget(event, opts = {}) {
  const env = opts.env || process.env;
  const pluginName = event && event.data && event.data.pluginName;
  const optOutName = pluginName ? telemetryOptOutEnvVarName(pluginName) : '';
  const optOutValue = optOutName ? env[optOutName] || '' : '';

  try {
    const spawnProcess = opts.spawn || spawn;
    const child = spawnProcess(process.execPath, [__filename], {
      // Detached dispatch can outlive checkpoint CLIs. Inheriting the project
      // cwd would keep that directory locked against deletion on Windows.
      cwd: os.tmpdir(),
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        // Telemetry children receive only operational values. In particular,
        // credentials from the invoking agent process are never inherited.
        PATH: env.PATH || '',
        SystemRoot: env.SystemRoot || '',
        HOME: env.HOME || '',
        USERPROFILE: env.USERPROFILE || '',
        APPDATA: env.APPDATA || '',
        POWER_PLATFORM_SKILLS_CONFIG_DIR: opts.configDir || '',
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: opts.fakeProbe || '',
        POWER_PLATFORM_SKILLS_PROJECT_ROOT: opts.projectRoot || '',
        POWER_PLATFORM_SKILLS_IKEY_JSON: opts.ikeyJsonPath || '',
        ...(optOutName && optOutValue ? { [optOutName]: optOutValue } : {}),
      },
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
    child.unref();
  } catch {
    // Telemetry is observational and must never affect skill execution.
  }
}

function readIkeyConfig(env) {
  const configPath = env.POWER_PLATFORM_SKILLS_IKEY_JSON ||
    path.join(__dirname, 'telemetry', 'ikey.json');
  try {
    return { cfg: JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath };
  } catch {
    return { cfg: null, configPath };
  }
}

function sanitizeData(data, options = {}) {
  if (
    !data ||
    data.pluginName !== 'mobile-app' ||
    !TRACKED_SKILLS.has(data.skillName) ||
    !isKnownTelemetryEvent(data.skillName, data.eventName)
  ) {
    return {};
  }

  const filtered = pick(data, Object.keys(FIELD_TYPES));
  for (const key of RESERVED_META_FIELDS) {
    if (typeof data[key] === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(data[key])) {
      filtered[key] = data[key];
    }
  }
  delete filtered.errorDescription;
  delete filtered.pacCliVersion;
  delete filtered.orgId;
  delete filtered.tenantId;

  for (const name of ['pluginVersion', 'nodeVersion', 'aiAgentVersion', 'osVersion']) {
    if (
      filtered[name] !== undefined &&
      !/^(?:unknown|v?\d[\dA-Za-z.+_-]{0,63})$/.test(filtered[name])
    ) {
      delete filtered[name];
    }
  }
  if (
    filtered.osName !== undefined &&
    !['Windows', 'Mac', 'Linux'].includes(filtered.osName)
  ) {
    delete filtered.osName;
  }
  if (filtered.aiAgentName !== undefined && !AGENT_NAMES.has(filtered.aiAgentName)) {
    delete filtered.aiAgentName;
  }
  for (const name of ['sessionId', 'correlationId']) {
    if (
      filtered[name] !== undefined &&
      !/^[A-Za-z0-9_-]{1,128}$/.test(filtered[name])
    ) {
      delete filtered[name];
    }
  }
  if (!ERROR_CLASSES.has(filtered.errorClass)) delete filtered.errorClass;
  if (
    typeof data.durationMs !== 'number' ||
    !Number.isSafeInteger(data.durationMs) ||
    data.durationMs < 0
  ) {
    delete filtered.durationMs;
  }

  const source = data.eventInfo &&
    typeof data.eventInfo === 'object' &&
    !Array.isArray(data.eventInfo)
    ? data.eventInfo
    : {};
  const eventInfo = {};
  for (const name of ID_FIELDS) {
    if (typeof source[name] === 'string' && GUID.test(source[name])) {
      eventInfo[name] = source[name].toLowerCase();
    }
  }
  if (source.appInstanceId === null) eventInfo.appInstanceId = null;
  if (SOURCES.has(source.invocationSource)) {
    eventInfo.invocationSource = source.invocationSource;
  }
  if (isTelemetryStaticInfo(source.additionalInfo)) {
    eventInfo.additionalInfo = source.additionalInfo;
  }
  if (['enabled', 'disabled'].includes(source.appInsightsSelection)) {
    eventInfo.appInsightsSelection = source.appInsightsSelection;
  }
  if (source.schemaVersion === 2) {
    if (
      !eventInfo.runId ||
      !eventInfo.spanId ||
      !['skill', 'checkpoint'].includes(source.spanType) ||
      !STATES.has(source.state) ||
      !GUID.test(filtered.correlationId || '') ||
      !GUID.test(filtered.sessionId || '')
    ) {
      return {};
    }
    eventInfo.schemaVersion = 2;
    eventInfo.spanType = source.spanType;
    eventInfo.state = source.state;
    if (Number.isSafeInteger(source.attempt) && source.attempt > 0) {
      eventInfo.attempt = source.attempt;
    }
    if (['measured', 'clock_invalid', 'not_applicable'].includes(source.timingStatus)) {
      eventInfo.timingStatus = source.timingStatus;
    }
    if (source.timingStatus !== 'measured') delete filtered.durationMs;

    // GUID shape alone cannot prove organization attribution. Recheck the local
    // span/ancestor verification before logging and again when replaying to wire.
    const verified = options.projectRoot && options.configDir
      ? readProjectTelemetryContext(options.projectRoot, {
        configDir: options.configDir,
        lifecycle,
        runId: eventInfo.runId,
        spanId: eventInfo.spanId,
      })
      : {};
    for (const name of ['orgId', 'tenantId']) {
      if (typeof data[name] === 'string' && verified[name] &&
          data[name].toLowerCase() === verified[name].toLowerCase()) {
        filtered[name] = verified[name].toLowerCase();
      }
    }
    if (typeof source.environmentId === 'string' && verified.environmentId &&
        source.environmentId.toLowerCase() === verified.environmentId.toLowerCase()) {
      eventInfo.environmentId = verified.environmentId.toLowerCase();
    }
  }

  filtered.eventInfo = eventInfo;
  return filtered;
}

function buildNormalEventData(data, time) {
  const dimensions = { ...data };
  delete dimensions.eventName;
  delete dimensions.eventType;
  delete dimensions.severity;

  // This mirrors the Power Apps native provider's production defaults. The
  // semantic event name is a data column; the envelope name remains `event`.
  return {
    app_Name: 'powerappsclient',
    clientType: 'PowerAppsNative',
    clusterCategory: 'prod',
    device_Id: 'react-native',
    event_Name: data.eventName || '',
    session_Id: data.sessionId || '',
    ...(data.tenantId ? { tenantId: data.tenantId } : {}),
    ...(data.eventInfo?.environmentId
      ? { environmentId: data.eventInfo.environmentId }
      : {}),
    severity: data.severity || 'Info',
    timestamp: time,
    customDimensions: JSON.stringify(dimensions),
  };
}

function buildEnvelope(data, time, iKey, eventStreamName) {
  const envelope = {
    ver: '4.0',
    name: eventStreamName || 'event',
    time,
    iKey: `o:${String(iKey || '').split('-')[0]}`,
    data: buildNormalEventData(data, time),
  };

  // The native provider adds these Common Schema Part A extensions before
  // transmission. Keep them outside customDimensions so the ingestion mapping
  // can populate the standard app, session, and OS columns.
  envelope.ext = {
    app: {
      sesId: data.sessionId || '',
      ver: data.pluginVersion || '',
    },
    os: {
      name: data.osName || '',
      ver: data.osVersion || '',
    },
  };
  return envelope;
}

// TEST ONLY. Captures the would-be POST so tests can assert on it without
// touching the real collector; nothing in the shipped product sets the env var.
function writeProbe(filePath, record) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(record), 'utf8');
  } catch {
    // Test-only probe failures are non-fatal, like real transport failures.
  }
}

async function dispatch(raw, env) {
  const { cfg, configPath } = readIkeyConfig(env);
  // A missing config or disabled repository switch is a true hard-off: no
  // local record and no transmission.
  if (!cfg || cfg.disabled === true) return;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const replaying = Array.isArray(event.replay);
  if (replaying && event.data?.pluginName !== 'mobile-app') return;
  const configDir = env.POWER_PLATFORM_SKILLS_CONFIG_DIR || DEFAULT_LOCAL_DIR;
  const context = {
    configDir,
    projectRoot: env.POWER_PLATFORM_SKILLS_PROJECT_ROOT || '',
  };
  const data = replaying ? { pluginName: 'mobile-app' } : sanitizeData(event.data, context);
  if (!data.pluginName) return;
  const time = typeof event.time === 'string' && Number.isFinite(Date.parse(event.time))
    ? new Date(event.time).toISOString()
    : new Date().toISOString();
  if (!replaying) {
    appendLocal({ time, name: cfg.event_stream_name, data }, { configDir });
  }
  if (isTransmissionOptedOut(configDir, data.pluginName, env)) return;

  let records = Array.isArray(event.replay) ? event.replay : [{ data, time }];
  let iKey = '';
  let collectorUrl = '';
  const resolver = loadResolver(path.dirname(configPath));
  if (resolver && typeof resolver.resolve === 'function') {
    try {
      let cluster;
      if (data.pluginName === 'mobile-app') {
        const batch = await prepareTelemetryBatch(env.POWER_PLATFORM_SKILLS_PROJECT_ROOT || '', env);
        cluster = batch.cluster;
        if (!cluster) return;
        if (!Array.isArray(event.replay) && batch.replay.length) records = batch.replay;
      }
      const resolved = await resolver.resolve({
        event,
        cfg,
        configDir,
        projectRoot: env.POWER_PLATFORM_SKILLS_PROJECT_ROOT || '',
        cluster,
      });
      iKey = resolved && resolved.iKey || '';
      collectorUrl = resolved && resolved.collectorUrl || '';
    } catch {
      // A resolver failure leaves the event in the local mirror.
    }
  } else {
    iKey = cfg.instrumentationKey || '';
    collectorUrl = cfg.collector_url || '';
  }
  if (!iKey || iKey === PLACEHOLDER_IKEY || !collectorUrl) return;

  records = records.flatMap((record) => {
    const filtered = sanitizeData(record.data, context);
    return filtered.pluginName &&
      typeof record.time === 'string' &&
      Number.isFinite(Date.parse(record.time))
      ? [{ data: filtered, time: new Date(record.time).toISOString() }]
      : [];
  });
  if (!records.length) return;
  const body = records.map(record => JSON.stringify(
    buildEnvelope(record.data, record.time, iKey, cfg.event_stream_name),
  )).join('\n') + '\n';
  const headers = {
    'Content-Type': 'application/x-json-stream; charset=utf-8',
    'x-apikey': iKey,
    'Content-Length': Buffer.byteLength(body),
  };

  // TEST ONLY: unset in production, so real runs fall through to the POST below.
  // The URL is captured because US and EU share one instrumentation key and differ
  // only by collector, so headers alone cannot prove where an event was routed.
  if (env.POWER_PLATFORM_SKILLS_FAKE_HTTPS) {
    writeProbe(env.POWER_PLATFORM_SKILLS_FAKE_HTTPS, { headers, body, url: collectorUrl });
    return;
  }

  let url;
  try {
    url = new URL(collectorUrl);
  } catch {
    return;
  }

  await new Promise((resolve) => {
    const request = https.request({
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    }, (response) => {
      response.on('data', () => {});
      response.on('end', resolve);
    });
    request.on('error', resolve);
    request.setTimeout(4000, () => {
      request.destroy();
      resolve();
    });
    request.end(body);
  });
}

function runDispatcher() {
  let raw = '';
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    dispatch(raw, process.env).finally(() => process.exit(0));
  });
}

if (require.main === module) runDispatcher();

module.exports = {
  buildEnvelope,
  buildNormalEventData,
  fireAndForget,
  flushPriorEvents,
  readPriorEvents,
  sanitizeData,
};