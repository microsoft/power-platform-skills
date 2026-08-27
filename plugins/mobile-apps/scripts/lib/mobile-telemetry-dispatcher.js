#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const { FIELD_TYPES, pick } = require('./telemetry/lib/events');
const { appendLocal } = require('./telemetry/lib/local-log');
const { loadResolver } = require('./telemetry/lib/resolver-loader');
const {
  isTransmissionOptedOut,
  telemetryOptOutEnvVarName,
} = require('./telemetry/lib/user-config');

const PLACEHOLDER_IKEY = 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING';
const DEFAULT_LOCAL_DIR = path.join(os.homedir(), '.power-platform-skills');
const RESERVED_META_FIELDS = new Set(['eventName', 'eventType', 'severity']);

function fireAndForget(event, opts = {}) {
  const env = opts.env || process.env;
  const pluginName = event && event.data && event.data.pluginName;
  const optOutName = pluginName ? telemetryOptOutEnvVarName(pluginName) : '';
  const optOutValue = optOutName ? env[optOutName] || '' : '';

  try {
    const child = spawn(process.execPath, [__filename], {
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
        POWER_PLATFORM_SKILLS_CLOUD: opts.cloud || '',
        POWER_PLATFORM_SKILLS_IKEY_JSON: opts.ikeyJsonPath || '',
        ...(optOutName && optOutValue ? { [optOutName]: optOutValue } : {}),
      },
    });
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

function sanitizeData(data) {
  if (!data || typeof data !== 'object') return {};
  const filtered = pick(data, Object.keys(FIELD_TYPES));
  for (const key of RESERVED_META_FIELDS) {
    if (typeof data[key] === 'string') filtered[key] = data[key];
  }
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

  const data = sanitizeData(event.data);
  const time = new Date().toISOString();
  const configDir = env.POWER_PLATFORM_SKILLS_CONFIG_DIR || DEFAULT_LOCAL_DIR;
  appendLocal({ time, name: event.name, data }, { configDir });

  if (isTransmissionOptedOut(configDir, data.pluginName, env)) return;

  let iKey = '';
  let collectorUrl = '';
  const resolver = loadResolver(path.dirname(configPath));
  if (resolver && typeof resolver.resolve === 'function') {
    try {
      const resolved = await resolver.resolve({
        event,
        cfg,
        cloud: env.POWER_PLATFORM_SKILLS_CLOUD || '',
        configDir,
      });
      iKey = resolved && resolved.iKey || '';
      collectorUrl = resolved && resolved.collectorUrl || '';
    } catch {
      // A resolver failure falls through to the static Mobile configuration.
    }
  }
  iKey = iKey || cfg.instrumentationKey || '';
  collectorUrl = collectorUrl || cfg.collector_url || '';
  if (!iKey || iKey === PLACEHOLDER_IKEY || !collectorUrl) return;

  const envelope = buildEnvelope(data, time, iKey, cfg.event_stream_name);
  const body = `${JSON.stringify(envelope)}\n`;
  const headers = {
    'Content-Type': 'application/x-json-stream; charset=utf-8',
    'x-apikey': iKey,
    'Content-Length': Buffer.byteLength(body),
  };

  if (env.POWER_PLATFORM_SKILLS_FAKE_HTTPS) {
    writeProbe(env.POWER_PLATFORM_SKILLS_FAKE_HTTPS, { headers, body });
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
};