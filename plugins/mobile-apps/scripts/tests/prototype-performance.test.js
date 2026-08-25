'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  compilePerformanceEvidence,
  countPerformanceEvent,
  markPerformanceEvent,
} = require('../record-prototype-performance');

const goldenRoot = path.join(__dirname, 'fixtures', 'prototype-semantic');

function write(root, relativePath, value) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function project(context, withMetro = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-performance-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.tmp/planner-transport.json', { requestBytes: 12000, responseBytes: 48000, plannerAttempts: 1, plannerRepairAttempts: 0 });
  write(root, '.tmp/design-instruction-manifest.json', { mode: 'automatic-native', loadedFiles: ['dispatcher', 'automatic'], loadedBytes: 3200, modelCalls: 0, optionalReferencesLoaded: 0 });
  write(root, '.tmp/native-canary-validation.json', {
    valid: true, screenIds: ['home', 'detail'], validatedAt: '2026-08-25T00:00:04.000Z',
    sources: { home: { bytes: 1200 }, detail: { bytes: 1800 } },
  });
  if (withMetro) write(root, '.tmp/prototype-metro-evidence.json', {
    status: 'metro-ready', port: 8081, command: ['npm', 'run', 'dev'], readyAt: '2026-08-25T00:00:06.000Z', startupDurationMs: 500,
  });
  const phases = [
    ['workflow', 0, 6], ['planning', 0, 1], ['domain', 1, 3], ['design', 1, 2], ['canary', 3, 4], ['metro', 5, 6],
  ];
  for (const [phase, start, end] of phases) {
    markPerformanceEvent(root, phase, 'start', new Date(`2026-08-25T00:00:0${start}.000Z`));
    markPerformanceEvent(root, phase, 'end', new Date(`2026-08-25T00:00:0${end}.000Z`));
  }
  countPerformanceEvent(root, 'foregroundToolCalls', 17);
  return root;
}

test('performance evidence records planner, design, calls, phases, Home, and Metro-ready key flow', (context) => {
  const report = compilePerformanceEvidence(project(context));
  assert.equal(report.planner.responseBytes, 48000);
  assert.equal(report.planner.repairCount, 0);
  assert.equal(report.design.loadedBytes, 3200);
  assert.equal(report.design.optionalReferencesLoaded, 0);
  assert.equal(report.calls.modelCalls, 3);
  assert.equal(report.calls.foregroundToolCalls, 17);
  assert.equal(report.phaseDurationsMs.domain, 2000);
  assert.equal(report.timeToValidatedHomeMs, 4000);
  assert.equal(report.timeToMetroReadyKeyFlowMs, 6000);
  assert.equal(report.previewStatus, 'statically validated + Metro ready');
});

test('performance evidence reports truthful manual Metro status without discarding canary evidence', (context) => {
  const root = project(context, false);
  const report = compilePerformanceEvidence(root);
  assert.equal(report.metro, null);
  assert.equal(report.timeToMetroReadyKeyFlowMs, null);
  assert.equal(report.previewStatus, 'statically validated; manual Metro command required');
});

test('both golden apps record planner bytes and complete canary performance evidence', (context) => {
  for (const name of ['flight-shop.json', 'icrc-receiving.json']) {
    const golden = JSON.parse(fs.readFileSync(path.join(goldenRoot, name), 'utf8'));
    const root = project(context);
    const semanticBytes = Buffer.byteLength(JSON.stringify(golden.semanticPlan));
    write(root, '.tmp/planner-transport.json', { requestBytes: 16000, responseBytes: semanticBytes, plannerAttempts: 1, plannerRepairAttempts: 0 });
    const canaryIds = golden.semanticPlan.screens.criticalFlow.screenIds;
    write(root, '.tmp/native-canary-validation.json', {
      valid: true,
      screenIds: canaryIds,
      validatedAt: '2026-08-25T00:00:04.000Z',
      sources: Object.fromEntries(canaryIds.map((screenId) => [screenId, { bytes: 1000 }])),
    });
    const report = compilePerformanceEvidence(root);
    assert.equal(report.planner.responseBytes, semanticBytes, name);
    assert.deepEqual(report.canary.screenIds, canaryIds, name);
    assert.equal(report.canary.builderModelCalls, canaryIds.length, name);
    assert.equal(report.design.optionalReferencesLoaded, 0, name);
    assert.equal(report.timeToValidatedHomeMs, 4000, name);
    assert.equal(report.timeToMetroReadyKeyFlowMs, 6000, name);
  }
});
