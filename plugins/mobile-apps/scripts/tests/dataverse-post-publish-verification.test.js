'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  verifyChangedScope,
} = require('../verify-dataverse-post-publish');

function fixture() {
  const manifest = {
    integritySha256: 'a'.repeat(64),
    execution: {
      phases: [
        {
          name: 'tableCreates',
          operations: [{
            id: 'create-table:new_confirmation',
            method: 'POST',
            apiPath: 'EntityDefinitions',
            body: {
              SchemaName: 'new_confirmation',
              IsAvailableOffline: true,
              ChangeTrackingEnabled: true,
              Attributes: [{
                '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
                SchemaName: 'new_name',
              }],
            },
          }],
        },
        {
          name: 'extensions',
          operations: [{
            id: 'extend-column:new_evidence:new_photo',
            method: 'POST',
            apiPath: "EntityDefinitions(LogicalName='new_evidence')/Attributes",
            body: {
              '@odata.type': 'Microsoft.Dynamics.CRM.ImageAttributeMetadata',
              SchemaName: 'new_photo',
              CanStoreFullImage: true,
              MaxSizeInKB: 10240,
            },
          }],
        },
        {
          name: 'relationships',
          operations: [{
            id: 'create-relationship:new_confirmation_parent',
            method: 'POST',
            apiPath: 'RelationshipDefinitions',
            body: {
              SchemaName: 'new_confirmation_parent',
              ReferencingEntity: 'new_confirmation',
              ReferencingAttribute: 'new_parentid',
              ReferencedEntity: 'new_parent',
              ReferencedAttribute: 'new_parentid',
              CascadeConfiguration: {
                Assign: 'NoCascade',
                Delete: 'RemoveLink',
              },
            },
          }],
        },
        {
          name: 'alternateKeys',
          operations: [{
            id: 'create-key:new_confirmation:new_confirmation_key',
            method: 'POST',
            apiPath: "EntityDefinitions(LogicalName='new_confirmation')/Keys",
            body: { SchemaName: 'new_confirmation_key', KeyAttributes: ['new_code'] },
          }],
        },
        { name: 'publish', operations: [{ id: 'publish-customizations' }] },
      ],
    },
  };
  const reconciliation = {
    tables: [
      {
        logicalName: 'new_confirmation',
        isAvailableOffline: true,
        changeTrackingEnabled: true,
        columns: [
          { logicalName: 'new_name', type: 'String' },
          { logicalName: 'new_code', type: 'String' },
        ],
        manyToOneRelationships: [{
          schemaName: 'new_confirmation_parent',
          lookupColumn: 'new_parentid',
          targetTable: 'new_parent',
          targetColumn: 'new_parentid',
          cascadeConfiguration: {
            Assign: 'NoCascade',
            Delete: 'RemoveLink',
          },
        }],
        oneToManyRelationships: [],
        manyToManyRelationships: [],
        alternateKeys: [{
          schemaName: 'new_confirmation_key',
          columns: ['new_code'],
          status: 'Pending',
        }],
      },
      {
        logicalName: 'new_evidence',
        columns: [{
          logicalName: 'new_photo',
          type: 'Image',
          canStoreFullImage: true,
          maxSizeInKB: 10240,
          maxHeight: 144,
          maxWidth: 144,
        }],
        manyToOneRelationships: [],
        oneToManyRelationships: [],
        manyToManyRelationships: [],
        alternateKeys: [],
      },
    ],
  };
  return {
    manifest,
    reconciliation,
    executionOutcome: { status: 'DONE', reasonCode: 'PUBLISH_CONFIRMED' },
    imageConfigurations: [{
      parententitylogicalname: 'new_evidence',
      attributelogicalname: 'new_photo',
      canstorefullimage: true,
    }],
  };
}

test('targeted verification reports compatible pending alternate keys', () => {
  const result = verifyChangedScope(fixture());
  assert.equal(result.status, 'DONE_WITH_PENDING_ACTIVATIONS');
  assert.deepEqual(result.pendingActivations, [{
    tableLogicalName: 'new_confirmation',
    schemaName: 'new_confirmation_key',
    status: 'Pending',
  }]);
  assert.deepEqual(result.mismatches, []);
});

test('targeted verification detects full-image configuration drift', () => {
  const input = fixture();
  input.reconciliation.tables[1].columns[0].canStoreFullImage = false;
  input.imageConfigurations[0].canstorefullimage = false;
  const result = verifyChangedScope(input);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.mismatches.some((item) => item.fact === 'CanStoreFullImage'));
  assert.ok(result.mismatches.some((item) => item.fact === 'attributeimageconfig'));
});

test('targeted verification detects missing changed relationships', () => {
  const input = fixture();
  input.reconciliation.tables[0].manyToOneRelationships = [];
  const result = verifyChangedScope(input);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.mismatches.some(
    (item) => item.fact === 'relationship' && item.name === 'new_confirmation_parent',
  ));
});

test('targeted verification checks every inline table-create column', () => {
  const input = fixture();
  input.reconciliation.tables[0].columns = input.reconciliation.tables[0].columns.filter(
    (column) => column.logicalName !== 'new_name',
  );
  const result = verifyChangedScope(input);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.mismatches.some(
    (item) => item.fact === 'column'
      && item.table === 'new_confirmation'
      && item.name === 'new_name',
  ));
});

test('targeted verification checks changed offline and change-tracking flags', () => {
  const input = fixture();
  input.reconciliation.tables[0].isAvailableOffline = false;
  input.reconciliation.tables[0].changeTrackingEnabled = false;
  const result = verifyChangedScope(input);
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(
    result.mismatches.filter((item) => item.fact === 'table-setting').map(
      (item) => item.name,
    ).sort(),
    ['ChangeTrackingEnabled', 'IsAvailableOffline'],
  );
});

test('targeted verification checks relationship endpoints and cascade behavior', () => {
  const input = fixture();
  const relationship = input.reconciliation.tables[0].manyToOneRelationships[0];
  relationship.targetTable = 'new_wrongparent';
  relationship.cascadeConfiguration.Delete = 'Cascade';
  const result = verifyChangedScope(input);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.mismatches.some(
    (item) => item.fact === 'relationship-semantics'
      && item.name === 'new_confirmation_parent',
  ));
});

test('targeted verification checks many-to-many endpoints and intersect table', () => {
  const input = fixture();
  const relationshipPhase = input.manifest.execution.phases.find(
    (phase) => phase.name === 'relationships',
  );
  relationshipPhase.operations.push({
    id: 'create-relationship:new_confirmation_tag',
    method: 'POST',
    apiPath: 'RelationshipDefinitions',
    body: {
      '@odata.type': 'Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata',
      SchemaName: 'new_confirmation_tag',
      Entity1LogicalName: 'new_confirmation',
      Entity2LogicalName: 'new_tag',
      IntersectEntityName: 'new_confirmation_tag_link',
    },
  });
  input.reconciliation.tables[0].manyToManyRelationships.push({
    schemaName: 'new_confirmation_tag',
    entity1: 'new_confirmation',
    entity2: 'new_tag',
    intersectTable: 'new_wrong_link',
  });
  const result = verifyChangedScope(input);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.mismatches.some(
    (item) => item.fact === 'relationship-semantics'
      && item.name === 'new_confirmation_tag',
  ));
});

test('targeted verification checks exact alternate-key member columns', () => {
  const input = fixture();
  input.reconciliation.tables[0].alternateKeys[0].columns = ['new_name'];
  const result = verifyChangedScope(input);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.mismatches.some(
    (item) => item.fact === 'alternate-key-members'
      && item.name === 'new_confirmation_key',
  ));
});

test('targeted verification checks File MaxSizeInKB', () => {
  const input = fixture();
  const extensionPhase = input.manifest.execution.phases.find(
    (phase) => phase.name === 'extensions',
  );
  extensionPhase.operations.push({
    id: 'extend-column:new_evidence:new_attachment',
    method: 'POST',
    apiPath: "EntityDefinitions(LogicalName='new_evidence')/Attributes",
    body: {
      '@odata.type': 'Microsoft.Dynamics.CRM.FileAttributeMetadata',
      SchemaName: 'new_attachment',
      MaxSizeInKB: 32768,
    },
  });
  input.reconciliation.tables[1].columns.push({
    logicalName: 'new_attachment',
    type: 'File',
    maxSizeInKB: 16384,
  });
  const result = verifyChangedScope(input);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.mismatches.some(
    (item) => item.fact === 'MaxSizeInKB'
      && item.name === 'new_attachment',
  ));
});

test('targeted verification requires a confirmed publish outcome', () => {
  const input = fixture();
  input.executionOutcome = { status: 'BLOCKED', reasonCode: 'METADATA_PHASE_FAILED' };
  const result = verifyChangedScope(input);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.mismatches.some((item) => item.fact === 'publish'));
});

test('targeted verification ignores unrelated metadata', () => {
  const input = fixture();
  input.reconciliation.tables.push({
    logicalName: 'unrelated_table',
    columns: [],
    manyToOneRelationships: [],
    oneToManyRelationships: [],
    manyToManyRelationships: [],
    alternateKeys: [],
  });
  assert.equal(verifyChangedScope(input).status, 'DONE_WITH_PENDING_ACTIVATIONS');
});

test('zero-write rerun accepts no-publish-required execution', () => {
  const input = fixture();
  input.manifest.execution.phases.forEach((phase) => { phase.operations = []; });
  input.executionOutcome = { status: 'DONE', reasonCode: 'NO_PUBLISH_REQUIRED' };
  const result = verifyChangedScope(input);
  assert.equal(result.status, 'DONE');
  assert.equal(result.changedOperationCount, 0);
});
