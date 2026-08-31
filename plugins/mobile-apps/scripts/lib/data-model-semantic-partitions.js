'use strict';

const fs = require('node:fs');

const { lexicalCompare } = require('./agent-return-envelope');
const {
  SCHEMA_PATH,
  normalizeSemanticResult,
  validateSemanticResult,
} = require('./compile-data-model-semantic-result');
const { sha256, stableJson } = require('../build-dataverse-operation-manifest');
const { validateJsonSchema } = require('./json-schema-lite');

const TOPOLOGY_RESULT_TYPE = 'data-model-topology-v1';
const DETAIL_RESULT_TYPE = 'data-model-detail-v1';

let schemasCache;

function stableSort(values, key) {
  return [...values].sort((left, right) => lexicalCompare(String(key(left)), String(key(right))));
}

function trimValue(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(trimValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, trimValue(child)]));
}

function partitionSchemas() {
  if (schemasCache) return structuredClone(schemasCache);
  const semanticSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const definitions = structuredClone(semanticSchema.definitions);
  const entityShell = structuredClone(definitions.entity);
  entityShell.required = entityShell.required.filter((field) => field !== 'fields');
  entityShell.required.push('contextItemIds');
  delete entityShell.properties.fields;
  entityShell.properties.contextItemIds = {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    uniqueItems: true,
  };
  definitions.entityShell = entityShell;
  definitions.operationAssignment = {
    type: 'object',
    required: ['operationId', 'entityId'],
    properties: {
      operationId: { $ref: '#/definitions/operationId' },
      entityId: { $ref: '#/definitions/entityId' },
    },
    additionalProperties: false,
  };
  const commonProperties = {
    schemaVersion: { const: 1 },
    status: { const: 'ready' },
  };
  const topology = {
    $schema: semanticSchema.$schema,
    type: 'object',
    required: [
      'schemaVersion',
      'status',
      'mode',
      'summary',
      'requirements',
      'entities',
      'relationships',
      'operationAssignments',
      'fixtureScenarios',
      'assumptions',
      'risks',
      'concerns',
    ],
    properties: {
      ...commonProperties,
      mode: structuredClone(semanticSchema.properties.mode),
      summary: structuredClone(semanticSchema.properties.summary),
      requirements: structuredClone(semanticSchema.properties.requirements),
      entities: { type: 'array', items: { $ref: '#/definitions/entityShell' } },
      relationships: structuredClone(semanticSchema.properties.relationships),
      operationAssignments: {
        type: 'array',
        items: { $ref: '#/definitions/operationAssignment' },
      },
      fixtureScenarios: structuredClone(semanticSchema.properties.fixtureScenarios),
      assumptions: { $ref: '#/definitions/stringArray' },
      risks: { $ref: '#/definitions/stringArray' },
      concerns: { $ref: '#/definitions/stringArray' },
    },
    additionalProperties: false,
    definitions,
  };
  const detail = {
    $schema: semanticSchema.$schema,
    type: 'object',
    required: [
      'schemaVersion',
      'status',
      'partitionId',
      'topologyHash',
      'entityIds',
      'entities',
      'operations',
      'assumptions',
      'risks',
      'concerns',
    ],
    properties: {
      ...commonProperties,
      partitionId: { type: 'string', pattern: '^detail-[0-9]{3,}$' },
      topologyHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      entityIds: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/definitions/entityId' },
        uniqueItems: true,
      },
      entities: { type: 'array', minItems: 1, items: { $ref: '#/definitions/entity' } },
      operations: structuredClone(semanticSchema.properties.operations),
      assumptions: { $ref: '#/definitions/stringArray' },
      risks: { $ref: '#/definitions/stringArray' },
      concerns: { $ref: '#/definitions/stringArray' },
    },
    additionalProperties: false,
    definitions,
  };
  schemasCache = { topology, detail };
  return structuredClone(schemasCache);
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(lexicalCompare);
}

function validateTopologyResult(value, { contextItemIds = null } = {}) {
  const errors = validateJsonSchema(value, partitionSchemas().topology);
  if (errors.length > 0) return { valid: false, errors };
  const entityIds = new Set(value.entities.map((entity) => entity.entityId));
  const requirementIds = new Set(value.requirements.map((item) => item.requirementId));
  const knownContextItems = contextItemIds ? new Set(contextItemIds) : null;
  const assignedContextItems = new Set();
  const allSemanticIds = [
    ...value.requirements.map((item) => item.requirementId),
    ...value.entities.map((item) => item.entityId),
    ...value.relationships.map((item) => item.relationshipId),
    ...value.operationAssignments.map((item) => item.operationId),
    ...value.fixtureScenarios.map((item) => item.scenarioId),
  ];
  for (const duplicate of duplicateValues(allSemanticIds)) {
    errors.push(`${duplicate} is duplicated in topology`);
  }
  for (const entity of value.entities) {
    if (['reuse', 'extend', 'adapt', 'unverified'].includes(entity.decision)
      && !entity.existingLogicalName) {
      errors.push(`${entity.entityId} ${entity.decision} requires existingLogicalName`);
    }
    for (const requirementId of entity.owningRequirementIds || []) {
      if (!requirementIds.has(requirementId)) {
        errors.push(`${entity.entityId} references unknown requirement ${requirementId}`);
      }
    }
    if (knownContextItems) {
      for (const contextItemId of entity.contextItemIds) {
        assignedContextItems.add(contextItemId);
        if (!knownContextItems.has(contextItemId)) {
          errors.push(`${entity.entityId} references unknown context item ${contextItemId}`);
        }
      }
    }
  }
  if (knownContextItems && value.entities.length > 0) {
    for (const contextItemId of knownContextItems) {
      if (!assignedContextItems.has(contextItemId)) {
        errors.push(`context item ${contextItemId} is not assigned to an entity`);
      }
    }
  }
  if (value.mode === 'dataverse-required' && value.entities.length === 0) {
    errors.push('dataverse-required topology requires at least one entity');
  }
  for (const relationship of value.relationships) {
    if (!entityIds.has(relationship.fromEntityId)) {
      errors.push(`${relationship.relationshipId} has unknown fromEntityId ${relationship.fromEntityId}`);
    }
    if (!entityIds.has(relationship.toEntityId)) {
      errors.push(`${relationship.relationshipId} has unknown toEntityId ${relationship.toEntityId}`);
    }
    if (['reuse', 'adapt', 'unverified'].includes(relationship.decision)
      && !relationship.existingSchemaName) {
      errors.push(`${relationship.relationshipId} ${relationship.decision} requires existingSchemaName`);
    }
    if (relationship.cardinalityIntent !== 'many-to-many'
      && ['reuse', 'adapt', 'unverified'].includes(relationship.decision)
      && !relationship.existingLookupLogicalName) {
      errors.push(
        `${relationship.relationshipId} ${relationship.decision} requires existingLookupLogicalName`,
      );
    }
    if (relationship.cardinalityIntent === 'many-to-many'
      && ['reuse', 'adapt', 'unverified'].includes(relationship.decision)
      && !relationship.existingIntersectTable) {
      errors.push(`${relationship.relationshipId} ${relationship.decision} requires existingIntersectTable`);
    }
  }
  for (const assignment of value.operationAssignments) {
    if (!entityIds.has(assignment.entityId)) {
      errors.push(`${assignment.operationId} is assigned to unknown entity ${assignment.entityId}`);
    }
  }
  for (const fixture of value.fixtureScenarios) {
    for (const entityId of fixture.entityIds) {
      if (!entityIds.has(entityId)) errors.push(`${fixture.scenarioId} references unknown entity ${entityId}`);
    }
    for (const requirementId of fixture.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        errors.push(`${fixture.scenarioId} references unknown requirement ${requirementId}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function normalizeTopologyResult(value, options = {}) {
  const result = trimValue(structuredClone(value));
  const validation = validateTopologyResult(result, options);
  if (!validation.valid) throw new Error(`Invalid data-model topology: ${validation.errors.join('; ')}`);
  result.requirements = stableSort(result.requirements.map((requirement) => ({
    ...requirement,
    coveredBy: [...requirement.coveredBy].sort(lexicalCompare),
  })), (requirement) => requirement.requirementId);
  result.entities = stableSort(result.entities.map((entity) => ({
    ...entity,
    owningRequirementIds: [...(entity.owningRequirementIds || [])].sort(lexicalCompare),
    contextItemIds: [...entity.contextItemIds].sort(lexicalCompare),
  })), (entity) => entity.entityId);
  result.relationships = stableSort(result.relationships, (item) => item.relationshipId);
  result.operationAssignments = stableSort(result.operationAssignments, (item) => item.operationId);
  result.fixtureScenarios = stableSort(result.fixtureScenarios.map((fixture) => ({
    ...fixture,
    entityIds: [...fixture.entityIds].sort(lexicalCompare),
    requirementIds: [...fixture.requirementIds].sort(lexicalCompare),
  })), (fixture) => fixture.scenarioId);
  for (const field of ['assumptions', 'risks', 'concerns']) {
    result[field] = [...result[field]].sort(lexicalCompare);
  }
  return JSON.parse(JSON.stringify(result));
}

function topologyHash(value, options = {}) {
  return sha256(stableJson(normalizeTopologyResult(value, options)));
}

function entityDependencies(topology) {
  const dependencies = new Map(topology.entities.map((entity) => [entity.entityId, new Set()]));
  for (const relationship of topology.relationships) {
    if (relationship.decision === 'defer' || relationship.cardinalityIntent === 'many-to-many') continue;
    const child = relationship.cardinalityIntent === 'many-to-one'
      ? relationship.fromEntityId
      : relationship.toEntityId;
    const parent = relationship.cardinalityIntent === 'many-to-one'
      ? relationship.toEntityId
      : relationship.fromEntityId;
    dependencies.get(child).add(parent);
  }
  return topology.entities.map((entity) => ({
    id: entity.entityId,
    dependsOn: [...dependencies.get(entity.entityId)].sort(lexicalCompare),
  }));
}

function shellFromEntity(entity) {
  const shell = structuredClone(entity);
  delete shell.fields;
  return JSON.parse(JSON.stringify(shell));
}

function validateDetailResult(value, topologyValue, expectedPartition) {
  const errors = validateJsonSchema(value, partitionSchemas().detail);
  if (errors.length > 0) return { valid: false, errors };
  const topology = normalizeTopologyResult(topologyValue);
  const expectedEntityIds = [...expectedPartition.entityIds].sort(lexicalCompare);
  const actualEntityIds = [...value.entityIds].sort(lexicalCompare);
  if (value.partitionId !== expectedPartition.partitionId) {
    errors.push(`partitionId must equal ${expectedPartition.partitionId}`);
  }
  if (value.topologyHash !== sha256(stableJson(topology))) errors.push('topologyHash mismatch');
  if (stableJson(actualEntityIds) !== stableJson(expectedEntityIds)) {
    errors.push(`entityIds must equal ${expectedEntityIds.join(', ')}`);
  }
  const returnedEntityIds = value.entities.map((entity) => entity.entityId).sort(lexicalCompare);
  if (stableJson(returnedEntityIds) !== stableJson(expectedEntityIds)) {
    errors.push(`entities must contain exactly ${expectedEntityIds.join(', ')}`);
  }
  const shellById = new Map(topology.entities.map((entity) => {
    const shell = structuredClone(entity);
    delete shell.contextItemIds;
    return [entity.entityId, JSON.parse(JSON.stringify(shell))];
  }));
  for (const entity of value.entities) {
    const expectedShell = shellById.get(entity.entityId);
    if (expectedShell && stableJson(shellFromEntity(entity)) !== stableJson(expectedShell)) {
      errors.push(`${entity.entityId} changed immutable topology fields`);
    }
  }
  const assignments = topology.operationAssignments
    .filter((assignment) => expectedEntityIds.includes(assignment.entityId));
  const expectedOperationIds = assignments.map((item) => item.operationId).sort(lexicalCompare);
  const actualOperationIds = value.operations.map((item) => item.operationId).sort(lexicalCompare);
  if (stableJson(actualOperationIds) !== stableJson(expectedOperationIds)) {
    errors.push(`operations must contain exactly ${expectedOperationIds.join(', ') || 'no operations'}`);
  }
  const assignmentById = new Map(assignments.map((item) => [item.operationId, item.entityId]));
  const fieldOwners = new Map();
  for (const entity of value.entities) {
    for (const field of entity.fields) fieldOwners.set(field.fieldId, entity.entityId);
  }
  for (const operation of value.operations) {
    if (assignmentById.get(operation.operationId) !== operation.entityId) {
      errors.push(`${operation.operationId} changed its topology entity assignment`);
    }
    const fieldIds = [
      ...operation.selectFieldIds,
      ...operation.mutationFieldIds,
      ...operation.filterIntent.map((filter) => filter.fieldId),
      ...operation.sortIntent.map((sort) => sort.fieldId),
    ];
    for (const fieldId of fieldIds) {
      if (fieldOwners.get(fieldId) !== operation.entityId) {
        errors.push(`${operation.operationId} references unavailable field ${fieldId}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function normalizeDetailResult(value, topology, expectedPartition) {
  const result = trimValue(structuredClone(value));
  const validation = validateDetailResult(result, topology, expectedPartition);
  if (!validation.valid) {
    throw new Error(`${expectedPartition.partitionId}: ${validation.errors.join('; ')}`);
  }
  result.entityIds = [...result.entityIds].sort(lexicalCompare);
  result.entities = stableSort(result.entities.map((entity) => ({
    ...entity,
    owningRequirementIds: [...(entity.owningRequirementIds || [])].sort(lexicalCompare),
    fields: stableSort(entity.fields.map((field) => ({
      ...field,
      options: field.options
        ? [...field.options].sort((left, right) => left.order - right.order
          || lexicalCompare(left.optionId, right.optionId))
        : undefined,
    })), (field) => field.fieldId),
  })), (entity) => entity.entityId);
  result.operations = stableSort(result.operations.map((operation) => ({
    ...operation,
    inputIntent: [...operation.inputIntent].sort(lexicalCompare),
    selectFieldIds: [...operation.selectFieldIds].sort(lexicalCompare),
    filterIntent: stableSort(operation.filterIntent, (filter) => (
      `${filter.fieldId}:${filter.operator}:${filter.input}`
    )),
    sortIntent: [...operation.sortIntent].sort((left, right) => left.order - right.order
      || lexicalCompare(left.fieldId, right.fieldId)),
    mutationFieldIds: [...operation.mutationFieldIds].sort(lexicalCompare),
  })), (operation) => operation.operationId);
  for (const field of ['assumptions', 'risks', 'concerns']) {
    result[field] = [...result[field]].sort(lexicalCompare);
  }
  return JSON.parse(JSON.stringify(result));
}

class DataModelPartitionMergeError extends Error {
  constructor(findings, repairPartitionIds) {
    super(`Data-model partitions cannot merge: ${findings.join('; ')}`);
    this.name = 'DataModelPartitionMergeError';
    this.findings = findings;
    this.repairPartitionIds = [...new Set(repairPartitionIds)].sort(lexicalCompare);
  }
}

function mergeDataModelSemanticPartitions(topologyValue, expectedPartitions, detailValues) {
  const topologyValidation = validateTopologyResult(topologyValue);
  if (!topologyValidation.valid) {
    throw new DataModelPartitionMergeError(topologyValidation.errors, ['topology']);
  }
  const topology = normalizeTopologyResult(topologyValue);
  if (!Array.isArray(expectedPartitions)
    || (expectedPartitions.length === 0 && topology.entities.length > 0)) {
    throw new DataModelPartitionMergeError(
      ['expectedPartitions must cover every topology entity'],
      ['topology'],
    );
  }
  if (!Array.isArray(detailValues)) {
    throw new DataModelPartitionMergeError(['detailValues must be an array'], []);
  }
  const expectedById = new Map();
  for (const partition of expectedPartitions) {
    if (!partition || typeof partition.partitionId !== 'string' || !Array.isArray(partition.entityIds)) {
      throw new DataModelPartitionMergeError(['expected partition shape is invalid'], ['topology']);
    }
    if (expectedById.has(partition.partitionId)) {
      throw new DataModelPartitionMergeError(
        [`duplicate expected partition ${partition.partitionId}`],
        ['topology'],
      );
    }
    expectedById.set(partition.partitionId, partition);
  }
  const topologyEntityIds = topology.entities.map((entity) => entity.entityId).sort(lexicalCompare);
  const assignedEntityIds = expectedPartitions
    .flatMap((partition) => partition.entityIds)
    .sort(lexicalCompare);
  const duplicateEntityIds = duplicateValues(assignedEntityIds);
  const missingEntityIds = topologyEntityIds.filter((entityId) => !assignedEntityIds.includes(entityId));
  const unknownEntityIds = assignedEntityIds.filter((entityId) => !topologyEntityIds.includes(entityId));
  if (duplicateEntityIds.length > 0 || missingEntityIds.length > 0 || unknownEntityIds.length > 0) {
    const coverageFindings = [
      ...(duplicateEntityIds.length > 0
        ? [`entities assigned to multiple partitions: ${duplicateEntityIds.join(', ')}`]
        : []),
      ...(missingEntityIds.length > 0
        ? [`topology entities missing from partitions: ${missingEntityIds.join(', ')}`]
        : []),
      ...(unknownEntityIds.length > 0
        ? [`partitions contain unknown topology entities: ${unknownEntityIds.join(', ')}`]
        : []),
    ];
    throw new DataModelPartitionMergeError(coverageFindings, ['topology']);
  }
  const detailsById = new Map();
  const findings = [];
  const repairPartitionIds = [];
  for (const detail of detailValues) {
    const partitionId = detail?.partitionId;
    if (!expectedById.has(partitionId)) {
      findings.push(`unexpected detail partition ${partitionId || '<missing>'}`);
      repairPartitionIds.push(partitionId || 'unknown');
      continue;
    }
    if (detailsById.has(partitionId)) {
      findings.push(`duplicate detail partition ${partitionId}`);
      repairPartitionIds.push(partitionId);
      continue;
    }
    const validation = validateDetailResult(detail, topology, expectedById.get(partitionId));
    if (!validation.valid) {
      findings.push(...validation.errors.map((error) => `${partitionId}: ${error}`));
      repairPartitionIds.push(partitionId);
      continue;
    }
    detailsById.set(partitionId, normalizeDetailResult(
      detail,
      topology,
      expectedById.get(partitionId),
    ));
  }
  for (const partitionId of expectedById.keys()) {
    if (!detailsById.has(partitionId) && !repairPartitionIds.includes(partitionId)) {
      findings.push(`${partitionId}: result is missing`);
      repairPartitionIds.push(partitionId);
    }
  }
  if (findings.length > 0) throw new DataModelPartitionMergeError(findings, repairPartitionIds);

  const details = [...detailsById.values()]
    .sort((left, right) => lexicalCompare(left.partitionId, right.partitionId));
  const merged = {
    schemaVersion: 1,
    status: 'ready',
    mode: topology.mode,
    summary: topology.summary,
    requirements: topology.requirements,
    entities: details.flatMap((detail) => detail.entities),
    relationships: topology.relationships,
    operations: details.flatMap((detail) => detail.operations),
    fixtureScenarios: topology.fixtureScenarios,
    assumptions: [...new Set([
      ...topology.assumptions,
      ...details.flatMap((detail) => detail.assumptions),
    ])].sort(lexicalCompare),
    risks: [...new Set([
      ...topology.risks,
      ...details.flatMap((detail) => detail.risks),
    ])].sort(lexicalCompare),
    concerns: [...new Set([
      ...topology.concerns,
      ...details.flatMap((detail) => detail.concerns),
    ])].sort(lexicalCompare),
  };
  const validation = validateSemanticResult(merged);
  if (!validation.valid) {
    const ownersBySemanticId = new Map();
    const registerOwner = (semanticId, partitionId) => {
      if (!ownersBySemanticId.has(semanticId)) ownersBySemanticId.set(semanticId, new Set());
      ownersBySemanticId.get(semanticId).add(partitionId);
    };
    for (const detail of details) {
      for (const entity of detail.entities) {
        registerOwner(entity.entityId, detail.partitionId);
        entity.fields.forEach((field) => registerOwner(field.fieldId, detail.partitionId));
      }
      detail.operations.forEach((operation) => registerOwner(operation.operationId, detail.partitionId));
    }
    const owners = validation.errors.flatMap((error) => (
      [...error.matchAll(/(?:requirement|entity|field|relationship|operation|scenario):[a-z0-9][a-z0-9-]*/g)]
        .flatMap((match) => [...(ownersBySemanticId.get(match[0]) || [])])
    ));
    throw new DataModelPartitionMergeError(
      validation.errors,
      owners.length > 0 ? owners : ['topology'],
    );
  }
  return normalizeSemanticResult(merged);
}

module.exports = {
  DETAIL_RESULT_TYPE,
  DataModelPartitionMergeError,
  TOPOLOGY_RESULT_TYPE,
  entityDependencies,
  mergeDataModelSemanticPartitions,
  normalizeDetailResult,
  normalizeTopologyResult,
  partitionSchemas,
  topologyHash,
  validateDetailResult,
  validateTopologyResult,
};