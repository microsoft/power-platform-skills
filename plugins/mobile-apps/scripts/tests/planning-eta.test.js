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
      foregroundPlanningMs: durationMs,
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
    foregroundPlanningMs: 30,
    userApprovalWaitingMs: 1000,
  }), 30);
});

test('planning history does not add diagnostic foreground sub-stages twice', () => {
  assert.equal(planningWallMs({
    foregroundPlanningMs: 100,
    requirementsPlanningMs: 20,
    dataModelPlanningMs: 30,
    journeyPackPlanningMs: 40,
    userApprovalWaitingMs: 999,
  }), 100);
});

test('screen build channels do not inflate the planning ETA history', () => {
  assert.equal(planningWallMs({
    foregroundPlanningMs: 97,
    screenBuildDirectWriteMs: 200,
    screenBuildReturnOnlyMs: 300,
    screenBuildForegroundMs: 400,
    userApprovalWaitingMs: 999,
  }), 97);
});
