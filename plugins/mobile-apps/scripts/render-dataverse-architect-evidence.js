#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteJson,
  validateSnapshot,
} = require('./create-dataverse-snapshot');

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

function buildArchitectEvidence(snapshot, sourceSnapshotSha256) {
  const validation = validateSnapshot(snapshot);
  if (!validation.valid) {
    throw new Error(`Invalid Dataverse snapshot: ${validation.errors.join('; ')}`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(sourceSnapshotSha256 || ''))) {
    throw new Error('sourceSnapshotSha256 must be a SHA-256 value');
  }
  const evidence = {
    schemaVersion: 1,
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
    selectedTables: snapshot.tables.map((table) => {
      const selected = clone(table);
      selected.detailLevel = table.detailLevel || 'full';
      selected.missingDetailClasses = clone(table.missingDetailClasses || []);
      return selected;
    }),
    selectedCandidateEvidence: snapshot.selectedCandidateEvidence || [],
    proposedNameChecks: snapshot.proposedNameChecks,
    exactNameResolution: snapshot.exactNameResolution,
    detailLoadFailures: snapshot.detailLoadFailures || [],
    detailLoadSummary: snapshot.detailLoadSummary,
    timings: snapshot.timings,
  };
  return JSON.parse(JSON.stringify(evidence));
}

function validateArchitectEvidence(evidence, snapshot, sourceSnapshotSha256) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { valid: false, errors: ['architect evidence must be an object'] };
  }
  if (evidence.schemaVersion !== 1) errors.push('architect evidence schemaVersion must be 1');
  if (evidence.sourceSnapshotSha256 !== sourceSnapshotSha256) {
    errors.push('architect evidence source snapshot hash is stale');
  }
  if (evidence.environment?.url !== snapshot.environmentUrl
    || evidence.environment?.tenantId !== snapshot.tenantId) {
    errors.push('architect evidence environment does not match the snapshot');
  }
  const expectedTables = new Map(snapshot.tables.map((table) => [table.logicalName, table]));
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
    const normalized = { ...table };
    if (!Object.prototype.hasOwnProperty.call(expected, 'detailLevel')) {
      delete normalized.detailLevel;
    }
    if (!Object.prototype.hasOwnProperty.call(expected, 'missingDetailClasses')) {
      delete normalized.missingDetailClasses;
    }
    if (stableJson(normalized) !== stableJson(expected)) {
      errors.push(`architect evidence table ${table.logicalName} differs from the snapshot`);
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
  const expectedEvidence = buildArchitectEvidence(snapshot, sourceSnapshotSha256);
  if (stableJson(evidence) !== stableJson(expectedEvidence)) {
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
  return { evidence, snapshot, sourceSnapshotSha256 };
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
    const evidence = buildArchitectEvidence(snapshot, sourceSnapshotSha256);
    const validation = validateArchitectEvidence(evidence, snapshot, sourceSnapshotSha256);
    if (!validation.valid) throw new Error(validation.errors.join('; '));
    atomicWriteJson(output, evidence);
    const result = {
      status: 'DONE',
      output,
      sourceSnapshotSha256,
      concepts: evidence.concepts.length,
      selectedTables: evidence.selectedTables.length,
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
  loadAndValidateArchitectEvidence,
  main,
  sha256,
  stableJson,
  validateArchitectEvidence,
};