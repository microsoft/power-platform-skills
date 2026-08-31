'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  summarizePlanningTimings,
  updatePlanningTiming,
} = require('../planning-timings');
const { appendSnapshotPlanningTimings } = require('../create-dataverse-snapshot');

function clock(isoValues, milliseconds) {
  let isoIndex = 0;
  let millisecondIndex = 0;
  return {
    nowIso: () => isoValues[isoIndex++],
    nowMs: () => milliseconds[millisecondIndex++],
  };
}

test('planning timing records completed attempts and duration', () => {
  const artifact = { schemaVersion: 1, stages: {} };
  updatePlanningTiming(artifact, {
    stage: 'metadataInventory',
    action: 'start',
    ...clock(['2026-08-28T00:00:00.000Z'], [100]),
  });
  updatePlanningTiming(artifact, {
    stage: 'metadataInventory',
    action: 'finish',
    ...clock(['2026-08-28T00:00:01.250Z'], [1350]),
  });
  assert.equal(artifact.stages.metadataInventory.attempts, 1);
  assert.equal(artifact.stages.metadataInventory.durationMs, 1250);
  assert.equal(artifact.stages.metadataInventory.status, 'done');
  assert.equal(artifact.stages.metadataInventory.history.length, 1);
});

test('planning timing preserves failed attempt history across retry', () => {
  const artifact = { schemaVersion: 1, stages: {} };
  updatePlanningTiming(artifact, {
    stage: 'journeyPackPlanning', action: 'start', ...clock(['start-1'], [10]),
  });
  updatePlanningTiming(artifact, {
    stage: 'journeyPackPlanning', action: 'needs-context', reason: 'missing route contract',
    ...clock(['end-1'], [20]),
  });
  updatePlanningTiming(artifact, {
    stage: 'journeyPackPlanning', action: 'start', retry: true, ...clock(['start-2'], [30]),
  });
  updatePlanningTiming(artifact, {
    stage: 'journeyPackPlanning', action: 'finish', ...clock(['end-2'], [50]),
  });
  assert.equal(artifact.stages.journeyPackPlanning.attempts, 2);
  assert.deepEqual(
    artifact.stages.journeyPackPlanning.history.map((entry) => entry.status),
    ['needs-context', 'done'],
  );
  assert.equal(artifact.stages.journeyPackPlanning.history[0].reason, 'missing route contract');
  assert.equal(artifact.stages.journeyPackPlanning.retryCount, 1);
  assert.equal(artifact.stages.journeyPackPlanning.needsContextCount, 1);
});

test('planning timing records snapshot-measured durations without a synthetic start', () => {
  const artifact = { schemaVersion: 1, stages: {} };
  updatePlanningTiming(artifact, {
    stage: 'metadataDetailLoading',
    action: 'record',
    durationMs: '412.5',
    ...clock(['2026-08-28T00:00:01.000Z'], [1000]),
  });
  assert.equal(artifact.stages.metadataDetailLoading.durationMs, 412.5);
  assert.equal(artifact.stages.metadataDetailLoading.status, 'done');
  assert.equal(artifact.stages.metadataDetailLoading.startedAt, '1970-01-01T00:00:00.587Z');
});

test('planning timing records optional model usage only when supplied', () => {
  const artifact = { schemaVersion: 1, stages: {} };
  updatePlanningTiming(artifact, {
    stage: 'screenBuildReturnOnly', action: 'start', ...clock(['start'], [10]),
  });
  updatePlanningTiming(artifact, {
    stage: 'screenBuildReturnOnly', action: 'finish', tokenCount: '1200', costUsd: '0.08',
    ...clock(['end'], [20]),
  });
  assert.deepEqual(artifact.stages.screenBuildReturnOnly.modelUsage, {
    tokenCount: 1200,
    costUsd: 0.08,
  });
  assert.equal(artifact.stages.metadataDetailLoading, undefined);
});

test('planning timing upgrades earlier schema-v1 stages with explicit counters', () => {
  const artifact = {
    schemaVersion: 1,
    stages: { foregroundPlanning: { attempts: 1, history: [] } },
  };
  updatePlanningTiming(artifact, {
    stage: 'foregroundPlanning', action: 'start', ...clock(['start'], [10]),
  });
  updatePlanningTiming(artifact, {
    stage: 'foregroundPlanning', action: 'finish', ...clock(['end'], [20]),
  });
  assert.equal(artifact.stages.foregroundPlanning.retryCount, 0);
  assert.equal(artifact.stages.foregroundPlanning.needsContextCount, 0);
});

test('timing summary keeps foreground planning, approval, and screen channels separate', () => {
  const artifact = {
    schemaVersion: 1,
    stages: {
      environmentResolution: { history: [{ durationMs: 5 }] },
      metadataInventory: { history: [{ durationMs: 20 }] },
      metadataCandidateSelection: { history: [{ durationMs: 3 }] },
      metadataDetailLoading: { history: [{ durationMs: 40 }] },
      metadataExpansion: { history: [{ durationMs: 10 }] },
      foregroundPlanning: {
        status: 'done',
        retryCount: 1,
        needsContextCount: 1,
        history: [{
          startedAt: '2026-08-28T00:00:00.000Z',
          completedAt: '2026-08-28T00:00:00.100Z',
          durationMs: 100,
        }],
      },
      requirementsPlanning: { history: [{ durationMs: 8 }] },
      experienceScopePlanning: { history: [{ durationMs: 12 }] },
      dataModelPlanning: { history: [{ durationMs: 20 }] },
      capabilityConnectorPlanning: { history: [{ durationMs: 7 }] },
      journeyPackPlanning: { history: [{ durationMs: 18 }] },
      planRendering: { history: [{ durationMs: 4 }] },
      designMaterialization: { history: [{ durationMs: 6 }] },
      artifactValidation: { history: [{ durationMs: 2 }] },
      planRepair: { history: [{ durationMs: 3 }] },
      userApproval: { history: [
        {
          startedAt: '2026-08-28T00:00:00.020Z',
          completedAt: '2026-08-28T00:00:00.040Z',
          durationMs: 20,
        },
        { durationMs: 40 },
      ] },
      screenBuildDirectWrite: { history: [{ durationMs: 50 }] },
      screenBuildReturnOnly: { history: [{ durationMs: 25 }, { durationMs: 30 }] },
      screenBuildForeground: { history: [{ durationMs: 10 }] },
      screenValidation: { history: [{ durationMs: 15 }] },
    },
  };
  assert.deepEqual(summarizePlanningTimings(artifact), {
    environmentResolutionMs: 5,
    publisherPrefixDetectionMs: 0,
    dataverseMetadataNetworkMs: 70,
    localDeterministicProcessingMs: 5,
    foregroundPlanningWallMs: 100,
    foregroundPlanningStatus: 'done',
    foregroundPlanningApprovalWaitingMs: 20,
    foregroundPlanningMs: 80,
    requirementsPlanningMs: 8,
    experienceScopePlanningMs: 12,
    dataModelPlanningMs: 20,
    capabilityConnectorPlanningMs: 7,
    journeyPackPlanningMs: 18,
    planRenderingMs: 4,
    designMaterializationMs: 6,
    planRepairMs: 3,
    screenBuildDirectWriteMs: 50,
    screenBuildReturnOnlyMs: 55,
    screenBuildForegroundMs: 10,
    screenBuildMs: 115,
    screenBuildAttemptsByChannel: { directWrite: 1, returnOnly: 2, foreground: 1 },
    screenValidationMs: 15,
    userApprovalWaitingMs: 60,
    totalExecutionMs: 210,
    totalMeasuredMs: 270,
    retries: { foregroundPlanning: 1 },
    needsContext: { foregroundPlanning: 1 },
  });
});

test('timing summary falls back to additive foreground stages when no wall is recorded', () => {
  const artifact = {
    schemaVersion: 1,
    stages: {
      environmentResolution: { history: [{ durationMs: 10 }] },
      metadataInventory: { history: [{ durationMs: 20 }] },
      metadataCandidateSelection: { history: [{ durationMs: 3 }] },
      artifactValidation: { history: [{ durationMs: 2 }] },
      requirementsPlanning: { history: [{ durationMs: 5 }] },
      planRepair: { history: [{ durationMs: 4 }] },
      userApproval: { history: [{ durationMs: 999 }] },
    },
  };
  const summary = summarizePlanningTimings(artifact);
  assert.equal(summary.foregroundPlanningWallMs, 0);
  assert.equal(summary.foregroundPlanningMs, 44);
  assert.equal(summary.userApprovalWaitingMs, 999);
  assert.equal(summary.totalExecutionMs, 44);
});

test('snapshot timings record initial stages and bounded expansion separately', () => {
  const writes = new Map();
  const fileSystem = {
    existsSync: (file) => writes.has(file),
    readFileSync: (file) => writes.get(file),
    mkdirSync: () => {},
    writeFileSync: (file, content) => writes.set(file, content),
    renameSync: (from, to) => {
      writes.set(to, writes.get(from));
      writes.delete(from);
    },
    rmSync: (file) => writes.delete(file),
  };
  const file = '/virtual/timings.json';
  appendSnapshotPlanningTimings(file, {
    timings: {
      inventoryRetrievalMs: 20,
      candidateSelectionMs: 3,
      detailLoadingMs: 40,
      totalDurationMs: 63,
    },
  }, fileSystem);
  const initial = JSON.parse(writes.get(file));
  assert.equal(initial.stages.metadataInventory.durationMs, 20);
  assert.equal(initial.stages.metadataCandidateSelection.durationMs, 3);
  assert.equal(initial.stages.metadataDetailLoading.durationMs, 40);

  appendSnapshotPlanningTimings(file, {
    expansion: { requestedTables: ['new_item'] },
    timings: {
      inventoryRetrievalMs: 2,
      candidateSelectionMs: 0,
      detailLoadingMs: 8,
      totalDurationMs: 10,
    },
  }, fileSystem);
  const expanded = JSON.parse(writes.get(file));
  assert.equal(expanded.stages.metadataExpansion.durationMs, 10);
  assert.equal(expanded.stages.metadataInventory.history.length, 1);
});

test('planning timing rejects unknown stages and completion without start', () => {
  const artifact = { schemaVersion: 1, stages: {} };
  assert.throws(
    () => updatePlanningTiming(artifact, { stage: 'unknown', action: 'start' }),
    /Unknown planning stage/,
  );
  assert.throws(
    () => updatePlanningTiming(artifact, {
      stage: 'screenBuildDirectWrite', action: 'finish', nowMs: () => 2, nowIso: () => 'end',
    }),
    /must be started/,
  );
  assert.throws(
    () => updatePlanningTiming(artifact, {
      stage: 'metadataInventory', action: 'record', durationMs: -1,
    }),
    /non-negative number/,
  );
});