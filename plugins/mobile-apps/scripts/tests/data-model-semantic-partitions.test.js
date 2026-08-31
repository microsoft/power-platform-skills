'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DataModelPartitionMergeError,
  entityDependencies,
  mergeDataModelSemanticPartitions,
  partitionSchemas,
  topologyHash,
  validateDetailResult,
  validateTopologyResult,
} = require('../lib/data-model-semantic-partitions');
const { compileDataModelSemanticResult } = require('../lib/compile-data-model-semantic-result');

function fixture() {
  const baseEntity = (id, displayName, primaryDisplayField, fields) => ({
    entityId: id,
    displayName,
    pluralDisplayName: `${displayName} records`,
    purpose: `${displayName} records support the maintenance workflow.`,
    lifecycle: `${displayName} records remain available throughout maintenance work.`,
    scopeRole: 'workflow record',
    ownershipIntent: 'organization',
    decision: 'new',
    primaryDisplayField,
    serviceRequired: true,
    owningRequirementIds: ['requirement:maintain-equipment'],
    behavior: { activities: false, notes: false, offlineAvailable: true, changeTracking: true },
    targetEvidence: { status: 'missing', summary: 'The proposed name is verified absent.' },
    fields,
  });
  const location = baseEntity('entity:location', 'Location', 'field:location-name', [{
    fieldId: 'field:location-name',
    displayName: 'Location name',
    typeIntent: 'text',
    required: true,
    purpose: 'Identifies the location for users.',
    decision: 'new',
  }]);
  const equipment = baseEntity('entity:equipment', 'Equipment', 'field:equipment-name', [{
    fieldId: 'field:equipment-name',
    displayName: 'Equipment name',
    typeIntent: 'text',
    required: true,
    purpose: 'Identifies equipment for users.',
    decision: 'new',
  }, {
    fieldId: 'field:equipment-code',
    displayName: 'Equipment code',
    typeIntent: 'text',
    required: true,
    purpose: 'Supports exact equipment lookup.',
    decision: 'new',
  }]);
  const semantic = {
    schemaVersion: 1,
    status: 'ready',
    mode: 'dataverse-required',
    summary: {
      productDomain: 'equipment maintenance',
      persistenceRationale: 'Teams share equipment and location records.',
    },
    requirements: [{
      requirementId: 'requirement:maintain-equipment',
      statement: 'Find and maintain equipment at a location.',
      coveredBy: ['entity:equipment', 'operation:find-equipment'],
    }],
    entities: [equipment, location],
    relationships: [{
      relationshipId: 'relationship:equipment-location',
      fromEntityId: 'entity:equipment',
      toEntityId: 'entity:location',
      cardinalityIntent: 'many-to-one',
      required: true,
      purpose: 'Places equipment at its owning location.',
      decision: 'new',
      deleteBehaviorIntent: 'restrict',
    }],
    operations: [{
      operationId: 'operation:find-equipment',
      kind: 'read-one',
      entityId: 'entity:equipment',
      inputIntent: ['equipmentCode'],
      selectFieldIds: ['field:equipment-code', 'field:equipment-name'],
      filterIntent: [{
        fieldId: 'field:equipment-code',
        operator: 'equals',
        input: 'equipmentCode',
      }],
      sortIntent: [],
      mutationFieldIds: [],
      paginationIntent: 'not-applicable',
      purpose: 'Find equipment from its scanned code.',
    }],
    fixtureScenarios: [{
      scenarioId: 'scenario:equipment-at-location',
      purpose: 'Show equipment assigned to a location.',
      entityIds: ['entity:equipment', 'entity:location'],
      requirementIds: ['requirement:maintain-equipment'],
    }],
    assumptions: [],
    risks: [],
    concerns: [],
  };
  const shells = semantic.entities.map((entity) => {
    const shell = structuredClone(entity);
    delete shell.fields;
    shell.contextItemIds = [`evidence:${entity.entityId.split(':')[1]}`];
    return shell;
  });
  const topology = {
    schemaVersion: 1,
    status: 'ready',
    mode: semantic.mode,
    summary: semantic.summary,
    requirements: semantic.requirements,
    entities: shells,
    relationships: semantic.relationships,
    operationAssignments: semantic.operations.map((operation) => ({
      operationId: operation.operationId,
      entityId: operation.entityId,
    })),
    fixtureScenarios: semantic.fixtureScenarios,
    assumptions: [],
    risks: [],
    concerns: [],
  };
  const hash = topologyHash(topology);
  const expected = [
    { partitionId: 'detail-001', entityIds: ['entity:location'] },
    { partitionId: 'detail-002', entityIds: ['entity:equipment'] },
  ];
  const details = expected.map((partition) => ({
    schemaVersion: 1,
    status: 'ready',
    partitionId: partition.partitionId,
    topologyHash: hash,
    entityIds: partition.entityIds,
    entities: semantic.entities.filter((entity) => partition.entityIds.includes(entity.entityId)),
    operations: semantic.operations.filter((operation) => partition.entityIds.includes(operation.entityId)),
    assumptions: [],
    risks: [],
    concerns: [],
  }));
  return { semantic, topology, expected, details };
}

test('partition schemas validate strict topology and detail shapes', () => {
  const { topology, expected, details } = fixture();
  assert.equal(validateTopologyResult(topology, {
    contextItemIds: ['evidence:equipment', 'evidence:location'],
  }).valid, true);
  assert.equal(validateDetailResult(details[0], topology, expected[0]).valid, true);
  const schemas = partitionSchemas();
  assert.equal(schemas.topology.additionalProperties, false);
  assert.equal(schemas.detail.additionalProperties, false);
});

test('topology rejects reuse decisions without exact existing identities', () => {
  const { topology } = fixture();
  topology.entities[0].decision = 'reuse';
  topology.relationships[0].decision = 'reuse';
  const validation = validateTopologyResult(topology);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('; '), /requires existingLogicalName/);
  assert.match(validation.errors.join('; '), /requires existingSchemaName/);
  assert.match(validation.errors.join('; '), /requires existingLookupLogicalName/);
});

test('relationship direction creates deterministic parent-before-child dependencies', () => {
  const { topology } = fixture();
  assert.deepEqual(entityDependencies(topology), [
    { id: 'entity:equipment', dependsOn: ['entity:location'] },
    { id: 'entity:location', dependsOn: [] },
  ]);
});

test('strict merge recreates the canonical semantic result independent of response order', () => {
  const { semantic, topology, expected, details } = fixture();
  const merged = mergeDataModelSemanticPartitions(topology, expected, [...details].reverse());
  const compiled = compileDataModelSemanticResult(merged, { publisherPrefix: 'cr1' });
  const direct = compileDataModelSemanticResult(semantic, { publisherPrefix: 'cr1' });
  assert.equal(compiled.receipt.semanticResultHash, direct.receipt.semanticResultHash);
  assert.equal(compiled.markdown, direct.markdown);
});

test('missing partitions never produce a partial semantic model', () => {
  const { topology, expected, details } = fixture();
  assert.throws(
    () => mergeDataModelSemanticPartitions(topology, expected, [details[0]]),
    (error) => error instanceof DataModelPartitionMergeError
      && error.repairPartitionIds.includes('detail-002')
      && /result is missing/.test(error.message),
  );
});

test('expected partitions must cover every topology entity exactly once', () => {
  const { topology, expected, details } = fixture();
  assert.throws(
    () => mergeDataModelSemanticPartitions(topology, [expected[0]], [details[0]]),
    (error) => error instanceof DataModelPartitionMergeError
      && error.repairPartitionIds.length === 1
      && error.repairPartitionIds[0] === 'topology'
      && /topology entities missing from partitions/.test(error.message),
  );
  assert.throws(
    () => mergeDataModelSemanticPartitions(topology, [
      expected[0],
      { partitionId: 'detail-002', entityIds: ['entity:location', 'entity:equipment'] },
    ], details),
    /entities assigned to multiple partitions/,
  );
});

test('immutable topology drift scopes repair to only the changed detail partition', () => {
  const { topology, expected, details } = fixture();
  details[1].entities[0].purpose = 'A changed purpose that conflicts with locked topology.';
  assert.throws(
    () => mergeDataModelSemanticPartitions(topology, expected, details),
    (error) => error instanceof DataModelPartitionMergeError
      && assert.deepEqual(error.repairPartitionIds, ['detail-002']) === undefined
      && /changed immutable topology fields/.test(error.message),
  );
});

test('operation cross-references cannot escape their assigned detail partition', () => {
  const { topology, expected, details } = fixture();
  details[1].operations[0].selectFieldIds.push('field:location-name');
  assert.throws(
    () => mergeDataModelSemanticPartitions(topology, expected, details),
    (error) => error instanceof DataModelPartitionMergeError
      && error.repairPartitionIds.length === 1
      && error.repairPartitionIds[0] === 'detail-002'
      && /unavailable field field:location-name/.test(error.message),
  );
});

test('detail results are bound to the exact topology hash', () => {
  const { topology, expected, details } = fixture();
  details[0].topologyHash = 'a'.repeat(64);
  const validation = validateDetailResult(details[0], topology, expected[0]);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('; '), /topologyHash mismatch/);
});

test('duplicate semantic IDs attribute repair to every owning detail partition', () => {
  const { topology, expected, details } = fixture();
  details[0].entities[0].fields.push({
    fieldId: 'field:equipment-code',
    displayName: 'Conflicting code',
    typeIntent: 'text',
    required: false,
    purpose: 'Creates a cross-partition semantic ID conflict.',
    decision: 'new',
  });
  assert.throws(
    () => mergeDataModelSemanticPartitions(topology, expected, details),
    (error) => error instanceof DataModelPartitionMergeError
      && assert.deepEqual(
        error.repairPartitionIds,
        ['detail-001', 'detail-002'],
      ) === undefined
      && /field:equipment-code is duplicated/.test(error.message),
  );
});