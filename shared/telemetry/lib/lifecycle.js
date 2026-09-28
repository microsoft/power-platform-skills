'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function normalizePolicy(input) {
  if (!input || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.pluginName || '')) {
    throw new TypeError('Lifecycle telemetry requires a valid plugin name');
  }
  if (!(input.trackedSkillNames instanceof Set) || typeof input.checkpointNames !== 'function') {
    throw new TypeError('Lifecycle telemetry requires skill and checkpoint validators');
  }
  return Object.freeze({
    pluginName: input.pluginName,
    trackedSkillNames: new Set(input.trackedSkillNames),
    exemptSkillNames: new Set(input.exemptSkillNames || []),
    checkpointNames: input.checkpointNames,
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
  return { directory, run, record };
}

function beginSpan(policy, options) {
  const { skillName, checkpointName } = options;
  if (!policy.trackedSkillNames.has(skillName) || policy.exemptSkillNames.has(skillName)) {
    throw new Error('invalid_skill');
  }
  if (checkpointName && !checkpointNames(policy, skillName).has(checkpointName)) {
    throw new Error('invalid_checkpoint');
  }
  const clock = clockReading(options);
  const now = clock.wallMs;
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_clock');
  const spanId = crypto.randomUUID();
  let runId = options.runId;
  let parentSpanId = options.parentSpanId;
  let directory;
  let run;
  if (runId || parentSpanId) {
    if (!runId || !parentSpanId) throw new Error('missing_parent');
    const parent = readSpan(policy, { ...options, spanId: parentSpanId });
    ({ directory, run } = parent);
    if (fs.existsSync(path.join(directory, `${requireGuid(parentSpanId)}.end.json`))) {
      throw new Error('parent_finished');
    }
    if (checkpointName && parent.record.skillName !== skillName) {
      throw new Error('invalid_parent');
    }
  } else {
    if (checkpointName) throw new Error('missing_parent');
    pruneRuns(policy, options.configDir, now);
    runId = crypto.randomUUID();
    directory = runDirectory(policy, options.configDir, runId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    run = { schemaVersion: 2, runId, rootSpanId: spanId, scopeKey: scopeKey(options.projectRoot),
      sessionId: GUID.test(options.sessionId || '') ? options.sessionId : runId, startedAtMs: now };
    writeExclusive(path.join(directory, 'run.json'), run);
  }
  let attempt = 1;
  if (options.retryOf) {
    const prior = readSpan(policy, { ...options, runId, spanId: options.retryOf }).record;
    if (prior.parentSpanId !== parentSpanId || prior.skillName !== skillName ||
        prior.checkpointName !== (checkpointName || null) ||
        !fs.existsSync(path.join(directory, `${prior.spanId}.end.json`))) throw new Error('invalid_retry');
    attempt = prior.attempt + 1;
  }
  const record = { schemaVersion: 2, runId, spanId, parentSpanId: parentSpanId || null,
    spanType: checkpointName ? 'checkpoint' : 'skill', skillName, checkpointName: checkpointName || null,
    sessionId: run.sessionId, attempt, eventId: crypto.randomUUID(),
    startedMonotonicMs: clock.monotonicMs, startedUptimeMs: clock.uptimeMs,
    startedAtMs: now, time: new Date(now).toISOString(), state: 'started' };
  // One immutable file per span avoids lost updates when independent agents run
  // concurrently. Project/process paths never enter the event record.
  writeExclusive(path.join(directory, `${spanId}.start.json`), record);
  return record;
}

function finishSpan(policy, options) {
  if (!policy.terminalStates.has(options.state)) throw new Error('invalid_state');
  if (options.errorClass && !policy.errorClasses.has(options.errorClass)) {
    throw new Error('invalid_error_class');
  }
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
  const hasMonotonic = Number.isSafeInteger(record.startedMonotonicMs) && Number.isSafeInteger(clock.monotonicMs);
  const monotonicElapsed = hasMonotonic ? clock.monotonicMs - record.startedMonotonicMs : wallElapsed;
  const uptimeElapsed = Number.isSafeInteger(record.startedUptimeMs) && Number.isSafeInteger(clock.uptimeMs)
    ? clock.uptimeMs - record.startedUptimeMs : wallElapsed;
  const measured = wallElapsed >= 0 && monotonicElapsed >= 0 && uptimeElapsed >= 0 &&
    Math.abs(wallElapsed - monotonicElapsed) <= 2000 && Math.abs(wallElapsed - uptimeElapsed) <= 2000;
  const result = { ...record, eventId: crypto.randomUUID(), state: options.state,
    time: new Date(now).toISOString(),
    timingStatus: options.state === 'skipped' ? 'not_applicable' : measured ? 'measured' : 'clock_invalid' };
  if (measured && options.state !== 'skipped') result.durationMs = monotonicElapsed;
  if (options.errorClass) result.errorClass = options.errorClass;
  try {
    // Exclusive creation makes duplicate finishes idempotent. A retry returns
    // the same event ID so replay can be deduplicated without inventing a span.
    writeExclusive(endPath, result);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return finishSpan(policy, options);
  }
  return result;
}

function resumeSpan(policy, options) {
  const { directory, record } = readSpan(policy, options);
  if (fs.existsSync(path.join(directory, `${record.spanId}.end.json`))) throw new Error('already_finished');
  return record;
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
  for (const field of ['runId', 'spanId', 'parentSpanId', 'skillName', 'checkpointName', 'spanType', 'sessionId', 'attempt', 'startedAtMs', 'startedMonotonicMs', 'startedUptimeMs']) {
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
  const spans = listSpans(policy, options).map((span) => ({
    spanId: span.spanId, parentSpanId: span.parentSpanId, skill: span.skillName,
    step: span.checkpointName, type: span.spanType, attempt: span.attempt,
    state: span.state === 'started' ? 'incomplete' : span.state,
    startedAt: new Date(span.startedAtMs).toISOString(),
    ...(span.state === 'started' ? {} : { finishedAt: new Date(span.time).toISOString() }),
    ...(span.durationMs === undefined ? {} : { durationMs: span.durationMs }),
    ...(policy.errorClasses.has(span.errorClass) ? { errorClass: span.errorClass } : {}),
  }));
  return { schemaVersion: 2, supportId: run.runId, runId: run.runId,
    state: spans.find((span) => span.spanId === run.rootSpanId)?.state || 'incomplete', spans };
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