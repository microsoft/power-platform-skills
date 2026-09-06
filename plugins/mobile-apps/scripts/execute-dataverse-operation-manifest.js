#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  PHASE_ORDER,
  sha256,
  stableJson,
} = require('./build-dataverse-operation-manifest');
const {
  runMetadataBatch,
  validateJournalOperations,
} = require('./dataverse-request');
const { invalidateInventoryCache } = require('./dataverse-inventory-cache');
const {
  readArtifact: readPlanningTimingArtifact,
  updatePlanningTiming,
} = require('./planning-timings');
const { atomicWriteJson } = require('./lib/dataverse-planning-telemetry');
const { getAuthToken } = require('./lib/validation-helpers');

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function validateExecutableManifest(manifest, context) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['operation manifest must be an object'] };
  }
  const unsigned = { ...manifest };
  delete unsigned.integritySha256;
  const expectedHash = sha256(stableJson(unsigned));
  if (manifest.integritySha256 !== expectedHash) {
    errors.push('operation manifest integrity hash does not match');
  }
  if (manifest.executable !== true) errors.push('operation manifest is not executable');
  if (manifest.execution?.executor !== 'BATCH-METADATA'
    || manifest.execution?.parallelWrites !== false
    || manifest.execution?.odataBatch !== false) {
    errors.push('operation manifest must use sequential BATCH-METADATA');
  }
  const phases = manifest.execution?.phases;
  if (!Array.isArray(phases)
    || phases.map((phase) => phase.name).join(',') !== PHASE_ORDER.join(',')) {
    errors.push(`operation phases must be exactly ${PHASE_ORDER.join(', ')}`);
  }
  if (context.environmentUrl
    && normalizeUrl(manifest.binding?.environmentUrl) !== normalizeUrl(context.environmentUrl)) {
    errors.push('operation manifest environment URL does not match execution context');
  }
  if (context.tenantId && manifest.binding?.tenantId
    && String(manifest.binding.tenantId).toLowerCase() !== String(context.tenantId).toLowerCase()) {
    errors.push('operation manifest tenant does not match execution context');
  }
  if (context.solution !== undefined
    && String(manifest.binding?.solutionUniqueName || '') !== String(context.solution || '')) {
    errors.push('operation manifest solution does not match execution context');
  }
  const operations = Array.isArray(phases)
    ? phases.flatMap((phase) => (phase.operations || []).map((operation) => ({
      ...operation,
      phase: operation.phase || phase.name,
    })))
    : [];
  try {
    validateJournalOperations(operations, context.solution || null);
  } catch (error) {
    errors.push(error.message);
  }
  if (operations.some((operation) => !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(
    String(operation.method || '').toUpperCase(),
  ))) {
    errors.push('operation manifest contains an unsupported HTTP method');
  }
  return { valid: errors.length === 0, errors, phases: phases || [], operations };
}

function executionCounts(phases) {
  const counts = {
    operations: 0,
    tableCreates: 0,
    extensions: 0,
    relationships: 0,
    alternateKeys: 0,
    publish: 0,
  };
  for (const phase of phases) {
    const count = (phase.operations || []).length;
    counts.operations += count;
    counts[phase.name] = count;
  }
  return counts;
}

function writeTiming(timingPath, action, options = {}) {
  if (!timingPath) return;
  const artifact = readPlanningTimingArtifact(timingPath);
  updatePlanningTiming(artifact, {
    stage: 'dataverseMetadataWrites',
    action,
    counts: options.counts,
    reason: options.reason,
    nowIso: options.nowIso,
    nowMs: options.nowMs,
  });
  atomicWriteJson(timingPath, artifact);
}

async function executeManifest(options) {
  const {
    manifest,
    environmentUrl,
    tenantId,
    solution,
    journalPath,
    publishCheckpointPath,
    inventoryCachePath,
    timingPath,
    getToken = getAuthToken,
    runPhase = runMetadataBatch,
    invalidateCache = invalidateInventoryCache,
    fileSystem = fs,
    nowMs = () => Date.now(),
    nowIso = () => new Date().toISOString(),
  } = options;
  const validation = validateExecutableManifest(manifest, {
    environmentUrl,
    tenantId,
    solution,
  });
  if (!validation.valid) {
    throw new Error(`Invalid Dataverse operation manifest: ${validation.errors.join('; ')}`);
  }
  const counts = executionCounts(validation.phases);
  writeTiming(timingPath, 'start', { counts, nowMs, nowIso });
  const startedAt = nowMs();
  let token;
  try {
    if (counts.operations === 0) {
      writeTiming(timingPath, 'finish', { counts, nowMs, nowIso });
      return {
        ok: true,
        durationMs: Math.max(0, nowMs() - startedAt),
        counts,
        results: validation.phases.map((phase) => ({
          name: phase.name,
          operationCount: 0,
          results: [],
        })),
      };
    }
    token = await getToken(environmentUrl, tenantId);
    if (!token) throw new Error('Dataverse access token is unavailable');
    const results = [];
    for (const phase of validation.phases) {
      const operations = phase.operations || [];
      if (operations.length === 0) {
        results.push({ name: phase.name, operationCount: 0, results: [] });
        continue;
      }
      const outcome = await runPhase(
        environmentUrl,
        operations,
        token,
        solution || null,
        tenantId || null,
        false,
        {
          journalPath,
          manifest,
          manifestHash: manifest.integritySha256,
          reconciliationHash: manifest.binding.reconciliationSha256,
          allOperations: validation.operations,
        },
      );
      token = outcome.token || token;
      results.push({
        name: phase.name,
        operationCount: operations.length,
        results: outcome.results || [],
      });
      if (outcome.failed) {
        const failure = (outcome.results || []).find((result) => (
          result.status < 200 || result.status >= 300
        ));
        throw new Error(
          `Dataverse phase ${phase.name} failed at ${failure?.operationId || failure?.index || 'unknown'}: ${failure?.error || `HTTP ${failure?.status || 0}`}`,
        );
      }
    }

    if (counts.publish > 0) {
      if (inventoryCachePath && !invalidateCache(inventoryCachePath, fileSystem)) {
        throw new Error(`Failed to invalidate Dataverse inventory cache: ${inventoryCachePath}`);
      }
      if (publishCheckpointPath) fileSystem.rmSync(publishCheckpointPath, { force: true });
    }
    writeTiming(timingPath, 'finish', { counts, nowMs, nowIso });
    return {
      ok: true,
      durationMs: Math.max(0, nowMs() - startedAt),
      counts,
      results,
    };
  } catch (error) {
    writeTiming(timingPath, 'fail', {
      counts,
      reason: 'dataverse-metadata-phase-failed',
      nowMs,
      nowIso,
    });
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--manifest') args.manifest = argv[++index];
    else if (token === '--env-url') args.environmentUrl = argv[++index];
    else if (token === '--tenant-id') args.tenantId = argv[++index];
    else if (token === '--solution') args.solution = argv[++index];
    else if (token === '--journal') args.journal = argv[++index];
    else if (token === '--publish-checkpoint') args.publishCheckpoint = argv[++index];
    else if (token === '--inventory-cache') args.inventoryCache = argv[++index];
    else if (token === '--timings') args.timings = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const field of ['manifest', 'environmentUrl', 'solution', 'journal']) {
    if (!args[field]) throw new Error(`--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return args;
}

async function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const manifestPath = path.resolve(args.manifest);
    const result = await executeManifest({
      manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      environmentUrl: args.environmentUrl,
      tenantId: args.tenantId || null,
      solution: args.solution,
      journalPath: path.resolve(args.journal),
      publishCheckpointPath: args.publishCheckpoint
        ? path.resolve(args.publishCheckpoint)
        : null,
      inventoryCachePath: args.inventoryCache ? path.resolve(args.inventoryCache) : null,
      timingPath: args.timings ? path.resolve(args.timings) : null,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`execute-dataverse-operation-manifest: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  executeManifest,
  executionCounts,
  main,
  parseArgs,
  validateExecutableManifest,
};