'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  estimate,
  planningWallMs,
  recordHistory,
} = require('../planning-eta');

test('planning ETA uses measured p50, p90, and last-run durations', () => {
  let history = { schemaVersion: 1, samples: [] };
  for (const durationMs of [180000, 120000, 300000, 240000]) {
    history = recordHistory(history, {
      environmentResolutionMs: durationMs,
    }, () => '2026-08-28T00:00:00.000Z');
  }
  assert.deepEqual(estimate(history), {
    sampleCount: 4,
    p50Ms: 180000,
    p90Ms: 300000,
    lastMs: 240000,
  });
});

test('planning wall time excludes user approval waiting', () => {
  assert.equal(planningWallMs({
    environmentResolutionMs: 10,
    dataverseMetadataNetworkMs: 20,
    outerPlannerWallMs: 1030,
    userApprovalWaitingMs: 1000,
    planRevisionMs: 500,
  }), 60);
});

test('planning wall time falls back to nested stages without double counting', () => {
  assert.equal(planningWallMs({
    environmentResolutionMs: 10,
    modelArchitectMs: 20,
    screenPlannerMs: 30,
    planRevisionMs: 40,
    userApprovalWaitingMs: 999,
  }), 100);
});

test('degraded planner attempts include subsequent inline planning work', () => {
  assert.equal(planningWallMs({
    outerPlannerWallMs: 10,
    nativePlannerStatus: 'failed',
    nativePlannerApprovalWaitingMs: 3,
    postPlannerModelArchitectMs: 20,
    postPlannerScreenPlannerMs: 30,
    postPlannerRevisionMs: 40,
    modelArchitectMs: 200,
    screenPlannerMs: 300,
    planRevisionMs: 400,
    userApprovalWaitingMs: 999,
  }), 97);
});
