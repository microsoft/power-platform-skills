'use strict';

const { lexicalCompare, sealWorkOrder, stableJson } = require('./agent-return-envelope');

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const MIN_MAX_PAYLOAD_BYTES = 8 * 1024;

function utf8ByteLength(value) {
  const text = typeof value === 'string' ? value : stableJson(value);
  return Buffer.byteLength(text, 'utf8');
}

function resolveMaxPayloadBytes(value = process.env.MOBILE_AGENT_MAX_PAYLOAD_BYTES) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MAX_PAYLOAD_BYTES;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_MAX_PAYLOAD_BYTES) {
    throw new Error(`max payload bytes must be an integer of at least ${MIN_MAX_PAYLOAD_BYTES}`);
  }
  return parsed;
}

function measureSealedWorkOrder(workOrder) {
  const sealedWorkOrder = sealWorkOrder(workOrder);
  return {
    sealedWorkOrder,
    payloadBytes: utf8ByteLength(sealedWorkOrder),
  };
}

function normalizeDependencyItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('dependency items must be a non-empty array');
  }
  const byId = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('each dependency item must be an object');
    }
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error('each dependency item requires a non-empty id');
    }
    const id = item.id.trim();
    if (byId.has(id)) throw new Error(`duplicate dependency item: ${id}`);
    if (!Array.isArray(item.dependsOn)
      || item.dependsOn.some((dependency) => typeof dependency !== 'string' || !dependency.trim())) {
      throw new Error(`${id} dependsOn must be an array of non-empty strings`);
    }
    byId.set(id, {
      ...item,
      id,
      dependsOn: [...new Set(item.dependsOn.map((dependency) => dependency.trim()))]
        .sort(lexicalCompare),
    });
  }
  for (const item of byId.values()) {
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`${item.id} has unknown dependency ${dependency}`);
      if (dependency === item.id) throw new Error(`${item.id} cannot depend on itself`);
    }
  }
  return byId;
}

function dependencyOrder(items) {
  const byId = normalizeDependencyItems(items);
  const dependents = new Map([...byId.keys()].map((id) => [id, []]));
  const indegree = new Map([...byId.values()].map((item) => [item.id, item.dependsOn.length]));
  for (const item of byId.values()) {
    for (const dependency of item.dependsOn) dependents.get(dependency).push(item.id);
  }
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort(lexicalCompare);
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const dependent of dependents.get(id).sort(lexicalCompare)) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort(lexicalCompare);
      }
    }
  }
  if (ordered.length !== byId.size) {
    const unresolved = [...indegree.entries()]
      .filter(([, count]) => count > 0)
      .map(([id]) => id)
      .sort(lexicalCompare);
    throw new Error(`dependency cycle detected: ${unresolved.join(', ')}`);
  }
  return ordered;
}

function partitionByPayloadBudget(items, {
  maxPayloadBytes,
  buildWorkOrder,
  partitionId = (index) => `partition-${String(index + 1).padStart(3, '0')}`,
} = {}) {
  const budget = resolveMaxPayloadBytes(maxPayloadBytes);
  if (typeof buildWorkOrder !== 'function') throw new Error('buildWorkOrder is required');
  const ordered = dependencyOrder(items);
  const partitions = [];
  let current = [];

  const measure = (candidate, index) => {
    const id = partitionId(index);
    const workOrder = buildWorkOrder(candidate, id);
    const measured = measureSealedWorkOrder(workOrder);
    return { id, itemIds: candidate.map((item) => item.id), ...measured };
  };

  for (const item of ordered) {
    const candidate = [...current, item];
    const candidateMeasurement = measure(candidate, partitions.length);
    if (candidateMeasurement.payloadBytes <= budget) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      partitions.push(measure(current, partitions.length));
      current = [item];
    } else {
      current = [item];
    }
    const singleMeasurement = measure(current, partitions.length);
    if (singleMeasurement.payloadBytes > budget) {
      throw new Error(
        `${item.id} requires ${singleMeasurement.payloadBytes} bytes, exceeding the ${budget}-byte payload budget`,
      );
    }
  }
  if (current.length > 0) partitions.push(measure(current, partitions.length));

  const assigned = partitions.flatMap((partition) => partition.itemIds);
  if (assigned.length !== ordered.length || new Set(assigned).size !== ordered.length) {
    throw new Error('payload partitioning did not preserve every dependency item exactly once');
  }
  return {
    maxPayloadBytes: budget,
    totalItemCount: ordered.length,
    partitionCount: partitions.length,
    partitions,
  };
}

module.exports = {
  DEFAULT_MAX_PAYLOAD_BYTES,
  MIN_MAX_PAYLOAD_BYTES,
  dependencyOrder,
  measureSealedWorkOrder,
  partitionByPayloadBudget,
  resolveMaxPayloadBytes,
  utf8ByteLength,
};