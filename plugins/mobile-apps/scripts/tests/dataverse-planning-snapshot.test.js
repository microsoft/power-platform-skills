'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { composeCreateMobileAppWorkflow } = require('./workflow-test-helpers');

const {
  analyzeProposedNames,
  atomicWriteFile,
  canonicalAttributeType,
  createCliRequest,
  createReconciliationSnapshot,
  createSnapshot,
  expandSnapshot,
  loadDetailedEntity,
  normalizedTokens,
  parseArgs,
  rankCandidatesByConcept,
  selectDetailedCandidates,
  selectDetailedEntities,
  singularizeToken,
  validateSnapshot,
} = require('../create-dataverse-snapshot');
const { renderPlanningEvidence } = require('../render-dataverse-planning-evidence');

function label(value) {
  return { UserLocalizedLabel: { Label: value } };
}

test('canonicalizes Dataverse virtual File and Image attribute types', () => {
  assert.equal(canonicalAttributeType('Virtual', { Value: 'FileType' }), 'File');
  assert.equal(canonicalAttributeType('Virtual', { Value: 'ImageType' }), 'Image');
  assert.equal(canonicalAttributeType('Virtual', { Value: 'StringType' }), 'Virtual');
  assert.equal(canonicalAttributeType('String', { Value: 'StringType' }), 'String');
});

function entity(logicalName, displayName, overrides = {}) {
  return {
    LogicalName: logicalName,
    SchemaName: logicalName,
    EntitySetName: `${logicalName}s`,
    DisplayName: label(displayName),
    DisplayCollectionName: label(`${displayName}s`),
    Description: label(`${displayName} records`),
    PrimaryIdAttribute: `${logicalName}id`,
    PrimaryNameAttribute: `${logicalName}name`,
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
    ...overrides,
  };
}

function normalizeInventoryForTest(value) {
  return {
    logicalName: value.LogicalName,
    schemaName: value.SchemaName,
    displayName: value.DisplayName.UserLocalizedLabel.Label,
    displayCollectionName: value.DisplayCollectionName.UserLocalizedLabel.Label,
    description: value.Description.UserLocalizedLabel.Label,
    entitySetName: value.EntitySetName,
    primaryIdAttribute: value.PrimaryIdAttribute,
    primaryNameAttribute: value.PrimaryNameAttribute,
    ownershipType: value.OwnershipType,
    hasActivities: value.HasActivities,
    hasNotes: value.HasNotes,
    isAvailableOffline: value.IsAvailableOffline,
    changeTrackingEnabled: value.ChangeTrackingEnabled,
    customEntity: value.IsCustomEntity,
    managed: value.IsManaged,
    customizable: value.IsCustomizable.Value,
    canCreateAttributes: value.CanCreateAttributes.Value,
    canBePrimaryEntityInRelationship: value.CanBePrimaryEntityInRelationship.Value,
    canBeRelatedEntityInRelationship: value.CanBeRelatedEntityInRelationship.Value,
    canBeInManyToMany: value.CanBeInManyToMany.Value,
  };
}

function projectScratch(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, '.scratch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function validSnapshotBase(overrides = {}) {
  const snapshot = {
    version: 3,
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    generatedAt: '2026-08-18T05:00:00.000Z',
    inputs: { concepts: [], explicitTableNames: [], proposedTableNames: [] },
    inventory: [],
    candidateRanking: [],
    selectedCandidateEvidence: [],
    tables: [],
    detailLoadFailures: [],
    proposedNameChecks: { checked: [], collisions: [], missing: [] },
    exactNameResolution: {
      requestedTables: [],
      loadedTables: [],
      unavailableTables: [],
    },
    timings: {
      inventoryRetrievalMs: 20,
      candidateSelectionMs: 2,
      detailLoadingMs: 0,
      totalDurationMs: 22,
    },
    ...overrides,
  };
  snapshot.inventoryFacts = overrides.inventoryFacts || {
    customizableTables: snapshot.inventory.length,
    exactNameTables: 0,
    requiredExactNameTables: 0,
    proposedCollisionTables: snapshot.proposedNameChecks.collisions.length,
    totalTables: snapshot.inventory.length,
  };
  snapshot.detailLoadSummary = overrides.detailLoadSummary || {
    attemptedCandidates: snapshot.tables.length + snapshot.detailLoadFailures.length,
    loadedCandidates: snapshot.tables.length,
    failedCandidates: snapshot.detailLoadFailures.length,
  };
  return snapshot;
}

test('concept ranking normalizes plurals and maps workflow families', () => {
  assert.equal(singularizeToken('activities'), 'activity');
  assert.equal(singularizeToken('batches'), 'batch');
  assert.deepEqual(normalizedTokens('Medical assessments'), ['medical', 'assessment']);

  const rankings = rankCandidatesByConcept([
    entity('wr_medicalassessment', 'Medical Assessment'),
    entity('wr_careactivity', 'Care Activity'),
  ], ['medical assessments', 'care activities']);

  assert.equal(rankings[0].candidates[0].logicalName, 'wr_medicalassessment');
  assert.equal(rankings[1].candidates[0].logicalName, 'wr_careactivity');
});

test('CLI parsing preserves intentionally empty optional lists', () => {
  assert.deepEqual(
    parseArgs(['node', 'script', '--tables', '', '--json']),
    { tables: '', json: true },
  );
});

test('selection prefers shortest unversioned tables in the best publisher family', () => {
  const entities = [
    entity('new_product', 'Product'),
    entity('new_productv2', 'Product'),
    entity('twd_product', 'Product'),
    entity('new_batch', 'Batch'),
  ];
  const rankings = rankCandidatesByConcept(entities, ['products', 'batches']);
  const productRanking = rankings.find((item) => item.concept === 'products');
  assert.equal(productRanking.preferredPublisherFamily, 'new');
  assert.equal(productRanking.candidates[0].logicalName, 'new_product');
  assert.equal(productRanking.candidates.find((item) => item.logicalName === 'new_productv2').versioned, true);

  const selected = selectDetailedEntities(entities, [], ['products', 'batches'])
    .map((item) => item.LogicalName);
  assert.deepEqual(selected, ['new_batch', 'new_product']);
});

test('explicit table names are always included when present', () => {
  const entities = [
    entity('new_product', 'Product'),
    entity('new_unrelatedaudit', 'Audit Ledger'),
  ];
  const selected = selectDetailedEntities(
    entities,
    ['new_unrelatedaudit'],
    ['products'],
  ).map((item) => item.LogicalName);
  assert.deepEqual(selected, ['new_product', 'new_unrelatedaudit']);
});

test('exact-covered concepts suppress unnecessary advisory alternatives', () => {
  const selection = selectDetailedCandidates([
    entity('new_product', 'Product'),
    entity('other_product', 'Product'),
  ], ['new_product'], ['products']);

  assert.deepEqual(
    selection.selectedEntities.map((item) => item.LogicalName),
    ['new_product'],
  );
  assert.deepEqual(selection.detailSelectionSummary, {
    requiredCandidates: 1,
    advisoryCandidates: 0,
    exactCoveredConcepts: 1,
    unresolvedConcepts: 0,
    advisoryLimit: 40,
  });
});

test('advisory allocation covers every concept before adding alternatives', () => {
  const concepts = Array.from({ length: 20 }, (_, index) => `domain${index}`);
  const entities = concepts.flatMap((concept) => [
    entity(`new_${concept}`, concept),
    entity(`new_${concept}detail`, concept),
    entity(`new_${concept}log`, concept),
  ]);
  const selection = selectDetailedCandidates(entities, [], concepts);
  const selected = new Set(selection.selectedEntities.map((item) => item.LogicalName));

  assert.equal(selection.detailSelectionSummary.advisoryCandidates, 40);
  for (const concept of concepts) {
    assert.ok(selected.has(`new_${concept}`), `${concept} should keep its best candidate`);
  }
});

test('one-per-concept quality coverage may exceed the advisory target', () => {
  const concepts = Array.from({ length: 45 }, (_, index) => `workflow${index}`);
  const selection = selectDetailedCandidates(
    concepts.map((concept) => entity(`new_${concept}`, concept)),
    [],
    concepts,
  );

  assert.equal(selection.detailSelectionSummary.advisoryCandidates, 45);
  assert.equal(selection.detailSelectionSummary.advisoryLimit, 45);
  assert.equal(selection.selectedEntities.length, 45);
});

test('proposed logical-name checks distinguish collisions and missing names', () => {
  const result = analyzeProposedNames(
    [entity('new_product', 'Product')],
    ['new_product', 'new_inventoryreview'],
  );
  assert.deepEqual(result.collisions.map((item) => item.logicalName), ['new_product']);
  assert.deepEqual(result.missing, ['new_inventoryreview']);
  assert.equal(result.checked[0].status, 'missing');
  assert.equal(result.checked[1].status, 'collision');
});

test('fresh reconciliation is bounded to exact approved names and reloads full metadata', async () => {
  const calls = [];
  const reconciliation = await createReconciliationSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    tableNames: ['new_product', 'new_missing'],
    proposedTableNames: ['new_missing'],
    nowIso: () => '2026-08-19T00:00:00.000Z',
    request: async (_method, apiPath) => {
      calls.push(apiPath);
      if (apiPath.startsWith('EntityDefinitions?')) {
        return { status: 200, data: { value: [entity('new_product', 'Product')] } };
      }
      if (apiPath.includes('/Attributes?$select=')) {
        return { status: 200, data: { value: [{
          MetadataId: 'name-id',
          LogicalName: 'new_name',
          SchemaName: 'new_Name',
          AttributeType: 'String',
          AttributeTypeName: { Value: 'StringType' },
          RequiredLevel: { Value: 'None' },
          IsPrimaryName: true,
          SourceType: 0,
        }] } };
      }
      if (apiPath.includes('StringAttributeMetadata')) {
        return { status: 200, data: { value: [{
          LogicalName: 'new_name',
          MaxLength: 200,
          FormatName: { Value: 'Text' },
        }] } };
      }
      if (apiPath.includes('/ManyToOneRelationships?')) {
        return { status: 200, data: { value: [{
          SchemaName: 'new_Category_Product',
          ReferencingAttribute: 'new_categoryid',
          ReferencedEntity: 'new_category',
          ReferencedAttribute: 'new_categoryid',
          IsManaged: false,
          CascadeConfiguration: {
            Assign: 'NoCascade',
            Delete: 'RemoveLink',
            Merge: 'NoCascade',
            Reparent: 'NoCascade',
            Share: 'NoCascade',
            Unshare: 'NoCascade',
            RollupView: 'NoCascade',
          },
        }] } };
      }
      return { status: 200, data: { value: [] } };
    },
  });

  assert.equal(reconciliation.purpose, 'execution-reconciliation');
  assert.deepEqual(reconciliation.reconciliation, {
    boundedExactNames: true,
    fullInventoryRead: false,
    tables: ['new_missing', 'new_product'],
    proposedNames: ['new_missing'],
  });
  assert.deepEqual(reconciliation.exactNameResolution, {
    requestedTables: ['new_missing', 'new_product'],
    loadedTables: ['new_product'],
    unavailableTables: ['new_missing'],
  });
  assert.equal(
    calls.some((apiPath) => apiPath.includes('IsCustomizable/Value eq true')),
    false,
  );
  assert.equal(
    calls.filter((apiPath) => apiPath.includes('/Attributes?$select=')).length,
    1,
  );
  assert.match(calls[0], /CanBePrimaryEntityInRelationship/);
  assert.match(calls[0], /CanBeRelatedEntityInRelationship/);
  assert.match(calls[0], /CanBeInManyToMany/);
  assert.match(calls[0], /OwnershipType/);
  assert.match(calls[0], /HasActivities/);
  assert.match(calls[0], /HasNotes/);
  assert.match(calls[0], /IsAvailableOffline/);
  assert.match(calls[0], /ChangeTrackingEnabled/);
  assert.equal(reconciliation.tables[0].canBeRelatedEntityInRelationship, true);
  assert.equal(reconciliation.tables[0].ownershipType, 'UserOwned');
  assert.equal(reconciliation.tables[0].isAvailableOffline, true);
  assert.match(
    calls.find((apiPath) => apiPath.includes('/ManyToOneRelationships?')),
    /CascadeConfiguration/,
  );
  assert.equal(
    reconciliation.tables[0].manyToOneRelationships[0]
      .cascadeConfiguration.Delete,
    'RemoveLink',
  );
});

test('proposed names are collision checks and stay out of required exact-name loading', async () => {
  const calls = [];
  const snapshot = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    proposedTableNames: ['new_product', 'new_missing'],
    request: async (_method, apiPath) => {
      calls.push(apiPath);
      if (apiPath.includes('IsCustomizable/Value eq true')) {
        return { status: 200, data: { value: [] } };
      }
      if (apiPath.startsWith('EntityDefinitions?')) {
        return { status: 200, data: { value: [entity('new_product', 'Product')] } };
      }
      return { status: 200, data: { value: [] } };
    },
  });

  assert.deepEqual(snapshot.exactNameResolution, {
    requestedTables: [],
    loadedTables: [],
    unavailableTables: [],
  });
  assert.deepEqual(snapshot.proposedNameChecks.missing, ['new_missing']);
  assert.deepEqual(
    snapshot.proposedNameChecks.collisions.map((item) => item.logicalName),
    ['new_product'],
  );
  assert.deepEqual(snapshot.tables, []);
  assert.deepEqual(snapshot.detailLoadSummary, {
    attemptedCandidates: 0,
    loadedCandidates: 0,
    failedCandidates: 0,
    requiredCandidates: 0,
    advisoryCandidates: 0,
    exactCoveredConcepts: 0,
    unresolvedConcepts: 0,
    advisoryLimit: 40,
  });
  assert.equal(calls.some((apiPath) => apiPath.includes('/Attributes?$select=')), false);
});

test('unreadable exact-name metadata fails closed instead of reporting absence', async () => {
  await assert.rejects(
    createSnapshot({
      environmentUrl: 'https://example.crm.dynamics.com',
      tenantId: 'tenant-1',
      tableNames: ['contact'],
      request: async (_method, apiPath) => {
        if (apiPath.includes('IsCustomizable/Value eq true')) {
          return { status: 200, data: { value: [] } };
        }
        return { status: 403, error: 'metadata forbidden' };
      },
    }),
    /Exact-name table metadata failed \(403\): metadata forbidden/,
  );
});

test('advisory candidate detail failure is recorded and does not abort the snapshot', async () => {
  const progress = [];
  const snapshot = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    concepts: ['activities', 'products'],
    onProgress: (event) => progress.push(event),
    request: async (_method, apiPath) => {
      if (apiPath.startsWith('EntityDefinitions?')) {
        return {
          status: 200,
          data: {
            value: [
              entity('activitypointer', 'Activity'),
              entity('new_product', 'Product'),
            ],
          },
        };
      }
      if (apiPath.includes("EntityDefinitions(LogicalName='activitypointer')/Attributes?")) {
        return { status: 400, error: 'abstract metadata type is unsupported' };
      }
      return { status: 200, data: { value: [] } };
    },
  });

  assert.deepEqual(snapshot.tables.map((table) => table.logicalName), ['new_product']);
  assert.deepEqual(snapshot.detailLoadSummary, {
    attemptedCandidates: 2,
    loadedCandidates: 1,
    failedCandidates: 1,
    requiredCandidates: 0,
    advisoryCandidates: 2,
    exactCoveredConcepts: 0,
    unresolvedConcepts: 2,
    advisoryLimit: 40,
  });
  assert.deepEqual(snapshot.detailLoadFailures, [{
    logicalName: 'activitypointer',
    selectionReasons: ['concept:activities'],
    status: 400,
    error: 'abstract metadata type is unsupported',
    required: false,
  }]);
  const detailProgress = progress.find((event) => event.milestoneId === 'details-loaded');
  assert.deepEqual({
    attempted: detailProgress.attemptedDetailedCandidates,
    loaded: detailProgress.loadedDetailedCandidates,
    failed: detailProgress.failedDetailedCandidates,
  }, { attempted: 2, loaded: 1, failed: 1 });
  const failedCandidate = snapshot.candidateRanking
    .flatMap((ranking) => ranking.candidates)
    .find((candidate) => candidate.logicalName === 'activitypointer');
  assert.equal(failedCandidate.detailed, false);
  assert.equal(failedCandidate.detailStatus, 'unavailable');
  assert.deepEqual(failedCandidate.detailFailure, snapshot.detailLoadFailures[0]);
  assert.equal(validateSnapshot(snapshot).valid, true);

  const malformed = JSON.parse(JSON.stringify(snapshot));
  malformed.detailLoadFailures[0].status = '400';
  assert.deepEqual(validateSnapshot(malformed), {
    valid: false,
    errors: ['detailLoadFailures[0].status must be null or an HTTP status integer'],
  });
});

test('explicit candidate detail failure remains required and throws', async () => {
  await assert.rejects(
    createSnapshot({
      environmentUrl: 'https://example.crm.dynamics.com',
      tenantId: 'tenant-1',
      tableNames: ['activitypointer'],
      concepts: ['activities'],
      request: async (_method, apiPath) => {
        if (apiPath.startsWith('EntityDefinitions?')) {
          return { status: 200, data: { value: [entity('activitypointer', 'Activity')] } };
        }
        if (apiPath.includes('/Attributes?$select=')) {
          return { status: 400, error: 'abstract metadata type is unsupported' };
        }
        return { status: 200, data: { value: [] } };
      },
    }),
    /activitypointer attributes failed \(400\): abstract metadata type is unsupported/,
  );
});

test('lookup sub-metadata failure skips advisory tables and blocks required tables', async () => {
  const request = async (_method, apiPath) => {
    if (apiPath.startsWith('EntityDefinitions?')) {
      return { status: 200, data: { value: [entity('new_product', 'Product')] } };
    }
    if (apiPath.includes('/Attributes?$select=')) {
      return { status: 200, data: { value: [{
        MetadataId: 'lookup-id',
        LogicalName: 'new_categoryid',
        SchemaName: 'new_CategoryId',
        AttributeType: 'Lookup',
        AttributeTypeName: { Value: 'LookupType' },
        SourceType: 0,
      }] } };
    }
    if (apiPath.includes('LookupAttributeMetadata')) {
      return { status: 404, error: 'lookup metadata unavailable' };
    }
    return { status: 200, data: { value: [] } };
  };

  const advisory = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    concepts: ['products'],
    request,
  });
  assert.deepEqual(advisory.tables, []);
  assert.equal(advisory.detailLoadFailures[0].logicalName, 'new_product');
  assert.match(advisory.detailLoadFailures[0].error, /lookup metadata unavailable/);

  await assert.rejects(
    createSnapshot({
      environmentUrl: 'https://example.crm.dynamics.com',
      tenantId: 'tenant-1',
      tableNames: ['new_product'],
      request,
    }),
    /new_product lookup metadata failed \(404\): lookup metadata unavailable/,
  );
});

test('snapshot captures detailed metadata, evidence, and timing shape without network access', async () => {
  const calls = [];
  const clock = [100, 140, 150, 210, 215];
  const snapshot = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com/',
    tenantId: 'tenant-1',
    tableNames: ['new_product'],
    proposedTableNames: ['new_product', 'new_missing'],
    concepts: ['products'],
    nowMs: () => clock.shift(),
    nowIso: () => '2026-08-18T05:00:00.000Z',
    request: async (_method, apiPath) => {
      calls.push(apiPath);
      if (apiPath.startsWith('EntityDefinitions?')) {
        return { status: 200, data: { value: [entity('new_product', 'Product')] } };
      }
      if (apiPath.includes('/Attributes?$select=')) {
        return { status: 200, data: { value: [
          {
            MetadataId: 'name-id',
            LogicalName: 'new_name',
            SchemaName: 'new_Name',
            AttributeType: 'String',
            AttributeTypeName: { Value: 'StringType' },
            RequiredLevel: { Value: 'ApplicationRequired' },
            IsCustomAttribute: true,
            IsCustomizable: { Value: true },
            IsPrimaryName: true,
            IsValidForCreate: true,
            IsValidForRead: true,
            IsValidForUpdate: true,
            SourceType: 0,
          },
          {
            MetadataId: 'category-id',
            LogicalName: 'new_categoryid',
            SchemaName: 'new_CategoryId',
            AttributeType: 'Lookup',
            AttributeTypeName: { Value: 'LookupType' },
            IsCustomizable: { Value: true },
            SourceType: 0,
          },
          {
            MetadataId: 'status-id',
            LogicalName: 'new_status',
            SchemaName: 'new_Status',
            AttributeType: 'Picklist',
            AttributeTypeName: { Value: 'PicklistType' },
            IsCustomizable: { Value: true },
            SourceType: 0,
          },
          {
            MetadataId: 'total-id',
            LogicalName: 'new_total',
            SchemaName: 'new_Total',
            AttributeType: 'Decimal',
            AttributeTypeName: { Value: 'DecimalType' },
            IsCustomizable: { Value: true },
            SourceType: 3,
            SourceTypeMask: 4,
          },
        ] } };
      }
      if (apiPath.includes('/ManyToOneRelationships?')) {
        return { status: 200, data: { value: [{
          SchemaName: 'new_Product_Category',
          ReferencingAttribute: 'new_categoryid',
          ReferencedEntity: 'new_category',
          ReferencedAttribute: 'new_categoryid',
        }] } };
      }
      if (apiPath.includes('/OneToManyRelationships?')
        || apiPath.includes('/ManyToManyRelationships?')) {
        return { status: 200, data: { value: [] } };
      }
      if (apiPath.includes('/Keys?')) {
        return { status: 200, data: { value: [{
          LogicalName: 'new_product_key',
          SchemaName: 'new_ProductKey',
          KeyAttributes: ['new_name'],
          EntityKeyIndexStatus: 'Active',
        }] } };
      }
      if (apiPath.includes('PicklistAttributeMetadata')) {
        return { status: 200, data: { value: [{
          LogicalName: 'new_status',
          OptionSet: { Options: [{
            Value: 1,
            Label: label('Active'),
          }] },
        }] } };
      }
      if (apiPath.includes('LookupAttributeMetadata')) {
        return { status: 200, data: { value: [{
          LogicalName: 'new_categoryid',
          Targets: ['new_category'],
        }] } };
      }
      if (apiPath.includes('/Attributes/Microsoft.Dynamics.CRM.StringAttributeMetadata')) {
        return { status: 200, data: { value: [{
          LogicalName: 'new_name',
          MaxLength: 160,
          Format: 'Text',
          FormatName: { Value: 'Text' },
        }] } };
      }
      if (apiPath.includes('/Attributes/Microsoft.Dynamics.CRM.DecimalAttributeMetadata')) {
        return { status: 200, data: { value: [{
          LogicalName: 'new_total',
          MinValue: -100000,
          MaxValue: 100000,
          Precision: 2,
        }] } };
      }
      if (apiPath.includes('Attributes(total-id)')) {
        return {
          status: 200,
          data: {
            LogicalName: 'new_total',
            SourceType: 3,
            SourceTypeMask: '4',
            FormulaDefinition: 'new_quantity * new_price',
          },
        };
      }
      return { status: 200, data: { value: [] } };
    },
  });

  assert.deepEqual(snapshot.timings, {
    inventoryRetrievalMs: 40,
    candidateSelectionMs: 10,
    detailLoadingMs: 60,
    totalDurationMs: 115,
  });
  assert.deepEqual(snapshot.proposedNameChecks.missing, ['new_missing']);
  assert.equal(snapshot.proposedNameChecks.collisions[0].logicalName, 'new_product');
  assert.equal(snapshot.tables[0].facts.columnCount, 4);
  assert.equal(snapshot.tables[0].facts.relationshipCount, 1);
  assert.equal(snapshot.tables[0].facts.keyCount, 1);
  assert.deepEqual(snapshot.tables[0].columns.find(
    (column) => column.logicalName === 'new_categoryid',
  ).lookupTargets, ['new_category']);
  assert.deepEqual(snapshot.tables[0].columns.find(
    (column) => column.logicalName === 'new_status',
  ).choices, [{ value: 1, label: 'Active' }]);
  assert.deepEqual(
    {
      maxLength: snapshot.tables[0].columns.find(
        (column) => column.logicalName === 'new_name',
      ).maxLength,
      formatName: snapshot.tables[0].columns.find(
        (column) => column.logicalName === 'new_name',
      ).formatName,
    },
    { maxLength: 160, formatName: 'Text' },
  );
  assert.deepEqual(
    {
      minValue: snapshot.tables[0].columns.find(
        (column) => column.logicalName === 'new_total',
      ).minValue,
      maxValue: snapshot.tables[0].columns.find(
        (column) => column.logicalName === 'new_total',
      ).maxValue,
      precision: snapshot.tables[0].columns.find(
        (column) => column.logicalName === 'new_total',
      ).precision,
    },
    { minValue: -100000, maxValue: 100000, precision: 2 },
  );
  assert.equal(snapshot.tables[0].columns.find(
    (column) => column.logicalName === 'new_total',
  ).computed.formula, 'new_quantity * new_price');
  assert.deepEqual(snapshot.tables[0].columns.find(
    (column) => column.logicalName === 'new_total',
  ).computed, {
    sourceType: 3,
    sourceTypeMask: 4,
    formulaDefinition: 'new_quantity * new_price',
    metadataStatus: 'available',
    unavailableReason: null,
    formula: 'new_quantity * new_price',
    attributeOf: null,
  });
  assert.deepEqual(snapshot.exactNameResolution, {
    requestedTables: ['new_product'],
    loadedTables: ['new_product'],
    unavailableTables: [],
  });
  assert.equal(validateSnapshot(snapshot, {
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
  }).valid, true);
  assert.equal(calls.filter((apiPath) => (
    apiPath.startsWith('EntityDefinitions?') && apiPath.includes('IsCustomizable/Value eq true')
  )).length, 1);
  assert.equal(calls.filter((apiPath) => (
    apiPath.startsWith('EntityDefinitions?') && apiPath.includes("LogicalName eq 'new_missing'")
  )).length, 1);
  assert.equal(calls.some((apiPath) => (
    apiPath.includes("EntityDefinitions(LogicalName='new_missing')/Attributes?")
  )), false);
});

test('snapshot validation rejects missing decision evidence', () => {
  const snapshot = validSnapshotBase();
  for (const field of [
    'generatedAt',
    'inventoryFacts',
    'proposedNameChecks',
    'exactNameResolution',
    'detailLoadSummary',
  ]) {
    const malformed = { ...snapshot };
    delete malformed[field];
    assert.equal(validateSnapshot(malformed).valid, false, field);
  }
});

test('exact-name expansion reuses inventory and performs no broad discovery request', async () => {
  const calls = [];
  const base = validSnapshotBase({
    inputs: { concepts: ['products'], explicitTableNames: [], proposedTableNames: [] },
    inventory: [{
      logicalName: 'new_product',
      schemaName: 'new_product',
      displayName: 'Product',
      displayCollectionName: 'Products',
      description: 'Product records',
      entitySetName: 'new_products',
      primaryIdAttribute: 'new_productid',
      primaryNameAttribute: 'new_name',
      customEntity: true,
      managed: false,
      customizable: true,
      canCreateAttributes: true,
    }],
    candidateRanking: [{
      concept: 'products',
      normalizedTokens: ['product'],
      preferredPublisherFamily: 'new',
      candidates: [{
        rank: 1,
        logicalName: 'new_product',
        displayName: 'Product',
        publisherFamily: 'new',
        versioned: false,
        score: 999.89,
        reasons: ['exact:product'],
        detailed: false,
        selectionEvidence: [],
      }],
    }],
    selectedCandidateEvidence: [],
  });
  const clock = [100, 105, 130, 132];
  const expanded = await expandSnapshot({
    snapshot: base,
    tableNames: ['new_product'],
    nowMs: () => clock.shift(),
    nowIso: () => '2026-08-18T05:01:00.000Z',
    request: async (_method, apiPath) => {
      calls.push(apiPath);
      if (apiPath.includes('/Attributes?$select=')) {
        return { status: 200, data: { value: [] } };
      }
      return { status: 200, data: { value: [] } };
    },
  });
  assert.equal(expanded.expansion.inventoryReused, true);
  assert.deepEqual(expanded.expansion.loadedTables, ['new_product']);
  assert.equal(expanded.timings.inventoryRetrievalMs, 5);
  assert.equal(expanded.candidateRanking[0].candidates[0].detailed, true);
  assert.equal(calls.some((apiPath) => apiPath.startsWith('EntityDefinitions?')), false);
});

test('exact-name expansion discovers and details a managed dependency absent from inventory', async () => {
  const calls = [];
  const base = validSnapshotBase({
    inputs: { concepts: ['animals'], explicitTableNames: [], proposedTableNames: [] },
    inventory: [normalizeInventoryForTest(entity('wr_animal', 'Animal'))],
  });
  const managedContact = entity('contact', 'Contact', {
    IsCustomEntity: false,
    IsManaged: true,
    IsCustomizable: { Value: false },
    CanCreateAttributes: { Value: false },
  });
  const expanded = await expandSnapshot({
    snapshot: base,
    tableNames: ['contact'],
    request: async (_method, apiPath) => {
      calls.push(apiPath);
      if (apiPath.startsWith('EntityDefinitions?')) {
        assert.match(apiPath, /LogicalName eq 'contact'/);
        assert.doesNotMatch(apiPath, /IsCustomizable\/Value eq true/);
        return { status: 200, data: { value: [managedContact] } };
      }
      return { status: 200, data: { value: [] } };
    },
  });

  assert.equal(calls.filter((apiPath) => apiPath.startsWith('EntityDefinitions?')).length, 1);
  assert.equal(calls.some((apiPath) => apiPath.includes("EntityDefinitions(LogicalName='contact')/Attributes?")), true);
  assert.deepEqual(expanded.expansion.requestedTables, ['contact']);
  assert.deepEqual(expanded.expansion.loadedTables, ['contact']);
  assert.deepEqual(expanded.expansion.newlyLoadedTables, ['contact']);
  assert.deepEqual(expanded.expansion.unavailableTables, []);
  assert.equal(expanded.inventory.find((item) => item.logicalName === 'contact').managed, true);
  assert.equal(expanded.inventory.find((item) => item.logicalName === 'contact').customizable, false);
  assert.equal(expanded.tables.find((item) => item.logicalName === 'contact').facts.columnCount, 0);
});

test('proposed-name expansion checks collisions without loading details', async () => {
  const calls = [];
  const base = validSnapshotBase();
  const expanded = await expandSnapshot({
    snapshot: base,
    proposedTableNames: ['new_product', 'new_missing'],
    request: async (_method, apiPath) => {
      calls.push(apiPath);
      if (apiPath.startsWith('EntityDefinitions?')) {
        return { status: 200, data: { value: [entity('new_product', 'Product')] } };
      }
      return { status: 200, data: { value: [] } };
    },
  });

  assert.deepEqual(
    expanded.proposedNameChecks.collisions.map((item) => item.logicalName),
    ['new_product'],
  );
  assert.deepEqual(expanded.proposedNameChecks.missing, ['new_missing']);
  assert.deepEqual(expanded.tables, []);
  assert.equal(calls.some((apiPath) => apiPath.includes('/Attributes?$select=')), false);
  assert.deepEqual(expanded.exactNameResolution, {
    requestedTables: [],
    loadedTables: [],
    unavailableTables: [],
  });
});

test('exact-name expansion fails closed when required detail metadata is unreadable', async () => {
  const base = validSnapshotBase({
    inputs: { concepts: ['activities'], explicitTableNames: [], proposedTableNames: [] },
    inventory: [normalizeInventoryForTest(entity('activitypointer', 'Activity'))],
  });

  await assert.rejects(
    expandSnapshot({
      snapshot: base,
      tableNames: ['activitypointer'],
      request: async (_method, apiPath) => {
        if (apiPath.includes('/Attributes?$select=')) {
          return { status: 403, error: 'metadata forbidden' };
        }
        return { status: 200, data: { value: [] } };
      },
    }),
    /activitypointer attributes failed \(403\): metadata forbidden/,
  );
});

test('computed metadata is explicitly unavailable when SourceTypeMask cannot be proven', async () => {
  const table = await loadDetailedEntity(async (_method, apiPath) => {
    if (apiPath.includes('/Attributes?$select=')) {
      return { status: 200, data: { value: [{
        MetadataId: 'computed-id',
        LogicalName: 'new_computed',
        SchemaName: 'new_Computed',
        AttributeType: 'Decimal',
        AttributeTypeName: { Value: 'DecimalType' },
        SourceType: 1,
      }] } };
    }
    if (apiPath.includes('Attributes(computed-id)')) {
      return {
        status: 200,
        data: {
          LogicalName: 'new_computed',
          SourceType: 1,
          FormulaDefinition: 'new_amount * 2',
        },
      };
    }
    return { status: 200, data: { value: [] } };
  }, entity('new_invoice', 'Invoice'));

  const computed = table.columns[0].computed;
  assert.equal(computed.sourceType, 1);
  assert.equal(computed.sourceTypeMask, null);
  assert.equal(computed.formulaDefinition, 'new_amount * 2');
  assert.equal(computed.metadataStatus, 'unavailable');
  assert.match(computed.unavailableReason, /SourceTypeMask unavailable or malformed/);
});

test('CLI request creation initializes one long-lived executor for the snapshot phase', async () => {
  let executorCreations = 0;
  let requests = 0;
  const request = createCliRequest({
    'env-url': 'https://example.crm.dynamics.com',
    'tenant-id': 'tenant-1',
  }, (options) => {
    executorCreations += 1;
    assert.equal(options.environmentUrl, 'https://example.crm.dynamics.com');
    return async () => {
      requests += 1;
      return { status: 200, data: { value: [] } };
    };
  });

  await request('GET', 'EntityDefinitions');
  await request('GET', "EntityDefinitions(LogicalName='contact')/Attributes");
  await request('GET', "EntityDefinitions(LogicalName='contact')/Keys");
  assert.equal(executorCreations, 1);
  assert.equal(requests, 3);
});

test('evidence renderer emits compact deterministic planning facts', () => {
  const collision = {
    logicalName: 'wr_animal',
    status: 'collision',
    existing: { customEntity: true, managed: false, customizable: true },
  };
  const snapshot = validSnapshotBase({
    candidateRanking: [{
      concept: 'animals',
      preferredPublisherFamily: 'wr',
      candidates: [{
        rank: 1,
        logicalName: 'wr_animal',
        score: 999.91,
        detailed: true,
        versioned: false,
        reasons: ['exact:animal'],
      }],
    }],
    tables: [{
      logicalName: 'wr_animal',
      customEntity: true,
      managed: false,
      customizable: true,
      columns: [{ logicalName: 'wr_name' }],
      manyToOneRelationships: [{}],
      oneToManyRelationships: [],
      manyToManyRelationships: [],
      alternateKeys: [],
    }],
    proposedNameChecks: {
      checked: [
        collision,
        { logicalName: 'wr_releaseevent', status: 'missing', existing: null },
      ],
      collisions: [collision],
      missing: ['wr_releaseevent'],
    },
    timings: {
      inventoryRetrievalMs: 25,
      candidateSelectionMs: 2,
      detailLoadingMs: 50,
      totalDurationMs: 78,
    },
  });
  const markdown = renderPlanningEvidence(snapshot);
  assert.match(markdown, /# Dataverse Planning Evidence/);
  assert.match(markdown, /animals.*wr_animal.*999\.91/);
  assert.match(markdown, /wr_animal.*yes.*no.*yes.*1.*1.*0/);
  assert.match(markdown, /wr_releaseevent.*missing/);
  assert.match(markdown, /Inventory retrieval.*25 ms/);
  assert.match(markdown, /\*\*Total\*\*.*\*\*78 ms\*\*/);
});

test('evidence renderer reports skipped advisory detail failures', () => {
  const snapshot = validSnapshotBase({
    candidateRanking: [{
      concept: 'activities',
      preferredPublisherFamily: '',
      candidates: [{
        rank: 1,
        logicalName: 'activitypointer',
        score: 749.85,
        detailed: false,
        detailStatus: 'unavailable',
        versioned: false,
        reasons: ['contains:activity'],
      }],
    }],
    tables: [],
    detailLoadFailures: [{
      logicalName: 'activitypointer',
      selectionReasons: ['concept:activities'],
      status: 400,
      error: 'abstract metadata type is unsupported',
      required: false,
    }],
    detailLoadSummary: {
      attemptedCandidates: 1,
      loadedCandidates: 0,
      failedCandidates: 1,
    },
    proposedNameChecks: { checked: [], collisions: [], missing: [] },
    timings: {
      inventoryRetrievalMs: 25,
      candidateSelectionMs: 2,
      detailLoadingMs: 15,
      totalDurationMs: 42,
    },
  });

  const markdown = renderPlanningEvidence(snapshot);
  assert.match(markdown, /activitypointer.*detail unavailable/);
  assert.match(markdown, /Skipped advisory detail failures/);
  assert.match(markdown, /activitypointer.*concept:activities.*400.*abstract metadata type is unsupported/);
});

test('atomic output replaces the target and leaves no sibling temporary file', (t) => {
  const directory = projectScratch(t);
  const output = path.join(directory, 'evidence.md');
  fs.writeFileSync(output, 'old\n');
  atomicWriteFile(output, 'new\n');
  assert.equal(fs.readFileSync(output, 'utf8'), 'new\n');
  assert.deepEqual(fs.readdirSync(directory), ['evidence.md']);
});

test('planning contracts require the snapshot-only path and bounded expansion', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const setup = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'setup-datamodel', 'SKILL.md'),
    'utf8',
  );
  const planning = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'phase-3-planning.md'),
    'utf8',
  );
  const snapshotScript = fs.readFileSync(
    path.join(pluginRoot, 'scripts', 'create-dataverse-snapshot.js'),
    'utf8',
  );
  assert.match(setup, /The foreground owns the proposal/);
  assert.match(setup, /full snapshot\s+only through deterministic validators/);
  assert.match(setup, /validate-dataverse-planning-decisions\.js/);
  assert.match(setup, /Missing full metadata for\s+Reuse\/Extend\/Adapt is `NEEDS_CONTEXT`/s);
  assert.match(planning, /`connector-only`: skip Dataverse metadata reads/);
  assert.match(planning, /`required`:[\s\S]+one\s+normalized snapshot/);
  assert.match(planning, /render-dataverse-architect-evidence\.js/);
  assert.match(planning, /--concepts-file "\$CONCEPTS_PATH"/);
  assert.match(planning, /--progressive-detail/);
  assert.match(planning, /--combined-base-read/);
  assert.match(planning, /--read-concurrency 1/);
  assert.match(planning, /--inventory-cache "\$INVENTORY_CACHE_PATH"/);
  assert.match(planning, /--telemetry-output "\$PLANNING_TELEMETRY_PATH"/);
  assert.match(planning, /--planning-timings-output "\$PLANNING_TIMINGS_PATH"/);
  assert.match(planning, /Required exact-name metadata failures block Dataverse planning/);
  assert.match(planning, /Reuse the one bounded exact-name expansion/);
  assert.match(planning, /never rerun broad discovery/);
  assert.match(planning, /\/setup-datamodel` in the foreground/);
  assert.match(planning, /validate-dataverse-planning-decisions\.js/);
  assert.match(planning, /planning-eta\.js/);
  assert.doesNotMatch(snapshotScript, /execFileSync/);
});
