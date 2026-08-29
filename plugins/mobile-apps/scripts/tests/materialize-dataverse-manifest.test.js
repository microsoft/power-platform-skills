'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildMaterializedManifest,
} = require('../materialize-dataverse-manifest');

const TABLE_ID = '3471119d-08a3-f111-b8dc-002248d61df6';

function fixture() {
  const contract = {
    schemaVersion: 1,
    publisherPrefix: 'new',
    tables: [{
      logicalName: 'new_parent',
      schemaName: 'new_parent',
      displayName: 'Parent',
      displayCollectionName: 'Parents',
      plannedDecision: 'reuse',
      dependencyTier: 0,
      serviceRequired: true,
      primaryIdAttribute: 'new_parentid',
      columns: [{
        logicalName: 'new_name',
        schemaName: 'new_name',
        displayName: 'Name',
        type: 'string',
        plannedDecision: 'reuse',
        primaryName: true,
        requiredLevel: 'ApplicationRequired',
      }],
      relationships: [],
      alternateKeys: [],
    }, {
      logicalName: 'new_child',
      schemaName: 'new_child',
      displayName: 'Child',
      displayCollectionName: 'Children',
      plannedDecision: 'adapt',
      adaptationKind: 'hidden-name-collision',
      adaptedLogicalName: 'new_childv2',
      adaptedSchemaName: 'new_childv2',
      collisionEvidence: {
        code: '0x80044363',
        operationId: 'create-table:new_child',
        operationFingerprint: 'a'.repeat(64),
        priorManifestSha256: 'b'.repeat(64),
        priorReconciliationSha256: 'c'.repeat(64),
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      dependencyTier: 1,
      serviceRequired: true,
      primaryIdAttribute: 'new_childid',
      columns: [{
        logicalName: 'new_name',
        schemaName: 'new_name',
        displayName: 'Name',
        type: 'string',
        plannedDecision: 'create',
        primaryName: true,
        requiredLevel: 'ApplicationRequired',
      }, {
        logicalName: 'new_photo',
        schemaName: 'new_photo',
        displayName: 'Photo',
        type: 'image',
        plannedDecision: 'create',
        requiredLevel: 'None',
        canStoreFullImage: true,
        maxSizeInKB: 10240,
      }, {
        logicalName: 'new_parentid',
        schemaName: 'new_parentid',
        displayName: 'Parent',
        type: 'lookup',
        plannedDecision: 'create',
        requiredLevel: 'None',
        lookupTarget: 'new_parent',
      }, {
        logicalName: 'new_channels',
        schemaName: 'new_channels',
        displayName: 'Channels',
        type: 'multiselectchoice',
        plannedDecision: 'create',
        requiredLevel: 'None',
        options: [{ value: 100000000, label: 'Mobile' }],
      }],
      relationships: [{
        kind: 'many-to-one',
        schemaName: 'new_parent_childv2',
        plannedDecision: 'create',
        parentTable: 'new_parent',
        childTable: 'new_child',
        lookup: {
          logicalName: 'new_parentid',
          schemaName: 'new_parentid',
        },
        cascadeConfiguration: { Delete: 'Restrict' },
      }],
      alternateKeys: [{
        schemaName: 'new_childv2_name_key',
        plannedDecision: 'create',
        columns: ['new_name'],
      }],
    }],
  };
  const manifest = {
    executable: true,
    aliases: {
      tables: { new_child: 'new_childv2' },
      columns: {},
    },
    decisions: [{
      itemType: 'table',
      requestedName: 'new_child',
      effectiveName: 'new_childv2',
      decision: 'adapt',
      observedOutcome: 'adapt',
      verificationStatus: 'verified',
      operation: 'create-table:new_childv2',
    }],
  };
  const reconciliation = {
    tables: [{
      logicalName: 'new_childv2',
      metadataId: TABLE_ID,
      displayName: 'Child',
      entitySetName: 'new_childv2s',
      columns: [{ logicalName: 'new_name', type: 'String' }, {
        logicalName: 'new_photo',
        type: 'Image',
        canStoreFullImage: true,
        maxSizeInKB: 10240,
        maxHeight: 144,
        maxWidth: 144,
      }, {
        logicalName: 'new_parentid',
        type: 'Lookup',
      }, {
        logicalName: 'new_channels',
        type: 'Virtual',
        typeName: 'MultiSelectPicklistType',
      }],
      alternateKeys: [{
        schemaName: 'new_childv2_name_key',
        columns: ['new_name'],
        status: 'Pending',
      }],
    }],
  };
  return {
    manifest,
    contract,
    reconciliation,
    context: {
      environmentId: 'environment-1',
      environmentUrl: 'https://example.crm.dynamics.com',
      solutionUniqueName: 'Default',
      publisherPrefix: 'new',
    },
  };
}

test('materializes verified aliases, media, relationships, and keys', () => {
  const result = buildMaterializedManifest({
    ...fixture(),
    nowIso: () => '2026-08-29T00:01:00.000Z',
  });
  assert.equal(result.tables.length, 1);
  const table = result.tables[0];
  assert.equal(table.logicalName, 'new_childv2');
  assert.equal(table.requestedLogicalName, 'new_child');
  assert.equal(table.status, 'new');
  assert.equal(table.metadataId, TABLE_ID);
  assert.deepEqual(table.columns.find((item) => item.logicalName === 'new_photo'), {
    logicalName: 'new_photo',
    type: 'Image',
    canStoreFullImage: true,
    maxSizeInKB: 10240,
    thumbnailHeight: 144,
    thumbnailWidth: 144,
  });
  assert.deepEqual(table.relationships[0], {
    schemaName: 'new_parent_childv2',
    kind: 'many-to-one',
    parentTable: 'new_parent',
    childTable: 'new_childv2',
    lookupColumn: 'new_parentid',
    deleteBehavior: 'Restrict',
  });
  assert.deepEqual(table.columns.find((item) => item.logicalName === 'new_channels'), {
    logicalName: 'new_channels',
    type: 'MultiSelectChoice',
  });
  assert.deepEqual(table.alternateKeys[0], {
    schemaName: 'new_childv2_name_key',
    keyAttributes: ['new_name'],
    indexStatus: 'Pending',
  });
});

test('materialization preserves prior ownership status on a zero-write rerun', () => {
  const input = fixture();
  input.manifest.decisions[0].observedOutcome = 'reuse';
  const result = buildMaterializedManifest({
    ...input,
    previousManifest: {
      tables: [{
        logicalName: 'new_childv2',
        requestedLogicalName: 'new_child',
        status: 'new',
      }],
    },
  });
  assert.equal(result.tables[0].status, 'new');
});

test('materialization recovers app-owned tables after a zero-write restart', () => {
  const input = fixture();
  input.manifest.decisions[0].observedOutcome = 'reuse';
  input.manifest.decisions[0].operation = 'none';
  const result = buildMaterializedManifest(input);

  assert.equal(result.tables.length, 1);
  assert.equal(result.tables[0].logicalName, 'new_childv2');
  assert.equal(result.tables[0].status, 'new');
});

test('materialization fails closed without verified server identity', () => {
  const input = fixture();
  input.reconciliation.tables[0].metadataId = null;
  assert.throws(
    () => buildMaterializedManifest(input),
    /has no valid MetadataId/,
  );
});

test('materializes an existing table when a verified child component changed', () => {
  const input = fixture();
  const parent = input.contract.tables.find((table) => table.logicalName === 'new_parent');
  parent.plannedDecision = 'extend';
  parent.columns.push({
    logicalName: 'new_code',
    schemaName: 'new_code',
    displayName: 'Code',
    type: 'string',
    plannedDecision: 'create',
    requiredLevel: 'None',
  });
  input.manifest.decisions.unshift({
    itemType: 'table',
    requestedName: 'new_parent',
    effectiveName: 'new_parent',
    decision: 'extend',
    observedOutcome: 'extend',
    verificationStatus: 'verified',
    operation: 'extensions-phase',
  }, {
    itemType: 'column',
    table: 'new_parent',
    requestedName: 'new_code',
    effectiveName: 'new_code',
    decision: 'create',
    observedOutcome: 'create',
    verificationStatus: 'verified',
    operation: 'extend-column:new_parent:new_code',
  });
  input.reconciliation.tables.push({
    logicalName: 'new_parent',
    metadataId: '11111111-2222-3333-4444-555555555555',
    displayName: 'Parent',
    entitySetName: 'new_parents',
    columns: [
      { logicalName: 'new_name', type: 'String' },
      { logicalName: 'new_code', type: 'String' },
    ],
    alternateKeys: [],
  });
  const result = buildMaterializedManifest(input);
  const materialized = result.tables.find((table) => table.logicalName === 'new_parent');
  assert.equal(materialized.status, 'extended');
  assert.deepEqual(
    materialized.columns.map((column) => column.logicalName),
    ['new_code', 'new_name'],
  );
});

test('partial contracts preserve unrelated prior materialized tables', () => {
  const input = fixture();
  const result = buildMaterializedManifest({
    ...input,
    previousManifest: {
      environmentId: input.context.environmentId,
      environmentUrl: input.context.environmentUrl,
      aliases: { new_old: 'new_oldv2' },
      tables: [{
        logicalName: 'new_unrelated',
        displayName: 'Unrelated',
        status: 'new',
        metadataId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        columns: [],
        relationships: [],
        alternateKeys: [],
      }],
    },
  });
  assert.ok(result.tables.some((table) => table.logicalName === 'new_unrelated'));
  assert.equal(result.aliases.new_old, 'new_oldv2');
});

test('materialization rejects a previous manifest from another environment', () => {
  const input = fixture();
  assert.throws(() => buildMaterializedManifest({
    ...input,
    previousManifest: {
      environmentId: 'other-environment',
      environmentUrl: input.context.environmentUrl,
      tables: [],
    },
  }), /environmentId does not match/);
});