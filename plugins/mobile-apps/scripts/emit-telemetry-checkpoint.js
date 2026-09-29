#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { constants } = require('node:os');

const {
  TELEMETRY_STATES,
  TRACKED_SKILL_NAMES,
  isKnownTelemetryEvent,
  isTelemetryStaticInfo,
} = require('./lib/mobileapp-hook-utils');
const {
  GUID,
  recordVerifiedDataverseOrganization,
} = require('./lib/mobile-telemetry-context');
const telemetry = require('./lib/mobile-telemetry');

const CHECKPOINT_STATES = new Set(TELEMETRY_STATES);
const CHECKPOINT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const CHECKPOINT_SKILLS = new Set(TRACKED_SKILL_NAMES);

function parseCheckpointPayload(payload) {
  if (typeof payload !== 'string') return null;
  const parts = payload.split('|').map((part) => part.trim());
  if (parts.length < 3 || parts.length > 4) return null;

  const [skillName, checkpointName, state, additionalInfo] = parts;
  if (parts.length === 4 && !additionalInfo) return null;
  if (
    !CHECKPOINT_SKILLS.has(skillName) ||
    checkpointName.length > 64 ||
    !CHECKPOINT_NAME_PATTERN.test(checkpointName) ||
    !CHECKPOINT_STATES.has(state)
  ) {
    return null;
  }
  if (!isKnownTelemetryEvent(skillName, `${checkpointName}_${state}`)) return null;
  if (
    additionalInfo &&
    (
      additionalInfo.length > 64 ||
      !CHECKPOINT_NAME_PATTERN.test(additionalInfo) ||
      !isTelemetryStaticInfo(additionalInfo)
    )
  ) {
    return null;
  }

  return {
    skillName,
    eventName: `${checkpointName}_${state}`,
    severity: state === 'failed' ? 'Error' : 'Info',
    source: 'checkpoint',
    additionalInfo: additionalInfo || undefined,
  };
}

function emitCheckpoint(payload, opts = {}) {
  try {
    const invocation = parseCheckpointPayload(payload);
    if (!invocation) return null;

    const createContext = opts.createTelemetryContext || telemetry.createTelemetryContext;
    const cwd = opts.cwd || process.cwd();
    const context = createContext({}, { cwd });
    if (!context) return null;

    if (opts.runId) return emitTrackedCheckpoint(payload, context, { ...opts, cwd });
    const emit = opts.emitCheckpoint || telemetry.emitCheckpoint;
    return emit(context, invocation, { cwd });
  } catch {
    return null;
  }
}

function captureSuccessfulDataverseRequest(environmentUrl, token, whoAmI, env = process.env) {
  try {
    const runId = env.POWER_PLATFORM_SKILLS_MOBILE_RUN_ID;
    const spanId = env.POWER_PLATFORM_SKILLS_MOBILE_SPAN_ID;
    if (!GUID.test(runId || '') || !GUID.test(spanId || '')) return false;
    const projectRoot = env.POWER_PLATFORM_SKILLS_PROJECT_ROOT || process.cwd();
    const context = telemetry.createTelemetryContext({}, {
      cwd: projectRoot,
      env,
      readProcessScope: () => '',
    });
    if (!context) return false;
    return recordVerifiedDataverseOrganization({
      projectRoot,
      configDir: context.configDir,
      runId,
      spanId,
      environmentUrl,
      lifecycle: telemetry.lifecycle,
      token,
      whoAmI,
    });
  } catch {
    // Verification enrichment is observational and cannot alter the request.
    return false;
  }
}

function publicContext(span) {
  return {
    schemaVersion: 2,
    runId: span.runId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    sessionId: span.sessionId,
    skillName: span.skillName,
    state: span.state,
    ...(span.durationMs === undefined ? {} : { durationMs: span.durationMs }),
  };
}

function emitTrackedCheckpoint(payload, context, opts) {
  const invocation = parseCheckpointPayload(payload);
  if (!invocation) throw new Error('invalid_input');
  const [, checkpointName, state] = payload.split('|').map((part) => part.trim());
  const options = {
    ...opts,
    configDir: context.configDir,
    projectRoot: opts.cwd,
    skillName: invocation.skillName,
    checkpointName,
    additionalInfo: invocation.additionalInfo,
    state,
  };
  let span;
  if (state === 'started') {
    span = telemetry.lifecycle.beginSpan(options);
  } else if (state === 'skipped' && !opts.spanId) {
    const start = telemetry.lifecycle.beginSpan(options);
    span = telemetry.lifecycle.finishSpan({ ...options, spanId: start.spanId });
  } else {
    const start = telemetry.lifecycle.readSpan(options).record;
    if (start.skillName !== invocation.skillName || start.checkpointName !== checkpointName) {
      throw new Error('invalid_context');
    }
    span = telemetry.lifecycle.finishSpan(options);
  }
  const emit = opts.emitLifecycle || telemetry.emitLifecycle;
  emit(context, span, { cwd: opts.cwd });
  return publicContext(span);
}

function parseOptions(argv) {
  const names = {
    '--begin': 'begin',
    '--finish': 'finish',
    '--resume': 'resume',
    '--execute': 'execute',
    '--run-id': 'runId',
    '--span-id': 'spanId',
    '--parent-span-id': 'parentSpanId',
    '--retry-of': 'retryOf',
    '--error-class': 'errorClass',
    '--project-root': 'cwd',
  };
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      result.command = argv.slice(index + 1);
      break;
    }
    if (argument === '--report') {
      result.report = true;
    } else if (names[argument]) {
      if (
        !argv[index + 1] ||
        argv[index + 1].startsWith('--') ||
        result[names[argument]] !== undefined
      ) {
        throw new Error('invalid_input');
      }
      result[names[argument]] = argv[++index];
    } else if (!argument.startsWith('--') && result.payload === undefined) {
      result.payload = argument;
    } else {
      throw new Error('invalid_input');
    }
  }
  return result;
}

function executeCommand(args, overrides = {}) {
  if (!Array.isArray(args.command) || !args.command.length) {
    throw new Error('invalid_input');
  }
  const payload = `${args.execute}|started`;
  if (!parseCheckpointPayload(payload)) throw new Error('invalid_input');

  const cwd = args.cwd || process.cwd();
  let context;
  try {
    context = (overrides.createTelemetryContext || telemetry.createTelemetryContext)(
      {},
      { cwd, env: overrides.env },
    );
  } catch {
    // A telemetry initialization failure must not suppress the wrapped command.
  }

  let start;
  try {
    if (context && args.runId) {
      start = emitTrackedCheckpoint(payload, context, { ...args, ...overrides, cwd });
    }
  } catch {
    // The requested command still runs when tracing cannot start.
  }

  const commandEnv = { ...(overrides.env || process.env) };
  if (start) {
    commandEnv.POWER_PLATFORM_SKILLS_MOBILE_RUN_ID = start.runId;
    commandEnv.POWER_PLATFORM_SKILLS_MOBILE_SPAN_ID = start.spanId;
    commandEnv.POWER_PLATFORM_SKILLS_MOBILE_SKILL_SPAN_ID = args.parentSpanId;
    commandEnv.POWER_PLATFORM_SKILLS_PROJECT_ROOT = cwd;
  } else {
    delete commandEnv.POWER_PLATFORM_SKILLS_MOBILE_RUN_ID;
    delete commandEnv.POWER_PLATFORM_SKILLS_MOBILE_SPAN_ID;
    delete commandEnv.POWER_PLATFORM_SKILLS_MOBILE_SKILL_SPAN_ID;
    delete commandEnv.POWER_PLATFORM_SKILLS_PROJECT_ROOT;
  }

  // An argument array plus inherited stdio preserves the original command
  // contract; executable, arguments, stdout, and stderr never enter telemetry.
  let result;
  try {
    result = (overrides.spawnSync || spawnSync)(args.command[0], args.command.slice(1), {
      cwd,
      env: commandEnv,
      stdio: 'inherit',
      shell: false,
    });
  } catch {
    result = { status: 1 };
  }
  const exitCode = Number.isInteger(result.status)
    ? result.status
    : result.signal && constants.signals[result.signal]
      ? 128 + constants.signals[result.signal]
      : 1;

  if (start) {
    try {
      const state = ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(result.signal)
        ? 'cancelled'
        : exitCode === 0
          ? 'completed'
          : 'failed';
      const span = telemetry.lifecycle.finishSpan({
        projectRoot: cwd,
        configDir: context.configDir,
        runId: start.runId,
        spanId: start.spanId,
        state,
        errorClass: result.error?.code === 'ENOENT'
          ? 'missing_dependency'
          : exitCode
            ? 'unknown'
            : undefined,
      });
      (overrides.emitLifecycle || telemetry.emitLifecycle)(context, span, { cwd });
    } catch {
      // Tracing cannot change the wrapped command result.
    }
  }
  return {
    status: 'executed',
    exitCode,
    ...(start ? { supportId: start.runId } : {}),
  };
}

function runCommand(argv = process.argv.slice(2), overrides = {}) {
  try {
    const args = parseOptions(argv);
    const commands = [
      args.begin,
      args.finish,
      args.resume,
      args.payload,
      args.report,
      args.execute,
    ].filter(Boolean);
    if (commands.length !== 1) throw new Error('invalid_input');
    if (args.execute) return executeCommand(args, overrides);
    if (args.command) throw new Error('invalid_input');
    if (args.payload && !args.runId) {
      return emitCheckpoint(args.payload, {
        ...overrides,
        cwd: args.cwd || overrides.cwd,
      });
    }

    const cwd = args.cwd || process.cwd();
    if (args.report) {
      return telemetry.lifecycle.reportRun({
        projectRoot: cwd,
        runId: args.runId,
        configDir: telemetry.getTelemetryConfigDir(overrides.env || process.env),
      });
    }

    const createContext = overrides.createTelemetryContext || telemetry.createTelemetryContext;
    const context = createContext({}, { cwd, env: overrides.env });
    if (!context) return { status: 'disabled' };
    const options = {
      ...args,
      projectRoot: cwd,
      configDir: context.configDir,
      sessionId: context.sessionId,
    };
    let span;
    if (args.begin) {
      span = telemetry.lifecycle.beginSpan({ ...options, skillName: args.begin });
    } else if (args.finish) {
      span = telemetry.lifecycle.finishSpan({ ...options, state: args.finish });
    } else if (args.resume) {
      span = telemetry.lifecycle.resumeSpan({ ...options, spanId: args.resume });
    } else {
      return emitTrackedCheckpoint(args.payload, context, { ...args, ...overrides, cwd });
    }
    (overrides.emitLifecycle || telemetry.emitLifecycle)(context, span, { cwd });
    return publicContext(span);
  } catch (error) {
    const safeReasons = new Set([
      'invalid_input',
      'invalid_context',
      'invalid_skill',
      'invalid_checkpoint',
      'invalid_additional_info',
      'missing_parent',
      'parent_finished',
      'invalid_parent',
      'invalid_retry',
      'invalid_resume',
      'already_finished',
      'invalid_state',
      'invalid_error_class',
      'invalid_clock',
      'children_pending',
      'lock_timeout',
    ]);
    return {
      status: 'unavailable',
      reason: safeReasons.has(error.message) ? error.message : 'telemetry_unavailable',
    };
  }
}

if (require.main === module) {
  const result = runCommand();
  if (
    result &&
    result.status !== 'executed' &&
    (result.schemaVersion === 2 || result.status)
  ) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  if (result?.status === 'executed') process.exitCode = result.exitCode;
}

module.exports = {
  captureSuccessfulDataverseRequest,
  emitCheckpoint,
  executeCommand,
  parseCheckpointPayload,
  parseOptions,
  runCommand,
};