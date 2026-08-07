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

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseWorkingDirArg(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const match = text.match(/--working-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  return pickString(match && match[1], match && match[2], match && match[3]);
}

function resolveInvocationCwd(payload) {
  const toolInput = payload && typeof payload.tool_input === 'object' ? payload.tool_input : null;
  const fromToolInput = pickString(
    toolInput && toolInput.cwd,
    toolInput && toolInput.working_dir,
    toolInput && toolInput.workingDir,
  );
  if (fromToolInput) return fromToolInput;

  const fromToolArgs = toolInput
    ? pickString(
      parseWorkingDirArg(toolInput.arguments),
      parseWorkingDirArg(toolInput.args),
      parseWorkingDirArg(toolInput.command),
      parseWorkingDirArg(toolInput.prompt),
    )
    : '';
  if (fromToolArgs) return fromToolArgs;

  return pickString(
    payload && payload.working_dir,
    payload && payload.workingDir,
    payload && payload.cwd,
  );
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
  if (context) {
    telemetry.emitSkillStarted(
      context,
      { skillName, source: mode },
      { cwd: resolveInvocationCwd(payload) },
    );
  }
}

function start(mode) {
  run(mode).catch(() => {}).finally(() => process.exit(0));
}

if (require.main === module) start(process.argv[2]);

module.exports = { start };