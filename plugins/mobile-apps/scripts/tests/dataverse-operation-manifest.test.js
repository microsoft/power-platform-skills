'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  bindContractToPlan,
  buildManifest,
  contractApprovalContent,
  normalizedContract,
  reconciliationScope,
  rollForwardPublishCheckpoint,
  sha256,
  stableJson,
  validateManifest,
} = require('../build-dataverse-operation-manifest');
const { operationFingerprint } = require('../dataverse-request');

const NOW = '2026-08-19T00:00:00.000Z';
const SNAPSHOT_AT = '2026-08-18T23:55:00.000Z';
const CONTEXT = {
  environmentId: 'environment-1',
  environmentUrl: 'https://example.crm.dynamics.com',
  tenantId: 'tenant-1',
  publisherPrefix: 'cr1',
  solutionUniqueName: 'MobileAppSolution',
};

function column(logicalName, type = 'String', overrides = {}) {
  const constraints = {
    BigInt: {},
    Boolean: { defaultValue: false },
    DateTime: { format: 'DateAndTime', dateTimeBehavior: 'UserLocal' },
    Decimal: {
      minValue: -100000000000,
      maxValue: 100000000000,
      precision: 2,
    },
    Double: {
      minValue: -100000000000,
      maxValue: 100000000000,
      precision: 2,
    },
    File: { maxSizeInKB: 32768 },
    Image: { maxHeight: 1440, maxWidth: 1440 },
    Integer: { minValue: -2147483648, maxValue: 2147483647, format: 'None' },
    Memo: { maxLength: 10000, format: 'TextArea' },
    Money: {
      minValue: -922337203685477,
      maxValue: 922337203685477,
      precision: 2,
      precisionSource: 2,
    },
    String: { maxLength: 200, formatName: 'Text' },
  }[type] || {};
  return {
    logicalName,
    schemaName: logicalName,
    type,
    typeName: `${type}Type`,
    sourceType: 0,
    sourceTypeMask: 0,
    lookupTargets: [],
    choices: [],
    formulaDefinition: null,
    primaryName: false,
    requiredLevel: 'None',
    ...constraints,
    ...overrides,
  };
}

function table(logicalName, columns, overrides = {}) {
  return {
    logicalName,
    schemaName: logicalName,
    displayName: logicalName,
    displayCollectionName: `${logicalName}s`,
    entitySetName: `${logicalName}s`,
    primaryIdAttribute: `${logicalName}id`,
    primaryNameAttribute: columns.find((item) => item.primaryName)?.logicalName
      || columns[0]?.logicalName
      || `${logicalName}name`,
    ownershipType: 'UserOwned',
    hasActivities: false,
    hasNotes: false,
    isAvailableOffline: true,
    changeTrackingEnabled: true,
    customEntity: logicalName !== 'contact',
    managed: false,
    customizable: true,
    canCreateAttributes: true,
    canBePrimaryEntityInRelationship: true,
    canBeRelatedEntityInRelationship: true,
    canBeInManyToMany: true,
    columns,
    manyToOneRelationships: [],
    oneToManyRelationships: [],
    manyToManyRelationships: [],
    alternateKeys: [],
    facts: {
      columnCount: columns.length,
      relationshipCount: 0,
      keyCount: 0,
    },
    ...overrides,
  };
}

function inventory(tableValue) {
  return {
    logicalName: tableValue.logicalName,
    schemaName: tableValue.schemaName,
    displayName: tableValue.displayName,
    displayCollectionName: tableValue.displayCollectionName,
    description: '',
    entitySetName: tableValue.entitySetName,
    primaryIdAttribute: tableValue.primaryIdAttribute,
    primaryNameAttribute: tableValue.primaryNameAttribute,
    ownershipType: tableValue.ownershipType,
    hasActivities: tableValue.hasActivities,
    hasNotes: tableValue.hasNotes,
    isAvailableOffline: tableValue.isAvailableOffline,
    changeTrackingEnabled: tableValue.changeTrackingEnabled,
    customEntity: tableValue.customEntity,
    managed: tableValue.managed,
    customizable: tableValue.customizable,
    canCreateAttributes: tableValue.canCreateAttributes,
    canBePrimaryEntityInRelationship: tableValue.canBePrimaryEntityInRelationship,
    canBeRelatedEntityInRelationship: tableValue.canBeRelatedEntityInRelationship,
    canBeInManyToMany: tableValue.canBeInManyToMany,
  };
}

function snapshot({
  tables = [],
  proposedMissing = [],
  proposedCollisions = [],
  exactUnavailable = [],
  generatedAt = SNAPSHOT_AT,
} = {}) {
  const exactLoaded = tables.map((item) => item.logicalName);
  const requested = [...new Set([
    ...exactLoaded,
    ...exactUnavailable,
    ...proposedMissing,
    ...proposedCollisions,
  ])].sort();
  const loadedSet = new Set(exactLoaded);
  const unavailable = requested.filter((logicalName) => !loadedSet.has(logicalName));
  const checked = [
    ...proposedMissing.map((logicalName) => ({ logicalName, status: 'missing', existing: null })),
    ...proposedCollisions.map((logicalName) => ({
      logicalName,
      status: 'collision',
      existing: inventory(tables.find((item) => item.logicalName === logicalName)),
    })),
  ].sort((left, right) => left.logicalName.localeCompare(right.logicalName));
  const collisions = checked.filter((item) => item.status === 'collision');
  return {
    version: 3,
    purpose: 'execution-reconciliation',
    environmentUrl: CONTEXT.environmentUrl,
    tenantId: CONTEXT.tenantId,
    generatedAt,
    inputs: {
      concepts: [],
      explicitTableNames: requested,
      proposedTableNames: checked.map((item) => item.logicalName),
    },
    inventory: tables.map(inventory).sort((left, right) => (
      left.logicalName.localeCompare(right.logicalName)
    )),
    inventoryFacts: {
      customizableTables: tables.length,
      exactNameTables: tables.length,
      requiredExactNameTables: tables.length,
      proposedCollisionTables: collisions.length,
      totalTables: tables.length,
    },
    candidateRanking: [],
    selectedCandidateEvidence: [],
    tables,
    detailLoadFailures: [],
    detailLoadSummary: {
      attemptedCandidates: tables.length,
      loadedCandidates: tables.length,
      failedCandidates: 0,
    },
    proposedNameChecks: {
      checked,
      collisions,
      missing: proposedMissing,
    },
    exactNameResolution: {
      requestedTables: requested,
      loadedTables: exactLoaded,
      unavailableTables: unavailable,
    },
    timings: {
      inventoryRetrievalMs: 10,
      candidateSelectionMs: 1,
      detailLoadingMs: 3,
      totalDurationMs: 14,
    },
    reconciliation: {
      boundedExactNames: true,
      fullInventoryRead: false,
      tables: requested,
      proposedNames: checked.map((item) => item.logicalName),
    },
  };
}

function contractTable(logicalName, plannedDecision, dependencyTier, columns, overrides = {}) {
  return {
    logicalName,
    schemaName: logicalName,
    displayName: logicalName,
    displayCollectionName: `${logicalName}s`,
    plannedDecision,
    dependencyTier,
    serviceRequired: true,
    ownershipType: 'UserOwned',
    columns,
    relationships: [],
    alternateKeys: [],
    ...overrides,
  };
}

function contractColumn(logicalName, type, plannedDecision = 'create', overrides = {}) {
  return {
    logicalName,
    schemaName: logicalName,
    displayName: logicalName,
    type,
    plannedDecision,
    requiredLevel: 'None',
    ...overrides,
  };
}

function createContract() {
  return {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_item', 'create', 1, [
        contractColumn('cr1_name', 'string', 'create', {
          primaryName: true,
          requiredLevel: 'ApplicationRequired',
        }),
        contractColumn('cr1_categoryid', 'lookup', 'create', {
          lookupTarget: 'cr1_category',
        }),
        contractColumn('cr1_code', 'string'),
      ], {
        relationships: [{
          kind: 'many-to-one',
          schemaName: 'cr1_Category_Item',
          plannedDecision: 'create',
          parentTable: 'cr1_category',
          childTable: 'cr1_item',
          lookup: {
            logicalName: 'cr1_categoryid',
            schemaName: 'cr1_categoryid',
            displayName: 'Category',
            requiredLevel: 'None',
          },
        }],
        alternateKeys: [{
          schemaName: 'cr1_item_code_key',
          displayName: 'Item Code Key',
          plannedDecision: 'create',
          columns: ['cr1_code'],
        }],
      }),
      contractTable('cr1_category', 'create', 0, [
        contractColumn('cr1_name', 'string', 'create', {
          primaryName: true,
          requiredLevel: 'ApplicationRequired',
        }),
      ]),
      contractTable('contact', 'reuse', 0, [
        contractColumn('fullname', 'string', 'reuse', { primaryName: true }),
      ]),
      contractTable('cr1_deferred', 'defer', 0, [], {
        reason: 'owning solution is not installed',
      }),
    ],
  };
}

function buildInputs(contract, reconciliation, plan = '# Plan\n') {
  const planBytes = Buffer.from(plan);
  const normalized = normalizedContract(contract);
  const serviceRequiredTables = [];
  for (const tableValue of normalized.tables) {
    if (tableValue.serviceRequired && tableValue.plannedDecision !== 'defer') {
      serviceRequiredTables.push({
        logicalName: tableValue.plannedDecision === 'adapt'
          ? tableValue.adaptedLogicalName
          : tableValue.logicalName,
        consumers: [`test:${tableValue.logicalName}`],
      });
    }
    for (const relationship of tableValue.relationships) {
      if (relationship.kind !== 'many-to-many'
        || !relationship.serviceRequired
        || relationship.plannedDecision === 'defer') continue;
      serviceRequiredTables.push({
        logicalName: relationship.plannedDecision === 'adapt'
          ? relationship.adaptedIntersectTable
          : relationship.intersectTable,
        consumers: [`test:${relationship.schemaName}`],
      });
    }
  }
  const serviceDependencies = {
    schemaVersion: 1,
    serviceRequiredTables: [...new Map(serviceRequiredTables.map((item) => [
      item.logicalName,
      item,
    ])).values()],
  };
  const approvedContract = contractApprovalContent(normalized);
  const approvalReceipt = {
    schemaVersion: 1,
    workflow: 'create-mobile-app',
    approvals: {
      dataModel: {
        status: 'approved',
        approvedAt: NOW,
        approvedContractSha256: sha256(stableJson(approvedContract)),
      },
      nativeCapabilities: { status: 'approved', approvedAt: NOW },
      connectors: { status: 'approved', approvedAt: NOW },
      screenPlan: { status: 'approved', approvedAt: NOW },
    },
    approvedPlanSha256: sha256(planBytes),
    approvedContractSha256: sha256(stableJson(approvedContract)),
    approvedContract,
    serviceRequiredTables: serviceDependencies.serviceRequiredTables,
  };
  approvalReceipt.integritySha256 = sha256(stableJson(approvalReceipt));
  const bound = bindContractToPlan(normalized, planBytes, approvalReceipt);
  const scope = reconciliationScope(bound);
  const scopedReconciliation = structuredClone(reconciliation);
  const tableByName = new Map(
    (scopedReconciliation.tables || []).map((item) => [item.logicalName, item]),
  );
  scopedReconciliation.inputs = {
    ...(scopedReconciliation.inputs || {}),
    explicitTableNames: scope.exactTables,
    proposedTableNames: scope.proposedTables,
  };
  scopedReconciliation.exactNameResolution = {
    requestedTables: scope.exactTables,
    loadedTables: scope.exactTables.filter((logicalName) => tableByName.has(logicalName)),
    unavailableTables: scope.exactTables.filter((logicalName) => !tableByName.has(logicalName)),
  };
  const checked = scope.proposedTables.map((logicalName) => ({
    logicalName,
    status: tableByName.has(logicalName) ? 'collision' : 'missing',
    existing: tableByName.has(logicalName) ? inventory(tableByName.get(logicalName)) : null,
  }));
  scopedReconciliation.proposedNameChecks = {
    checked,
    collisions: checked.filter((item) => item.status === 'collision'),
    missing: checked.filter((item) => item.status === 'missing')
      .map((item) => item.logicalName),
  };
  scopedReconciliation.reconciliation = {
    boundedExactNames: true,
    fullInventoryRead: false,
    tables: scope.exactTables,
    proposedNames: scope.proposedTables,
  };
  const contractBytes = Buffer.from(stableJson(bound));
  const reconciliationBytes = Buffer.from(JSON.stringify(scopedReconciliation, null, 2));
  return {
    contract: bound,
    approvalReceipt,
    reconciliation: scopedReconciliation,
    contractBytes,
    reconciliationBytes,
    planBytes,
    context: CONTEXT,
    now: NOW,
  };
}

function approvedDecisions(contract) {
  const decisions = new Map();
  for (const tableValue of normalizedContract(contract).tables) {
    decisions.set(`table:${tableValue.logicalName}`, tableValue.plannedDecision);
    for (const columnValue of tableValue.columns) {
      decisions.set(
        `column:${tableValue.logicalName}:${columnValue.logicalName}`,
        columnValue.plannedDecision,
      );
    }
    for (const relationship of tableValue.relationships) {
      decisions.set(
        `relationship:${tableValue.logicalName}:${relationship.schemaName.toLowerCase()}`,
        relationship.plannedDecision,
      );
    }
    for (const key of tableValue.alternateKeys) {
      decisions.set(
        `key:${tableValue.logicalName}:${key.schemaName.toLowerCase()}`,
        key.plannedDecision,
      );
    }
  }
  return decisions;
}

function basePlanningSnapshot() {
  const contact = table('contact', [
    column('fullname', 'String', {
      primaryName: true,
      customAttribute: false,
    }),
  ], { customEntity: false });
  return snapshot({
    tables: [contact],
    proposedMissing: ['cr1_category', 'cr1_item'],
    exactUnavailable: ['cr1_deferred'],
  });
}

function fullyAppliedSnapshot() {
  const category = table('cr1_category', [
    column('cr1_name', 'String', {
      primaryName: true,
      requiredLevel: 'ApplicationRequired',
    }),
  ]);
  const item = table('cr1_item', [
    column('cr1_name', 'String', {
      primaryName: true,
      requiredLevel: 'ApplicationRequired',
    }),
    column('cr1_categoryid', 'Lookup', {
      lookupTargets: ['cr1_category'],
    }),
    column('cr1_code', 'String'),
  ], {
    manyToOneRelationships: [{
      schemaName: 'cr1_Category_Item',
      lookupColumn: 'cr1_categoryid',
      targetTable: 'cr1_category',
      targetColumn: 'cr1_categoryid',
      managed: false,
      cascadeConfiguration: {
        Assign: 'NoCascade',
        Delete: 'RemoveLink',
        Merge: 'NoCascade',
        Reparent: 'NoCascade',
        Share: 'NoCascade',
        Unshare: 'NoCascade',
        RollupView: 'NoCascade',
      },
    }],
    alternateKeys: [{
      logicalName: 'cr1_item_code_key',
      schemaName: 'cr1_item_code_key',
      columns: ['cr1_code'],
      status: 'Active',
      managed: false,
    }],
  });
  const contact = table('contact', [
    column('fullname', 'String', { primaryName: true }),
  ], { customEntity: false });
  return snapshot({
    tables: [category, item, contact],
    proposedCollisions: ['cr1_category', 'cr1_item'],
    exactUnavailable: ['cr1_deferred'],
  });
}

test('manifest output is deterministic with complete coverage and dependency order', () => {
  const contract = createContract();
  const inputs = buildInputs(contract, basePlanningSnapshot());
  const first = buildManifest(inputs);
  const second = buildManifest(inputs);

  assert.deepEqual(first, second);
  assert.equal(first.executable, true);
  assert.equal(first.summary.decisionCount, 11);
  assert.equal(first.decisions.length, 11);
  assert.equal(new Set(first.decisions.map((item) => item.itemId)).size, 11);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.binding.environmentId, CONTEXT.environmentId);
  assert.equal(first.binding.environmentUrl, CONTEXT.environmentUrl);
  assert.equal(first.binding.tenantId, CONTEXT.tenantId);
  assert.equal(first.binding.publisherPrefix, CONTEXT.publisherPrefix);
  assert.equal(first.binding.solutionUniqueName, CONTEXT.solutionUniqueName);
  assert.match(first.binding.planSha256, /^[a-f0-9]{64}$/);
  assert.match(first.binding.structuredSchemaSha256, /^[a-f0-9]{64}$/);
  assert.match(first.binding.reconciliationSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    first.execution.phases.map((phase) => phase.name),
    ['tableCreates', 'extensions', 'relationships', 'alternateKeys', 'publish'],
  );
  assert.deepEqual(first.execution.journal, {
    required: true,
    schemaVersion: 1,
    atomicPerOperation: true,
    uncertainResumeRequiresFreshReconciliation: true,
  });
  assert.deepEqual(
    first.execution.phases[0].operations.map((item) => item.id),
    ['create-table:cr1_category', 'create-table:cr1_item'],
  );
  assert.equal(first.execution.phases[0].operations[1].body.Attributes.length, 2);
  assert.equal(first.execution.phases[1].operations.length, 0);
  assert.equal(
    first.execution.phases[0].operations[1].body.Attributes.some(
      (item) => item['@odata.type'].includes('Lookup'),
    ),
    false,
  );
  assert.equal(first.execution.phases[2].operations[0].id, 'create-relationship:cr1_category_item');
  assert.equal(first.execution.phases[3].operations[0].id, 'create-key:cr1_item:cr1_item_code_key');
  assert.equal(first.execution.phases[4].operations[0].apiPath, 'PublishXml');
  assert.deepEqual(
    first.execution.phases.flatMap((phase) => phase.operations).map((item) => item.index),
    [0, 1, 2, 3, 4],
  );
});

test('fresh reconciliation scope comes only from the structured schema artifact', () => {
  const scope = reconciliationScope(createContract());
  assert.deepEqual(scope, {
    schemaVersion: 1,
    exactTables: ['contact', 'cr1_category', 'cr1_deferred', 'cr1_item'],
    proposedTables: ['cr1_category', 'cr1_item'],
  });
  const manifest = buildManifest(buildInputs(createContract(), basePlanningSnapshot()));
  assert.deepEqual(manifest.verification.reconciliationScope, scope);
});

test('lookup columns require an explicit matching relationship contract', () => {
  const contract = createContract();
  contract.tables.find((item) => item.logicalName === 'cr1_item').relationships = [];
  assert.throws(
    () => reconciliationScope(contract),
    /lookup has no matching many-to-one relationship/,
  );
});

test('schema names deterministically resolve to their logical identities', () => {
  const valid = createContract();
  const item = valid.tables.find((entry) => entry.logicalName === 'cr1_item');
  item.schemaName = 'cr1_Item';
  item.columns.find((entry) => entry.logicalName === 'cr1_name').schemaName = 'cr1_Name';
  item.relationships[0].lookup.schemaName = 'cr1_CategoryId';
  assert.doesNotThrow(() => reconciliationScope(valid));
  const defaultedLookupSchema = structuredClone(valid);
  delete defaultedLookupSchema.tables
    .find((entry) => entry.logicalName === 'cr1_item')
    .relationships[0].lookup.schemaName;
  assert.equal(
    normalizedContract(defaultedLookupSchema).tables
      .find((entry) => entry.logicalName === 'cr1_item')
      .relationships[0].lookup.schemaName,
    'cr1_categoryid',
  );

  const tableMismatch = structuredClone(valid);
  tableMismatch.tables.find((entry) => entry.logicalName === 'cr1_item').schemaName = 'cr1_Other';
  assert.throws(
    () => reconciliationScope(tableMismatch),
    /schemaName must resolve to logicalName cr1_item/,
  );

  const columnMismatch = structuredClone(valid);
  columnMismatch.tables
    .find((entry) => entry.logicalName === 'cr1_item')
    .columns
    .find((entry) => entry.logicalName === 'cr1_name')
    .schemaName = 'cr1_OtherName';
  assert.throws(
    () => reconciliationScope(columnMismatch),
    /schemaName must resolve to logicalName cr1_name/,
  );

  const adaptedTableMismatch = createContract();
  const adaptedItem = adaptedTableMismatch.tables.find(
    (entry) => entry.logicalName === 'cr1_item',
  );
  adaptedItem.plannedDecision = 'adapt';
  adaptedItem.adaptedLogicalName = 'cr1_itemv2';
  adaptedItem.adaptedSchemaName = 'cr1_WrongV2';
  assert.throws(
    () => reconciliationScope(adaptedTableMismatch),
    /schemaName must resolve to logicalName cr1_itemv2/,
  );
});

test('adapted relationship lookup identity must match the adapted child column', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_child', 'extend', 1, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
        contractColumn('cr1_parentid', 'lookup', 'adapt', {
          lookupTarget: 'cr1_parent',
          adaptedLogicalName: 'cr1_parentidv2',
          adaptedSchemaName: 'cr1_ParentIdV2',
        }),
      ], {
        relationships: [{
          kind: 'many-to-one',
          schemaName: 'cr1_Parent_Child_v2',
          adaptedSchemaName: 'cr1_Parent_Child_v2',
          plannedDecision: 'adapt',
          parentTable: 'cr1_parent',
          childTable: 'cr1_child',
          lookup: {
            logicalName: 'cr1_parentid',
            schemaName: 'cr1_ParentId',
            adaptedLogicalName: 'cr1_differentid',
            adaptedSchemaName: 'cr1_DifferentId',
          },
        }],
      }),
      contractTable('cr1_parent', 'reuse', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
      ]),
    ],
  };
  const adaptedColumnMismatch = structuredClone(contract);
  const mismatchedColumn = adaptedColumnMismatch.tables[0].columns.find(
    (entry) => entry.logicalName === 'cr1_parentid',
  );
  mismatchedColumn.adaptedSchemaName = 'cr1_WrongId';
  adaptedColumnMismatch.tables[0].relationships[0].lookup.adaptedLogicalName =
    mismatchedColumn.adaptedLogicalName;
  adaptedColumnMismatch.tables[0].relationships[0].lookup.adaptedSchemaName =
    'cr1_ParentIdV2';
  assert.throws(
    () => reconciliationScope(adaptedColumnMismatch),
    /schemaName must resolve to logicalName cr1_parentidv2/,
  );
  assert.throws(
    () => reconciliationScope(contract),
    /adapted lookup identity must match/,
  );
});

test('lookup and relationship decisions cannot authorize different outcomes', () => {
  const contract = createContract();
  contract.tables
    .find((item) => item.logicalName === 'cr1_item')
    .columns
    .find((item) => item.logicalName === 'cr1_categoryid')
    .plannedDecision = 'defer';
  assert.throws(
    () => reconciliationScope(contract),
    /decision must match its lookup column decision/,
  );
});

test('lookup column requiredLevel is authoritative for relationship payloads', () => {
  const mismatch = createContract();
  mismatch.tables
    .find((item) => item.logicalName === 'cr1_item')
    .relationships[0].lookup.requiredLevel = 'ApplicationRequired';
  assert.throws(
    () => reconciliationScope(mismatch),
    /lookup requiredLevel must match/,
  );

  const contract = createContract();
  const item = contract.tables.find((entry) => entry.logicalName === 'cr1_item');
  item.columns.find((entry) => entry.logicalName === 'cr1_categoryid')
    .requiredLevel = 'ApplicationRequired';
  delete item.relationships[0].lookup.requiredLevel;
  const manifest = buildManifest(buildInputs(contract, basePlanningSnapshot()));
  assert.equal(
    manifest.execution.phases[2].operations[0].body.Lookup.RequiredLevel.Value,
    'ApplicationRequired',
  );
});

test('alternate keys cannot depend on deferred or unverified columns', () => {
  const contract = createContract();
  contract.tables
    .find((item) => item.logicalName === 'cr1_item')
    .columns
    .find((item) => item.logicalName === 'cr1_code')
    .plannedDecision = 'defer';
  assert.throws(
    () => reconciliationScope(contract),
    /cannot depend on cr1_code with decision defer/,
  );
});

test('reuse tables cannot smuggle create or adapt column writes', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [contractTable('cr1_existing', 'reuse', 0, [
      contractColumn('cr1_name', 'string', 'create', { primaryName: true }),
    ])],
  };
  assert.throws(
    () => reconciliationScope(contract),
    /reuse table cannot authorize create column cr1_name/,
  );
});

test('existing create targets with missing ordinary columns conflict instead of extending', () => {
  const contact = table('contact', [
    column('fullname', 'String', { primaryName: true, customAttribute: false }),
  ], { customEntity: false });
  const partialCategory = table('cr1_category', []);
  const manifest = buildManifest(buildInputs(createContract(), snapshot({
    tables: [contact, partialCategory],
    proposedMissing: ['cr1_item'],
    proposedCollisions: ['cr1_category'],
    exactUnavailable: ['cr1_deferred'],
  })));
  const categoryName = manifest.decisions.find(
    (item) => item.itemId === 'column:cr1_category:cr1_name',
  );
  assert.equal(categoryName.decision, 'create');
  assert.equal(categoryName.verificationStatus, 'unverified');
  assert.equal(manifest.execution.phases[1].operations.length, 0);
  assert.equal(manifest.executable, false);
});

test('free-form Markdown is hash-bound but never parsed into operations', () => {
  const contract = createContract();
  const reconciliation = basePlanningSnapshot();
  const first = buildManifest(buildInputs(contract, reconciliation, '# Approved A\n'));
  const second = buildManifest(buildInputs(contract, reconciliation, '# Completely different prose\n'));
  assert.notEqual(first.binding.planSha256, second.binding.planSha256);
  assert.deepEqual(first.decisions, second.decisions);
  assert.deepEqual(first.aliases, second.aliases);
  assert.deepEqual(first.service, second.service);
  assert.deepEqual(first.execution, second.execution);
});

test('service-required tables are explicit and deferred tables are excluded', () => {
  const manifest = buildManifest(buildInputs(createContract(), basePlanningSnapshot()));
  assert.deepEqual(
    manifest.service.requiredTables.map((item) => item.logicalName),
    ['contact', 'cr1_category', 'cr1_item'],
  );
  assert.equal(manifest.service.generationMode, 'sequential-outside-batch-metadata');
  assert.equal(manifest.execution.executor, 'BATCH-METADATA');
  assert.equal(manifest.execution.odataBatch, false);
  assert.equal(manifest.execution.parallelWrites, false);
});

test('service-required M:N intersect tables stay outside metadata table creates', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_item', 'create', 0, [
        contractColumn('cr1_name', 'string', 'create', { primaryName: true }),
      ], {
        relationships: [{
          kind: 'many-to-many',
          schemaName: 'cr1_Item_Tag',
          plannedDecision: 'create',
          entity1: 'cr1_item',
          entity2: 'cr1_tag',
          intersectTable: 'cr1_item_tag',
          serviceRequired: true,
        }],
      }),
      contractTable('cr1_tag', 'create', 0, [
        contractColumn('cr1_name', 'string', 'create', { primaryName: true }),
      ]),
    ],
  };
  const manifest = buildManifest(buildInputs(contract, snapshot({
    proposedMissing: ['cr1_item', 'cr1_tag'],
  })));
  assert.deepEqual(reconciliationScope(contract), {
    schemaVersion: 1,
    exactTables: ['cr1_item', 'cr1_item_tag', 'cr1_tag'],
    proposedTables: ['cr1_item', 'cr1_item_tag', 'cr1_tag'],
  });

  assert.deepEqual(
    manifest.service.requiredTables.map((item) => item.logicalName),
    ['cr1_item', 'cr1_item_tag', 'cr1_tag'],
  );
  assert.deepEqual(
    manifest.execution.phases[0].operations.map((item) => item.id),
    ['create-table:cr1_item', 'create-table:cr1_tag'],
  );
  assert.equal(manifest.execution.phases[2].operations[0].id, 'create-relationship:cr1_item_tag');

  const collidingIntersect = table('cr1_item_tag', [
    column('cr1_name', 'String', { primaryName: true }),
  ]);
  const existingItem = table('cr1_item', [
    column('cr1_name', 'String', { primaryName: true }),
  ]);
  const existingTag = table('cr1_tag', [
    column('cr1_name', 'String', { primaryName: true }),
  ]);
  const blocked = buildManifest(buildInputs(contract, snapshot({
    tables: [existingItem, collidingIntersect, existingTag],
  })));
  const relationshipDecision = blocked.decisions.find(
    (decision) => decision.itemType === 'relationship',
  );
  assert.equal(relationshipDecision.verificationStatus, 'unverified');
  assert.match(relationshipDecision.reason, /intersect name cr1_item_tag collides/);
  assert.equal(blocked.execution.phases[2].operations.length, 0);
});

test('existing customizable tables queue only missing ordinary columns as extensions', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_item', 'extend', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
        contractColumn('cr1_code', 'string', 'create'),
      ]),
    ],
  };
  const liveItem = table('cr1_item', [
    column('cr1_name', 'String', { primaryName: true }),
  ]);
  const manifest = buildManifest(buildInputs(contract, snapshot({ tables: [liveItem] })));

  assert.equal(
    manifest.decisions.find((item) => item.itemId === 'table:cr1_item').decision,
    'extend',
  );
  assert.equal(manifest.execution.phases[0].operations.length, 0);
  assert.deepEqual(
    manifest.execution.phases[1].operations.map((item) => item.id),
    ['extend-column:cr1_item:cr1_code'],
  );
  assert.equal(manifest.execution.phases[4].operations.length, 1);
});

test('adapt, defer, and unverified decisions are explicit and unverified blocks execution', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_collision', 'adapt', 0, [
        contractColumn('cr1_name', 'string', 'create', { primaryName: true }),
      ], {
        adaptedLogicalName: 'cr1_collisionv2',
        adaptedSchemaName: 'cr1_collisionv2',
      }),
      contractTable('cr1_manageddependency', 'defer', 0, []),
      contractTable('cr1_unknown', 'unverified', 0, [
        contractColumn('cr1_name', 'string', 'unverified', { primaryName: true }),
      ]),
    ],
  };
  const manifest = buildManifest(buildInputs(contract, snapshot({
    proposedMissing: ['cr1_collisionv2'],
    exactUnavailable: ['cr1_manageddependency'],
  })));
  const byId = new Map(manifest.decisions.map((item) => [item.itemId, item]));

  assert.equal(byId.get('table:cr1_collision').decision, 'adapt');
  assert.equal(byId.get('table:cr1_collision').effectiveName, 'cr1_collisionv2');
  assert.equal(byId.get('table:cr1_manageddependency').decision, 'defer');
  assert.equal(byId.get('table:cr1_unknown').decision, 'unverified');
  assert.equal(byId.get('table:cr1_unknown').verificationStatus, 'unverified');
  assert.equal(byId.get('column:cr1_unknown:cr1_name').decision, 'unverified');
  assert.equal(
    byId.get('column:cr1_unknown:cr1_name').verificationStatus,
    'unverified',
  );
  assert.equal(manifest.executable, false);
  assert.equal(manifest.publishCheckpoint, null);
  assert.deepEqual(manifest.verification.unresolvedItemIds, [
    'column:cr1_unknown:cr1_name',
    'table:cr1_unknown',
  ]);
});

test('validation rejects environment, plan, and reconciliation mismatches', () => {
  const contract = createContract();
  const snapshotValue = basePlanningSnapshot();
  const inputs = buildInputs(contract, snapshotValue, '# Approved plan\n');
  const manifest = buildManifest(inputs);

  const wrongEnvironment = validateManifest(manifest, {
    ...inputs,
    context: { ...CONTEXT, environmentId: 'environment-2' },
  });
  assert.equal(wrongEnvironment.valid, false);
  assert.match(wrongEnvironment.errors.join('; '), /environmentId mismatch/);

  const wrongPlan = validateManifest(manifest, {
    ...inputs,
    planBytes: Buffer.from('# Changed plan\n'),
  });
  assert.equal(wrongPlan.valid, false);
  assert.match(wrongPlan.errors.join('; '), /plan hash mismatch/);
  assert.throws(
    () => buildManifest({
      ...inputs,
      planBytes: Buffer.from('# Changed plan\n'),
    }),
    /mobile plan approval receipt plan hash does not match/,
  );

  const changedSnapshot = {
    ...snapshotValue,
    generatedAt: '2026-08-18T23:40:00.000Z',
  };
  const wrongSnapshot = validateManifest(manifest, {
    ...inputs,
    reconciliation: changedSnapshot,
    reconciliationBytes: Buffer.from(JSON.stringify(changedSnapshot, null, 2)),
  });
  assert.equal(wrongSnapshot.valid, false);
  assert.match(
    wrongSnapshot.errors.join('; '),
    /execution reconciliation hash mismatch|execution reconciliation timestamp mismatch/,
  );
});

test('validation rejects stale reconciliations and non-executable manifests', () => {
  const contract = createContract();
  const stale = basePlanningSnapshot();
  stale.generatedAt = '2026-08-18T20:00:00.000Z';
  assert.throws(
    () => buildManifest(buildInputs(contract, stale)),
    /execution reconciliation is stale/,
  );

  const unverifiedContract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_unknown', 'unverified', 0, [
        contractColumn('cr1_name', 'string', 'unverified', { primaryName: true }),
      ]),
    ],
  };
  const inputs = buildInputs(unverifiedContract, snapshot());
  const manifest = buildManifest(inputs);
  const validation = validateManifest(manifest, {
    ...inputs,
    requireExecutable: true,
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('; '), /approved schema revision is required/);
});

test('foreground planning snapshot alone can never authorize metadata writes', () => {
  const contract = createContract();
  const planningSnapshot = basePlanningSnapshot();
  planningSnapshot.purpose = 'foreground-planning';
  delete planningSnapshot.reconciliation;
  assert.throws(
    () => buildManifest(buildInputs(contract, planningSnapshot)),
    /fresh bounded exact-name artifact/,
  );
});

test('fresh reconciliation must cover the exact structured-schema scope', () => {
  const inputs = buildInputs(createContract(), basePlanningSnapshot());
  const removed = inputs.reconciliation.inputs.explicitTableNames.pop();
  inputs.reconciliation.exactNameResolution.requestedTables = inputs.reconciliation
    .exactNameResolution.requestedTables.filter((name) => name !== removed);
  inputs.reconciliation.exactNameResolution.unavailableTables = inputs.reconciliation
    .exactNameResolution.unavailableTables.filter((name) => name !== removed);
  inputs.reconciliationBytes = Buffer.from(JSON.stringify(
    inputs.reconciliation,
    null,
    2,
  ));
  assert.throws(
    () => buildManifest(inputs),
    /scope does not exactly match the approved structured schema/,
  );
});

test('a fully applied rerun produces zero metadata POST operations', () => {
  const contract = createContract();
  const manifest = buildManifest(buildInputs(contract, fullyAppliedSnapshot()));
  const operations = manifest.execution.phases.flatMap((phase) => phase.operations);

  assert.equal(manifest.executable, true);
  assert.equal(manifest.summary.metadataOperationCount, 0);
  assert.equal(manifest.summary.metadataWriteCount, 0);
  assert.deepEqual(operations, []);
  assert.ok(
    manifest.decisions
      .filter((item) => item.decision === 'create')
      .every((item) => item.operation === 'none' && item.verificationStatus === 'verified'),
  );
});

test('mobile plan approval receipt binds exact contract and service dependencies', () => {
  const contract = createContract();
  const inputs = buildInputs(contract, basePlanningSnapshot(), '# Approved plan\n');
  const manifest = buildManifest(inputs);

  assert.equal(
    manifest.binding.approvedContractSha256,
    inputs.approvalReceipt.approvedContractSha256,
  );
  assert.equal(
    manifest.binding.approvalReceiptSha256,
    inputs.approvalReceipt.integritySha256,
  );
  assert.deepEqual(
    manifest.service.requiredTables.map((item) => ({
      logicalName: item.logicalName,
      consumers: item.consumers,
    })),
    inputs.approvalReceipt.serviceRequiredTables,
  );

  const addedTable = createContract();
  addedTable.tables.push(contractTable('cr1_unapproved', 'create', 0, [
    contractColumn('cr1_name', 'string', 'create', { primaryName: true }),
  ]));
  assert.throws(
    () => bindContractToPlan(
      addedTable,
      inputs.planBytes,
      inputs.approvalReceipt,
    ),
    /structured contract content does not match the approved contract/,
  );

  const alteredBoundContract = structuredClone(inputs.contract);
  alteredBoundContract.tables.find(
    (tableValue) => tableValue.logicalName === 'cr1_item',
  ).columns.push(contractColumn('cr1_unapprovedcolumn', 'string', 'create'));
  assert.throws(
    () => buildManifest({
      ...inputs,
      contract: alteredBoundContract,
      contractBytes: Buffer.from(stableJson(alteredBoundContract)),
    }),
    /structured contract content does not match the approved contract/,
  );

  const missingServiceReceipt = structuredClone(inputs.approvalReceipt);
  missingServiceReceipt.serviceRequiredTables =
    missingServiceReceipt.serviceRequiredTables.filter(
      (item) => item.logicalName !== 'contact',
    );
  delete missingServiceReceipt.integritySha256;
  missingServiceReceipt.integritySha256 = sha256(stableJson(missingServiceReceipt));
  assert.throws(
    () => bindContractToPlan(
      contract,
      inputs.planBytes,
      missingServiceReceipt,
    ),
    /approved service dependencies do not exactly match contract serviceRequired declarations/,
  );

  const pendingReceipt = structuredClone(inputs.approvalReceipt);
  pendingReceipt.approvals.screenPlan.status = 'pending';
  delete pendingReceipt.integritySha256;
  pendingReceipt.integritySha256 = sha256(stableJson(pendingReceipt));
  assert.throws(
    () => bindContractToPlan(contract, inputs.planBytes, pendingReceipt),
    /screenPlan status must be approved/,
  );
  assert.throws(
    () => bindContractToPlan(contract, inputs.planBytes, null),
    /mobile plan approval receipt must be an object/,
  );
});

test('existing Dataverse File and Image virtual attributes are zero-write compatible', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_item', 'extend', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
        contractColumn('cr1_document', 'file', 'create', { maxSizeInKB: 32768 }),
        contractColumn('cr1_photo', 'image', 'create', {
          maxHeight: 1440,
          maxWidth: 1440,
        }),
      ]),
    ],
  };
  const existing = table('cr1_item', [
    column('cr1_name', 'String', { primaryName: true }),
    column('cr1_document', 'Virtual', {
      typeName: 'FileType',
      maxSizeInKB: 32768,
    }),
    column('cr1_photo', 'Virtual', {
      typeName: 'ImageType',
      maxHeight: 1440,
      maxWidth: 1440,
    }),
  ]);
  const manifest = buildManifest(buildInputs(contract, snapshot({
    tables: [existing],
  })));
  assert.equal(manifest.summary.metadataOperationCount, 0);
  for (const logicalName of ['cr1_document', 'cr1_photo']) {
    const decision = manifest.decisions.find(
      (item) => item.itemId === `column:cr1_item:${logicalName}`,
    );
    assert.equal(decision.decision, 'create');
    assert.equal(decision.observedOutcome, 'reuse');
    assert.equal(decision.verificationStatus, 'verified');
  }

  for (const [logicalName, typeName] of [
    ['cr1_document', 'ImageType'],
    ['cr1_photo', 'FileType'],
  ]) {
    const incompatible = structuredClone(existing);
    incompatible.columns.find(
      (item) => item.logicalName === logicalName,
    ).typeName = typeName;
    const mismatch = buildManifest(buildInputs(contract, snapshot({
      tables: [incompatible],
    })));
    const decision = mismatch.decisions.find(
      (item) => item.itemId === `column:cr1_item:${logicalName}`,
    );
    assert.notEqual(decision.verificationStatus, 'verified');
    assert.equal(mismatch.executable, false);
    assert.equal(mismatch.summary.metadataOperationCount, 0);
  }
});

test('mechanical reconciliation never changes approved architecture decisions', () => {
  const contract = createContract();
  const manifest = buildManifest(buildInputs(contract, fullyAppliedSnapshot()));
  const approved = approvedDecisions(contract);
  for (const decision of manifest.decisions) {
    assert.equal(decision.decision, approved.get(decision.itemId));
  }
  assert.ok(manifest.decisions.some(
    (decision) => decision.decision === 'create'
      && decision.observedOutcome === 'reuse'
      && decision.operation === 'none',
  ));
});

test('unverified table, column, relationship, and key decisions never queue writes', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_unknown', 'unverified', 0, [
        contractColumn('cr1_name', 'string', 'unverified', { primaryName: true }),
        contractColumn('cr1_parentid', 'lookup', 'unverified', {
          lookupTarget: 'cr1_parent',
        }),
      ], {
        relationships: [{
          kind: 'many-to-one',
          schemaName: 'cr1_Parent_Unknown',
          plannedDecision: 'unverified',
          parentTable: 'cr1_parent',
          childTable: 'cr1_unknown',
          lookup: {
            logicalName: 'cr1_parentid',
            schemaName: 'cr1_parentid',
          },
        }],
        alternateKeys: [{
          schemaName: 'cr1_unknown_name_key',
          plannedDecision: 'unverified',
          columns: ['cr1_name'],
        }],
      }),
      contractTable('cr1_parent', 'unverified', 0, [
        contractColumn('cr1_name', 'string', 'unverified', { primaryName: true }),
      ]),
    ],
  };
  const manifest = buildManifest(buildInputs(contract, snapshot({
    proposedMissing: ['cr1_parent', 'cr1_unknown'],
  })));

  assert.equal(manifest.executable, false);
  assert.equal(manifest.summary.metadataOperationCount, 0);
  assert.deepEqual(
    [...new Set(manifest.decisions.map((item) => item.decision))],
    ['unverified'],
  );
  assert.ok(manifest.decisions.every((item) => item.operation === 'none'));
});

test('semantic validation rejects recomputed-hash tampering across executable content', () => {
  const inputs = buildInputs(createContract(), basePlanningSnapshot());
  const manifest = buildManifest(inputs);
  const variants = [
    (candidate) => { candidate.decisions[0].reason = 'tampered decision'; },
    (candidate) => { candidate.service.requiredTables[0].logicalName = 'cr1_other'; },
    (candidate) => {
      candidate.execution.phases[0].operations[0].apiPath = 'OtherDefinitions';
    },
    (candidate) => {
      candidate.execution.phases[0].operations[0].body.LogicalName = 'cr1_other';
    },
    (candidate) => { candidate.aliases.tables.cr1_item = 'cr1_other'; },
    (candidate) => { candidate.binding.maxReconciliationAgeMs *= 2; },
  ];

  for (const mutate of variants) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    delete candidate.integritySha256;
    candidate.integritySha256 = sha256(stableJson(candidate));
    const validation = validateManifest(candidate, inputs);
    assert.equal(validation.valid, false);
    assert.match(validation.errors.join('; '), /semantic content/);
  }
});

test('ordinary-column reuse requires complete compatible behavior evidence', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_item', 'extend', 0, [
        contractColumn('cr1_name', 'string', 'reuse', {
          primaryName: true,
          maxLength: 100,
          format: 'Text',
          requiredLevel: 'ApplicationRequired',
        }),
      ]),
    ],
  };
  const compatible = column('cr1_name', 'String', {
    primaryName: true,
    maxLength: 200,
    formatName: 'Text',
    requiredLevel: 'ApplicationRequired',
  });
  const compatibleManifest = buildManifest(buildInputs(contract, snapshot({
    tables: [table('cr1_item', [compatible])],
  })));
  assert.equal(
    compatibleManifest.decisions.find((item) => item.itemType === 'column').decision,
    'reuse',
  );

  for (const liveColumn of [
    { ...compatible, maxLength: 50 },
    (() => {
      const missing = { ...compatible };
      delete missing.formatName;
      return missing;
    })(),
    { ...compatible, requiredLevel: 'None' },
  ]) {
    const manifest = buildManifest(buildInputs(contract, snapshot({
      tables: [table('cr1_item', [liveColumn])],
    })));
    assert.equal(
      manifest.decisions.find((item) => item.itemType === 'column').decision,
      'reuse',
    );
    assert.equal(
      manifest.decisions.find((item) => item.itemType === 'column').verificationStatus,
      'unverified',
    );
    assert.equal(manifest.summary.metadataOperationCount, 0);
  }
});

test('ordinary Memo and Lookup columns accept nullable Dataverse SourceType', () => {
  const lookupReconciliation = fullyAppliedSnapshot();
  lookupReconciliation.tables
    .find((tableValue) => tableValue.logicalName === 'cr1_item')
    .columns
    .find((columnValue) => columnValue.logicalName === 'cr1_categoryid')
    .sourceType = null;
  const lookupManifest = buildManifest(buildInputs(
    createContract(),
    lookupReconciliation,
  ));
  assert.equal(lookupManifest.executable, true);
  assert.equal(lookupManifest.summary.metadataOperationCount, 0);

  const memoContract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_note', 'extend', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
        contractColumn('cr1_description', 'memo', 'reuse', {
          maxLength: 10000,
          format: 'TextArea',
        }),
      ]),
    ],
  };
  const memoManifest = buildManifest(buildInputs(memoContract, snapshot({
    tables: [table('cr1_note', [
      column('cr1_name', 'String', { primaryName: true }),
      column('cr1_description', 'Memo', { sourceType: null }),
    ])],
  })));
  assert.equal(memoManifest.executable, true);
  assert.equal(memoManifest.summary.metadataOperationCount, 0);

  const stringWithNullSourceType = column('cr1_name', 'String', {
    primaryName: true,
    sourceType: null,
  });
  const blocked = buildManifest(buildInputs({
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_note', 'extend', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
      ]),
    ],
  }, snapshot({
    tables: [table('cr1_note', [stringWithNullSourceType])],
  })));
  assert.equal(blocked.executable, false);
  assert.match(
    blocked.decisions.find((item) => item.itemType === 'column').reason,
    /SourceType evidence is missing/,
  );
});

test('ordinary-column precision, range, date behavior, and primary-name constraints are enforced', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_item', 'extend', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
        contractColumn('cr1_amount', 'decimal', 'reuse', {
          minValue: -10,
          maxValue: 10,
          precision: 2,
        }),
        contractColumn('cr1_occurredon', 'datetime', 'reuse', {
          format: 'DateAndTime',
          behavior: 'UserLocal',
        }),
      ]),
    ],
  };
  const compatibleColumns = [
    column('cr1_name', 'String', { primaryName: true }),
    column('cr1_amount', 'Decimal', {
      minValue: -100,
      maxValue: 100,
      precision: 2,
    }),
    column('cr1_occurredon', 'DateTime', {
      format: 'DateAndTime',
      dateTimeBehavior: 'UserLocal',
    }),
  ];
  assert.equal(buildManifest(buildInputs(contract, snapshot({
    tables: [table('cr1_item', compatibleColumns)],
  }))).executable, true);

  const mutations = [
    (columns) => { columns[0].primaryName = false; },
    (columns) => { columns[1].minValue = 0; },
    (columns) => { columns[1].precision = 4; },
    (columns) => { columns[2].dateTimeBehavior = 'TimeZoneIndependent'; },
  ];
  for (const mutate of mutations) {
    const liveColumns = structuredClone(compatibleColumns);
    mutate(liveColumns);
    const manifest = buildManifest(buildInputs(contract, snapshot({
      tables: [table('cr1_item', liveColumns)],
    })));
    assert.equal(manifest.executable, false);
    assert.equal(manifest.summary.metadataOperationCount, 0);
  }
});

test('relationship reuse requires complete matching cascade semantics', () => {
  for (const mutate of [
    (relationship) => { relationship.cascadeConfiguration = null; },
    (relationship) => { relationship.cascadeConfiguration.Delete = 'Cascade'; },
  ]) {
    const reconciliation = fullyAppliedSnapshot();
    const relationship = reconciliation.tables
      .find((tableValue) => tableValue.logicalName === 'cr1_item')
      .manyToOneRelationships[0];
    mutate(relationship);
    const manifest = buildManifest(buildInputs(createContract(), reconciliation));
    const decision = manifest.decisions.find(
      (item) => item.itemType === 'relationship',
    );
    assert.equal(decision.decision, 'create');
    assert.equal(decision.verificationStatus, 'conflict');
    assert.equal(manifest.executable, false);
  }
});

test('create-table idempotency requires complete matching emitted table behavior', () => {
  for (const mutate of [
    (liveTable) => { liveTable.hasActivities = true; },
    (liveTable) => { delete liveTable.ownershipType; },
    (liveTable) => { liveTable.changeTrackingEnabled = false; },
  ]) {
    const reconciliation = fullyAppliedSnapshot();
    const liveItem = reconciliation.tables.find(
      (tableValue) => tableValue.logicalName === 'cr1_item',
    );
    mutate(liveItem);
    const manifest = buildManifest(buildInputs(createContract(), reconciliation));
    const itemDecision = manifest.decisions.find(
      (decision) => decision.itemId === 'table:cr1_item',
    );
    assert.equal(itemDecision.decision, 'create');
    assert.equal(itemDecision.verificationStatus, 'unverified');
    assert.equal(manifest.executable, false);
    assert.equal(manifest.summary.metadataOperationCount, 0);
  }

  const matchingContract = createContract();
  matchingContract.tables.find((tableValue) => tableValue.logicalName === 'cr1_item')
    .hasActivities = true;
  const matchingSnapshot = fullyAppliedSnapshot();
  matchingSnapshot.tables.find((tableValue) => tableValue.logicalName === 'cr1_item')
    .hasActivities = true;
  const matching = buildManifest(buildInputs(matchingContract, matchingSnapshot));
  assert.equal(matching.executable, true);
  assert.equal(matching.summary.metadataOperationCount, 0);
});

test('missing lookups on non-extensible child tables conflict without changing approved decisions', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_child', 'extend', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
        contractColumn('cr1_parentid', 'lookup', 'create', {
          lookupTarget: 'cr1_parent',
        }),
      ], {
        relationships: [{
          kind: 'many-to-one',
          schemaName: 'cr1_Parent_Child',
          plannedDecision: 'create',
          parentTable: 'cr1_parent',
          childTable: 'cr1_child',
          lookup: {
            logicalName: 'cr1_parentid',
            schemaName: 'cr1_parentid',
          },
        }],
      }),
      contractTable('cr1_parent', 'reuse', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
      ]),
    ],
  };
  const parent = table('cr1_parent', [
    column('cr1_name', 'String', { primaryName: true }),
  ]);
  for (const capabilities of [
    { customizable: false, canCreateAttributes: true },
    { customizable: true, canCreateAttributes: false },
    {
      customizable: true,
      canCreateAttributes: true,
      canBeRelatedEntityInRelationship: false,
    },
  ]) {
    const child = table('cr1_child', [
      column('cr1_name', 'String', { primaryName: true }),
    ], capabilities);
    const manifest = buildManifest(buildInputs(
      contract,
      snapshot({ tables: [child, parent] }),
    ));

    assert.equal(
      manifest.decisions.find(
        (item) => item.itemId === 'column:cr1_child:cr1_parentid',
      ).decision,
      'create',
    );
    assert.equal(
      manifest.decisions.find((item) => item.itemType === 'relationship').decision,
      'create',
    );
    assert.equal(
      manifest.decisions.find(
        (item) => item.itemId === 'column:cr1_child:cr1_parentid',
      ).verificationStatus,
      'conflict',
    );
    assert.equal(
      manifest.decisions.find((item) => item.itemType === 'relationship')
        .verificationStatus,
      'conflict',
    );
    assert.equal(manifest.execution.phases[2].operations.length, 0);
  }
});

test('supplied fast-path failures fail closed while absent handoffs retain Step 2 fallback', () => {
  const skill = fs.readFileSync(path.join(
    __dirname,
    '../../skills/add-dataverse/SKILL.md',
  ), 'utf8');
  assert.match(skill, /An entirely absent fast-path handoff means[\s\S]*fallback/);
  assert.match(skill, /partially supplied handoff[\s\S]*must fail closed/);
  assert.match(skill, /Never jump to[\s\S]*Step 4 without Step 2 initialization/);
  assert.match(skill, /do not[\s\S]*switch a supplied candidate to the standalone fallback/i);
  assert.match(
    skill,
    /non-executable[\s\S]*candidate[\s\S]*authorizes no metadata write/,
  );
  assert.match(skill, /discard[\s\S]*not-yet-run phase arrays/);
  assert.match(
    skill,
    /structured schema[\s\S]*regenerate the complete aliases[\s\S]*service-required names/,
  );
  assert.match(skill, /--approval-receipt <working_dir>\/\.tmp\/mobile-plan-status\.json/);
  const createSkill = fs.readFileSync(path.join(
    __dirname,
    '../../skills/create-mobile-app/SKILL.md',
  ), 'utf8');
  assert.match(
    createSkill,
    /foreground planning snapshot[\s\S]*never authorizes a write/,
  );
  assert.match(createSkill, /--reconcile-exact/);
  assert.match(
    createSkill,
    /one fresh bounded reconciliation[\s\S]*ordinary typed columns[\s\S]*relationships[\s\S]*alternate keys/,
  );
  assert.match(createSkill, /--bind-plan "\$SCHEMA_CONTRACT"/);
  assert.match(createSkill, /--approval-receipt "\$APPROVAL_RECEIPT"/);
  assert.match(
    createSkill,
    /receipt is missing, STOP as `BLOCKED`[\s\S]*must not synthesize it/,
  );
  const planner = fs.readFileSync(path.join(
    __dirname,
    '../../agents/native-app-planner.md',
  ), 'utf8');
  assert.match(
    planner,
    /Approved:[\s\S]*mobile-plan-status\.json[\s\S]*dataModel.*approval record/,
  );
  assert.match(
    planner,
    /Do not call the manifest builder to create or restamp this receipt/,
  );
});

test('publish checkpoint retries PublishXml after schema writes become idempotent', () => {
  const contract = createContract();
  const first = buildManifest(buildInputs(contract, basePlanningSnapshot()));
  assert.ok(first.publishCheckpoint);
  assert.deepEqual(first.publishCheckpoint.tables, ['cr1_category', 'cr1_item']);

  const appliedInputs = buildInputs(contract, fullyAppliedSnapshot());
  const retry = buildManifest({
    ...appliedInputs,
    publishCheckpoint: first.publishCheckpoint,
  });
  assert.deepEqual(
    retry.execution.phases.flatMap((phase) => phase.operations).map((item) => item.id),
    ['publish-customizations'],
  );
  assert.deepEqual(retry.publishCheckpoint, first.publishCheckpoint);

  const complete = buildManifest(appliedInputs);
  assert.equal(complete.publishCheckpoint, null);
  assert.equal(complete.summary.metadataOperationCount, 0);

  const mismatchedCheckpoint = structuredClone(first.publishCheckpoint);
  mismatchedCheckpoint.binding.environmentId = 'environment-2';
  delete mismatchedCheckpoint.integritySha256;
  mismatchedCheckpoint.integritySha256 = sha256(stableJson(mismatchedCheckpoint));
  assert.throws(
    () => buildManifest({ ...appliedInputs, publishCheckpoint: mismatchedCheckpoint }),
    /publish checkpoint environmentId mismatch/,
  );
});

test('collision checkpoint roll-forward preserves prior writes and rebinds revised aliases', () => {
  const priorInputs = buildInputs(createContract(), basePlanningSnapshot(), '# Prior plan\n');
  const priorManifest = buildManifest(priorInputs);
  const priorOperations = priorManifest.execution.phases.flatMap(
    (phase) => phase.operations,
  );
  const completedOperation = priorOperations.find(
    (operation) => operation.id === 'create-table:cr1_category',
  );
  const collisionOperation = priorOperations.find(
    (operation) => operation.id === 'create-table:cr1_item',
  );
  const journal = {
    schemaVersion: 1,
    binding: {
      environmentUrl: CONTEXT.environmentUrl,
      solution: CONTEXT.solutionUniqueName,
    },
    completed: {
      [operationFingerprint(completedOperation, CONTEXT.solutionUniqueName)]: {
        operationId: completedOperation.id,
      },
    },
    recoveries: [],
    inFlight: {
      index: collisionOperation.index,
      operationId: collisionOperation.id,
      fingerprint: operationFingerprint(
        collisionOperation,
        CONTEXT.solutionUniqueName,
      ),
      manifestHash: priorManifest.integritySha256,
      reconciliationHash: priorManifest.binding.reconciliationSha256,
      failure: {
        status: 400,
        collision: true,
      },
    },
  };
  const supersededFingerprint = 'f'.repeat(64);
  journal.completed[supersededFingerprint] = {
    operationId: 'create-table:older-collision',
  };
  journal.recoveries.push({
    fingerprint: supersededFingerprint,
    outcome: 'fresh-reconciliation-confirmed-superseded-collision',
  });

  const revisedContract = createContract();
  const revisedItem = revisedContract.tables.find(
    (tableValue) => tableValue.logicalName === 'cr1_item',
  );
  revisedItem.plannedDecision = 'adapt';
  revisedItem.adaptedLogicalName = 'cr1_itemv2';
  revisedItem.adaptedSchemaName = 'cr1_ItemV2';
  const revisedTables = fullyAppliedSnapshot().tables.filter(
    (tableValue) => tableValue.logicalName !== 'cr1_item',
  );
  const revisedSnapshot = snapshot({
    tables: revisedTables,
    exactUnavailable: ['cr1_deferred'],
  });
  const revisedInputs = buildInputs(
    revisedContract,
    revisedSnapshot,
    '# Revised plan\n',
  );
  const rolled = rollForwardPublishCheckpoint({
    checkpoint: priorManifest.publishCheckpoint,
    previousManifest: priorManifest,
    journal,
    contract: revisedInputs.contract,
    approvalReceipt: revisedInputs.approvalReceipt,
    contractBytes: revisedInputs.contractBytes,
    planBytes: revisedInputs.planBytes,
    context: CONTEXT,
    rolledAt: NOW,
  });

  assert.deepEqual(rolled.tables, ['cr1_category', 'cr1_itemv2']);
  assert.equal(rolled.binding.planSha256, sha256(revisedInputs.planBytes));
  assert.equal(
    rolled.binding.structuredSchemaSha256,
    sha256(revisedInputs.contractBytes),
  );
  assert.deepEqual(rolled.rollForwards[0].previousTables, [
    'cr1_category',
    'cr1_item',
  ]);
  assert.deepEqual(
    rolled.rollForwards[0].previousCheckpoint,
    priorManifest.publishCheckpoint,
  );
  assert.deepEqual(rolled.rollForwards[0].tableMappings, [{
    requestedName: 'cr1_item',
    from: 'cr1_item',
    to: 'cr1_itemv2',
  }]);

  const revisedManifest = buildManifest({
    ...revisedInputs,
    publishCheckpoint: rolled,
  });
  assert.deepEqual(revisedManifest.publishCheckpoint.rollForwards, rolled.rollForwards);
  assert.equal(
    revisedManifest.execution.phases[4].operations[0].body.ParameterXml
      .includes('<entity>cr1_item</entity>'),
    false,
  );
  assert.match(
    revisedManifest.execution.phases[4].operations[0].body.ParameterXml,
    /<entity>cr1_category<\/entity>.*<entity>cr1_itemv2<\/entity>/,
  );
  const erasedEvidence = structuredClone(rolled);
  erasedEvidence.rollForwards[0].previousCheckpoint.tables = ['cr1_item'];
  delete erasedEvidence.integritySha256;
  erasedEvidence.integritySha256 = sha256(stableJson(erasedEvidence));
  assert.throws(
    () => buildManifest({
      ...revisedInputs,
      publishCheckpoint: erasedEvidence,
    }),
    /previousCheckpoint integrity does not match|previousCheckpoint evidence does not match/,
  );

  const unsafeContract = structuredClone(revisedInputs.contract);
  unsafeContract.tables = unsafeContract.tables.filter(
    (tableValue) => tableValue.logicalName !== 'cr1_category',
  );
  const unsafeItem = unsafeContract.tables.find(
    (tableValue) => tableValue.logicalName === 'cr1_item',
  );
  unsafeItem.columns = unsafeItem.columns.filter(
    (columnValue) => columnValue.logicalName !== 'cr1_categoryid',
  );
  unsafeItem.relationships = [];
  const unsafeInputs = buildInputs(
    unsafeContract,
    revisedSnapshot,
    '# Revised plan\n',
  );
  assert.throws(
    () => rollForwardPublishCheckpoint({
      checkpoint: priorManifest.publishCheckpoint,
      previousManifest: priorManifest,
      journal,
      contract: unsafeInputs.contract,
      approvalReceipt: unsafeInputs.approvalReceipt,
      contractBytes: unsafeInputs.contractBytes,
      planBytes: unsafeInputs.planBytes,
      context: CONTEXT,
      rolledAt: NOW,
    }),
    /checkpoint table cr1_category is outside the revised contract without collision evidence/,
  );
});

test('checkpoint roll-forward rejects removed completed columns, relationships, and keys', () => {
  function expectCompletedComponentRejected({
    priorContract,
    reconciliation,
    completedId,
    collisionId,
    revise,
  }) {
    const priorInputs = buildInputs(priorContract, reconciliation, '# Prior component plan\n');
    const priorManifest = buildManifest(priorInputs);
    const operations = priorManifest.execution.phases.flatMap((phase) => phase.operations);
    const completedOperation = operations.find((item) => item.id === completedId);
    const collisionOperation = operations.find((item) => item.id === collisionId);
    assert.ok(completedOperation, completedId);
    assert.ok(collisionOperation, collisionId);
    const journal = {
      schemaVersion: 1,
      binding: {
        environmentUrl: CONTEXT.environmentUrl,
        solution: CONTEXT.solutionUniqueName,
      },
      completed: {
        [operationFingerprint(completedOperation, CONTEXT.solutionUniqueName)]: {
          operationId: completedOperation.id,
        },
      },
      recoveries: [],
      inFlight: {
        index: collisionOperation.index,
        operationId: collisionOperation.id,
        fingerprint: operationFingerprint(
          collisionOperation,
          CONTEXT.solutionUniqueName,
        ),
        manifestHash: priorManifest.integritySha256,
        reconciliationHash: priorManifest.binding.reconciliationSha256,
        failure: { status: 400, collision: true },
      },
    };
    const revisedContract = structuredClone(priorContract);
    revise(revisedContract);
    const revisedInputs = buildInputs(
      revisedContract,
      reconciliation,
      '# Revised component plan\n',
    );
    assert.throws(
      () => rollForwardPublishCheckpoint({
        checkpoint: priorManifest.publishCheckpoint,
        previousManifest: priorManifest,
        journal,
        contract: revisedInputs.contract,
        approvalReceipt: revisedInputs.approvalReceipt,
        contractBytes: revisedInputs.contractBytes,
        planBytes: revisedInputs.planBytes,
        context: CONTEXT,
        rolledAt: NOW,
      }),
      new RegExp(`completed metadata component ${completedId} was removed or changed`),
    );
  }

  const extensionContract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [contractTable('cr1_item', 'extend', 0, [
      contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
      contractColumn('cr1_a', 'string', 'create'),
      contractColumn('cr1_b', 'string', 'create'),
    ])],
  };
  const existingItem = table('cr1_item', [
    column('cr1_name', 'String', { primaryName: true }),
  ]);
  expectCompletedComponentRejected({
    priorContract: extensionContract,
    reconciliation: snapshot({ tables: [existingItem] }),
    completedId: 'extend-column:cr1_item:cr1_a',
    collisionId: 'extend-column:cr1_item:cr1_b',
    revise: (contract) => {
      contract.tables[0].columns = contract.tables[0].columns.filter(
        (item) => item.logicalName !== 'cr1_a',
      );
      const collisionColumn = contract.tables[0].columns.find(
        (item) => item.logicalName === 'cr1_b',
      );
      collisionColumn.plannedDecision = 'adapt';
      collisionColumn.adaptedLogicalName = 'cr1_bv2';
      collisionColumn.adaptedSchemaName = 'cr1_BV2';
    },
  });

  const relationshipContract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_item', 'reuse', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
      ], {
        relationships: [{
          kind: 'many-to-many',
          schemaName: 'cr1_Item_Tag',
          plannedDecision: 'create',
          entity1: 'cr1_item',
          entity2: 'cr1_tag',
          intersectTable: 'cr1_item_tag',
        }, {
          kind: 'many-to-many',
          schemaName: 'cr1_Item_Category',
          plannedDecision: 'create',
          entity1: 'cr1_item',
          entity2: 'cr1_category',
          intersectTable: 'cr1_item_category',
        }],
      }),
      contractTable('cr1_category', 'reuse', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
      ]),
      contractTable('cr1_tag', 'reuse', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
      ]),
    ],
  };
  const relationshipSnapshot = snapshot({
    tables: [
      table('cr1_item', [column('cr1_name', 'String', { primaryName: true })]),
      table('cr1_category', [column('cr1_name', 'String', { primaryName: true })]),
      table('cr1_tag', [column('cr1_name', 'String', { primaryName: true })]),
    ],
  });
  expectCompletedComponentRejected({
    priorContract: relationshipContract,
    reconciliation: relationshipSnapshot,
    completedId: 'create-relationship:cr1_item_category',
    collisionId: 'create-relationship:cr1_item_tag',
    revise: (contract) => {
      contract.tables[0].relationships = contract.tables[0].relationships.filter(
        (item) => item.schemaName !== 'cr1_Item_Category',
      );
      const collisionRelationship = contract.tables[0].relationships[0];
      collisionRelationship.plannedDecision = 'adapt';
      collisionRelationship.adaptedSchemaName = 'cr1_Item_Tag_v2';
      collisionRelationship.adaptedIntersectTable = 'cr1_item_tag_v2';
    },
  });

  const keyContract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [contractTable('cr1_item', 'reuse', 0, [
      contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
      contractColumn('cr1_code', 'string', 'reuse'),
    ], {
      alternateKeys: [{
        schemaName: 'cr1_item_code_key_a',
        plannedDecision: 'create',
        columns: ['cr1_code'],
      }, {
        schemaName: 'cr1_item_code_key_b',
        plannedDecision: 'create',
        columns: ['cr1_code'],
      }],
    })],
  };
  const keySnapshot = snapshot({
    tables: [table('cr1_item', [
      column('cr1_name', 'String', { primaryName: true }),
      column('cr1_code', 'String'),
    ])],
  });
  expectCompletedComponentRejected({
    priorContract: keyContract,
    reconciliation: keySnapshot,
    completedId: 'create-key:cr1_item:cr1_item_code_key_a',
    collisionId: 'create-key:cr1_item:cr1_item_code_key_b',
    revise: (contract) => {
      contract.tables[0].alternateKeys =
        contract.tables[0].alternateKeys.filter(
          (item) => item.schemaName !== 'cr1_item_code_key_a',
        );
      contract.tables[0].alternateKeys[0].plannedDecision = 'adapt';
      contract.tables[0].alternateKeys[0].adaptedSchemaName =
        'cr1_item_code_key_b_v2';
    },
  });
});

test('CLI cannot self-mint approval receipts and still enforces publish checkpoints', (t) => {
  const directory = fs.mkdtempSync(path.join(__dirname, '.manifest-scratch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const planContent = '# Plan\n';
  const contract = normalizedContract(createContract());
  const prepared = buildInputs(contract, basePlanningSnapshot(), planContent);
  const reconciliation = prepared.reconciliation;
  const files = {
    contract: path.join(directory, 'contract.json'),
    approvalReceipt: path.join(directory, 'mobile-plan-status.json'),
    selfMintedReceipt: path.join(directory, 'self-minted-receipt.json'),
    reconciliation: path.join(directory, 'reconciliation.json'),
    plan: path.join(directory, 'plan.md'),
    manifest: path.join(directory, 'manifest.json'),
    checkpoint: path.join(directory, 'publish.json'),
  };
  fs.writeFileSync(files.contract, stableJson(contract));
  fs.writeFileSync(files.approvalReceipt, stableJson(prepared.approvalReceipt));
  fs.writeFileSync(files.reconciliation, JSON.stringify(reconciliation, null, 2));
  fs.writeFileSync(files.plan, planContent);
  const script = path.join(__dirname, '../build-dataverse-operation-manifest.js');
  assert.equal(
    require('../build-dataverse-operation-manifest').createApprovalEnvelope,
    undefined,
  );
  const selfMint = spawnSync(process.execPath, [
    script,
    '--create-approval-envelope', files.contract,
    '--plan', files.plan,
    '--output', files.selfMintedReceipt,
  ], { encoding: 'utf8' });
  assert.equal(selfMint.status, 1);
  assert.equal(fs.existsSync(files.selfMintedReceipt), false);
  assert.doesNotMatch(selfMint.stderr, /create approval receipt|create approval envelope/i);
  const bound = spawnSync(process.execPath, [
    script,
    '--bind-plan', files.contract,
    '--approval-receipt', files.approvalReceipt,
    '--plan', files.plan,
    '--output', files.contract,
  ], { encoding: 'utf8' });
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(files.contract, 'utf8')).approvedPlanSha256,
    sha256(Buffer.from(planContent)),
  );
  const commonArgs = [
    '--contract', files.contract,
    '--approval-receipt', files.approvalReceipt,
    '--reconciliation', files.reconciliation,
    '--plan', files.plan,
    '--environment-id', CONTEXT.environmentId,
    '--env-url', CONTEXT.environmentUrl,
    '--tenant-id', CONTEXT.tenantId,
    '--publisher-prefix', CONTEXT.publisherPrefix,
    '--solution', CONTEXT.solutionUniqueName,
    '--publish-checkpoint', files.checkpoint,
    '--now', NOW,
  ];
  const built = spawnSync(process.execPath, [
    script,
    ...commonArgs,
    '--output', files.manifest,
  ], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const manifest = JSON.parse(fs.readFileSync(files.manifest, 'utf8'));
  const checkpoint = JSON.parse(fs.readFileSync(files.checkpoint, 'utf8'));
  assert.deepEqual(checkpoint, manifest.publishCheckpoint);

  fs.rmSync(files.checkpoint);
  const validation = spawnSync(process.execPath, [
    script,
    ...commonArgs,
    '--validate', files.manifest,
    '--require-executable',
  ], { encoding: 'utf8' });
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /persisted publish checkpoint is required/);
});

test('M:N adapt reruns match effective schema and intersect names', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_item', 'reuse', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
      ], {
        relationships: [{
          kind: 'many-to-many',
          schemaName: 'cr1_Item_Tag',
          adaptedSchemaName: 'cr1_Item_Tag_v2',
          plannedDecision: 'adapt',
          entity1: 'cr1_item',
          entity2: 'cr1_tag',
          intersectTable: 'cr1_item_tag',
          adaptedIntersectTable: 'cr1_item_tag_v2',
          serviceRequired: true,
        }],
      }),
      contractTable('cr1_tag', 'reuse', 0, [
        contractColumn('cr1_name', 'string', 'reuse', { primaryName: true }),
      ]),
    ],
  };
  const item = table('cr1_item', [
    column('cr1_name', 'String', { primaryName: true }),
  ], {
    manyToManyRelationships: [{
      schemaName: 'cr1_Item_Tag_v2',
      entity1: 'cr1_item',
      entity2: 'cr1_tag',
      intersectTable: 'cr1_item_tag_v2',
      managed: false,
    }],
  });
  const tag = table('cr1_tag', [
    column('cr1_name', 'String', { primaryName: true }),
  ]);
  const manifest = buildManifest(buildInputs(contract, snapshot({ tables: [item, tag] })));

  assert.equal(
    manifest.decisions.find((decision) => decision.itemType === 'relationship').decision,
    'adapt',
  );
  assert.equal(manifest.execution.phases[2].operations.length, 0);
  assert.deepEqual(
    manifest.service.requiredTables.map((item) => item.logicalName),
    ['cr1_item', 'cr1_item_tag_v2', 'cr1_tag'],
  );
});

test('BigInt payload omits unsafe default bounds and accepts only explicit safe bounds', () => {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [
      contractTable('cr1_item', 'create', 0, [
        contractColumn('cr1_name', 'string', 'create', { primaryName: true }),
        contractColumn('cr1_count', 'bigint', 'create'),
      ]),
    ],
  };
  const manifest = buildManifest(buildInputs(contract, snapshot({
    proposedMissing: ['cr1_item'],
  })));
  const bigIntBody = manifest.execution.phases[0].operations[0].body.Attributes
    .find((attribute) => attribute.SchemaName === 'cr1_count');
  assert.equal(Object.hasOwn(bigIntBody, 'MinValue'), false);
  assert.equal(Object.hasOwn(bigIntBody, 'MaxValue'), false);

  const unsafe = structuredClone(contract);
  unsafe.tables[0].columns[1].maxValue = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => buildManifest(buildInputs(unsafe, snapshot({ proposedMissing: ['cr1_item'] }))),
    /maxValue must be a safely representable integer/,
  );
});

test('deterministic local manifest preparation remains sub-second for a typical plan', () => {
  const inputs = buildInputs(createContract(), basePlanningSnapshot());
  const started = process.hrtime.bigint();
  for (let index = 0; index < 100; index += 1) buildManifest(inputs);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(
    elapsedMs < 1000,
    `expected 100 deterministic local preparations under 1000ms, got ${elapsedMs.toFixed(1)}ms`,
  );
});
