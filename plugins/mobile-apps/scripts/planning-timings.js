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
  'executionReconciliation',
  'manifestBuildValidation',
  'metadataWrite',
  'publish',
  'uncertainRecovery',
  'collisionAdaptation',
  'postPublishVerification',
  'planRevision',
  'userApproval',
]);

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
    else if (argv[index] === '--summary') args.summary = true;
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
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

function recordPlanningDuration(file, stage, durationMs, {
  fileSystem = fs,
  nowIso = () => new Date().toISOString(),
  nowMs = () => Date.now(),
} = {}) {
  const resolved = path.resolve(file);
  const artifact = updatePlanningTiming(readArtifact(resolved, fileSystem), {
    stage,
    action: 'record',
    durationMs,
    nowIso,
    nowMs,
  });
  atomicWriteJson(resolved, artifact, fileSystem);
  return artifact;
}

function summarizePlanningTimings(artifact) {
  return {
    environmentResolutionMs: stageDuration(artifact, 'environmentResolution'),
    publisherPrefixDetectionMs: stageDuration(artifact, 'publisherPrefixDetection'),
    planningInventoryMs: stageDuration(artifact, 'metadataInventory'),
    planningCandidateSelectionMs: stageDuration(artifact, 'metadataCandidateSelection'),
    planningDetailLoadingMs: stageDuration(artifact, 'metadataDetailLoading'),
    planningExpansionMs: stageDuration(artifact, 'metadataExpansion'),
    architectEvidenceRenderMs: stageDuration(artifact, 'artifactValidation'),
    executionReconciliationMs: stageDuration(artifact, 'executionReconciliation'),
    manifestBuildValidationMs: stageDuration(artifact, 'manifestBuildValidation'),
    metadataWriteMs: stageDuration(artifact, 'metadataWrite'),
    publishMs: stageDuration(artifact, 'publish'),
    uncertainRecoveryMs: stageDuration(artifact, 'uncertainRecovery'),
    collisionAdaptationMs: stageDuration(artifact, 'collisionAdaptation'),
    postPublishVerificationMs: stageDuration(artifact, 'postPublishVerification'),
    approvalWaitingMs: stageDuration(artifact, 'userApproval'),
    dataverseMetadataNetworkMs: stageDuration(artifact, 'metadataInventory')
      + stageDuration(artifact, 'metadataDetailLoading')
      + stageDuration(artifact, 'metadataExpansion'),
    localDeterministicProcessingMs: stageDuration(artifact, 'metadataCandidateSelection')
      + stageDuration(artifact, 'artifactValidation'),
    outerPlannerWallMs: stageDuration(artifact, 'nativePlanner'),
    modelArchitectMs: stageDuration(artifact, 'modelArchitect'),
    screenPlannerMs: stageDuration(artifact, 'screenPlanner'),
    planRevisionMs: stageDuration(artifact, 'planRevision'),
    userApprovalWaitingMs: stageDuration(artifact, 'userApproval'),
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
  if (!args.projectRoot || !args.stage || !args.action) {
    process.stderr.write(
      'Usage: node planning-timings.js --project-root <dir> --stage <name> '
      + '--action <start|finish|fail|needs-context|record> [--reason <text>] '
      + '[--duration-ms <number>] [--token-count <number>] [--cost-usd <number>] '
      + '[--retry] [--output <path>] [--json]\n'
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
  STAGES,
  main,
  parseArgs,
  readArtifact,
  recordPlanningDuration,
  stageDuration,
  summarizePlanningTimings,
  updatePlanningTiming,
};