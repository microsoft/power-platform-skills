'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSnapshot,
  expandSnapshot,
  loadDetailedEntity,
  requestCombinedBaseMetadata,
  validateSnapshot,
} = require('../create-dataverse-snapshot');

function label(value) {
  return { UserLocalizedLabel: { Label: value } };
}

function entity(logicalName = 'new_inspection', displayName = 'Inspection') {
  return {
    LogicalName: logicalName,
    SchemaName: logicalName,
    EntitySetName: `${logicalName}s`,
    DisplayName: label(displayName),
    DisplayCollectionName: label(`${displayName}s`),
    Description: label(`${displayName} records`),
    PrimaryIdAttribute: `${logicalName}id`,
    PrimaryNameAttribute: 'new_name',
    OwnershipType: 'UserOwned',
    HasActivities: false,
    HasNotes: false,
    IsAvailableOffline: true,
    ChangeTrackingEnabled: true,
    IsCustomEntity: true,
    IsManaged: false,
    IsCustomizable: { Value: true },
    CanCreateAttributes: { Value: true },
    CanBePrimaryEntityInRelationship: { Value: true },
    CanBeRelatedEntityInRelationship: { Value: true },
    CanBeInManyToMany: { Value: true },
  };
}

function attributes() {
  return [
    {
      MetadataId: 'name-id',
      LogicalName: 'new_name',
      SchemaName: 'new_Name',
      AttributeType: 'String',
      AttributeTypeName: { Value: 'StringType' },
      RequiredLevel: { Value: 'ApplicationRequired' },
      IsPrimaryName: true,
      SourceType: 0,
    },
    {
      MetadataId: 'status-id',
      LogicalName: 'new_status',
      SchemaName: 'new_Status',
      AttributeType: 'Picklist',
      AttributeTypeName: { Value: 'PicklistType' },
      SourceType: 0,
    },
    {
      MetadataId: 'site-id',
      LogicalName: 'new_siteid',
      SchemaName: 'new_SiteId',
      AttributeType: 'Lookup',
      AttributeTypeName: { Value: 'LookupType' },
      SourceType: 0,
    },
  ];
}

function fixtureRequest(calls) {
  return async (_method, apiPath) => {
    calls.push(apiPath);
    if (apiPath.includes('/Attributes?$select=')) {
      return { status: 200, data: { value: attributes() } };
    }
    if (apiPath.includes('StringAttributeMetadata')) {
      return { status: 200, data: { value: [{ LogicalName: 'new_name', MaxLength: 200 }] } };
    }
    if (apiPath.includes('PicklistAttributeMetadata')) {
      return { status: 200, data: { value: [{
        LogicalName: 'new_status',
        OptionSet: { Options: [{ Value: 1, Label: label('Open') }] },
      }] } };
    }
    if (apiPath.includes('LookupAttributeMetadata')) {
      return { status: 200, data: { value: [{ LogicalName: 'new_siteid', Targets: ['new_site'] }] } };
    }
    return { status: 200, data: { value: [] } };
  };
}

function typedConcept() {
  return {
    phrase: 'inspection results',
    kind: 'entity',
    discoverTable: true,
    evidence: 'The brief stores inspection results.',
  };
}

test('core detail skips typed and lookup enrichment requests', async () => {
  const coreCalls = [];
  const fullCalls = [];
  const core = await loadDetailedEntity(fixtureRequest(coreCalls), entity(), {
    detailLevel: 'core',
  });
  const full = await loadDetailedEntity(fixtureRequest(fullCalls), entity());

  assert.equal(coreCalls.length, 5);
  assert.ok(fullCalls.length > coreCalls.length);
  assert.equal(core.detailLevel, 'core');
  assert.deepEqual(core.missingDetailClasses.sort(), [
    'choice-options',
    'lookup-targets',
    'typed-constraints',
  ]);
  assert.deepEqual(core.columns.find((column) => column.logicalName === 'new_status').choices, []);
  assert.deepEqual(core.columns.find((column) => column.logicalName === 'new_siteid').lookupTargets, []);
  assert.equal(full.detailLevel, 'full');
  assert.deepEqual(full.missingDetailClasses, []);
  assert.deepEqual(full.columns.find((column) => column.logicalName === 'new_status').choices, [
    { value: 1, label: 'Open' },
  ]);
});

test('combined base read matches sequential normalized evidence and follows pagination', async () => {
  const sequentialCalls = [];
  const sequential = await loadDetailedEntity(fixtureRequest(sequentialCalls), entity(), {
    detailLevel: 'core',
  });
  const combinedCalls = [];
  const combined = await loadDetailedEntity(async (method, apiPath) => {
    assert.equal(method, 'GET');
    combinedCalls.push(apiPath);
    if (apiPath.includes('$expand=Attributes')) {
      return {
        status: 200,
        data: {
          LogicalName: 'new_inspection',
          Attributes: attributes().slice(0, 1),
          'Attributes@odata.nextLink': 'https://example.crm.dynamics.com/api/data/v9.2/attribute-page-2',
          ManyToOneRelationships: [],
          OneToManyRelationships: [],
          ManyToManyRelationships: [],
          Keys: [],
        },
      };
    }
    if (apiPath === 'attribute-page-2') {
      return { status: 200, data: { value: attributes().slice(1) } };
    }
    throw new Error(`Unexpected combined request: ${apiPath}`);
  }, entity(), {
    detailLevel: 'core',
    combinedBaseRead: true,
  });

  assert.deepEqual(combined, sequential);
  assert.equal(sequentialCalls.length, 5);
  assert.equal(combinedCalls.length, 2);
});

test('combined base read fails closed on a malformed or unreadable continuation', async () => {
  await assert.rejects(
    loadDetailedEntity(async (_method, apiPath) => {
      if (apiPath.includes('$expand=Attributes')) {
        return {
          status: 200,
          data: {
            Attributes: [],
            'Attributes@odata.nextLink': 'next-page',
            ManyToOneRelationships: [],
            OneToManyRelationships: [],
            ManyToManyRelationships: [],
            Keys: [],
          },
        };
      }
      return { status: 500, error: 'continuation unavailable' };
    }, entity(), { detailLevel: 'core', combinedBaseRead: true }),
    /continuation failed \(500\): continuation unavailable/,
  );
});

test('combined base read follows relationship continuation links', async () => {
  const result = await requestCombinedBaseMetadata(
    async (_method, apiPath) => {
      if (apiPath.includes('$expand=Attributes')) {
        return {
          status: 200,
          data: {
            Attributes: [],
            ManyToOneRelationships: [{ SchemaName: 'new_First' }],
            'ManyToOneRelationships@odata.nextLink': 'https://example.crm.dynamics.com/api/data/v9.2/relationship-page-2',
            OneToManyRelationships: [],
            ManyToManyRelationships: [],
            Keys: [],
          },
        };
      }
      assert.equal(apiPath, 'relationship-page-2');
      return { status: 200, data: { value: [{ SchemaName: 'new_Second' }] } };
    },
    "EntityDefinitions(LogicalName='new_inspection')",
    'new_inspection',
  );
  assert.deepEqual(
    result.manyToOneRelationships.map((item) => item.SchemaName),
    ['new_First', 'new_Second'],
  );
});

test('progressive typed weak candidates are core while explicit tables remain full', async () => {
  async function request(_method, apiPath) {
    if (apiPath.startsWith('EntityDefinitions?')) {
      return { status: 200, data: { value: [entity()] } };
    }
    return fixtureRequest([])(_method, apiPath);
  }
  const advisory = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    concepts: [typedConcept()],
    progressiveDetail: true,
    request,
  });
  const exact = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    tableNames: ['new_inspection'],
    concepts: [typedConcept()],
    progressiveDetail: true,
    request,
  });

  assert.equal(advisory.tables[0].detailLevel, 'core');
  assert.equal(advisory.detailLoadSummary.coreCandidates, 1);
  assert.equal(exact.tables[0].detailLevel, 'full');
  assert.equal(exact.detailLoadSummary.fullCandidates, 1);
});

test('bounded exact expansion upgrades a core table in place', async () => {
  async function request(_method, apiPath) {
    if (apiPath.startsWith('EntityDefinitions?')) {
      return { status: 200, data: { value: [entity()] } };
    }
    return fixtureRequest([])(_method, apiPath);
  }
  const core = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    concepts: [typedConcept()],
    progressiveDetail: true,
    request,
  });
  const expanded = await expandSnapshot({
    snapshot: core,
    tableNames: ['new_inspection'],
    request,
  });

  assert.equal(expanded.tables.length, 1);
  assert.equal(expanded.tables[0].detailLevel, 'full');
  assert.deepEqual(expanded.expansion.newlyLoadedTables, []);
  assert.deepEqual(expanded.expansion.upgradedTables, ['new_inspection']);
  assert.deepEqual(expanded.exactNameResolution.loadedTables, ['new_inspection']);
  assert.equal(validateSnapshot(expanded).valid, true);
});

test('execution reconciliation rejects core detail', async () => {
  const calls = [];
  const coreTable = await loadDetailedEntity(fixtureRequest(calls), entity(), {
    detailLevel: 'core',
  });
  const malformed = {
    version: 3,
    purpose: 'execution-reconciliation',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    generatedAt: '2026-08-28T00:00:00.000Z',
    inputs: { concepts: [], explicitTableNames: ['new_inspection'], proposedTableNames: [] },
    inventory: [{ logicalName: 'new_inspection', customizable: true }],
    inventoryFacts: { customizableTables: 1, exactNameTables: 1, requiredExactNameTables: 1, proposedCollisionTables: 0, totalTables: 1 },
    candidateRanking: [],
    selectedCandidateEvidence: [],
    tables: [coreTable],
    detailLoadFailures: [],
    detailLoadSummary: { attemptedCandidates: 1, loadedCandidates: 1, failedCandidates: 0 },
    proposedNameChecks: { checked: [], collisions: [], missing: [] },
    exactNameResolution: { requestedTables: ['new_inspection'], loadedTables: ['new_inspection'], unavailableTables: [] },
    timings: { inventoryRetrievalMs: 1, candidateSelectionMs: 0, detailLoadingMs: 1, totalDurationMs: 2 },
  };
  const validation = validateSnapshot(malformed);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('tables[0] execution reconciliation requires full detail'));
});