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
  'foregroundPlanning',
  'requirementsPlanning',
  'experienceScopePlanning',
  'persistenceContractPlanning',
  'dataModelPlanning',
  'dataModelArchitect',
  'dataModelCompilation',
  'dataModelValidation',
  'capabilityConnectorPlanning',
  'journeyPackPlanning',
  'planRendering',
  'designMaterialization',
  'artifactValidation',
  'planRepair',
  'userApproval',
  'screenBuildDirectWrite',
  'screenBuildReturnOnly',
  'screenBuildForeground',
  'screenValidation',
  'dataverseExecutionReconciliation',
  'dataverseManifestPreparation',
  'dataverseMetadataWrites',
  'dataverseServiceGeneration',
]);

const FOREGROUND_DETAIL_STAGES = [
  'requirementsPlanning',
  'experienceScopePlanning',
  'persistenceContractPlanning',
  'dataModelPlanning',
  'capabilityConnectorPlanning',
  'journeyPackPlanning',
  'planRendering',
  'designMaterialization',
  'planRepair',
];

function parseArgs(argv) {
  const args = { counts: {} };
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
    else if (argv[index] === '--interrupt-open') args.interruptOpen = true;
    else if (argv[index] === '--count') {
      const raw = String(argv[++index] || '');
      const separator = raw.indexOf('=');
      if (separator <= 0) throw new Error(`Invalid --count value: ${raw || '<missing>'}`);
      args.counts[raw.slice(0, separator)] = raw.slice(separator + 1);
    }
    else if (argv[index] === '--summary') args.summary = true;
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function normalizeCounts(counts) {
  const normalized = {};
  for (const [name, value] of Object.entries(counts || {})) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
      throw new Error(`Invalid workload count name: ${name}`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Workload count ${name} must be a non-negative number`);
    }
    normalized[name] = parsed;
  }
  return normalized;
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
  counts = {},
  nowIso = () => new Date().toISOString(),
  nowMs = () => Date.now(),
}) {
  if (!STAGES.has(stage)) throw new Error(`Unknown planning stage: ${stage}`);
  if (!['start', 'finish', 'fail', 'needs-context', 'record', 'interrupt'].includes(action)) {
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
  current.interruptionCount = Number.isInteger(current.interruptionCount)
    ? current.interruptionCount
    : 0;
  const normalizedCounts = normalizeCounts(counts);
  if (action === 'start') {
    const startedAt = nowIso();
    const startedAtMs = nowMs();
    if (current.status === 'in-progress' && Number.isFinite(current.startedAtMs)) {
      current.history.push({
        attempt: current.attempts,
        startedAt: current.startedAt,
        completedAt: startedAt,
        durationMs: Math.max(0, startedAtMs - current.startedAtMs),
        status: 'interrupted',
        reason: 'superseded-open-attempt',
      });
      current.interruptionCount += 1;
    }
    current.attempts += 1;
    if (retry) current.retryCount += 1;
    current.startedAt = startedAt;
    current.startedAtMs = startedAtMs;
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
    if (Object.keys(normalizedCounts).length > 0) result.counts = normalizedCounts;
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
        ? 'needs-context' : action === 'interrupt' ? 'interrupted' : 'failed',
      reason: action === 'finish' ? null : String(
        reason || (action === 'interrupt' ? 'workflow-interrupted' : 'unspecified failure'),
      ),
    };
    if (action === 'needs-context') current.needsContextCount += 1;
    if (action === 'interrupt') current.interruptionCount += 1;
    if (Object.keys(normalizedCounts).length > 0) result.counts = normalizedCounts;
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
    (total, attempt) => total + (
      attempt.status !== 'interrupted' && Number.isFinite(attempt.durationMs)
        ? attempt.durationMs
        : 0
    ),
    0,
  );
}

function stageCounts(artifact, stage) {
  const counts = {};
  for (const attempt of artifact.stages?.[stage]?.history || []) {
    if (attempt.status === 'interrupted') continue;
    for (const [name, value] of Object.entries(attempt.counts || {})) {
      counts[name] = (counts[name] || 0) + Number(value || 0);
    }
  }
  return counts;
}

function interruptOpenStages(artifact, options = {}) {
  for (const [stage, current] of Object.entries(artifact.stages || {})) {
    if (current.status !== 'in-progress') continue;
    updatePlanningTiming(artifact, {
      stage,
      action: 'interrupt',
      reason: options.reason || 'workflow-resumed-after-interruption',
      nowIso: options.nowIso,
      nowMs: options.nowMs,
    });
  }
  return artifact;
}

function parsedInterval(attempt) {
  const start = Date.parse(attempt.startedAt);
  const end = Date.parse(attempt.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
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

function totalStageDuration(artifact, stages) {
  return stages.reduce((total, stage) => total + stageDuration(artifact, stage), 0);
}

function stageAttemptCount(artifact, stage) {
  return (artifact.stages?.[stage]?.history || []).length;
}

function summarizePlanningTimings(artifact) {
  const environmentResolutionMs = stageDuration(artifact, 'environmentResolution');
  const publisherPrefixDetectionMs = stageDuration(artifact, 'publisherPrefixDetection');
  const dataverseMetadataNetworkMs = stageDuration(artifact, 'metadataInventory')
    + stageDuration(artifact, 'metadataDetailLoading')
    + stageDuration(artifact, 'metadataExpansion');
  const localDeterministicProcessingMs = stageDuration(artifact, 'metadataCandidateSelection')
    + stageDuration(artifact, 'artifactValidation');
  const foregroundPlanningWallMs = stageDuration(artifact, 'foregroundPlanning');
  const foregroundPlanningApprovalWaitingMs = stageOverlapDuration(
    artifact,
    'userApproval',
    'foregroundPlanning',
  );
  const detailedForegroundMs = totalStageDuration(artifact, FOREGROUND_DETAIL_STAGES);
  const foregroundPlanningMs = foregroundPlanningWallMs > 0
    ? Math.max(0, foregroundPlanningWallMs - foregroundPlanningApprovalWaitingMs)
    : environmentResolutionMs + publisherPrefixDetectionMs
      + dataverseMetadataNetworkMs
      + localDeterministicProcessingMs
      + detailedForegroundMs;
  const screenBuildDirectWriteMs = stageDuration(artifact, 'screenBuildDirectWrite');
  const screenBuildReturnOnlyMs = stageDuration(artifact, 'screenBuildReturnOnly');
  const screenBuildForegroundMs = stageDuration(artifact, 'screenBuildForeground');
  const screenBuildMs = screenBuildDirectWriteMs
    + screenBuildReturnOnlyMs
    + screenBuildForegroundMs;
  const screenValidationMs = stageDuration(artifact, 'screenValidation');
  const userApprovalWaitingMs = stageDuration(artifact, 'userApproval');
  const dataverseExecutionMs = totalStageDuration(artifact, [
    'dataverseExecutionReconciliation',
    'dataverseManifestPreparation',
    'dataverseMetadataWrites',
    'dataverseServiceGeneration',
  ]);
  const totalExecutionMs = foregroundPlanningMs + dataverseExecutionMs
    + screenBuildMs + screenValidationMs;
  const summary = {
    environmentResolutionMs,
    publisherPrefixDetectionMs,
    dataverseMetadataNetworkMs,
    localDeterministicProcessingMs,
    foregroundPlanningWallMs,
    foregroundPlanningStatus: artifact.stages?.foregroundPlanning?.status || null,
    foregroundPlanningApprovalWaitingMs,
    foregroundPlanningMs,
    requirementsPlanningMs: stageDuration(artifact, 'requirementsPlanning'),
    experienceScopePlanningMs: stageDuration(artifact, 'experienceScopePlanning'),
    dataModelPlanningMs: stageDuration(artifact, 'dataModelPlanning'),
    capabilityConnectorPlanningMs: stageDuration(artifact, 'capabilityConnectorPlanning'),
    journeyPackPlanningMs: stageDuration(artifact, 'journeyPackPlanning'),
    planRenderingMs: stageDuration(artifact, 'planRendering'),
    designMaterializationMs: stageDuration(artifact, 'designMaterialization'),
    planRepairMs: stageDuration(artifact, 'planRepair'),
    screenBuildDirectWriteMs,
    screenBuildReturnOnlyMs,
    screenBuildForegroundMs,
    screenBuildMs,
    screenBuildAttemptsByChannel: {
      directWrite: stageAttemptCount(artifact, 'screenBuildDirectWrite'),
      returnOnly: stageAttemptCount(artifact, 'screenBuildReturnOnly'),
      foreground: stageAttemptCount(artifact, 'screenBuildForeground'),
    },
    screenValidationMs,
    userApprovalWaitingMs,
    totalExecutionMs,
    totalMeasuredMs: totalExecutionMs + userApprovalWaitingMs,
    retries: Object.fromEntries(Object.entries(artifact.stages || {})
      .filter(([, value]) => Number(value.retryCount || 0) > 0)
      .map(([stage, value]) => [stage, value.retryCount])),
    needsContext: Object.fromEntries(Object.entries(artifact.stages || {})
      .filter(([, value]) => Number(value.needsContextCount || 0) > 0)
      .map(([stage, value]) => [stage, value.needsContextCount])),
  };
  const interruptions = Object.fromEntries(Object.entries(artifact.stages || {})
    .filter(([, value]) => Number(value.interruptionCount || 0) > 0)
    .map(([stage, value]) => [stage, value.interruptionCount]));
  if (Object.keys(interruptions).length > 0) summary.interruptions = interruptions;

  const workload = Object.fromEntries([...STAGES]
    .map((stage) => [stage, stageCounts(artifact, stage)])
    .filter(([, counts]) => Object.keys(counts).length > 0));
  if (Object.keys(workload).length > 0) summary.workload = workload;

  const dataModelBreakdown = Object.fromEntries([
    'dataModelArchitect',
    'dataModelCompilation',
    'dataModelValidation',
  ].map((stage) => [stage, stageDuration(artifact, stage)])
    .filter(([, duration]) => duration > 0));
  if (Object.keys(dataModelBreakdown).length > 0) {
    summary.dataModelBreakdown = dataModelBreakdown;
  }

  const dataverseExecutionBreakdown = Object.fromEntries([
    'dataverseExecutionReconciliation',
    'dataverseManifestPreparation',
    'dataverseMetadataWrites',
    'dataverseServiceGeneration',
  ].map((stage) => [stage, stageDuration(artifact, stage)])
    .filter(([, duration]) => duration > 0));
  if (Object.keys(dataverseExecutionBreakdown).length > 0) {
    summary.dataverseExecutionBreakdown = dataverseExecutionBreakdown;
    summary.dataverseExecutionMs = dataverseExecutionMs;
  }
  return summary;
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
  if (args.projectRoot && args.interruptOpen) {
    try {
      const root = path.resolve(args.projectRoot);
      const output = path.resolve(root, args.output || '.tmp/mobile-planning-timings.json');
      const artifact = interruptOpenStages(readArtifact(output), { reason: args.reason });
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
      + '--action <start|finish|fail|needs-context|record|interrupt> [--reason <text>] '
      + '[--duration-ms <number>] [--token-count <number>] [--cost-usd <number>] '
      + '[--count <name>=<number> ...] [--retry] [--output <path>] [--json]\n'
      + '       node planning-timings.js --project-root <dir> --interrupt-open [--reason <text>]\n'
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
  FOREGROUND_DETAIL_STAGES,
  STAGES,
  interruptOpenStages,
  main,
  parseArgs,
  readArtifact,
  stageCounts,
  stageDuration,
  summarizePlanningTimings,
  updatePlanningTiming,
};