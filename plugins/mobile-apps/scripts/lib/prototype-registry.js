'use strict';

const { assertRevision, revision } = require('./prototype-files');
const { conceptId } = require('../compile-persistence-contract');

function projectDataAccess(registry, entityIds) {
  if (registry.contractType !== 'data-access-registry') throw new Error('Expected an app-owned data-access registry');
  assertRevision(registry, 'registryRevision', 'Data-access registry');
  if (!Array.isArray(entityIds) || new Set(entityIds).size !== entityIds.length) throw new Error('Registry projection requires unique entity IDs');
  const entities = [...entityIds].sort().map((entityId) => {
    const entity = registry.entities.find((entry) => entry.entityId === entityId);
    if (!entity) throw new Error(`Registry does not expose ${entityId}`);
    return structuredClone(entity);
  });
  return { registryRevision: registry.registryRevision, entities, ...(registry.media ? { media: structuredClone(registry.media) } : {}) };
}

function validateDataAccess(registry, projection, signatures, requiredOperations = []) {
  if (!projection || !Array.isArray(projection.entities)) throw new Error('Local work order requires its actual data-access projection');
  const expected = projectDataAccess(registry, projection.entities.map((entry) => entry.entityId));
  if (revision(expected) !== revision(projection)) throw new Error('Work-order data-access projection is stale or invented');
  const available = new Set([
    ...expected.entities.flatMap((entity) => entity.operations.map((operation) => operation.signature)),
    ...(expected.media?.signatures || []),
  ]);
  for (const signature of signatures) {
    if (!available.has(signature)) throw new Error(`Work order names an unverified repository signature: ${signature}`);
  }
  for (const operation of requiredOperations.filter((entry) => ['read', 'create', 'update', 'delete'].includes(entry.kind))) {
    const binding = typeof operation.entity === 'string' && registry.entities.find((entry) => (
      entry.entityId === operation.entity || entry.tableLogicalName === operation.entity || entry.conceptId === conceptId(operation.entity)
    ));
    if (!binding || !expected.entities.some((entry) => entry.entityId === binding.entityId)) {
      throw new Error('Work order omits the canonical operation repository');
    }
    const methods = operation.kind === 'read' ? ['list', 'get'] : [operation.kind];
    if (!binding.operations.some((entry) => methods.includes(entry.name) && signatures.includes(entry.signature))) {
      throw new Error(`Work order omits the verified ${operation.kind} repository signature`);
    }
  }
  return expected;
}

module.exports = { projectDataAccess, validateDataAccess };
