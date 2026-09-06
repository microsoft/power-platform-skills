#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteJson,
  validateSnapshot,
} = require('./create-dataverse-snapshot');

const EVIDENCE_SCHEMA_VERSION = 2;
const GENERIC_TOKENS = new Set([
  'and',
  'data',
  'field',
  'item',
  'record',
  'records',
  'table',
  'tables',
]);
const ESSENTIAL_STANDARD_COLUMNS = new Set([
  'azureactivedirectoryobjectid',
  'emailaddress1',
  'fullname',
  'internalemailaddress',
  'isdisabled',
  'name',
  'statecode',
  'statuscode',
  'systemuserid',
]);
const SYSTEM_PLUMBING_COLUMN = /^(?:created|modified|owner|owning|importsequence|overriddencreatedon|processid|stageid|timezonerule|traversedpath|utcconversion|versionnumber)/;
const SYSTEM_RELATIONSHIP = /^(?:business_unit_|lk_|owner_|team_|user_)/;

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

function compactObject(source, fields) {
  return Object.fromEntries(fields
    .filter((field) => source?.[field] !== undefined)
    .map((field) => [field, source[field]]));
}

function normalizedNeedles(value) {
  const tokens = String(value || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
  const meaningful = tokens.filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token));
  return [...new Set([...meaningful, meaningful.join('')].filter(Boolean))];
}

function relevantConceptNeedles(snapshot) {
  return [...new Set((snapshot.candidateRanking || [])
    .flatMap((ranking) => normalizedNeedles(ranking.concept)))];
}

function compactColumn(column, conceptNeedles) {
  const logicalName = String(column.logicalName || '').toLowerCase();
  const normalizedName = logicalName.replace(/[^a-z0-9]/g, '');
  const conceptMatch = conceptNeedles.some((needle) => normalizedName.includes(needle));
  const keep = column.primaryName
    || ESSENTIAL_STANDARD_COLUMNS.has(logicalName)
    || (column.customAttribute !== false && !column.logical && !column.attributeOf)
    || (conceptMatch && !SYSTEM_PLUMBING_COLUMN.test(logicalName));
  if (!keep || column.primaryId || column.logical || column.attributeOf) return null;
  return compactObject(column, [
    'logicalName',
    'schemaName',
    'type',
    'typeName',
    'maxLength',
    'minValue',
    'maxValue',
    'precision',
    'precisionSource',
    'maxSizeInKB',
    'canStoreFullImage',
    'isPrimaryImage',
    'format',
    'formatName',
    'dateTimeBehavior',
    'defaultValue',
    'requiredLevel',
    'customAttribute',
    'managed',
    'customizable',
    'primaryName',
    'validForCreate',
    'validForRead',
    'validForUpdate',
    'sourceType',
    'sourceTypeMask',
    'lookupTargets',
    'choices',
    'formulaDefinition',
  ]);
}

function compactRelationship(relationship, selectedNames, retainedColumns) {
  const schemaName = String(relationship.schemaName || '');
  const lookupColumn = String(
    relationship.lookupColumn || relationship.referencingAttribute || '',
  ).toLowerCase();
  const endpoints = [
    relationship.targetTable,
    relationship.sourceTable,
    relationship.entity1,
    relationship.entity2,
    relationship.referencingEntity,
    relationship.referencedEntity,
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  const selectedEndpoints = new Set(endpoints.filter((name) => selectedNames.has(name)));
  const relevant = retainedColumns.has(lookupColumn)
    || selectedEndpoints.size > 1
    || (Boolean(lookupColumn)
      && !SYSTEM_RELATIONSHIP.test(schemaName.toLowerCase())
      && !SYSTEM_PLUMBING_COLUMN.test(lookupColumn));
  if (!relevant) return null;
  return compactObject(relationship, [
    'schemaName',
    'lookupColumn',
    'sourceTable',
    'targetTable',
    'targetColumn',
    'entity1',
    'entity2',
    'intersectTable',
    'managed',
    'cascadeConfiguration',
  ]);
}

function compactTable(table, snapshot) {
  const conceptNeedles = relevantConceptNeedles(snapshot);
  const selectedNames = new Set(
    snapshot.tables.map((candidate) => String(candidate.logicalName || '').toLowerCase()),
  );
  const columns = (table.columns || [])
    .map((column) => compactColumn(column, conceptNeedles))
    .filter(Boolean);
  const retainedColumns = new Set(columns.map((column) => column.logicalName.toLowerCase()));
  const compactRelationships = (relationships) => (relationships || [])
    .map((relationship) => compactRelationship(
      relationship,
      selectedNames,
      retainedColumns,
    ))
    .filter(Boolean);
  const manyToOneRelationships = compactRelationships(table.manyToOneRelationships);
  const oneToManyRelationships = compactRelationships(table.oneToManyRelationships);
  const manyToManyRelationships = compactRelationships(table.manyToManyRelationships);
  return {
    ...compactObject(table, [
      'logicalName',
      'schemaName',
      'displayName',
      'displayCollectionName',
      'description',
      'entitySetName',
      'primaryIdAttribute',
      'primaryNameAttribute',
      'ownershipType',
      'hasActivities',
      'hasNotes',
      'isAvailableOffline',
      'changeTrackingEnabled',
      'customEntity',
      'managed',
      'customizable',
      'canCreateAttributes',
      'canBePrimaryEntityInRelationship',
      'canBeRelatedEntityInRelationship',
      'canBeInManyToMany',
      'detailLevel',
      'missingDetailClasses',
    ]),
    detailLevel: table.detailLevel || 'full',
    missingDetailClasses: table.missingDetailClasses || [],
    columns,
    manyToOneRelationships,
    oneToManyRelationships,
    manyToManyRelationships,
    alternateKeys: table.alternateKeys || [],
    evidenceCounts: {
      totalColumns: (table.columns || []).length,
      retainedColumns: columns.length,
      totalRelationships: (table.manyToOneRelationships || []).length
        + (table.oneToManyRelationships || []).length
        + (table.manyToManyRelationships || []).length,
      retainedRelationships: manyToOneRelationships.length
        + oneToManyRelationships.length
        + manyToManyRelationships.length,
      keys: (table.alternateKeys || []).length,
    },
  };
}

function compactNameChecks(checks) {
  const compactExisting = (existing) => existing ? compactObject(existing, [
    'logicalName',
    'schemaName',
    'displayName',
    'displayCollectionName',
    'primaryIdAttribute',
    'primaryNameAttribute',
    'ownershipType',
    'customEntity',
    'managed',
    'customizable',
    'canCreateAttributes',
  ]) : null;
  const checked = (checks?.checked || []).map((item) => ({
    logicalName: item.logicalName,
    status: item.status,
    existing: compactExisting(item.existing),
  }));
  return {
    checked,
    collisions: checked.filter((item) => item.status === 'collision'),
    missing: checked.filter((item) => item.status === 'missing')
      .map((item) => item.logicalName),
  };
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
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    sourceSnapshotSha256,
    generatedAt: snapshot.generatedAt,
    concepts: snapshot.candidateRanking.map((ranking) => ({
      concept: ranking.concept,
      conceptKind: ranking.conceptKind || 'legacy',
      discoverTable: ranking.discoverTable !== false,
      skippedReason: ranking.skippedReason || null,
      preferredPublisherFamily: ranking.preferredPublisherFamily || '',
      topCandidates: (ranking.candidates || []).slice(0, 3).map(architectCandidate),
    })),
    selectedTables: snapshot.tables.map((table) => compactTable(table, snapshot)),
    selectedCandidateEvidence: snapshot.selectedCandidateEvidence || [],
    proposedNameChecks: compactNameChecks(snapshot.proposedNameChecks),
    exactNameResolution: snapshot.exactNameResolution,
    detailLoadFailures: (snapshot.detailLoadFailures || []).map((failure) => compactObject(
      failure,
      ['logicalName', 'selectionReasons', 'status', 'required'],
    )),
    detailLoadSummary: snapshot.detailLoadSummary,
  };
  return JSON.parse(JSON.stringify(evidence));
}

function validateArchitectEvidence(evidence, snapshot, sourceSnapshotSha256) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { valid: false, errors: ['architect evidence must be an object'] };
  }
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    errors.push(`architect evidence schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
  }
  if (evidence.sourceSnapshotSha256 !== sourceSnapshotSha256) {
    errors.push('architect evidence source snapshot hash is stale');
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
    if (stableJson(table) !== stableJson(compactTable(expected, snapshot))) {
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
  EVIDENCE_SCHEMA_VERSION,
  architectCandidate,
  buildArchitectEvidence,
  compactColumn,
  compactTable,
  loadAndValidateArchitectEvidence,
  main,
  sha256,
  stableJson,
  validateArchitectEvidence,
};