'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  promotePlanningGeneration,
  validatePlanningGenerationPointer,
} = require('../refresh-dataverse-planning-evidence');

function snapshot(generatedAt = '2026-08-29T00:00:00.000Z') {
  const table = {
    logicalName: 'new_item',
    schemaName: 'new_Item',
    columns: [{ logicalName: 'new_name', type: 'String', primaryName: true }],
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
    generatedAt,
    inputs: { concepts: [], explicitTableNames: ['new_item'], proposedTableNames: [] },
    inventory: [{ logicalName: 'new_item', customizable: true }],
    inventoryFacts: {
      customizableTables: 1,
      exactNameTables: 1,
      requiredExactNameTables: 1,
      proposedCollisionTables: 0,
      totalTables: 1,
    },
    candidateRanking: [],
    selectedCandidateEvidence: [{
      logicalName: 'new_item',
      reasons: ['explicit-table'],
      required: true,
      detailStatus: 'loaded',
      detailFailure: null,
    }],
    tables: [table],
    detailLoadFailures: [],
    detailLoadSummary: { attemptedCandidates: 1, loadedCandidates: 1, failedCandidates: 0 },
    proposedNameChecks: { checked: [], collisions: [], missing: [] },
    exactNameResolution: {
      requestedTables: ['new_item'],
      loadedTables: ['new_item'],
      unavailableTables: [],
    },
    timings: {
      inventoryRetrievalMs: 1,
      candidateSelectionMs: 1,
      detailLoadingMs: 1,
      totalDurationMs: 3,
    },
  };
}

function fixture(testContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataverse-generation-'));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    snapshotFile: path.join(root, 'staged-snapshot.json'),
    generationsDir: path.join(root, 'generations'),
    pointerFile: path.join(root, 'current.json'),
  };
}

test('planning generation promotes one validated immutable directory and pointer', (context) => {
  const files = fixture(context);
  fs.writeFileSync(files.snapshotFile, `${JSON.stringify(snapshot(), null, 2)}\n`);
  const promoted = promotePlanningGeneration(files);
  assert.equal(promoted.generationId.length, 64);
  assert.equal(fs.existsSync(promoted.snapshotPath), true);
  assert.equal(fs.existsSync(promoted.evidencePath), true);
  assert.equal(fs.existsSync(promoted.manifestPath), true);
  assert.equal(fs.existsSync(files.pointerFile), true);
  assert.deepEqual(validatePlanningGenerationPointer(files.pointerFile), promoted);
  assert.equal(
    fs.readdirSync(files.generationsDir).some((name) => name.startsWith('.tmp-')),
    false,
  );
});

test('failed generation leaves the previous current pointer unchanged', (context) => {
  const files = fixture(context);
  fs.writeFileSync(files.snapshotFile, `${JSON.stringify(snapshot(), null, 2)}\n`);
  const first = promotePlanningGeneration(files);
  const pointerBefore = fs.readFileSync(files.pointerFile, 'utf8');
  fs.writeFileSync(
    files.snapshotFile,
    `${JSON.stringify(snapshot('2026-08-29T00:01:00.000Z'), null, 2)}\n`,
  );
  assert.throws(
    () => promotePlanningGeneration({
      ...files,
      buildBundle: () => {
        throw new Error('planned render failure');
      },
    }),
    /planned render failure/,
  );
  assert.equal(fs.readFileSync(files.pointerFile, 'utf8'), pointerBefore);
  assert.deepEqual(validatePlanningGenerationPointer(files.pointerFile), first);
});

test('re-promoting the same snapshot is idempotent', (context) => {
  const files = fixture(context);
  fs.writeFileSync(files.snapshotFile, `${JSON.stringify(snapshot(), null, 2)}\n`);
  const first = promotePlanningGeneration(files);
  const second = promotePlanningGeneration(files);
  assert.equal(second.generationId, first.generationId);
  assert.equal(fs.readdirSync(files.generationsDir).length, 1);
});

test('tampered current generation fails pointer validation', (context) => {
  const files = fixture(context);
  fs.writeFileSync(files.snapshotFile, `${JSON.stringify(snapshot(), null, 2)}\n`);
  const promoted = promotePlanningGeneration(files);
  fs.appendFileSync(promoted.evidencePath, 'tampered');
  assert.throws(
    () => validatePlanningGenerationPointer(files.pointerFile),
    /evidence hash does not match|Unexpected non-whitespace character/,
  );
});