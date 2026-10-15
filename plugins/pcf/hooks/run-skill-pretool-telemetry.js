#!/usr/bin/env node
'use strict';

// Usage telemetry is non-blocking and fail-closed: errors exit 0 without emission.
// Disabled or unprovisioned configs gate before PAC or dispatcher work.
// Enabled telemetry uses only the approved skill_started base fields.
if (process.env.PCF_DISABLE_HOOKS === '1' || process.env.PCF_DISABLE_HOOKS === 'true') {
  process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const TELEMETRY_DIR = path.resolve(__dirname, '..', 'scripts', 'lib', 'telemetry');

let utils, events, session, pacAuth, agentInfo, emitSpawn, resolverLoader;
try {
  utils = require('../scripts/lib/pcf-hook-utils.js');
  events = require(path.join(TELEMETRY_DIR, 'lib', 'events.js'));
  session = require(path.join(TELEMETRY_DIR, 'lib', 'session.js'));
  pacAuth = require(path.join(TELEMETRY_DIR, 'lib', 'pac-auth.js'));
  agentInfo = require(path.join(TELEMETRY_DIR, 'lib', 'agent-info.js'));
  emitSpawn = require(path.join(TELEMETRY_DIR, 'lib', 'emit-spawn.js'));
  resolverLoader = require(path.join(TELEMETRY_DIR, 'lib', 'resolver-loader.js'));
} catch {
  // A partial install cannot authorize emission or break the user's tool call.
  process.exit(0);
}

function readIkey() {
  // The same override seam is read by the dispatcher, so an offline test never
  // edits the committed shared-tenant config or falls back to another plugin's key.
  const override = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const ikeyPath = override && override.trim() ? override : path.join(TELEMETRY_DIR, 'ikey.json');
  try {
    return { cfg: JSON.parse(fs.readFileSync(ikeyPath, 'utf8')), ikeyPath };
  } catch {
    return { cfg: null, ikeyPath };
  }
}

(async () => {
  const parsed = JSON.parse(await utils.readUtf8Stream(process.stdin));
  const skillName = utils.getTrackedSkillFromToolInput(parsed && parsed.tool_input);
  if (!skillName) process.exit(0);

  // Gate before PAC: disabled, unreadable and unprovisioned configs produce no
  // network or local telemetry side effects. User opt-outs are intentionally
  // later, in the dispatcher, because an enabled build still keeps its mirror.
  const { cfg, ikeyPath } = readIkey();
  if (!cfg || cfg.disabled === true) process.exit(0);
  const resolver = resolverLoader.loadResolver(path.dirname(ikeyPath));
  const provisioned = resolver && typeof resolver.isProvisioned === 'function'
    ? resolver.isProvisioned(cfg)
    : !!(cfg.instrumentationKey && cfg.instrumentationKey !== 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING');
  if (!provisioned) process.exit(0);

  const auth = pacAuth.readPacAuth();
  const agent = { ...agentInfo.readAiAgent(), pacCliVersion: agentInfo.readPacCliVersion() };
  const fields = {
    pluginName: 'pcf',
    pluginVersion: utils.readPluginVersion(),
    sessionId: session.getSessionId(session.resolveHostSessionId(parsed)),
    correlationId: crypto.randomUUID(),
    osName: ({ win32: 'Windows', darwin: 'Mac', linux: 'Linux' })[process.platform] || process.platform,
    osVersion: os.release(),
    nodeVersion: 'v' + String(process.versions.node).split('.')[0],
    skillName,
  };
  if (auth && auth.orgId) fields.orgId = auth.orgId;
  if (auth && auth.tenantId) fields.tenantId = auth.tenantId;
  // Organization/tenant context is approved; a user's object ID is not. Do not
  // pass objectId or any eventInfo, arguments, prompt text, paths or URLs.
  if (agent.aiAgentName) fields.aiAgentName = agent.aiAgentName;
  if (agent.aiAgentVersion) fields.aiAgentVersion = agent.aiAgentVersion;
  if (agent.pacCliVersion) fields.pacCliVersion = agent.pacCliVersion;

  emitSpawn.fireAndForget(events.buildSkillStarted(cfg.event_stream_name || '', fields), {
    cloud: (auth && auth.cloud) || '',
    configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || '',
    fakeProbe: process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || '',
    ikeyJsonPath: ikeyPath,
  });
  process.exit(0);
})().catch(() => process.exit(0));
