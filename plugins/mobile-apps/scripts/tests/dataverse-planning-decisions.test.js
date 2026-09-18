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
    entitySetName: `${logicalName}s`,
    primaryIdAttribute: `${logicalName}id`,
    detailLevel,
    missingDetailClasses: detailLevel === 'full' ? [] : ['typed-constraints'],
    columns: [],
    manyToOneRelationships: [],
    oneToManyRelationships: [],
    manyToManyRelationships: [],
    alternateKeys: [],
    facts: { columnCount: 0, relationshipCount: 0, keyCount: 0 },
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

test('snapshot-only unverified tables require revision even without a detail failure', () => {
  const result = validatePlanningDecisions(
    contract({ new_target: 'unverified' }),
    snapshot([]),
  );
  assert.equal(result.valid, false);
  assert.deepEqual(getBlockingErrors(result), []);
  assert.deepEqual(result.contextNames, []);
  assert.deepEqual(result.proposedContextNames, []);
  assert.match(getRevisionErrors(result).join('; '), /new_target.*unverified.*defer/i);
});

test('snapshot-only unverified columns relationships and keys require revision', () => {
  for (const kind of ['columns', 'relationships', 'alternateKeys']) {
    const source = contract({ new_left: 'extend', new_right: 'reuse' });
    source.tables[0].columns.push({
      logicalName: 'new_code', schemaName: 'new_Code', displayName: 'Code',
      type: 'string', plannedDecision: 'reuse',
    });
    if (kind === 'relationships') {
      source.tables[0].relationships.push({
        kind: 'many-to-many', schemaName: 'new_Left_Right', plannedDecision: 'reuse',
        entity1: 'new_left', entity2: 'new_right', intersectTable: 'new_left_right',
      });
    } else if (kind === 'alternateKeys') {
      source.tables[0].alternateKeys.push({
        schemaName: 'new_Left_Code', plannedDecision: 'reuse', columns: ['new_code'],
      });
    }
    const component = source.tables[0][kind][0];
    component.plannedDecision = 'unverified';
    const evidence = snapshot([table('new_left'), table('new_right')]);
    const result = validatePlanningDecisions(source, evidence);
    assert.equal(result.valid, false, kind);
    assert.deepEqual(getBlockingErrors(result), [], kind);
    assert.deepEqual(result.contextNames, [], kind);
    assert.deepEqual(result.proposedContextNames, [], kind);
    assert.match(getRevisionErrors(result).join('; '), /unverified.*defer/i, kind);
    component.plannedDecision = 'defer';
    assert.equal(validatePlanningDecisions(source, evidence).valid, true, kind);
  }
});

test('unverified CLI decisions request revision instead of approval or extra discovery', (testContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-unverified-'));
  testContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const contractPath = path.join(directory, 'contract.json');
  const snapshotPath = path.join(directory, 'snapshot.json');
  fs.writeFileSync(contractPath, JSON.stringify(contract({ new_target: 'unverified' })));
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot([])));
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'validate-dataverse-planning-decisions.js'),
    '--contract', contractPath, '--snapshot', snapshotPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /^NEEDS_REVISION: dataverse-plan-validation/m);
  assert.match(result.stderr, /new_target.*unverified.*defer/);
  assert.doesNotMatch(result.stderr, /NEEDS_CONTEXT:|BLOCKED:/);
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
    [
      'tables with attempted unavailable detail metadata must be deferred',
      'table new_target is unverified; revise the decision from snapshot evidence or defer it',
    ],
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

function computedFixture(decision = 'reuse') {
  const source = contract({ new_item: decision });
  const column = {
    logicalName: 'new_total', schemaName: 'new_Total', type: 'computed',
    attributeType: 'Decimal', sourceType: 1, sourceTypeMask: 0,
    formulaDefinition: 'new_quantity * new_price', plannedDecision: 'reuse',
  };
  source.tables[0].columns.push(column);
  const evidence = table('new_item');
  evidence.columns.push({
    logicalName: column.logicalName, type: 'Decimal', sourceType: 1,
    computed: {
      metadataStatus: 'available', sourceType: 1, sourceTypeMask: 0,
      formulaDefinition: column.formulaDefinition,
    },
  });
  evidence.facts.columnCount = 1;
  const checks = decision === 'adapt'
    ? [{ logicalName: 'new_itemv2', status: 'missing', existing: null }]
    : [];
  return { source, evidence, checks };
}

test('required computed metadata must be available before an existing-table decision', () => {
  for (const decision of ['reuse', 'extend', 'adapt']) {
    const { source, evidence, checks } = computedFixture(decision);
    evidence.columns[0].computed.metadataStatus = 'unavailable';
    const result = validatePlanningDecisions(source, snapshot([evidence], checks));
    assert.equal(result.valid, false, decision);
    assert.deepEqual(result.contextNames, []);
    assert.match(getRevisionErrors(result).join('; '), /new_item.new_total.*defer the column/);
  }
});

test('computed evidence must match the contract and cannot claim availability with missing facts', () => {
  const { source, evidence } = computedFixture();
  assert.equal(validatePlanningDecisions(source, snapshot([evidence])).valid, true);
  for (const updates of [
    { sourceTypeMask: null }, { sourceTypeMask: 32 }, { sourceType: null },
    { formulaDefinition: '' }, { formulaDefinition: 'new_quantity + new_price' },
  ]) {
    const changed = structuredClone(evidence);
    Object.assign(changed.columns[0].computed, updates);
    const result = validatePlanningDecisions(source, snapshot([changed]));
    assert.equal(result.valid, false, JSON.stringify(updates));
    assert.ok(getRevisionErrors(result).length > 0);
  }
});

test('unused and explicitly deferred computed columns do not prevent reuse', () => {
  const { source, evidence } = computedFixture();
  evidence.columns[0].computed.metadataStatus = 'unavailable';
  source.tables[0].columns[0].plannedDecision = 'defer';
  assert.equal(validatePlanningDecisions(source, snapshot([evidence])).valid, true);
  source.tables[0].columns = [];
  assert.equal(validatePlanningDecisions(source, snapshot([evidence])).valid, true);
});

test('required computed columns on core tables request expansion before deferral', () => {
  const { source, evidence } = computedFixture();
  evidence.detailLevel = 'core';
  evidence.missingDetailClasses = ['computed-metadata'];
  evidence.columns[0].computed = null;
  const result = validatePlanningDecisions(source, snapshot([evidence]));
  assert.deepEqual(result.contextNames, ['new_item']);
  assert.deepEqual(getRevisionErrors(result), []);
});