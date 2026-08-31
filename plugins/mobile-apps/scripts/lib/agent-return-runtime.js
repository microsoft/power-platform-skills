'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DEFAULT_MODE_TTL_MS = 30 * 60 * 1000;
const EXECUTION_MODES = new Set(['parallel-return', 'foreground-return']);
const INTERACTION_KINDS = new Set(['clarification', 'approval']);
const DISPATCH_REASONS = new Set([
  'initial',
  'transport_retry',
  'needs_context',
  'needs_clarification',
  'targeted_repair',
]);

function atomicWriteJson(file, value, fileSystem = fs) {
  const resolved = path.resolve(file);
  fileSystem.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fileSystem.renameSync(temporary, resolved);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function normalizeBinding(binding) {
  return {
    hostId: requiredString(binding?.hostId, 'hostId'),
    runtimeId: requiredString(binding?.runtimeId, 'runtimeId'),
    pluginVersion: requiredString(binding?.pluginVersion, 'pluginVersion'),
  };
}

function readExecutionMode(file, binding, {
  fileSystem = fs,
  nowMs = () => Date.now(),
  ttlMs = DEFAULT_MODE_TTL_MS,
} = {}) {
  const expected = normalizeBinding(binding);
  if (!fileSystem.existsSync(path.resolve(file))) {
    return { executionMode: null, cacheHit: false, reason: 'missing' };
  }
  let value;
  try {
    value = JSON.parse(fileSystem.readFileSync(path.resolve(file), 'utf8'));
  } catch {
    return { executionMode: null, cacheHit: false, reason: 'invalid-json' };
  }
  if (value?.schemaVersion !== SCHEMA_VERSION
    || !EXECUTION_MODES.has(value.executionMode)
    || !value.binding
    || !Number.isFinite(Date.parse(value.checkedAt))) {
    return { executionMode: null, cacheHit: false, reason: 'invalid-shape' };
  }
  if (Object.keys(expected).some((key) => value.binding[key] !== expected[key])) {
    return { executionMode: null, cacheHit: false, reason: 'binding-changed' };
  }
  const ageMs = nowMs() - Date.parse(value.checkedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttlMs) {
    return { executionMode: null, cacheHit: false, reason: 'stale' };
  }
  return {
    executionMode: value.executionMode,
    cacheHit: true,
    reason: 'current',
    checkedAt: value.checkedAt,
  };
}

function writeExecutionMode(file, binding, executionMode, {
  fileSystem = fs,
  nowIso = () => new Date().toISOString(),
} = {}) {
  if (!EXECUTION_MODES.has(executionMode)) {
    throw new Error(`unsupported execution mode: ${executionMode}`);
  }
  const value = {
    schemaVersion: SCHEMA_VERSION,
    binding: normalizeBinding(binding),
    executionMode,
    checkedAt: nowIso(),
  };
  atomicWriteJson(file, value, fileSystem);
  return value;
}

function normalizeInteraction(interaction) {
  if (!INTERACTION_KINDS.has(interaction?.kind)) {
    throw new Error(`unsupported interaction kind: ${interaction?.kind || '<missing>'}`);
  }
  if (!Array.isArray(interaction.affectedDecisions)
    || interaction.affectedDecisions.some(
      (item) => typeof item !== 'string' || !item.trim(),
    )) {
    throw new Error('affectedDecisions must be an array of non-empty strings');
  }
  return {
    kind: interaction.kind,
    sectionId: requiredString(interaction.sectionId, 'sectionId'),
    question: requiredString(interaction.question, 'question'),
    affectedDecisions: interaction.affectedDecisions.map((item) => item.trim()),
  };
}

function writeWaitingInteraction(file, {
  runId,
  phase,
  pendingInteraction,
  revision = 1,
}, {
  fileSystem = fs,
  nowIso = () => new Date().toISOString(),
} = {}) {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error('revision must be a positive integer');
  }
  const value = {
    schemaVersion: SCHEMA_VERSION,
    runId: requiredString(runId, 'runId'),
    phase: requiredString(phase, 'phase'),
    status: 'waiting_for_user',
    revision,
    updatedAt: nowIso(),
    pendingInteraction: normalizeInteraction(pendingInteraction),
  };
  atomicWriteJson(file, value, fileSystem);
  return value;
}

function resumeWaitingInteraction(file, answer, {
  runId,
  fileSystem = fs,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const resolved = path.resolve(file);
  const normalizedRunId = requiredString(runId, 'runId');
  if (!fileSystem.existsSync(resolved)) throw new Error('interaction state is missing');
  const previous = JSON.parse(fileSystem.readFileSync(resolved, 'utf8'));
  if (previous.schemaVersion !== SCHEMA_VERSION
    || previous.status !== 'waiting_for_user'
    || !previous.pendingInteraction) {
    throw new Error('interaction state is not waiting for a user');
  }
  if (previous.runId !== normalizedRunId) {
    throw new Error('interaction state belongs to a different run');
  }
  const value = {
    schemaVersion: SCHEMA_VERSION,
    runId: normalizedRunId,
    phase: previous.phase,
    status: 'ready_to_resume',
    revision: previous.revision,
    updatedAt: nowIso(),
    pendingInteraction: null,
    resolvedInteraction: {
      ...normalizeInteraction(previous.pendingInteraction),
      answer: requiredString(answer, 'answer'),
      answeredAt: nowIso(),
    },
  };
  atomicWriteJson(resolved, value, fileSystem);
  return value;
}

function recordAgentDispatch(file, {
  runId,
  agent,
  workOrderId,
  reason,
  inputFingerprint,
}, {
  fileSystem = fs,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const normalizedRunId = requiredString(runId, 'runId');
  const normalizedAgent = requiredString(agent, 'agent');
  const normalizedWorkOrderId = requiredString(workOrderId, 'workOrderId');
  const normalizedReason = requiredString(reason, 'reason');
  const fingerprint = requiredString(inputFingerprint, 'inputFingerprint');
  if (!DISPATCH_REASONS.has(normalizedReason)) {
    throw new Error(`unsupported dispatch reason: ${normalizedReason}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('inputFingerprint must be a SHA-256 value');
  }
  let state = { schemaVersion: SCHEMA_VERSION, dispatches: [] };
  if (fileSystem.existsSync(path.resolve(file))) {
    state = JSON.parse(fileSystem.readFileSync(path.resolve(file), 'utf8'));
    if (state.schemaVersion !== SCHEMA_VERSION || !Array.isArray(state.dispatches)) {
      throw new Error('agent dispatch state is invalid');
    }
  }
  // Work-order IDs are stable across retries and may recur in a later app run.
  // Scope history to the run so an abandoned run cannot consume fresh budgets.
  const prior = state.dispatches.filter((entry) => (
    entry.runId === normalizedRunId
      && entry.agent === normalizedAgent
      && entry.workOrderId === normalizedWorkOrderId
  ));
  const sameReason = prior.filter((entry) => entry.reason === normalizedReason);
  if (normalizedReason === 'initial' && prior.length > 0) {
    throw new Error(`${normalizedAgent} initial dispatch already recorded`);
  }
  const limits = {
    transport_retry: 1,
    needs_context: 1,
    needs_clarification: 1,
    targeted_repair: 2,
  };
  if (limits[normalizedReason] !== undefined
    && sameReason.length >= limits[normalizedReason]) {
    throw new Error(`${normalizedAgent} ${normalizedReason} dispatch limit reached`);
  }
  if (normalizedReason === 'transport_retry') {
    const previous = prior.at(-1);
    if (!previous || previous.inputFingerprint !== fingerprint) {
      throw new Error('transport retry must reuse the byte-identical sealed work order');
    }
  }
  state.dispatches.push({
    sequence: state.dispatches.length + 1,
    runId: normalizedRunId,
    agent: normalizedAgent,
    workOrderId: normalizedWorkOrderId,
    reason: normalizedReason,
    inputFingerprint: fingerprint,
    recordedAt: nowIso(),
  });
  atomicWriteJson(file, state, fileSystem);
  return state;
}

function recordTransportFailure(file, {
  runId,
  agent,
  workOrderId,
  inputFingerprint,
}, {
  fileSystem = fs,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const normalizedRunId = requiredString(runId, 'runId');
  const normalizedAgent = requiredString(agent, 'agent');
  const normalizedWorkOrderId = requiredString(workOrderId, 'workOrderId');
  const fingerprint = requiredString(inputFingerprint, 'inputFingerprint');
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('inputFingerprint must be a SHA-256 value');
  }
  const resolved = path.resolve(file);
  if (!fileSystem.existsSync(resolved)) throw new Error('agent dispatch state is missing');
  const state = JSON.parse(fileSystem.readFileSync(resolved, 'utf8'));
  if (state.schemaVersion !== SCHEMA_VERSION || !Array.isArray(state.dispatches)) {
    throw new Error('agent dispatch state is invalid');
  }
  const dispatches = state.dispatches.filter((entry) => (
    entry.runId === normalizedRunId
      && entry.agent === normalizedAgent
      && entry.workOrderId === normalizedWorkOrderId
  ));
  const latestDispatch = dispatches.at(-1);
  if (!latestDispatch) throw new Error('transport failure requires a recorded dispatch');
  if (latestDispatch.inputFingerprint !== fingerprint) {
    throw new Error('transport failure must match the latest sealed work order');
  }
  state.transportFailures = Array.isArray(state.transportFailures)
    ? state.transportFailures
    : [];
  const priorFailures = state.transportFailures.filter((entry) => (
    entry.runId === normalizedRunId
      && entry.agent === normalizedAgent
      && entry.workOrderId === normalizedWorkOrderId
  ));
  if (priorFailures.length >= 2) {
    throw new Error(`${normalizedAgent} transport failure limit reached`);
  }
  // Retry malformed transport once. A second malformed response changes only
  // this work order's channel; the host-level parallel capability remains valid.
  const transportFailureCount = priorFailures.length + 1;
  const executionMode = transportFailureCount === 2
    ? 'foreground-return'
    : 'parallel-return';
  const event = {
    sequence: state.transportFailures.length + 1,
    runId: normalizedRunId,
    agent: normalizedAgent,
    workOrderId: normalizedWorkOrderId,
    inputFingerprint: fingerprint,
    transportFailureCount,
    executionMode,
    recordedAt: nowIso(),
  };
  state.transportFailures.push(event);
  atomicWriteJson(file, state, fileSystem);
  return {
    ...event,
    nextAction: executionMode === 'foreground-return'
      ? 'foreground_return'
      : 'transport_retry',
  };
}

module.exports = {
  DEFAULT_MODE_TTL_MS,
  DISPATCH_REASONS,
  EXECUTION_MODES,
  INTERACTION_KINDS,
  SCHEMA_VERSION,
  atomicWriteJson,
  readExecutionMode,
  recordAgentDispatch,
  recordTransportFailure,
  resumeWaitingInteraction,
  writeExecutionMode,
  writeWaitingInteraction,
};