'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildArchitectEvidence,
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
  assert.ok(validation.errors.some((error) => /differs from the snapshot/.test(error)));
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
    1,
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