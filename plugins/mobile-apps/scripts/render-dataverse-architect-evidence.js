#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteJson,
  validateSnapshot,
} = require('./create-dataverse-snapshot');
const {
  projectSelectedTables,
  stableJson: stableProjectionJson,
} = require('./lib/dataverse-evidence-projection');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}

function architectCandidate(candidate) {
  return {
    logicalName: candidate.logicalName,
    displayName: candidate.displayName,
    rank: candidate.rank,
    score: candidate.score,
    matchClass: candidate.matchClass || 'legacy',
    publisherFamily: candidate.publisherFamily,
    versioned: candidate.versioned,
    detailStatus: candidate.detailStatus || (candidate.detailed ? 'loaded' : 'inventory-only'),
    detailLevel: candidate.detailLevel || null,
    selectionEvidence: candidate.selectionEvidence || [],
    reasons: candidate.reasons || [],
  };
}

function buildArchitectEvidenceBundle(snapshot, sourceSnapshotSha256) {
  const validation = validateSnapshot(snapshot);
  if (!validation.valid) {
    throw new Error(`Invalid Dataverse snapshot: ${validation.errors.join('; ')}`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(sourceSnapshotSha256 || ''))) {
    throw new Error('sourceSnapshotSha256 must be a SHA-256 value');
  }
  const projection = projectSelectedTables(snapshot, sourceSnapshotSha256);
  const shardDescriptors = projection.shards.map((shard) => ({
    id: `table-index:${shard.tableLogicalName}`,
    tableLogicalName: shard.tableLogicalName,
    evidenceClasses: [
      ...(shard.columnIndex.length > 0 ? ['columns'] : []),
      ...(shard.relationshipIndex.length > 0 ? ['relationships'] : []),
      ...(shard.keyIndex.length > 0 ? ['keys'] : []),
    ],
    file: `${shard.tableLogicalName}.json`,
    integritySha256: shard.integritySha256,
    bytes: Buffer.byteLength(stableProjectionJson(shard)),
  }));
  const evidence = {
    schemaVersion: 2,
    sourceSnapshotSha256,
    environment: {
      url: snapshot.environmentUrl,
      tenantId: snapshot.tenantId,
    },
    generatedAt: snapshot.generatedAt,
    concepts: snapshot.candidateRanking.map((ranking) => ({
      concept: ranking.concept,
      conceptKind: ranking.conceptKind || 'legacy',
      discoverTable: ranking.discoverTable !== false,
      skippedReason: ranking.skippedReason || null,
      preferredPublisherFamily: ranking.preferredPublisherFamily || '',
      topCandidates: (ranking.candidates || []).slice(0, 3).map(architectCandidate),
    })),
    selectedTables: projection.selectedTables.map((table) => ({
      ...table,
      detailLevel: table.detailLevel || 'full',
      missingDetailClasses: clone(table.missingDetailClasses || []),
    })),
    shards: shardDescriptors,
    selectedCandidateEvidence: snapshot.selectedCandidateEvidence || [],
    proposedNameChecks: snapshot.proposedNameChecks,
    exactNameResolution: snapshot.exactNameResolution,
    detailLoadFailures: snapshot.detailLoadFailures || [],
    detailLoadSummary: snapshot.detailLoadSummary,
    timings: snapshot.timings,
  };
  return {
    evidence: JSON.parse(JSON.stringify(evidence)),
    shards: JSON.parse(JSON.stringify(projection.shards)),
  };
}

function buildArchitectEvidence(snapshot, sourceSnapshotSha256) {
  return buildArchitectEvidenceBundle(snapshot, sourceSnapshotSha256).evidence;
}

function validateArchitectEvidence(evidence, snapshot, sourceSnapshotSha256) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { valid: false, errors: ['architect evidence must be an object'] };
  }
  if (evidence.schemaVersion !== 2) errors.push('architect evidence schemaVersion must be 2');
  if (evidence.sourceSnapshotSha256 !== sourceSnapshotSha256) {
    errors.push('architect evidence source snapshot hash is stale');
  }
  if (evidence.environment?.url !== snapshot.environmentUrl
    || evidence.environment?.tenantId !== snapshot.tenantId) {
    errors.push('architect evidence environment does not match the snapshot');
  }
  const expectedBundle = buildArchitectEvidenceBundle(snapshot, sourceSnapshotSha256);
  const expectedTables = new Map(expectedBundle.evidence.selectedTables.map(
    (table) => [table.logicalName, table],
  ));
  const actualTables = Array.isArray(evidence.selectedTables) ? evidence.selectedTables : [];
  if (new Set(actualTables.map((table) => table.logicalName)).size !== actualTables.length) {
    errors.push('architect evidence selected tables must be unique');
  }
  if (actualTables.length !== expectedTables.size) {
    errors.push('architect evidence selected table count does not match the snapshot');
  }
  for (const table of actualTables) {
    const expected = expectedTables.get(table.logicalName);
    if (!expected) {
      errors.push(`architect evidence contains unknown table ${table.logicalName}`);
      continue;
    }
    if (stableJson(table) !== stableJson(expected)) {
      errors.push(`architect evidence table ${table.logicalName} differs from the projection`);
    }
  }
  const expectedConcepts = snapshot.candidateRanking || [];
  if (!Array.isArray(evidence.concepts) || evidence.concepts.length !== expectedConcepts.length) {
    errors.push('architect evidence concept count does not match the snapshot');
  } else {
    for (const [index, concept] of evidence.concepts.entries()) {
      if (concept.concept !== expectedConcepts[index].concept) {
        errors.push(`architect evidence concept ${index} does not match the snapshot`);
      }
      if (!Array.isArray(concept.topCandidates) || concept.topCandidates.length > 3) {
        errors.push(`architect evidence concept ${index} exceeds the top-three candidate limit`);
      }
    }
  }
  if (stableJson(evidence) !== stableJson(expectedBundle.evidence)) {
    errors.push('architect evidence differs from the deterministic snapshot projection');
  }
  return { valid: errors.length === 0, errors };
}

function loadAndValidateArchitectEvidence(snapshotFile, evidenceFile, fileSystem = fs) {
  const snapshotSource = fileSystem.readFileSync(path.resolve(snapshotFile), 'utf8');
  const snapshot = JSON.parse(snapshotSource);
  const snapshotValidation = validateSnapshot(snapshot);
  if (!snapshotValidation.valid) {
    throw new Error(`Invalid Dataverse snapshot: ${snapshotValidation.errors.join('; ')}`);
  }
  const evidence = JSON.parse(fileSystem.readFileSync(path.resolve(evidenceFile), 'utf8'));
  const sourceSnapshotSha256 = sha256(snapshotSource);
  const validation = validateArchitectEvidence(evidence, snapshot, sourceSnapshotSha256);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  const expectedBundle = buildArchitectEvidenceBundle(snapshot, sourceSnapshotSha256);
  const shardDirectory = `${path.resolve(evidenceFile)}.shards`;
  const shards = [];
  for (const [index, descriptor] of (evidence.shards || []).entries()) {
    if (!/^[A-Za-z][A-Za-z0-9_]*\.json$/.test(String(descriptor.file || ''))) {
      throw new Error(`architect evidence shard ${index} has an unsafe file name`);
    }
    const shardPath = path.join(shardDirectory, descriptor.file);
    if (!fileSystem.existsSync(shardPath)) {
      throw new Error(`architect evidence shard is missing: ${descriptor.file}`);
    }
    const shard = JSON.parse(fileSystem.readFileSync(shardPath, 'utf8'));
    const withoutIntegrity = { ...shard };
    delete withoutIntegrity.integritySha256;
    if (shard.integritySha256 !== sha256(stableProjectionJson(withoutIntegrity))) {
      throw new Error(`architect evidence shard integrity is invalid: ${descriptor.file}`);
    }
    if (shard.integritySha256 !== descriptor.integritySha256) {
      throw new Error(`architect evidence shard descriptor is stale: ${descriptor.file}`);
    }
    const expected = expectedBundle.shards.find(
      (item) => item.tableLogicalName === shard.tableLogicalName,
    );
    if (!expected || stableJson(shard) !== stableJson(expected)) {
      throw new Error(`architect evidence shard differs from projection: ${descriptor.file}`);
    }
    shards.push(shard);
  }
  if (shards.length !== expectedBundle.shards.length) {
    throw new Error('architect evidence shard count does not match projection');
  }
  return { evidence, shards, snapshot, sourceSnapshotSha256 };
}

function writeArchitectEvidenceBundle(output, bundle, fileSystem = fs) {
  const resolved = path.resolve(output);
  const shardDirectory = `${resolved}.shards`;
  if (bundle.shards.length > 0) fileSystem.mkdirSync(shardDirectory, { recursive: true });
  for (const shard of bundle.shards) {
    atomicWriteJson(path.join(shardDirectory, `${shard.tableLogicalName}.json`), shard, fileSystem);
  }
  atomicWriteJson(resolved, bundle.evidence, fileSystem);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--snapshot') args.snapshot = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--json') args.json = true;
    else if (argv[index] === '--validate-only') args.validateOnly = true;
  }
  return args;
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (!args.snapshot || !args.output) {
    process.stderr.write(
      'Usage: node render-dataverse-architect-evidence.js '
      + '--snapshot <json> --output <json> [--validate-only] [--json]\n',
    );
    return 2;
  }
  try {
    const snapshotPath = path.resolve(args.snapshot);
    const output = path.resolve(args.output);
    if (args.validateOnly) {
      const validated = loadAndValidateArchitectEvidence(snapshotPath, output);
      const result = {
        status: 'DONE',
        output,
        sourceSnapshotSha256: validated.sourceSnapshotSha256,
        concepts: validated.evidence.concepts.length,
        selectedTables: validated.evidence.selectedTables.length,
      };
      process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : 'Dataverse architect evidence is current.'}\n`);
      return 0;
    }
    const source = fs.readFileSync(snapshotPath, 'utf8');
    const snapshot = JSON.parse(source);
    const sourceSnapshotSha256 = sha256(source);
    const bundle = buildArchitectEvidenceBundle(snapshot, sourceSnapshotSha256);
    const evidence = bundle.evidence;
    const validation = validateArchitectEvidence(evidence, snapshot, sourceSnapshotSha256);
    if (!validation.valid) throw new Error(validation.errors.join('; '));
    writeArchitectEvidenceBundle(output, bundle);
    const result = {
      status: 'DONE',
      output,
      sourceSnapshotSha256,
      concepts: evidence.concepts.length,
      selectedTables: evidence.selectedTables.length,
      shards: evidence.shards.length,
      bytes: Buffer.byteLength(JSON.stringify(evidence)),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`render-dataverse-architect-evidence: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  architectCandidate,
  buildArchitectEvidence,
  buildArchitectEvidenceBundle,
  loadAndValidateArchitectEvidence,
  main,
  sha256,
  stableJson,
  validateArchitectEvidence,
  writeArchitectEvidenceBundle,
};