'use strict';

// Lifecycle persistence is Mobile Apps-specific so other telemetry adopters
// can evolve independently without taking this workflow contract.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_INITIALIZATION_GRACE_MS = 1000;
const LOCK_DIRECTORY = '.lifecycle.lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_RECOVERY_DIRECTORY = '.lifecycle.lock.recovery';

function normalizePolicy(input) {
  if (!input || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.pluginName || '')) {
    throw new TypeError('Lifecycle telemetry requires a valid plugin name');
  }
  if (!(input.trackedSkillNames instanceof Set) || typeof input.checkpointNames !== 'function') {
    throw new TypeError('Lifecycle telemetry requires skill and checkpoint validators');
  }
  if (typeof input.isAdditionalInfo !== 'function') {
    throw new TypeError('Lifecycle telemetry requires an additional-info validator');
  }
  return Object.freeze({
    pluginName: input.pluginName,
    trackedSkillNames: new Set(input.trackedSkillNames),
    exemptSkillNames: new Set(input.exemptSkillNames || []),
    checkpointNames: input.checkpointNames,
    isAdditionalInfo: input.isAdditionalInfo,
    terminalStates: new Set(input.terminalStates || [
      'completed', 'failed', 'blocked', 'cancelled', 'skipped', 'needs_context',
    ]),
    errorClasses: new Set(input.errorClasses || []),
    retentionMs: Number.isSafeInteger(input.retentionMs) && input.retentionMs > 0
      ? input.retentionMs
      : DEFAULT_RETENTION_MS,
  });
}

function checkpointNames(policy, skillName) {
  if (!policy.trackedSkillNames.has(skillName) || policy.exemptSkillNames.has(skillName)) {
    return new Set();
  }
  const names = policy.checkpointNames(skillName);
  return names instanceof Set ? names : new Set();
}

function requireGuid(value) {
  if (typeof value !== 'string' || !GUID.test(value)) throw new Error('invalid_context');
  return value.toLowerCase();
}

function scopeKey(projectRoot) {
  return crypto.createHash('sha256').update(fs.realpathSync(projectRoot)).digest('hex');
}

function runDirectory(policy, configDir, runId) {
  return path.join(configDir, 'telemetry', policy.pluginName, 'runs', requireGuid(runId));
}

function readJson(filename) {
  if (fs.statSync(filename).size > 32 * 1024) throw new Error('invalid_context');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function writeExclusive(filename, value) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Publish without replacing an existing record or exposing a half-written
    // JSON file to a concurrent finish. Both links stay in the private directory.
    fs.linkSync(temporary, filename);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

function processIsAlive(pid, options) {
  if (typeof options.isProcessAlive === 'function') return options.isProcessAlive(pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function readLockOwner(lockPath) {
  try {
    const owner = readJson(path.join(lockPath, LOCK_OWNER_FILE));
    if (
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.token === 'string' &&
      GUID.test(owner.token) &&
      Number.isSafeInteger(owner.acquiredAtMs)
    ) {
      return owner;
    }
  } catch {
    // Missing or malformed metadata is handled after the initialization grace.
  }
  return null;
}

function writeLockOwner(lockPath, token) {
  fs.writeFileSync(path.join(lockPath, LOCK_OWNER_FILE), JSON.stringify({
    pid: process.pid,
    token,
    acquiredAtMs: Date.now(),
  }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function releaseOwnedLock(lockPath, token) {
  try {
    const owner = readLockOwner(lockPath);
    if (owner?.token === token) fs.rmSync(lockPath, { recursive: true });
  } catch {
    // A release failure is recovered when the owner process is no longer live.
  }
}

function initializationGraceElapsed(lockPath, options) {
  const graceMs = Number.isSafeInteger(options.lockInitializationGraceMs) &&
    options.lockInitializationGraceMs >= 0
    ? options.lockInitializationGraceMs
    : DEFAULT_LOCK_INITIALIZATION_GRACE_MS;
  return Date.now() - fs.statSync(lockPath).mtimeMs >= graceMs;
}

function acquireRecoveryLock(recoveryPath, options) {
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(recoveryPath, { mode: 0o700 });
      try {
        writeLockOwner(recoveryPath, token);
      } catch (error) {
        fs.rmSync(recoveryPath, { recursive: true, force: true });
        throw error;
      }
      return () => releaseOwnedLock(recoveryPath, token);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readLockOwner(recoveryPath);
      if (owner && processIsAlive(owner.pid, options)) return null;
      if (!owner && !initializationGraceElapsed(recoveryPath, options)) return null;
      fs.rmSync(recoveryPath, { recursive: true, force: true });
    }
  }
  return null;
}

function tryRecoverRunLock(directory, options) {
  const lockPath = path.join(directory, LOCK_DIRECTORY);
  const recoveryPath = path.join(directory, LOCK_RECOVERY_DIRECTORY);
  const releaseRecovery = acquireRecoveryLock(recoveryPath, options);
  if (!releaseRecovery) return false;

  try {
    if (!fs.existsSync(lockPath)) return true;
    const owner = readLockOwner(lockPath);
    if (owner && processIsAlive(owner.pid, options)) return false;
    if (!owner && !initializationGraceElapsed(lockPath, options)) return false;

    // Only one process can hold the recovery directory, and no new owner can
    // acquire the stable lock path until this stale directory is removed.
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } finally {
    releaseRecovery();
  }
}

function acquireRunLock(directory, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.lockTimeoutMs) && options.lockTimeoutMs >= 0
    ? options.lockTimeoutMs
    : DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = Number.isSafeInteger(options.lockRetryMs) && options.lockRetryMs > 0
    ? options.lockRetryMs
    : DEFAULT_LOCK_RETRY_MS;
  const lockPath = path.join(directory, LOCK_DIRECTORY);
  const token = crypto.randomUUID();
  const startedAt = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeLockOwner(lockPath, token);
      } catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => releaseOwnedLock(lockPath, token);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (tryRecoverRunLock(directory, options)) continue;
      if (Date.now() - startedAt >= timeoutMs) throw new Error('lock_timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
    }
  }
}

function clockReading(options) {
  return {
    wallMs: options.now === undefined ? Date.now() : options.now,
    monotonicMs: options.monotonicMs ?? (options.now === undefined ? Number(process.hrtime.bigint() / 1000000n) : null),
    uptimeMs: options.uptimeMs ?? (options.now === undefined ? Math.round(os.uptime() * 1000) : null),
  };
}

function readRun(policy, options) {
  const directory = runDirectory(policy, options.configDir, options.runId);
  const record = readJson(path.join(directory, 'run.json'));
  if (record.schemaVersion !== 2 || record.runId !== options.runId ||
      !GUID.test(record.rootSpanId || '') || !GUID.test(record.sessionId || '') ||
      !Number.isSafeInteger(record.startedAtMs) ||
      record.scopeKey !== scopeKey(options.projectRoot)) throw new Error('invalid_context');
  return { directory, record };
}

function readSpan(policy, options) {
  const { directory, record: run } = readRun(policy, options);
  const spanId = requireGuid(options.spanId);
  const record = readJson(path.join(directory, `${spanId}.start.json`));
  if (record.runId !== run.runId || record.spanId !== spanId ||
      !policy.trackedSkillNames.has(record.skillName) ||
      !['skill', 'checkpoint'].includes(record.spanType) ||
      !GUID.test(record.eventId || '') || record.sessionId !== run.sessionId ||
      (record.parentSpanId !== null && !GUID.test(record.parentSpanId || '')) ||
      !Number.isSafeInteger(record.attempt) || record.attempt < 1 ||
      !Number.isSafeInteger(record.startedAtMs)) throw new Error('invalid_context');
  if (record.spanType === 'checkpoint' && !checkpointNames(policy, record.skillName).has(record.checkpointName)) {
    throw new Error('invalid_context');
  }
  if (record.additionalInfo != null && !policy.isAdditionalInfo(record.additionalInfo)) {
    throw new Error('invalid_context');
  }
  return { directory, run, record };
}

function persistSpan(policy, options, context) {
  const { clock, directory, parentSpanId, run, spanId } = context;
  let attempt = 1;
  if (options.retryOf) {
    const prior = readSpan(policy, {
      ...options,
      runId: run.runId,
      spanId: options.retryOf,
    }).record;
    if (prior.parentSpanId !== parentSpanId || prior.skillName !== options.skillName ||
        prior.checkpointName !== (options.checkpointName || null) ||
        !fs.existsSync(path.join(directory, `${prior.spanId}.end.json`))) throw new Error('invalid_retry');
    attempt = prior.attempt + 1;
  }
  const record = { schemaVersion: 2, runId: run.runId, spanId, parentSpanId: parentSpanId || null,
    spanType: options.checkpointName ? 'checkpoint' : 'skill',
    skillName: options.skillName, checkpointName: options.checkpointName || null,
    additionalInfo: options.additionalInfo || null,
    sessionId: run.sessionId, attempt, eventId: crypto.randomUUID(),
    startedMonotonicMs: clock.monotonicMs, startedUptimeMs: clock.uptimeMs,
    startedAtMs: clock.wallMs, time: new Date(clock.wallMs).toISOString(), state: 'started' };
  // One immutable file per span avoids lost updates when independent agents run
  // concurrently. Project/process paths never enter the event record.
  writeExclusive(path.join(directory, `${spanId}.start.json`), record);
  return record;
}

function beginSpan(policy, options) {
  const { skillName, checkpointName } = options;
  if (!policy.trackedSkillNames.has(skillName) || policy.exemptSkillNames.has(skillName)) {
    throw new Error('invalid_skill');
  }
  if (checkpointName && !checkpointNames(policy, skillName).has(checkpointName)) {
    throw new Error('invalid_checkpoint');
  }
  if (options.additionalInfo && !policy.isAdditionalInfo(options.additionalInfo)) {
    throw new Error('invalid_additional_info');
  }
  const clock = clockReading(options);
  if (!Number.isSafeInteger(clock.wallMs) || clock.wallMs < 0) throw new Error('invalid_clock');
  const spanId = crypto.randomUUID();
  const runId = options.runId;
  const parentSpanId = options.parentSpanId;

  if (runId || parentSpanId) {
    if (!runId || !parentSpanId) throw new Error('missing_parent');
    const initialParent = readSpan(policy, { ...options, spanId: parentSpanId });
    const release = acquireRunLock(initialParent.directory, options);
    try {
      const parent = readSpan(policy, { ...options, spanId: parentSpanId });
      if (fs.existsSync(path.join(parent.directory, `${parent.record.spanId}.end.json`))) {
        throw new Error('parent_finished');
      }
      if (checkpointName && parent.record.skillName !== skillName) {
        throw new Error('invalid_parent');
      }
      return persistSpan(policy, options, {
        clock,
        directory: parent.directory,
        parentSpanId: parent.record.spanId,
        run: parent.run,
        spanId,
      });
    } finally {
      release();
    }
  }

  if (checkpointName) throw new Error('missing_parent');
  pruneRuns(policy, options.configDir, clock.wallMs);
  const newRunId = crypto.randomUUID();
  const directory = runDirectory(policy, options.configDir, newRunId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run = {
    schemaVersion: 2,
    runId: newRunId,
    rootSpanId: spanId,
    scopeKey: scopeKey(options.projectRoot),
    sessionId: GUID.test(options.sessionId || '') ? options.sessionId : newRunId,
    startedAtMs: clock.wallMs,
  };
  writeExclusive(path.join(directory, 'run.json'), run);
  return persistSpan(policy, options, {
    clock,
    directory,
    parentSpanId: null,
    run,
    spanId,
  });
}

function finishSpan(policy, options) {
  if (!policy.terminalStates.has(options.state)) throw new Error('invalid_state');
  if (options.errorClass && !policy.errorClasses.has(options.errorClass)) {
    throw new Error('invalid_error_class');
  }
  const initial = readSpan(policy, options);
  const release = acquireRunLock(initial.directory, options);
  try {
    const { directory, record } = readSpan(policy, options);
    const endPath = path.join(directory, `${record.spanId}.end.json`);
    if (fs.existsSync(endPath)) {
      const previous = readJson(endPath);
      validateEnd(policy, record, previous);
      if (previous.state !== options.state) throw new Error('already_finished');
      return previous;
    }
    if (options.state === 'completed') {
      const spans = listSpans(policy, options);
      const byId = new Map(spans.map((span) => [span.spanId, span]));
      for (const candidate of spans) {
        if (candidate.spanId === record.spanId || candidate.state !== 'started') continue;
        let parent = candidate.parentSpanId;
        const visited = new Set();
        while (parent && !visited.has(parent)) {
          if (parent === record.spanId) throw new Error('children_pending');
          visited.add(parent);
          parent = byId.get(parent)?.parentSpanId;
        }
      }
    }
    const clock = clockReading(options);
    const now = clock.wallMs;
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_clock');
    const wallElapsed = now - record.startedAtMs;
    const hasMonotonic = Number.isSafeInteger(record.startedMonotonicMs) &&
      Number.isSafeInteger(clock.monotonicMs);
    const monotonicElapsed = hasMonotonic ? clock.monotonicMs - record.startedMonotonicMs : wallElapsed;
    const uptimeElapsed = Number.isSafeInteger(record.startedUptimeMs) &&
      Number.isSafeInteger(clock.uptimeMs)
      ? clock.uptimeMs - record.startedUptimeMs
      : wallElapsed;
    const measured = wallElapsed >= 0 && monotonicElapsed >= 0 && uptimeElapsed >= 0 &&
      Math.abs(wallElapsed - monotonicElapsed) <= 2000 &&
      Math.abs(wallElapsed - uptimeElapsed) <= 2000;
    const result = {
      ...record,
      eventId: crypto.randomUUID(),
      state: options.state,
      time: new Date(now).toISOString(),
      timingStatus: options.state === 'skipped'
        ? 'not_applicable'
        : measured
          ? 'measured'
          : 'clock_invalid',
    };
    if (measured && options.state !== 'skipped') result.durationMs = monotonicElapsed;
    if (options.errorClass) result.errorClass = options.errorClass;
    writeExclusive(endPath, result);
    return result;
  } finally {
    release();
  }
}

function resumeSpan(policy, options) {
  const initial = readSpan(policy, options);
  const release = acquireRunLock(initial.directory, options);
  try {
    const { directory, run, record } = readSpan(policy, options);
    if (record.spanType !== 'skill') throw new Error('invalid_resume');
    const end = readJsonIfPresent(path.join(directory, `${record.spanId}.end.json`));
    if (!end) throw new Error('invalid_resume');
    validateEnd(policy, record, end);
    if (end.state !== 'needs_context') throw new Error('invalid_resume');
    if (
      record.parentSpanId &&
      fs.existsSync(path.join(directory, `${record.parentSpanId}.end.json`))
    ) {
      throw new Error('parent_finished');
    }
    const clock = clockReading(options);
    if (!Number.isSafeInteger(clock.wallMs) || clock.wallMs < 0) {
      throw new Error('invalid_clock');
    }
    return persistSpan(policy, {
      ...options,
      skillName: record.skillName,
      checkpointName: null,
      additionalInfo: record.additionalInfo,
      retryOf: record.spanId,
    }, {
      clock,
      directory,
      parentSpanId: record.parentSpanId,
      run,
      spanId: crypto.randomUUID(),
    });
  } finally {
    release();
  }
}

function listSpans(policy, options) {
  const { directory } = readRun(policy, options);
  const files = fs.readdirSync(directory).filter((name) => /^[0-9a-f-]{36}\.start\.json$/i.test(name));
  if (files.length > 4096) throw new Error('invalid_context');
  return files.map((name) => {
    const spanId = name.slice(0, 36);
    const start = readSpan(policy, { ...options, spanId }).record;
    const end = readJsonIfPresent(path.join(directory, `${spanId}.end.json`));
    if (end) validateEnd(policy, start, end);
    return end || start;
  });
}

function readJsonIfPresent(filename) {
  try { return readJson(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateEnd(policy, start, end) {
  for (const field of ['runId', 'spanId', 'parentSpanId', 'skillName', 'checkpointName', 'additionalInfo', 'spanType', 'sessionId', 'attempt', 'startedAtMs', 'startedMonotonicMs', 'startedUptimeMs']) {
    if (start[field] !== end[field]) throw new Error('invalid_context');
  }
  if (!policy.terminalStates.has(end.state) || !GUID.test(end.eventId || '') ||
      !Number.isFinite(Date.parse(end.time)) ||
      (end.durationMs !== undefined && (!Number.isSafeInteger(end.durationMs) || end.durationMs < 0))) {
    throw new Error('invalid_context');
  }
}

function pruneRuns(policy, configDir, now = Date.now()) {
  const root = path.join(configDir, 'telemetry', policy.pluginName, 'runs');
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !GUID.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      const run = readJsonIfPresent(path.join(directory, 'run.json'));
      if (
        run?.runId === entry.name &&
        Number.isSafeInteger(run.startedAtMs) &&
        now - run.startedAtMs > policy.retentionMs
      ) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  } catch { /* Retention cleanup is best effort and never blocks a workflow. */ }
}

function reportRun(policy, options) {
  const { record: run } = readRun(policy, options);
  const rawSpans = listSpans(policy, options);
  const initialRoot = rawSpans.find((span) => span.spanId === run.rootSpanId);
  const currentRoot = rawSpans
    .filter((span) => span.spanType === 'skill' &&
      span.parentSpanId === null &&
      span.skillName === initialRoot?.skillName)
    .sort((left, right) =>
      right.attempt - left.attempt ||
      right.startedAtMs - left.startedAtMs ||
      right.spanId.localeCompare(left.spanId))[0];
  const spans = rawSpans.map((span) => ({
    spanId: span.spanId, parentSpanId: span.parentSpanId, skill: span.skillName,
    step: span.checkpointName, type: span.spanType, attempt: span.attempt,
    state: span.state === 'started' ? 'incomplete' : span.state,
    startedAt: new Date(span.startedAtMs).toISOString(),
    ...(span.state === 'started' ? {} : { finishedAt: new Date(span.time).toISOString() }),
    ...(span.durationMs === undefined ? {} : { durationMs: span.durationMs }),
    ...(policy.errorClasses.has(span.errorClass) ? { errorClass: span.errorClass } : {}),
    ...(policy.isAdditionalInfo(span.additionalInfo) ? { additionalInfo: span.additionalInfo } : {}),
  }));
  return { schemaVersion: 2, supportId: run.runId, runId: run.runId,
    state: currentRoot?.state === 'started' ? 'incomplete' : currentRoot?.state || 'incomplete', spans };
}

function createLifecycle(input) {
  const policy = normalizePolicy(input);
  return Object.freeze({
    beginSpan: (options) => beginSpan(policy, options),
    finishSpan: (options) => finishSpan(policy, options),
    listSpans: (options) => listSpans(policy, options),
    pruneRuns: (configDir, now) => pruneRuns(policy, configDir, now),
    readRun: (options) => readRun(policy, options),
    readSpan: (options) => readSpan(policy, options),
    reportRun: (options) => reportRun(policy, options),
    resumeSpan: (options) => resumeSpan(policy, options),
    runDirectory: (configDir, runId) => runDirectory(policy, configDir, runId),
  });
}

module.exports = { GUID, createLifecycle };