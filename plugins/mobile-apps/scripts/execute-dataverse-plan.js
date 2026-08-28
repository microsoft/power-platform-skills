#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  validateManifest,
  stableJson,
} = require('./build-dataverse-operation-manifest');
const {
  getAuthToken,
} = require('./lib/validation-helpers');
const {
  runMetadataBatch,
} = require('./dataverse-request');
const {
  invalidateInventoryCache,
} = require('./dataverse-inventory-cache');
const {
  recordPlanningDuration,
} = require('./planning-timings');

function atomicWriteJson(file, value, fileSystem = fs) {
  if (!file) return;
  const resolved = path.resolve(file);
  fileSystem.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, stableJson(value), 'utf8');
    fileSystem.renameSync(temporary, resolved);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function safeOperationResult(result) {
  return {
    index: Number.isInteger(result?.index) ? result.index : -1,
    status: Number.isInteger(result?.status) ? result.status : 0,
    operationId: result?.operationId || null,
    durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : 0,
    operationClass: result?.operationClass || null,
    requestedTimeoutMs: Number.isFinite(result?.requestedTimeoutMs)
      ? result.requestedTimeoutMs
      : null,
    uncertain: Boolean(result?.uncertain),
    rateLimited: Boolean(result?.rateLimited),
    journalStatus: result?.journalStatus || null,
  };
}

function collisionCode(value) {
  const match = String(value || '').match(/0x80044363|0x80060890/i);
  return match ? match[0].toLowerCase() : null;
}

function collisionEvidence(journal) {
  const inFlight = journal?.inFlight;
  if (!inFlight?.failure?.collision) return null;
  const code = collisionCode(
    inFlight.failure.collisionCode || inFlight.failure.error,
  );
  if (!code) return null;
  return {
    code,
    operationId: inFlight.operationId,
    operationFingerprint: inFlight.fingerprint,
    priorManifestSha256: inFlight.manifestHash,
    priorReconciliationSha256: inFlight.reconciliationHash,
    observedAt: inFlight.failure.recordedAt,
  };
}

function defaultReadJournal(journalPath) {
  return journalPath && fs.existsSync(path.resolve(journalPath))
    ? readJson(journalPath)
    : null;
}

async function executeValidatedManifest({
  manifest,
  manifestPath,
  environmentUrl,
  tenantId,
  solution,
  journalPath,
  checkpointPath = null,
  inventoryCachePath = null,
  outcomePath = null,
  timingsPath = null,
  timeoutMs = null,
  getToken = getAuthToken,
  runPhase = runMetadataBatch,
  readJournal = defaultReadJournal,
  invalidateCache = () => {
    if (inventoryCachePath) invalidateInventoryCache(inventoryCachePath);
  },
  nowMs = () => Date.now(),
  nowIso = () => new Date().toISOString(),
}) {
  const startedAt = nowIso();
  const allOperations = (manifest.execution?.phases || [])
    .flatMap((phase) => phase.operations || []);
  const timing = {
    metadataWriteMs: 0,
    publishMs: 0,
  };
  const phaseResults = [];
  const token = await getToken(environmentUrl, tenantId);
  if (!token) {
    const result = {
      schemaVersion: 1,
      status: 'BLOCKED',
      stage: 'authentication',
      reasonCode: 'TOKEN_UNAVAILABLE',
      startedAt,
      completedAt: nowIso(),
      timing,
      phases: phaseResults,
    };
    atomicWriteJson(outcomePath, result);
    return result;
  }

  for (const phase of manifest.execution?.phases || []) {
    const operations = phase.operations || [];
    if (operations.length === 0) continue;
    const phaseStarted = nowMs();
    const executed = await runPhase(
      environmentUrl,
      operations,
      token,
      solution,
      tenantId,
      false,
      {
        journalPath,
        manifestHash: manifest.integritySha256,
        reconciliationHash: manifest.binding.reconciliationSha256,
        allOperations,
        manifest,
        manifestFile: manifestPath,
        timeoutMs,
      },
    );
    const durationMs = Math.max(0, nowMs() - phaseStarted);
    if (phase.name === 'publish') timing.publishMs += durationMs;
    else timing.metadataWriteMs += durationMs;
    if (timingsPath) {
      recordPlanningDuration(
        timingsPath,
        phase.name === 'publish' ? 'publish' : 'metadataWrite',
        durationMs,
      );
    }
    phaseResults.push({
      name: phase.name,
      durationMs,
      operations: (executed.results || []).map(safeOperationResult),
    });
    if (executed.failed) {
      const journal = readJournal(journalPath);
      const collision = collisionEvidence(journal);
      const uncertain = (executed.results || []).some((result) => result.uncertain)
        || journal?.inFlight?.failure?.uncertain === true;
      const result = {
        schemaVersion: 1,
        status: collision
          ? 'COLLISION_ADAPTATION_REQUIRED'
          : uncertain
            ? 'UNCERTAIN_RECONCILIATION_REQUIRED'
            : 'BLOCKED',
        stage: phase.name,
        reasonCode: collision
          ? 'HIDDEN_SCHEMA_NAME_COLLISION'
          : uncertain
            ? 'UNCERTAIN_METADATA_MUTATION'
            : 'METADATA_PHASE_FAILED',
        ...(collision ? { collisionEvidence: collision } : {}),
        startedAt,
        completedAt: nowIso(),
        timing,
        phases: phaseResults,
      };
      atomicWriteJson(outcomePath, result);
      return result;
    }
  }

  const published = phaseResults.some((phase) => phase.name === 'publish');
  if (published) {
    if (checkpointPath) fs.rmSync(path.resolve(checkpointPath), { force: true });
    invalidateCache();
  }
  const result = {
    schemaVersion: 1,
    status: 'DONE',
    stage: published ? 'publish' : 'metadata-execution',
    reasonCode: published ? 'PUBLISH_CONFIRMED' : 'NO_PUBLISH_REQUIRED',
    startedAt,
    completedAt: nowIso(),
    timing,
    phases: phaseResults,
  };
  atomicWriteJson(outcomePath, result);
  return result;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--manifest') args.manifestPath = argv[++index];
    else if (argv[index] === '--contract') args.contractPath = argv[++index];
    else if (argv[index] === '--approval-receipt') args.approvalReceiptPath = argv[++index];
    else if (argv[index] === '--reconciliation') args.reconciliationPath = argv[++index];
    else if (argv[index] === '--plan') args.planPath = argv[++index];
    else if (argv[index] === '--journal') args.journalPath = argv[++index];
    else if (argv[index] === '--publish-checkpoint') args.checkpointPath = argv[++index];
    else if (argv[index] === '--inventory-cache') args.inventoryCachePath = argv[++index];
    else if (argv[index] === '--outcome') args.outcomePath = argv[++index];
    else if (argv[index] === '--timings-output') args.timingsPath = argv[++index];
    else if (argv[index] === '--environment-id') args.environmentId = argv[++index];
    else if (argv[index] === '--env-url') args.environmentUrl = argv[++index];
    else if (argv[index] === '--tenant-id') args.tenantId = argv[++index];
    else if (argv[index] === '--publisher-prefix') args.publisherPrefix = argv[++index];
    else if (argv[index] === '--solution') args.solution = argv[++index];
    else if (argv[index] === '--timeout-ms') args.timeoutMs = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

async function executeFromFiles(args) {
  const validationStartedAt = Date.now();
  const manifest = readJson(args.manifestPath);
  const contract = readJson(args.contractPath);
  const approvalReceipt = readJson(args.approvalReceiptPath);
  const reconciliation = readJson(args.reconciliationPath);
  const planBytes = fs.readFileSync(path.resolve(args.planPath));
  const contractBytes = fs.readFileSync(path.resolve(args.contractPath));
  const reconciliationBytes = fs.readFileSync(path.resolve(args.reconciliationPath));
  const publishCheckpoint = args.checkpointPath
    && fs.existsSync(path.resolve(args.checkpointPath))
    ? readJson(args.checkpointPath)
    : null;
  const context = {
    environmentId: args.environmentId,
    environmentUrl: args.environmentUrl,
    tenantId: args.tenantId || null,
    publisherPrefix: args.publisherPrefix,
    solutionUniqueName: args.solution,
  };
  const validation = validateManifest(manifest, {
    planBytes,
    contractBytes,
    reconciliationBytes,
    contract,
    approvalReceipt,
    reconciliation,
    context,
    publishCheckpoint,
    requireExecutable: true,
  });
  if (args.timingsPath) {
    recordPlanningDuration(
      args.timingsPath,
      'manifestBuildValidation',
      Math.max(0, Date.now() - validationStartedAt),
    );
  }
  if (!validation.valid) {
    throw new Error(`Manifest validation failed: ${validation.errors.join('; ')}`);
  }
  return executeValidatedManifest({
    manifest,
    manifestPath: path.resolve(args.manifestPath),
    environmentUrl: args.environmentUrl,
    tenantId: args.tenantId,
    solution: args.solution,
    journalPath: args.journalPath,
    checkpointPath: args.checkpointPath,
    inventoryCachePath: args.inventoryCachePath,
    outcomePath: args.outcomePath,
    timingsPath: args.timingsPath,
    timeoutMs: args.timeoutMs,
  });
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const required = [
    'manifestPath',
    'contractPath',
    'approvalReceiptPath',
    'reconciliationPath',
    'planPath',
    'journalPath',
    'outcomePath',
    'environmentId',
    'environmentUrl',
    'publisherPrefix',
    'solution',
  ];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) {
    process.stderr.write(`execute-dataverse-plan: missing ${missing.join(', ')}\n`);
    return 2;
  }
  try {
    const result = await executeFromFiles(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'DONE') return 0;
    if (result.status === 'COLLISION_ADAPTATION_REQUIRED') return 3;
    if (result.status === 'UNCERTAIN_RECONCILIATION_REQUIRED') return 4;
    return 2;
  } catch (error) {
    process.stderr.write(`execute-dataverse-plan: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  collisionCode,
  collisionEvidence,
  executeFromFiles,
  executeValidatedManifest,
  main,
  safeOperationResult,
};
