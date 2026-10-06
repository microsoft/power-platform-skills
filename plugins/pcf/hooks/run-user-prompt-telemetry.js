#!/usr/bin/env node
'use strict';

// Some hosts surface a skill as a slash-command prompt instead of a Skill call.
// The shared helper owns disabled/provisioned gates BEFORE any PAC work, then
// emits only tracked commands. No telemetry failure may block a user's prompt.
if (process.env.PCF_DISABLE_HOOKS === '1' || process.env.PCF_DISABLE_HOOKS === 'true') {
  process.exit(0);
}

const path = require('node:path');
const TELEMETRY_DIR = path.resolve(__dirname, '..', 'scripts', 'lib', 'telemetry');
let utils, emitFromPrompt, session, pacAuth;
try {
  utils = require('../scripts/lib/pcf-hook-utils.js');
  emitFromPrompt = require(path.join(TELEMETRY_DIR, 'lib', 'emit-from-prompt.js'));
  session = require(path.join(TELEMETRY_DIR, 'lib', 'session.js'));
  pacAuth = require(path.join(TELEMETRY_DIR, 'lib', 'pac-auth.js'));
} catch {
  process.exit(0);
}

(async () => {
  const parsed = JSON.parse(await utils.readUtf8Stream(process.stdin));
  if (!parsed || typeof parsed.prompt !== 'string' || !parsed.prompt) process.exit(0);
  emitFromPrompt.emitSkillStartedFromPrompt(parsed.prompt, {
    pluginName: 'pcf',
    pluginVersion: utils.readPluginVersion(),
    trackedSkills: utils.TRACKED_SKILLS,
    telemetryDir: TELEMETRY_DIR,
    sessionId: session.resolveHostSessionId(parsed),
    _readPacAuth: () => {
      const auth = pacAuth.readPacAuth();
      if (!auth) return null;
      // The shared helper attaches objectId as eventInfo.aadObjectId. Strip it
      // without mutating PAC's cached result: PCF approves only org/tenant IDs
      // and the other base fields, never a user identifier or eventInfo payload.
      const allowed = { ...auth };
      delete allowed.objectId;
      return allowed;
    },
  });
  process.exit(0);
})().catch(() => process.exit(0));
