#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./lib/dataverse-planning-telemetry');

const STAGES = new Set([
  'environmentResolution',
  'publisherPrefixDetection',
  'metadataInventory',
  'metadataCandidateSelection',
  'metadataDetailLoading',
  'metadataExpansion',
  'nativePlanner',
  'modelArchitect',
  'screenPlanner',
  'artifactValidation',
  'planRevision',
  'userApproval',
]);
const EXECUTION_MODES = new Set(['parallel-return', 'foreground-return']);

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--stage') args.stage = argv[++index];
    else if (argv[index] === '--action') args.action = argv[++index];
    else if (argv[index] === '--reason') args.reason = argv[++index];
    else if (argv[index] === '--duration-ms') args.durationMs = argv[++index];
    else if (argv[index] === '--token-count') args.tokenCount = argv[++index];
    else if (argv[index] === '--cost-usd') args.costUsd = argv[++index];
    else if (argv[index] === '--retry') args.retry = true;
    else if (argv[index] === '--record-agent-execution') args.recordAgentExecution = true;
    else if (argv[index] === '--execution-mode') args.executionMode = argv[++index];
    else if (argv[index] === '--agent-dispatch-count') args.agentDispatchCount = argv[++index];
    else if (argv[index] === '--agent-retry-count') args.agentRetryCount = argv[++index];
    else if (argv[index] === '--agent-tool-call-count') args.agentToolCallCount = argv[++index];
    else if (argv[index] === '--request-payload-bytes') args.requestPayloadBytes = argv[++index];
    else if (argv[index] === '--response-payload-bytes') args.responsePayloadBytes = argv[++index];
    else if (argv[index] === '--work-order-count') args.workOrderCount = argv[++index];
    else if (argv[index] === '--detail-partition-count') args.detailPartitionCount = argv[++index];
    else if (argv[index] === '--completed-work-order-count') {
      args.completedWorkOrderCount = argv[++index];
    } else if (argv[index] === '--resumed-work-order-count') {
      args.resumedWorkOrderCount = argv[++index];
    }
    else if (argv[index] === '--foreground-materialization-ms') {
      args.foregroundMaterializationMs = argv[++index];
    } else if (argv[index] === '--foreground-validation-ms') {
      args.foregroundValidationMs = argv[++index];
    }
    else if (argv[index] === '--summary') args.summary = true;
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function nonNegativeNumber(value, label, { integer = false } = {}) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
  return parsed;
}

function recordAgentExecutionMetrics(artifact, {
  executionMode,
  agentDispatchCount = 0,
  agentRetryCount = 0,
  agentToolCallCount = 0,
  requestPayloadBytes = 0,
  responsePayloadBytes = 0,
  workOrderCount = 0,
  detailPartitionCount = 0,
  completedWorkOrderCount = 0,
  resumedWorkOrderCount = 0,
  foregroundMaterializationMs = 0,
  foregroundValidationMs = 0,
}) {
  if (!EXECUTION_MODES.has(executionMode)) {
    throw new Error(`Unknown agent execution mode: ${executionMode}`);
  }
  const toolCallCount = nonNegativeNumber(
    agentToolCallCount,
    'agentToolCallCount',
    { integer: true },
  );
  if (toolCallCount !== 0) {
    throw new Error('converted return-only agents must have agentToolCallCount 0');
  }
  const previous = artifact.agentExecution || {
    executionMode,
    agentDispatchCount: 0,
    agentDispatchesByMode: {
      'parallel-return': 0,
      'foreground-return': 0,
    },
    agentRetryCount: 0,
    agentToolCallCount: 0,
    requestPayloadBytes: 0,
    responsePayloadBytes: 0,
    workOrderCount: 0,
    detailPartitionCount: 0,
    completedWorkOrderCount: 0,
    resumedWorkOrderCount: 0,
    foregroundMaterializationMs: 0,
    foregroundValidationMs: 0,
  };
  const dispatchCount = nonNegativeNumber(
    agentDispatchCount,
    'agentDispatchCount',
    { integer: true },
  );
  const priorDispatchesByMode = {
    'parallel-return': previous.agentDispatchesByMode?.['parallel-return']
      ?? (previous.executionMode === 'parallel-return' ? previous.agentDispatchCount : 0),
    'foreground-return': previous.agentDispatchesByMode?.['foreground-return']
      ?? (previous.executionMode === 'foreground-return' ? previous.agentDispatchCount : 0),
  };
  // A host can remain parallel-capable while one exhausted work order falls
  // back to foreground execution, so preserve both channel counts truthfully.
  artifact.agentExecution = {
    executionMode: previous.executionMode === executionMode
      ? executionMode
      : 'mixed-return',
    agentDispatchCount: previous.agentDispatchCount + dispatchCount,
    agentDispatchesByMode: {
      ...priorDispatchesByMode,
      [executionMode]: priorDispatchesByMode[executionMode] + dispatchCount,
    },
    agentRetryCount: previous.agentRetryCount + nonNegativeNumber(
      agentRetryCount,
      'agentRetryCount',
      { integer: true },
    ),
    agentToolCallCount: 0,
    requestPayloadBytes: (previous.requestPayloadBytes || 0) + nonNegativeNumber(
      requestPayloadBytes,
      'requestPayloadBytes',
      { integer: true },
    ),
    responsePayloadBytes: (previous.responsePayloadBytes || 0) + nonNegativeNumber(
      responsePayloadBytes,
      'responsePayloadBytes',
      { integer: true },
    ),
    workOrderCount: (previous.workOrderCount || 0) + nonNegativeNumber(
      workOrderCount,
      'workOrderCount',
      { integer: true },
    ),
    detailPartitionCount: (previous.detailPartitionCount || 0) + nonNegativeNumber(
      detailPartitionCount,
      'detailPartitionCount',
      { integer: true },
    ),
    completedWorkOrderCount: (previous.completedWorkOrderCount || 0) + nonNegativeNumber(
      completedWorkOrderCount,
      'completedWorkOrderCount',
      { integer: true },
    ),
    resumedWorkOrderCount: (previous.resumedWorkOrderCount || 0) + nonNegativeNumber(
      resumedWorkOrderCount,
      'resumedWorkOrderCount',
      { integer: true },
    ),
    foregroundMaterializationMs: previous.foregroundMaterializationMs + nonNegativeNumber(
      foregroundMaterializationMs,
      'foregroundMaterializationMs',
    ),
    foregroundValidationMs: previous.foregroundValidationMs + nonNegativeNumber(
      foregroundValidationMs,
      'foregroundValidationMs',
    ),
  };
  return artifact;
}

function readArtifact(file, fileSystem = fs) {
  if (!fileSystem.existsSync(file)) return { schemaVersion: 1, stages: {} };
  const artifact = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
  if (artifact.schemaVersion !== 1 || !artifact.stages || Array.isArray(artifact.stages)) {
    throw new Error('Planning timing artifact is invalid');
  }
  return artifact;
}

function updatePlanningTiming(artifact, {
  stage,
  action,
  reason = null,
  durationMs = null,
  tokenCount = null,
  costUsd = null,
  retry = false,
  nowIso = () => new Date().toISOString(),
  nowMs = () => Date.now(),
}) {
  if (!STAGES.has(stage)) throw new Error(`Unknown planning stage: ${stage}`);
  if (!['start', 'finish', 'fail', 'needs-context', 'record'].includes(action)) {
    throw new Error(`Unknown planning timing action: ${action}`);
  }
  const current = artifact.stages[stage] || {
    attempts: 0,
    retryCount: 0,
    needsContextCount: 0,
    history: [],
  };
  current.retryCount = Number.isInteger(current.retryCount)
    ? current.retryCount
    : 0;
  current.needsContextCount = Number.isInteger(current.needsContextCount)
    ? current.needsContextCount
    : 0;
  if (action === 'start') {
    current.attempts += 1;
    if (retry) current.retryCount += 1;
    current.startedAt = nowIso();
    current.startedAtMs = nowMs();
    current.completedAt = null;
    current.durationMs = null;
    current.status = 'in-progress';
    current.reason = null;
  } else if (action === 'record') {
    if (current.status === 'in-progress') {
      throw new Error(`Planning stage ${stage} cannot record over an in-progress attempt`);
    }
    const measuredDurationMs = Number(durationMs);
    if (!Number.isFinite(measuredDurationMs) || measuredDurationMs < 0) {
      throw new Error('Recorded planning duration must be a non-negative number');
    }
    const completedAtMs = nowMs();
    const completedAt = nowIso();
    current.attempts += 1;
    const result = {
      attempt: current.attempts,
      startedAt: new Date(completedAtMs - measuredDurationMs).toISOString(),
      completedAt,
      durationMs: measuredDurationMs,
      status: 'done',
      reason: null,
    };
    current.history.push(result);
    Object.assign(current, result);
  } else {
    if (current.status !== 'in-progress' || !Number.isFinite(current.startedAtMs)) {
      throw new Error(`Planning stage ${stage} must be started before ${action}`);
    }
    const completedAtMs = nowMs();
    const completedAt = nowIso();
    const result = {
      attempt: current.attempts,
      startedAt: current.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAtMs - current.startedAtMs),
      status: action === 'finish' ? 'done' : action === 'needs-context'
        ? 'needs-context' : 'failed',
      reason: action === 'finish' ? null : String(reason || 'unspecified failure'),
    };
    if (action === 'needs-context') current.needsContextCount += 1;
    const parsedTokenCount = tokenCount == null ? null : Number(tokenCount);
    const parsedCostUsd = costUsd == null ? null : Number(costUsd);
    if (parsedTokenCount != null || parsedCostUsd != null) {
      if ((parsedTokenCount != null && (!Number.isFinite(parsedTokenCount) || parsedTokenCount < 0))
        || (parsedCostUsd != null && (!Number.isFinite(parsedCostUsd) || parsedCostUsd < 0))) {
        throw new Error('Model usage values must be non-negative numbers');
      }
      result.modelUsage = {
        ...(parsedTokenCount == null ? {} : { tokenCount: parsedTokenCount }),
        ...(parsedCostUsd == null ? {} : { costUsd: parsedCostUsd }),
      };
    }
    current.history.push(result);
    Object.assign(current, result);
    delete current.startedAtMs;
  }
  artifact.stages[stage] = current;
  return artifact;
}

function stageDuration(artifact, stage) {
  const history = artifact.stages?.[stage]?.history || [];
  return history.reduce(
    (total, attempt) => total + (Number.isFinite(attempt.durationMs) ? attempt.durationMs : 0),
    0,
  );
}

function parsedInterval(attempt) {
  const start = Date.parse(attempt.startedAt);
  const end = Date.parse(attempt.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

function latestStageCompletion(artifact, stage) {
  return (artifact.stages?.[stage]?.history || [])
    .map(parsedInterval)
    .filter(Boolean)
    .reduce((latest, interval) => Math.max(latest, interval.end), -Infinity);
}

function stageDurationStartingAtOrAfter(artifact, stage, cutoff) {
  if (!Number.isFinite(cutoff)) return 0;
  return (artifact.stages?.[stage]?.history || []).reduce((total, attempt) => {
    const interval = parsedInterval(attempt);
    return interval && interval.start >= cutoff
      ? total + (Number.isFinite(attempt.durationMs) ? attempt.durationMs : 0)
      : total;
  }, 0);
}

function stageOverlapDuration(artifact, stage, containerStage) {
  const containers = (artifact.stages?.[containerStage]?.history || [])
    .map(parsedInterval)
    .filter(Boolean);
  return (artifact.stages?.[stage]?.history || []).reduce((total, attempt) => {
    const interval = parsedInterval(attempt);
    if (!interval) return total;
    return total + containers.reduce(
      (overlap, container) => overlap
        + Math.max(0, Math.min(interval.end, container.end) - Math.max(interval.start, container.start)),
      0,
    );
  }, 0);
}

function summarizePlanningTimings(artifact) {
  const plannerCompletion = latestStageCompletion(artifact, 'nativePlanner');
  const agentExecution = artifact.agentExecution || {};
  return {
    environmentResolutionMs: stageDuration(artifact, 'environmentResolution'),
    publisherPrefixDetectionMs: stageDuration(artifact, 'publisherPrefixDetection'),
    dataverseMetadataNetworkMs: stageDuration(artifact, 'metadataInventory')
      + stageDuration(artifact, 'metadataDetailLoading')
      + stageDuration(artifact, 'metadataExpansion'),
    localDeterministicProcessingMs: stageDuration(artifact, 'metadataCandidateSelection')
      + stageDuration(artifact, 'artifactValidation'),
    outerPlannerWallMs: stageDuration(artifact, 'nativePlanner'),
    nativePlannerStatus: artifact.stages?.nativePlanner?.status || null,
    nativePlannerApprovalWaitingMs: stageOverlapDuration(
      artifact,
      'userApproval',
      'nativePlanner',
    ),
    modelArchitectMs: stageDuration(artifact, 'modelArchitect'),
    screenPlannerMs: stageDuration(artifact, 'screenPlanner'),
    planRevisionMs: stageDuration(artifact, 'planRevision'),
    postPlannerModelArchitectMs: stageDurationStartingAtOrAfter(
      artifact,
      'modelArchitect',
      plannerCompletion,
    ),
    postPlannerScreenPlannerMs: stageDurationStartingAtOrAfter(
      artifact,
      'screenPlanner',
      plannerCompletion,
    ),
    postPlannerRevisionMs: stageDurationStartingAtOrAfter(
      artifact,
      'planRevision',
      plannerCompletion,
    ),
    userApprovalWaitingMs: stageDuration(artifact, 'userApproval'),
    executionMode: agentExecution.executionMode || null,
    agentDispatchCount: agentExecution.agentDispatchCount || 0,
    agentDispatchesByMode: agentExecution.agentDispatchesByMode || {
      'parallel-return': 0,
      'foreground-return': 0,
    },
    agentRetryCount: agentExecution.agentRetryCount || 0,
    agentToolCallCount: agentExecution.agentToolCallCount || 0,
    requestPayloadBytes: agentExecution.requestPayloadBytes || 0,
    responsePayloadBytes: agentExecution.responsePayloadBytes || 0,
    workOrderCount: agentExecution.workOrderCount || 0,
    detailPartitionCount: agentExecution.detailPartitionCount || 0,
    completedWorkOrderCount: agentExecution.completedWorkOrderCount || 0,
    resumedWorkOrderCount: agentExecution.resumedWorkOrderCount || 0,
    foregroundMaterializationMs: agentExecution.foregroundMaterializationMs || 0,
    foregroundValidationMs: agentExecution.foregroundValidationMs || 0,
    retries: Object.fromEntries(Object.entries(artifact.stages || {})
      .filter(([, value]) => Number(value.retryCount || 0) > 0)
      .map(([stage, value]) => [stage, value.retryCount])),
    needsContext: Object.fromEntries(Object.entries(artifact.stages || {})
      .filter(([, value]) => Number(value.needsContextCount || 0) > 0)
      .map(([stage, value]) => [stage, value.needsContextCount])),
  };
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.projectRoot && args.summary) {
    try {
      const root = path.resolve(args.projectRoot);
      const output = path.resolve(root, args.output || '.tmp/mobile-planning-timings.json');
      process.stdout.write(`${JSON.stringify(summarizePlanningTimings(readArtifact(output)), null, 2)}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`planning-timings: ${error.message}\n`);
      return 2;
    }
  }
  if (args.projectRoot && args.recordAgentExecution) {
    try {
      const root = path.resolve(args.projectRoot);
      const output = path.resolve(root, args.output || '.tmp/mobile-planning-timings.json');
      const artifact = recordAgentExecutionMetrics(readArtifact(output), args);
      atomicWriteJson(output, artifact);
      if (args.json) process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`planning-timings: ${error.message}\n`);
      return 2;
    }
  }
  if (!args.projectRoot || !args.stage || !args.action) {
    process.stderr.write(
      'Usage: node planning-timings.js --project-root <dir> --stage <name> '
      + '--action <start|finish|fail|needs-context|record> [--reason <text>] '
      + '[--duration-ms <number>] [--token-count <number>] [--cost-usd <number>] '
      + '[--retry] [--output <path>] [--json]\n'
      + '       node planning-timings.js --project-root <dir> --record-agent-execution '
      + '--execution-mode <parallel-return|foreground-return> '
      + '[--agent-dispatch-count <n>] [--agent-retry-count <n>] '
      + '[--agent-tool-call-count 0] [--foreground-materialization-ms <n>] '
      + '[--foreground-validation-ms <n>] [--request-payload-bytes <n>] '
      + '[--response-payload-bytes <n>] [--work-order-count <n>] '
      + '[--detail-partition-count <n>] [--completed-work-order-count <n>] '
      + '[--resumed-work-order-count <n>] [--output <path>] [--json]\n'
      + '       node planning-timings.js --project-root <dir> --summary [--output <path>]\n',
    );
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const output = path.resolve(root, args.output || '.tmp/mobile-planning-timings.json');
    const artifact = updatePlanningTiming(readArtifact(output), args);
    atomicWriteJson(output, artifact);
    if (args.json) process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`planning-timings: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  EXECUTION_MODES,
  STAGES,
  main,
  parseArgs,
  readArtifact,
  recordAgentExecutionMetrics,
  stageDuration,
  summarizePlanningTimings,
  updatePlanningTiming,
};