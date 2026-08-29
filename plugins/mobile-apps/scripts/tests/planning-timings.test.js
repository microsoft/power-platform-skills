'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  recordAgentExecutionMetrics,
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
      nativePlanner: {
        status: 'failed',
        retryCount: 1,
        needsContextCount: 1,
        history: [{ durationMs: 100 }],
      },
      modelArchitect: { history: [{ durationMs: 50 }] },
      screenPlanner: { history: [{ durationMs: 25 }, { durationMs: 30 }] },
      artifactValidation: { history: [{ durationMs: 2 }] },
      userApproval: { history: [{ durationMs: 60 }] },
    },
  };
  assert.deepEqual(summarizePlanningTimings(artifact), {
    environmentResolutionMs: 0,
    publisherPrefixDetectionMs: 0,
    dataverseMetadataNetworkMs: 70,
    localDeterministicProcessingMs: 5,
    outerPlannerWallMs: 100,
    nativePlannerStatus: 'failed',
    nativePlannerApprovalWaitingMs: 0,
    modelArchitectMs: 50,
    screenPlannerMs: 55,
    planRevisionMs: 0,
    postPlannerModelArchitectMs: 0,
    postPlannerScreenPlannerMs: 0,
    postPlannerRevisionMs: 0,
    userApprovalWaitingMs: 60,
    executionMode: null,
    agentDispatchCount: 0,
    agentRetryCount: 0,
    agentToolCallCount: 0,
    foregroundMaterializationMs: 0,
    foregroundValidationMs: 0,
    retries: { nativePlanner: 1 },
    needsContext: { nativePlanner: 1 },
  });
});

test('planning timing records return-only execution metrics', () => {
  const artifact = { schemaVersion: 1, stages: {} };
  recordAgentExecutionMetrics(artifact, {
    executionMode: 'parallel-return',
    agentDispatchCount: 3,
    agentRetryCount: 1,
    agentToolCallCount: 0,
    foregroundMaterializationMs: 12.5,
    foregroundValidationMs: 8,
  });
  recordAgentExecutionMetrics(artifact, {
    executionMode: 'parallel-return',
    agentDispatchCount: 2,
    foregroundMaterializationMs: 4.5,
    foregroundValidationMs: 2,
  });
  const summary = summarizePlanningTimings(artifact);
  assert.equal(summary.executionMode, 'parallel-return');
  assert.equal(summary.agentDispatchCount, 5);
  assert.equal(summary.agentRetryCount, 1);
  assert.equal(summary.agentToolCallCount, 0);
  assert.equal(summary.foregroundMaterializationMs, 17);
  assert.equal(summary.foregroundValidationMs, 10);
  assert.throws(() => recordAgentExecutionMetrics(artifact, {
    executionMode: 'parallel-return',
    agentToolCallCount: 1,
  }), /must have agentToolCallCount 0/);
});

test('planning timing separates nested planner work from post-failure fallback work', () => {
  const artifact = {
    schemaVersion: 1,
    stages: {
      nativePlanner: {
        status: 'failed',
        history: [{
          startedAt: '2026-08-28T00:00:00.000Z',
          completedAt: '2026-08-28T00:00:01.000Z',
          durationMs: 1000,
        }],
      },
      modelArchitect: {
        history: [
          {
            startedAt: '2026-08-28T00:00:00.100Z',
            completedAt: '2026-08-28T00:00:00.500Z',
            durationMs: 400,
          },
          {
            startedAt: '2026-08-28T00:00:01.100Z',
            completedAt: '2026-08-28T00:00:01.300Z',
            durationMs: 200,
          },
        ],
      },
      screenPlanner: {
        history: [{
          startedAt: '2026-08-28T00:00:01.300Z',
          completedAt: '2026-08-28T00:00:01.600Z',
          durationMs: 300,
        }],
      },
      userApproval: {
        history: [{
          startedAt: '2026-08-28T00:00:00.600Z',
          completedAt: '2026-08-28T00:00:00.800Z',
          durationMs: 200,
        }],
      },
    },
  };
  const summary = summarizePlanningTimings(artifact);
  assert.equal(summary.nativePlannerApprovalWaitingMs, 200);
  assert.equal(summary.postPlannerModelArchitectMs, 200);
  assert.equal(summary.postPlannerScreenPlannerMs, 300);
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