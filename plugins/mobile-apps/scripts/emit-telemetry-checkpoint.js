#!/usr/bin/env node
'use strict';

const { TRACKED_SKILL_NAMES } = require('./lib/mobileapp-hook-utils');
const telemetry = require('./lib/mobile-telemetry');

const CHECKPOINT_STATES = new Set(['started', 'completed', 'skipped', 'failed']);
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
  if (
    additionalInfo &&
    (additionalInfo.length > 64 || !CHECKPOINT_NAME_PATTERN.test(additionalInfo))
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
    const context = createContext({});
    if (!context) return null;

    const emit = opts.emitCheckpoint || telemetry.emitCheckpoint;
    return emit(context, invocation, { cwd: opts.cwd || process.cwd() });
  } catch {
    return null;
  }
}

if (require.main === module) {
  emitCheckpoint(process.argv[2]);
}

module.exports = { emitCheckpoint, parseCheckpointPayload };