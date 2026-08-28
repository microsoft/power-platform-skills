'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildArchitectEvidence,
  buildArchitectEvidenceBundle,
  loadAndValidateArchitectEvidence,
  sha256,
  validateArchitectEvidence,
} = require('../render-dataverse-architect-evidence');

function snapshot() {
  const table = {
    logicalName: 'new_goodsreception',
    schemaName: 'new_GoodsReception',
    columns: [{ logicalName: 'new_name', type: 'String' }],
    manyToOneRelationships: [],
    oneToManyRelationships: [],
    manyToManyRelationships: [],
    alternateKeys: [],
    facts: { columnCount: 1, relationshipCount: 0, keyCount: 0 },
  };
  return {
    version: 3,
    purpose: 'foreground-planning',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    generatedAt: '2026-08-28T00:00:00.000Z',
    inputs: { concepts: [], explicitTableNames: [], proposedTableNames: [] },
    inventory: [
      { logicalName: 'new_goodsreception', customizable: true },
      { logicalName: 'new_unselected', customizable: true },
    ],
    inventoryFacts: {
      customizableTables: 2,
      exactNameTables: 0,
      requiredExactNameTables: 0,
      proposedCollisionTables: 0,
      totalTables: 2,
    },
    candidateRanking: [{
      concept: 'goods receptions',
      conceptKind: 'entity',
      discoverTable: true,
      skippedReason: null,
      preferredPublisherFamily: 'new',
      candidates: [
        { rank: 1, logicalName: 'new_goodsreception', score: 999, reasons: ['exact:goodreception'], matchClass: 'exact', detailed: true },
        { rank: 2, logicalName: 'new_unselected', score: 500, reasons: ['token:reception'], matchClass: 'token', detailed: false },
        { rank: 3, logicalName: 'new_third', score: 400, reasons: ['partial-token:reception'], matchClass: 'partial-token', detailed: false },
        { rank: 4, logicalName: 'new_fourth', score: 399, reasons: ['partial-token:reception'], matchClass: 'partial-token', detailed: false },
      ],
    }],
    selectedCandidateEvidence: [{ logicalName: table.logicalName, reasons: ['concept:goods receptions:primary'], required: false, detailStatus: 'loaded', detailFailure: null }],
    tables: [table],
    detailLoadFailures: [],
    detailLoadSummary: { attemptedCandidates: 1, loadedCandidates: 1, failedCandidates: 0 },
    proposedNameChecks: { checked: [], collisions: [], missing: [] },
    exactNameResolution: { requestedTables: [], loadedTables: [], unavailableTables: [] },
    timings: { inventoryRetrievalMs: 1, candidateSelectionMs: 1, detailLoadingMs: 1, totalDurationMs: 3 },
  };
}

function highFanoutSnapshot() {
  const source = snapshot();
  const systemUser = {
    logicalName: 'systemuser',
    schemaName: 'SystemUser',
    entitySetName: 'systemusers',
    primaryIdAttribute: 'systemuserid',
    primaryNameAttribute: 'fullname',
    customEntity: false,
    columns: [
      { logicalName: 'systemuserid', type: 'Uniqueidentifier', primaryId: true },
      { logicalName: 'fullname', type: 'String', primaryName: true },
      { logicalName: 'internalemailaddress', type: 'String' },
    ],
    manyToOneRelationships: [],
    oneToManyRelationships: [
      {
        schemaName: 'lk_new_goodsreception_createdby',
        childTable: 'new_goodsreception',
        childLookupColumn: 'createdby',
        parentColumn: 'systemuserid',
        managed: false,
      },
      ...Array.from({ length: 4001 }, (_, index) => ({
        schemaName: `lk_unrelated_${index}`,
        childTable: `unrelated_${index}`,
        childLookupColumn: 'createdby',
        parentColumn: 'systemuserid',
        managed: true,
      })),
    ],
    manyToManyRelationships: [],
    alternateKeys: [{
      logicalName: 'aadobjectid',
      schemaName: 'aadobjectid',
      columns: ['internalemailaddress'],
      status: 'Active',
    }],
    facts: { columnCount: 3, relationshipCount: 4002, keyCount: 1 },
  };
  const reception = {
    logicalName: 'new_goodsreception',
    schemaName: 'new_GoodsReception',
    entitySetName: 'new_goodsreceptions',
    primaryIdAttribute: 'new_goodsreceptionid',
    primaryNameAttribute: 'new_name',
    customEntity: true,
    columns: [
      { logicalName: 'new_goodsreceptionid', type: 'Uniqueidentifier', primaryId: true },
      { logicalName: 'new_name', type: 'String', primaryName: true, customAttribute: true },
      {
        logicalName: 'new_inspectorid',
        type: 'Lookup',
        customAttribute: true,
        lookupTargets: ['systemuser'],
      },
    ],
    manyToOneRelationships: [{
      schemaName: 'new_goodsreception_inspector',
      lookupColumn: 'new_inspectorid',
      targetTable: 'systemuser',
      targetColumn: 'systemuserid',
      managed: false,
    }],
    oneToManyRelationships: [],
    manyToManyRelationships: [],
    alternateKeys: [],
    facts: { columnCount: 3, relationshipCount: 1, keyCount: 0 },
  };
  source.inventory = [
    { logicalName: 'new_goodsreception', customizable: true },
    { logicalName: 'systemuser', customizable: true },
  ];
  source.inventoryFacts = {
    customizableTables: 2,
    exactNameTables: 2,
    requiredExactNameTables: 2,
    proposedCollisionTables: 0,
    totalTables: 2,
  };
  source.tables = [reception, systemUser];
  source.selectedCandidateEvidence = source.tables.map((table) => ({
    logicalName: table.logicalName,
    reasons: ['explicit-table'],
    required: true,
    detailStatus: 'loaded',
    detailFailure: null,
  }));
  source.detailLoadSummary = {
    attemptedCandidates: 2,
    loadedCandidates: 2,
    failedCandidates: 0,
  };
  source.exactNameResolution = {
    requestedTables: ['new_goodsreception', 'systemuser'],
    loadedTables: ['new_goodsreception', 'systemuser'],
    unavailableTables: [],
  };
  return source;
}

test('architect evidence excludes unselected inventory and caps candidate summaries', () => {
  const source = snapshot();
  const hash = 'a'.repeat(64);
  const evidence = buildArchitectEvidence(source, hash);
  assert.deepEqual(evidence.selectedTables.map((table) => table.logicalName), [
    'new_goodsreception',
  ]);
  assert.equal(evidence.concepts[0].topCandidates.length, 3);
  assert.doesNotMatch(JSON.stringify(evidence), /new_unselected.*customizable/);
  assert.deepEqual(validateArchitectEvidence(evidence, source, hash), {
    valid: true,
    errors: [],
  });
});

test('architect evidence detects stale hashes and changed selected facts', () => {
  const source = snapshot();
  const evidence = buildArchitectEvidence(source, 'a'.repeat(64));
  evidence.selectedTables[0].columns[0].type = 'Integer';
  const validation = validateArchitectEvidence(evidence, source, 'b'.repeat(64));
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('architect evidence source snapshot hash is stale'));
  assert.ok(validation.errors.some((error) => /differs from the projection/.test(error)));
  assert.ok(validation.errors.includes(
    'architect evidence differs from the deterministic snapshot projection',
  ));
});

test('architect evidence detects tampered candidate and name-check projections', () => {
  const source = snapshot();
  const hash = 'a'.repeat(64);
  const evidence = buildArchitectEvidence(source, hash);
  evidence.concepts[0].topCandidates[0].score = -1;
  evidence.proposedNameChecks.missing.push('new_injected');
  const validation = validateArchitectEvidence(evidence, source, hash);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes(
    'architect evidence differs from the deterministic snapshot projection',
  ));
});

test('architect evidence is materially smaller when inventory is large', () => {
  const source = snapshot();
  source.inventory.push(...Array.from({ length: 500 }, (_, index) => ({
    logicalName: `new_inventory${index}`,
    description: 'Inventory-only table that is deliberately excluded from architect evidence.',
    customizable: true,
  })));
  source.inventoryFacts.customizableTables = source.inventory.length;
  source.inventoryFacts.totalTables = source.inventory.length;
  const evidence = buildArchitectEvidence(source, 'a'.repeat(64));
  assert.ok(
    Buffer.byteLength(JSON.stringify(evidence))
      < Buffer.byteLength(JSON.stringify(source)) * 0.5,
  );
});

test('high-fan-out platform relationships are indexed outside bounded model evidence', () => {
  const source = highFanoutSnapshot();
  const original = structuredClone(source);
  const bundle = buildArchitectEvidenceBundle(source, 'a'.repeat(64));
  const user = bundle.evidence.selectedTables.find(
    (table) => table.logicalName === 'systemuser',
  );
  assert.equal(bundle.evidence.schemaVersion, 2);
  assert.deepEqual(
    user.oneToManyRelationships.map((relationship) => relationship.schemaName),
    ['lk_new_goodsreception_createdby'],
  );
  assert.equal(user.projectionSummary.omittedRelationships, 4001);
  assert.equal(bundle.shards.length, 1);
  assert.equal(bundle.shards[0].tableLogicalName, 'systemuser');
  assert.equal(bundle.shards[0].relationshipIndex.length, 4001);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle.evidence)) <= 500 * 1024);
  assert.deepEqual(source, original);
});

test('file validation detects a sidecar stale against the full snapshot', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-evidence-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshotFile = path.join(directory, 'snapshot.json');
  const evidenceFile = path.join(directory, 'evidence.json');
  const sourceSnapshot = snapshot();
  const source = `${JSON.stringify(sourceSnapshot, null, 2)}\n`;
  fs.writeFileSync(snapshotFile, source);
  fs.writeFileSync(
    evidenceFile,
    JSON.stringify(buildArchitectEvidence(sourceSnapshot, sha256(source))),
  );

  assert.equal(
    loadAndValidateArchitectEvidence(snapshotFile, evidenceFile).evidence.schemaVersion,
    2,
  );
  fs.writeFileSync(
    snapshotFile,
    `${JSON.stringify({ ...sourceSnapshot, generatedAt: '2026-08-28T00:01:00.000Z' }, null, 2)}\n`,
  );
  assert.throws(
    () => loadAndValidateArchitectEvidence(snapshotFile, evidenceFile),
    /source snapshot hash is stale/,
  );
});