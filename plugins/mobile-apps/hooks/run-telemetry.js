#!/usr/bin/env node
'use strict';

let telemetry;
let getTrackedSkillFromPrompt;
let getTrackedSkillFromToolInput;
try {
  telemetry = require('../scripts/lib/mobile-telemetry');
  ({
    getTrackedSkillFromPrompt,
    getTrackedSkillFromToolInput,
  } = require('../scripts/lib/mobileapp-hook-utils'));
} catch {
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', () => resolve(input));
  });
}

function invocationFor(mode, payload) {
  if (mode === 'prompt') return getTrackedSkillFromPrompt(payload.prompt);
  if (mode === 'pretool') return getTrackedSkillFromToolInput(payload.tool_input);
  return null;
}

async function run(mode) {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }

  const skillName = invocationFor(mode, payload);
  if (!skillName) return;

  const context = telemetry.createTelemetryContext(payload);
  if (context) telemetry.emitSkillStarted(context, { skillName, source: mode });
}

function start(mode) {
  run(mode).catch(() => {}).finally(() => process.exit(0));
}

if (require.main === module) start(process.argv[2]);

module.exports = { start };