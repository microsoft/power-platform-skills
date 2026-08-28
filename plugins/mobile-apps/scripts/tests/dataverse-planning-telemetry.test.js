'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  appendPlanningTelemetry,
  createPlanningTelemetryCollector,
  summarizeEvents,
} = require('../lib/dataverse-planning-telemetry');

test('telemetry collector serializes only the safe event allowlist', () => {
  const collector = createPlanningTelemetryCollector({
    nowIso: () => '2026-08-28T00:00:00.000Z',
  });
  collector.record({
    method: 'GET',
    category: 'attributes',
    table: 'new_item',
    metadataType: null,
    status: 200,
    durationMs: 12,
    responseBytes: 20,
    attempts: 2,
    retryCount: 1,
    rateLimited: false,
    tokenAcquisitionCount: 1,
    tokenRefreshCount: 1,
    operationClass: 'read',
    requestedTimeoutMs: 60000,
    token: 'must-not-serialize',
    authorization: 'must-not-serialize',
    responseBody: 'must-not-serialize',
  });
  const run = collector.run({
    id: 'test-run',
    environmentUrl: 'https://example.crm.dynamics.com/',
  });
  assert.equal(run.events.length, 1);
  assert.equal(run.summary.requestCount, 1);
  assert.equal(run.summary.attemptCount, 2);
  assert.equal(run.summary.retryCount, 1);
  assert.equal(run.events[0].operationClass, 'read');
  assert.equal(run.events[0].requestedTimeoutMs, 60000);
  assert.doesNotMatch(JSON.stringify(run), /must-not-serialize|authorization/i);
});

test('telemetry summary groups categories and computes observed percentiles', () => {
  const events = [10, 20, 30, 40, 100].map((durationMs, index) => ({
    category: index < 2 ? 'attributes' : 'typed-attribute-metadata',
    status: index === 4 ? 429 : 200,
    durationMs,
    responseBytes: 5,
    attempts: index === 4 ? 2 : 1,
    retryCount: index === 4 ? 1 : 0,
    rateLimited: index === 4,
    tokenAcquisitionCount: index === 0 ? 1 : 0,
    tokenRefreshCount: 0,
    operationClass: 'read',
    requestedTimeoutMs: 60000,
  }));
  assert.deepEqual(summarizeEvents(events), {
    requestCount: 5,
    attemptCount: 6,
    requestCountByCategory: { attributes: 2, 'typed-attribute-metadata': 3 },
    requestCountByOperationClass: { read: 5 },
    statusCounts: { 200: 4, 429: 1 },
    responseBytes: 25,
    summedRequestDurationMs: 200,
    p50DurationMs: 30,
    p95DurationMs: 40,
    retryCount: 1,
    rateLimitCount: 1,
    tokenAcquisitionCount: 1,
    tokenRefreshCount: 0,
  });
});

test('planning telemetry appends runs atomically', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-telemetry-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'telemetry.json');
  appendPlanningTelemetry(output, { id: 'one', summary: {}, events: [] });
  appendPlanningTelemetry(output, { id: 'two', summary: {}, events: [] });
  const artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(artifact.schemaVersion, 1);
  assert.deepEqual(artifact.runs.map((run) => run.id), ['one', 'two']);
  assert.equal(fs.readdirSync(directory).some((name) => name.includes('.tmp-')), false);
});