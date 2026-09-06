'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  getBlockingErrors,
  getRevisionErrors,
  validatePlanningDecisions,
} = require('../validate-dataverse-planning-decisions');

function table(logicalName, detailLevel = 'full') {
  return {
    logicalName,
    schemaName: logicalName,
    detailLevel,
    missingDetailClasses: detailLevel === 'full' ? [] : ['typed-constraints'],
    columns: [],
    manyToOneRelationships: [],
    oneToManyRelationships: [],
    manyToManyRelationships: [],
    alternateKeys: [],
  };
}

function snapshot(tables, proposedChecks = [], detailLoadFailures = []) {
  const inventoryNames = new Set([
    ...tables.map((item) => item.logicalName),
    ...detailLoadFailures.map((failure) => failure.logicalName),
  ]);
  return {
    version: 3,
    purpose: 'foreground-planning',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    generatedAt: '2026-08-28T00:00:00.000Z',
    inputs: { concepts: [], explicitTableNames: [], proposedTableNames: [] },
    inventory: [...inventoryNames].map((logicalName) => ({ logicalName, customizable: true })),
    inventoryFacts: { customizableTables: inventoryNames.size, exactNameTables: 0, requiredExactNameTables: 0, proposedCollisionTables: 0, totalTables: inventoryNames.size },
    candidateRanking: [],
    selectedCandidateEvidence: [],
    tables,
    detailLoadFailures,
    detailLoadSummary: { attemptedCandidates: tables.length + detailLoadFailures.length, loadedCandidates: tables.length, failedCandidates: detailLoadFailures.length },
    proposedNameChecks: {
      checked: proposedChecks,
      collisions: proposedChecks.filter((item) => item.status === 'collision'),
      missing: proposedChecks.filter((item) => item.status === 'missing')
        .map((item) => item.logicalName),
    },
    exactNameResolution: { requestedTables: [], loadedTables: [], unavailableTables: [] },
    timings: { inventoryRetrievalMs: 1, candidateSelectionMs: 1, detailLoadingMs: 1, totalDurationMs: 3 },
  };
}

function contract(decisions) {
  return {
    schemaVersion: 1,
    planningMode: 'required',
    executionEligible: true,
    publisherPrefix: 'new',
    tables: Object.entries(decisions).map(([logicalName, plannedDecision]) => {
      const createsTable = ['create', 'adapt'].includes(plannedDecision);
      return {
        logicalName,
        schemaName: logicalName,
        displayName: logicalName,
        displayCollectionName: `${logicalName}s`,
        primaryIdAttribute: `${logicalName}id`,
        plannedDecision,
        ...(plannedDecision === 'adapt' ? {
          adaptedLogicalName: `${logicalName}v2`,
          adaptedSchemaName: `${logicalName}v2`,
        } : {}),
        dependencyTier: 0,
        serviceRequired: true,
        ownershipType: 'UserOwned',
        columns: createsTable ? [{
          logicalName: `${logicalName}_name`,
          schemaName: `${logicalName}_name`,
          displayName: 'Name',
          type: 'string',
          plannedDecision: 'create',
          requiredLevel: 'ApplicationRequired',
          primaryName: true,
        }] : [],
        relationships: [],
        alternateKeys: [],
      };
    }),
  };
}

test('reuse, extend, and adapt decisions request full metadata for core tables', () => {
  const result = validatePlanningDecisions(
    contract({ new_reuse: 'reuse', new_extend: 'extend', new_adapt: 'adapt' }),
    snapshot([
      table('new_reuse', 'core'),
      table('new_extend', 'full'),
    ]),
  );
  assert.equal(result.valid, false);
  assert.deepEqual(result.contextNames, ['new_adapt', 'new_reuse']);
  assert.deepEqual(result.proposedContextNames, ['new_adaptv2']);
});

test('create decisions require a checked missing proposed name', () => {
  const result = validatePlanningDecisions(
    contract({ new_create: 'create', new_defer: 'defer' }),
    snapshot([]),
  );
  assert.equal(result.valid, false);
  assert.deepEqual(result.contextNames, []);
  assert.deepEqual(result.proposedContextNames, ['new_create']);
});

test('checked missing Create and Adapt names satisfy the collision gate', () => {
  const result = validatePlanningDecisions(
    contract({ new_create: 'create', new_adapt: 'adapt' }),
    snapshot([table('new_adapt')], [
      { logicalName: 'new_create', status: 'missing', existing: null },
      { logicalName: 'new_adaptv2', status: 'missing', existing: null },
    ]),
  );
  assert.deepEqual(result, {
    valid: true,
    errors: [],
    contextNames: [],
    proposedContextNames: [],
  });
});

test('a proposed-name collision makes the approved decision invalid', () => {
  const result = validatePlanningDecisions(
    contract({ new_create: 'create' }),
    snapshot([], [
      { logicalName: 'new_create', status: 'collision', existing: {} },
    ]),
  );
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /new_create is not available \(collision\)/);
});

test('decision revision errors take precedence over missing-context signals', () => {
  const result = validatePlanningDecisions(
    contract({ new_reuse: 'reuse', new_create: 'create' }),
    snapshot([table('new_reuse', 'core')], [
      { logicalName: 'new_create', status: 'collision', existing: {} },
    ]),
  );
  assert.deepEqual(result.contextNames, ['new_reuse']);
  assert.deepEqual(getBlockingErrors(result), []);
  assert.deepEqual(
    getRevisionErrors(result),
    ['proposed table name new_create is not available (collision)'],
  );
});

test('validator CLI requests automatic revision before emitting context signals', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-decisions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const contractPath = path.join(directory, 'contract.json');
  const snapshotPath = path.join(directory, 'snapshot.json');
  fs.writeFileSync(
    contractPath,
    JSON.stringify(contract({ new_reuse: 'reuse', new_create: 'create' })),
  );
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify(snapshot([table('new_reuse', 'core')], [
      { logicalName: 'new_create', status: 'collision', existing: {} },
    ])),
  );

  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'validate-dataverse-planning-decisions.js'),
    '--contract', contractPath,
    '--snapshot', snapshotPath,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /^NEEDS_REVISION: dataverse-plan-validation/m);
  assert.match(result.stderr, /new_create is not available \(collision\)/);
  assert.doesNotMatch(result.stderr, /NEEDS_CONTEXT:/);
});

test('create many-to-many relationships require a checked missing intersect name', () => {
  const source = contract({ new_left: 'create', new_right: 'create' });
  source.tables[0].relationships.push({
    kind: 'many-to-many',
    schemaName: 'new_Left_Right',
    plannedDecision: 'create',
    entity1: 'new_left',
    entity2: 'new_right',
    intersectTable: 'new_left_right',
  });
  const result = validatePlanningDecisions(
    source,
    snapshot([], [
      { logicalName: 'new_left', status: 'missing', existing: null },
      { logicalName: 'new_right', status: 'missing', existing: null },
    ]),
  );
  assert.equal(result.valid, false);
  assert.deepEqual(result.proposedContextNames, ['new_left_right']);
});

test('full evidence satisfies existing-table decisions', () => {
  const result = validatePlanningDecisions(
    contract({ new_reuse: 'reuse', new_extend: 'extend' }),
    snapshot([table('new_reuse'), table('new_extend')]),
  );
  assert.deepEqual(result, {
    valid: true,
    errors: [],
    contextNames: [],
    proposedContextNames: [],
  });
});

test('attempted unavailable detail metadata must be deferred', () => {
  const failure = {
    logicalName: 'new_target',
    selectionReasons: ['concept:targets'],
    status: 500,
    error: 'metadata unavailable',
    required: false,
  };
  const invalid = validatePlanningDecisions(
    contract({ new_target: 'unverified' }),
    snapshot([], [], [failure]),
  );
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.contextNames, ['new_target']);
  assert.match(invalid.errors.join('; '), /must be deferred/);
  assert.deepEqual(
    getRevisionErrors(invalid),
    ['tables with attempted unavailable detail metadata must be deferred'],
  );

  const deferred = validatePlanningDecisions(
    contract({ new_target: 'defer' }),
    snapshot([], [], [failure]),
  );
  assert.deepEqual(deferred, {
    valid: true,
    errors: [],
    contextNames: [],
    proposedContextNames: [],
  });
});