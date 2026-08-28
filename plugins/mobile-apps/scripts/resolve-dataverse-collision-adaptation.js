#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteJson,
  sha256,
  stableJson,
  validateAdaptationPolicy,
} = require('./build-dataverse-operation-manifest');
const {
  analyzeProposedNames,
  resolveExactNameEntities,
} = require('./create-dataverse-snapshot');
const {
  createDataverseRequestExecutor,
  operationFingerprint,
} = require('./dataverse-request');
const {
  collisionEvidence: journalCollisionEvidence,
} = require('./execute-dataverse-plan');

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function assertIntegrity(value, label) {
  const expected = String(value?.integritySha256 || '');
  const content = { ...(value || {}) };
  delete content.integritySha256;
  if (!/^[a-f0-9]{64}$/i.test(expected)
    || sha256(stableJson(content)) !== expected) {
    throw new Error(`${label} integrity does not match`);
  }
}

function manifestOperations(manifest) {
  return (manifest.execution?.phases || []).flatMap(
    (phase) => phase.operations || [],
  );
}

function collisionAdaptationContext({
  manifest,
  approvalReceipt,
  executionOutcome,
  journal,
}) {
  assertIntegrity(manifest, 'manifest');
  assertIntegrity(approvalReceipt, 'approval receipt');
  if (manifest.binding?.approvalReceiptSha256 !== approvalReceipt.integritySha256) {
    throw new Error('manifest is not bound to the approval receipt');
  }
  const policyValidation = validateAdaptationPolicy(approvalReceipt.adaptationPolicy);
  if (!policyValidation.valid) {
    throw new Error(`invalid adaptation policy: ${policyValidation.errors.join('; ')}`);
  }
  if (executionOutcome?.status !== 'COLLISION_ADAPTATION_REQUIRED'
    || executionOutcome?.reasonCode !== 'HIDDEN_SCHEMA_NAME_COLLISION') {
    throw new Error('execution outcome is not a hidden collision adaptation request');
  }
  const evidence = executionOutcome.collisionEvidence;
  if (!evidence || evidence.priorManifestSha256 !== manifest.integritySha256) {
    throw new Error('collision evidence is not bound to the failed manifest');
  }
  const persistedEvidence = journalCollisionEvidence(journal);
  if (!persistedEvidence || stableJson(persistedEvidence) !== stableJson(evidence)) {
    throw new Error('collision evidence does not match the mutation journal');
  }
  const allowedCodes = new Set(
    approvalReceipt.adaptationPolicy.allowedCollisionCodes.map(normalizeName),
  );
  if (!allowedCodes.has(normalizeName(evidence.code))) {
    throw new Error(`collision code ${evidence.code || '<missing>'} is not approved`);
  }
  const matchingOperations = manifestOperations(manifest).filter(
    (operation) => operation.id === evidence.operationId,
  );
  if (matchingOperations.length !== 1) {
    throw new Error('collision operation is not unique in the failed manifest');
  }
  const operation = matchingOperations[0];
  if (String(operation.method || '').toUpperCase() !== 'POST'
    || operation.apiPath !== 'EntityDefinitions') {
    throw new Error('collision operation is not a table create');
  }
  const fingerprint = operationFingerprint(
    operation,
    manifest.binding?.solutionUniqueName || null,
  );
  if (fingerprint !== evidence.operationFingerprint) {
    throw new Error('collision operation fingerprint does not match the failed manifest');
  }
  const matchingDecisions = (manifest.decisions || []).filter(
    (decision) => decision.itemType === 'table'
      && decision.operation === operation.id,
  );
  if (matchingDecisions.length !== 1) {
    throw new Error('collision operation has no unique table decision');
  }
  const decision = matchingDecisions[0];
  const requestedLogicalName = normalizeName(decision.requestedName);
  const failedLogicalName = normalizeName(operation.body?.SchemaName);
  if (!requestedLogicalName || !failedLogicalName
    || normalizeName(decision.effectiveName) !== failedLogicalName) {
    throw new Error('collision table identity does not match the manifest decision');
  }

  const policy = approvalReceipt.adaptationPolicy;
  const suffixes = policy.alternativeSuffixes
    .slice(0, policy.maxAttempts)
    .map((suffix) => normalizeName(suffix));
  if (new Set(suffixes).size !== suffixes.length) {
    throw new Error('adaptation policy suffixes must be unique');
  }
  const candidates = suffixes.map((suffix, index) => ({
    logicalName: `${requestedLogicalName}_${suffix}`,
    schemaName: `${requestedLogicalName}_${suffix}`,
    suffix,
    attempt: index + 1,
  }));
  const failedCandidateIndex = failedLogicalName === requestedLogicalName
    ? -1
    : candidates.findIndex((candidate) => candidate.logicalName === failedLogicalName);
  if (failedLogicalName !== requestedLogicalName && failedCandidateIndex < 0) {
    throw new Error('failed table name is outside the approved suffix sequence');
  }
  return {
    evidence,
    failedLogicalName,
    manifestSha256: manifest.integritySha256,
    approvalReceiptSha256: approvalReceipt.integritySha256,
    requestedLogicalName,
    candidates: candidates.slice(failedCandidateIndex + 1),
  };
}

function withIntegrity(value) {
  return {
    ...value,
    integritySha256: sha256(stableJson(value)),
  };
}

async function probeCollisionAdaptation({
  manifest,
  approvalReceipt,
  executionOutcome,
  journal,
  request,
  environmentUrl = null,
  nowIso = () => new Date().toISOString(),
}) {
  const context = collisionAdaptationContext({
    manifest,
    approvalReceipt,
    executionOutcome,
    journal,
  });
  if (environmentUrl
    && String(environmentUrl).replace(/\/+$/, '')
      !== String(manifest.binding?.environmentUrl || '').replace(/\/+$/, '')) {
    throw new Error('collision probe environment does not match the manifest');
  }
  let checked = [];
  if (context.candidates.length > 0) {
    if (typeof request !== 'function') throw new Error('collision probe request is required');
    const names = context.candidates.map((candidate) => candidate.logicalName);
    const resolution = await resolveExactNameEntities(request, [], names);
    const checks = analyzeProposedNames(resolution.entities, names);
    const statusByName = new Map(checks.checked.map(
      (item) => [normalizeName(item.logicalName), item.status],
    ));
    checked = context.candidates.map((candidate) => ({
      ...candidate,
      status: statusByName.get(candidate.logicalName) || 'unverified',
    }));
  }
  const selected = checked.find((candidate) => candidate.status === 'missing') || null;
  return withIntegrity({
    schemaVersion: 1,
    status: selected ? 'ADAPTATION_CANDIDATE_READY' : 'COLLISION_SEQUENCE_EXHAUSTED',
    manifestSha256: context.manifestSha256,
    approvalReceiptSha256: context.approvalReceiptSha256,
    checkedAt: nowIso(),
    requestedLogicalName: context.requestedLogicalName,
    failedLogicalName: context.failedLogicalName,
    absenceSemantics: 'metadata-absent-not-reserved',
    checkedCandidates: checked,
    adaptation: selected ? {
      plannedDecision: 'adapt',
      adaptationKind: 'hidden-name-collision',
      adaptedLogicalName: selected.logicalName,
      adaptedSchemaName: selected.schemaName,
      suffix: selected.suffix,
      attempt: selected.attempt,
      collisionEvidence: context.evidence,
    } : null,
  });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--manifest') args.manifestPath = argv[++index];
    else if (argv[index] === '--approval-receipt') args.approvalReceiptPath = argv[++index];
    else if (argv[index] === '--execution-outcome') args.executionOutcomePath = argv[++index];
    else if (argv[index] === '--journal') args.journalPath = argv[++index];
    else if (argv[index] === '--env-url') args.environmentUrl = argv[++index];
    else if (argv[index] === '--tenant-id') args.tenantId = argv[++index];
    else if (argv[index] === '--output') args.outputPath = argv[++index];
    else if (argv[index] === '--timeout-ms') args.timeoutMs = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const required = [
    'manifestPath',
    'approvalReceiptPath',
    'executionOutcomePath',
    'journalPath',
    'environmentUrl',
    'outputPath',
  ];
  const missing = required.filter((name) => !args[name]);
  if (missing.length > 0) {
    process.stderr.write(`resolve-dataverse-collision-adaptation: missing ${missing.join(', ')}\n`);
    return 2;
  }
  try {
    const request = createDataverseRequestExecutor({
      environmentUrl: args.environmentUrl,
      tenantId: args.tenantId,
      timeoutMs: args.timeoutMs,
    });
    const result = await probeCollisionAdaptation({
      manifest: readJson(args.manifestPath),
      approvalReceipt: readJson(args.approvalReceiptPath),
      executionOutcome: readJson(args.executionOutcomePath),
      journal: readJson(args.journalPath),
      request,
      environmentUrl: args.environmentUrl,
    });
    atomicWriteJson(path.resolve(args.outputPath), result);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'ADAPTATION_CANDIDATE_READY' ? 0 : 3;
  } catch (error) {
    process.stderr.write(`resolve-dataverse-collision-adaptation: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  collisionAdaptationContext,
  main,
  parseArgs,
  probeCollisionAdaptation,
};