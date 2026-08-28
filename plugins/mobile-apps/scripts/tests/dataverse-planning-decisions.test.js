'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { validatePlanningDecisions } = require('../validate-dataverse-planning-decisions');

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

function snapshot(tables) {
  return {
    version: 3,
    purpose: 'foreground-planning',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    generatedAt: '2026-08-28T00:00:00.000Z',
    inputs: { concepts: [], explicitTableNames: [], proposedTableNames: [] },
    inventory: tables.map((item) => ({ logicalName: item.logicalName, customizable: true })),
    inventoryFacts: { customizableTables: tables.length, exactNameTables: 0, requiredExactNameTables: 0, proposedCollisionTables: 0, totalTables: tables.length },
    candidateRanking: [],
    selectedCandidateEvidence: [],
    tables,
    detailLoadFailures: [],
    detailLoadSummary: { attemptedCandidates: tables.length, loadedCandidates: tables.length, failedCandidates: 0 },
    proposedNameChecks: { checked: [], collisions: [], missing: [] },
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
});

test('create and defer decisions do not require existing full table detail', () => {
  const result = validatePlanningDecisions(
    contract({ new_create: 'create', new_defer: 'defer' }),
    snapshot([]),
  );
  assert.deepEqual(result, { valid: true, errors: [], contextNames: [] });
});

test('full evidence satisfies existing-table decisions', () => {
  const result = validatePlanningDecisions(
    contract({ new_reuse: 'reuse', new_extend: 'extend' }),
    snapshot([table('new_reuse'), table('new_extend')]),
  );
  assert.deepEqual(result, { valid: true, errors: [], contextNames: [] });
});