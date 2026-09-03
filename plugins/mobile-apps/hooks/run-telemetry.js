#!/usr/bin/env node
'use strict';

const os = require('node:os');

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

function withStableDispatchCwd(callback) {
  const originalCwd = process.cwd();
  let changed = false;
  try {
    // A detached child inherits the hook's cwd. On Windows, keeping a generated
    // app as that cwd can block moving or deleting the app until dispatch exits.
    process.chdir(os.tmpdir());
    changed = true;
  } catch {
    // Telemetry remains fail-open if the host's temp directory is unavailable.
  }

  try {
    return callback();
  } finally {
    if (changed) {
      try {
        process.chdir(originalCwd);
      } catch {
        // This hook process exits immediately after dispatch.
      }
    }
  }
}

// Builds a hook-driven handler: reads a JSON payload from stdin, resolves the
// tracked skill for `mode`, and emits `skill_started`.
function skillStart(mode) {
  return {
    stdin: true,
    handle({ payload }) {
      const skillName = invocationFor(mode, payload);
      if (!skillName) return;
      const context = telemetry.createTelemetryContext(payload);
      if (!context) return;
      telemetry.emitSkillStarted(
        context,
        { skillName, source: mode },
        { cwd: resolveInvocationCwd(payload) },
      );
    },
  };
}

// Registry of telemetry modes. Add a new command-driven event by adding one
// entry with `stdin: false` and a `handle`; add a new hook mode with
// `skillStart('<mode>')`. Shared plumbing (stdin read, cwd stabilization,
// fail-open) stays centralized in `run`, so handlers only source input and emit.
const HANDLERS = {
  prompt: skillStart('prompt'),
  pretool: skillStart('pretool'),
  'app-insights-selection': {
    stdin: false,
    handle({ args: [selection, invocationCwd] }) {
      const context = telemetry.createTelemetryContext({});
      if (!context) return;
      telemetry.emitAppInsightsSelection(context, selection, { cwd: invocationCwd });
    },
  },
};

async function run(mode, args = []) {
  const handler = HANDLERS[mode];
  if (!handler) return;

  let payload;
  if (handler.stdin) {
    try {
      payload = JSON.parse(await readStdin());
    } catch {
      return;
    }
  }

  withStableDispatchCwd(() => handler.handle({ args, payload }));
}

function start(mode, args = []) {
  run(mode, args).catch(() => {}).finally(() => process.exit(0));
}

if (require.main === module) {
  start(process.argv[2], process.argv.slice(3));
}

module.exports = { start, withStableDispatchCwd };