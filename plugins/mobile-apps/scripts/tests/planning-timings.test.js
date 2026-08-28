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
    stage: 'nativePlanner', action: 'start', ...clock(['start-1'], [10]),
  });
  updatePlanningTiming(artifact, {
    stage: 'nativePlanner', action: 'needs-context', reason: 'detailed metadata',
    ...clock(['end-1'], [20]),
  });
  updatePlanningTiming(artifact, {
    stage: 'nativePlanner', action: 'start', retry: true, ...clock(['start-2'], [30]),
  });
  updatePlanningTiming(artifact, {
    stage: 'nativePlanner', action: 'finish', ...clock(['end-2'], [50]),
  });
  assert.equal(artifact.stages.nativePlanner.attempts, 2);
  assert.deepEqual(
    artifact.stages.nativePlanner.history.map((entry) => entry.status),
    ['needs-context', 'done'],
  );
  assert.equal(artifact.stages.nativePlanner.history[0].reason, 'detailed metadata');
  assert.equal(artifact.stages.nativePlanner.retryCount, 1);
  assert.equal(artifact.stages.nativePlanner.needsContextCount, 1);
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
    stage: 'modelArchitect', action: 'start', ...clock(['start'], [10]),
  });
  updatePlanningTiming(artifact, {
    stage: 'modelArchitect', action: 'finish', tokenCount: '1200', costUsd: '0.08',
    ...clock(['end'], [20]),
  });
  assert.deepEqual(artifact.stages.modelArchitect.modelUsage, {
    tokenCount: 1200,
    costUsd: 0.08,
  });
  assert.equal(artifact.stages.metadataDetailLoading, undefined);
});

test('planning timing upgrades earlier schema-v1 stages with explicit counters', () => {
  const artifact = {
    schemaVersion: 1,
    stages: { nativePlanner: { attempts: 1, history: [] } },
  };
  updatePlanningTiming(artifact, {
    stage: 'nativePlanner', action: 'start', ...clock(['start'], [10]),
  });
  updatePlanningTiming(artifact, {
    stage: 'nativePlanner', action: 'finish', ...clock(['end'], [20]),
  });
  assert.equal(artifact.stages.nativePlanner.retryCount, 0);
  assert.equal(artifact.stages.nativePlanner.needsContextCount, 0);
});

test('planning timing summary keeps outer wall, model, and approval durations separate', () => {
  const artifact = {
    schemaVersion: 1,
    stages: {
      metadataInventory: { history: [{ durationMs: 20 }] },
      metadataCandidateSelection: { history: [{ durationMs: 3 }] },
      metadataDetailLoading: { history: [{ durationMs: 40 }] },
      metadataExpansion: { history: [{ durationMs: 10 }] },
      nativePlanner: { retryCount: 1, needsContextCount: 1, history: [{ durationMs: 100 }] },
      modelArchitect: { history: [{ durationMs: 50 }] },
      screenPlanner: { history: [{ durationMs: 25 }, { durationMs: 30 }] },
      artifactValidation: { history: [{ durationMs: 2 }] },
      userApproval: { history: [{ durationMs: 60 }] },
    },
  };
  assert.deepEqual(summarizePlanningTimings(artifact), {
    environmentResolutionMs: 0,
    publisherPrefixDetectionMs: 0,
    planningInventoryMs: 20,
    planningCandidateSelectionMs: 3,
    planningDetailLoadingMs: 40,
    planningExpansionMs: 10,
    architectEvidenceRenderMs: 2,
    executionReconciliationMs: 0,
    manifestBuildValidationMs: 0,
    metadataWriteMs: 0,
    publishMs: 0,
    uncertainRecoveryMs: 0,
    collisionAdaptationMs: 0,
    postPublishVerificationMs: 0,
    approvalWaitingMs: 60,
    dataverseMetadataNetworkMs: 70,
    localDeterministicProcessingMs: 5,
    outerPlannerWallMs: 100,
    modelArchitectMs: 50,
    screenPlannerMs: 55,
    planRevisionMs: 0,
    userApprovalWaitingMs: 60,
    retries: { nativePlanner: 1 },
    needsContext: { nativePlanner: 1 },
  });
});

test('planning timing summary keeps Dataverse execution phases separate', () => {
  const artifact = {
    schemaVersion: 1,
    stages: {
      executionReconciliation: { history: [{ durationMs: 11 }] },
      manifestBuildValidation: { history: [{ durationMs: 7 }] },
      metadataWrite: { history: [{ durationMs: 30 }, { durationMs: 5 }] },
      publish: { history: [{ durationMs: 13 }] },
      uncertainRecovery: { history: [{ durationMs: 17 }] },
      collisionAdaptation: { history: [{ durationMs: 19 }] },
      postPublishVerification: { history: [{ durationMs: 23 }] },
    },
  };
  const summary = summarizePlanningTimings(artifact);
  assert.equal(summary.executionReconciliationMs, 11);
  assert.equal(summary.manifestBuildValidationMs, 7);
  assert.equal(summary.metadataWriteMs, 35);
  assert.equal(summary.publishMs, 13);
  assert.equal(summary.uncertainRecoveryMs, 17);
  assert.equal(summary.collisionAdaptationMs, 19);
  assert.equal(summary.postPublishVerificationMs, 23);
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
      stage: 'screenPlanner', action: 'finish', nowMs: () => 2, nowIso: () => 'end',
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