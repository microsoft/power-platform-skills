'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

function nonNegativeInteger(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? Math.round(normalized) : 0;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction));
  return sorted[index];
}

function sanitizeIdentifier(value, pattern) {
  const normalized = String(value || '');
  return pattern.test(normalized) ? normalized : null;
}

function sanitizeEvent(event, sequence) {
  return {
    sequence,
    method: sanitizeIdentifier(event?.method, /^(?:GET|POST|PUT|PATCH|DELETE)$/) || 'GET',
    category: sanitizeIdentifier(event?.category, /^[a-z][a-z0-9-]*$/) || 'other',
    table: event?.table == null
      ? null
      : sanitizeIdentifier(event.table, /^[A-Za-z][A-Za-z0-9_]*$/),
    metadataType: event?.metadataType == null
      ? null
      : sanitizeIdentifier(event.metadataType, /^[A-Za-z][A-Za-z0-9]*$/),
    status: Number.isInteger(event?.status) ? event.status : 0,
    durationMs: nonNegativeInteger(event?.durationMs),
    responseBytes: nonNegativeInteger(event?.responseBytes),
    attempts: Math.max(1, nonNegativeInteger(event?.attempts)),
    retryCount: nonNegativeInteger(event?.retryCount),
    rateLimited: Boolean(event?.rateLimited),
    tokenAcquisitionCount: nonNegativeInteger(event?.tokenAcquisitionCount),
    tokenRefreshCount: nonNegativeInteger(event?.tokenRefreshCount),
    operationClass: sanitizeIdentifier(
      event?.operationClass,
      /^(?:read|table-write|column-write|relationship-or-key-write|publish|other-write)$/,
    ) || 'read',
    requestedTimeoutMs: nonNegativeInteger(event?.requestedTimeoutMs),
  };
}

function summarizeEvents(events) {
  const requestCountByCategory = {};
  const requestCountByOperationClass = {};
  const statusCounts = {};
  for (const event of events) {
    requestCountByCategory[event.category] =
      (requestCountByCategory[event.category] || 0) + 1;
    statusCounts[event.status] = (statusCounts[event.status] || 0) + 1;
    const operationClass = event.operationClass || 'read';
    requestCountByOperationClass[operationClass] =
      (requestCountByOperationClass[operationClass] || 0) + 1;
  }
  const durations = events.map((event) => event.durationMs);
  return {
    requestCount: events.length,
    attemptCount: events.reduce((total, event) => total + event.attempts, 0),
    requestCountByCategory,
    requestCountByOperationClass,
    statusCounts,
    responseBytes: events.reduce((total, event) => total + event.responseBytes, 0),
    summedRequestDurationMs: durations.reduce((total, duration) => total + duration, 0),
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    retryCount: events.reduce((total, event) => total + event.retryCount, 0),
    rateLimitCount: events.filter((event) => event.rateLimited).length,
    tokenAcquisitionCount: events.reduce(
      (total, event) => total + event.tokenAcquisitionCount,
      0,
    ),
    tokenRefreshCount: events.reduce((total, event) => total + event.tokenRefreshCount, 0),
  };
}

function createPlanningTelemetryCollector({ nowIso = () => new Date().toISOString() } = {}) {
  const events = [];
  return {
    record(event) {
      events.push(sanitizeEvent(event, events.length + 1));
    },
    run(context = {}) {
      return {
        id: String(context.id || `snapshot-${events.length}`),
        purpose: String(context.purpose || 'foreground-planning'),
        generatedAt: nowIso(),
        environmentUrl: String(context.environmentUrl || '').replace(/\/+$/, ''),
        snapshotGeneratedAt: context.snapshotGeneratedAt || null,
        snapshotTimings: context.snapshotTimings || null,
        summary: summarizeEvents(events),
        events: events.map((event) => ({ ...event })),
      };
    },
  };
}

function appendPlanningTelemetry(file, run, fileSystem = fs) {
  const resolved = path.resolve(file);
  let artifact = { schemaVersion: 1, runs: [] };
  if (fileSystem.existsSync(resolved)) {
    artifact = JSON.parse(fileSystem.readFileSync(resolved, 'utf8'));
    if (artifact.schemaVersion !== 1 || !Array.isArray(artifact.runs)) {
      throw new Error('Dataverse planning telemetry artifact is invalid');
    }
  }
  artifact.runs.push(run);
  atomicWriteJson(resolved, artifact, fileSystem);
  return artifact;
}

module.exports = {
  appendPlanningTelemetry,
  atomicWriteJson,
  createPlanningTelemetryCollector,
  percentile,
  sanitizeEvent,
  summarizeEvents,
};