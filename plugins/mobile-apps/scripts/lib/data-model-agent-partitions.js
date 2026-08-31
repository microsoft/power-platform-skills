'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { sha256, stableJson } = require('../build-dataverse-operation-manifest');
const {
  normalizeSemanticResult,
  SCHEMA_PATH,
  validateSemanticResult,
} = require('./compile-data-model-semantic-result');
const {
  DETAIL_RESULT_TYPE,
  TOPOLOGY_RESULT_TYPE,
  entityDependencies,
  mergeDataModelSemanticPartitions,
  normalizeDetailResult,
  normalizeTopologyResult,
  partitionSchemas,
  topologyHash,
  validateDetailResult,
  validateTopologyResult,
} = require('./data-model-semantic-partitions');
const {
  measureSealedWorkOrder,
  partitionByPayloadBudget,
  resolveMaxPayloadBytes,
  utf8ByteLength,
} = require('./agent-payload-budget');
const { lexicalCompare } = require('./agent-return-envelope');

const STATE_SCHEMA_VERSION = 1;
const FULL_RESULT_TYPE = 'data-model-semantic-v1';
const REQUEST_FIELDS = new Set([
  'schemaVersion',
  'runId',
  'attempt',
  'sharedContext',
  'topologyContext',
  'contextItems',
]);
const CONTEXT_ITEM_FIELDS = new Set(['contextItemId', 'summary', 'detail']);

let semanticSchemaCache;

function semanticSchema() {
  if (!semanticSchemaCache) {
    semanticSchemaCache = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  }
  return structuredClone(semanticSchemaCache);
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function normalizeRequest(value) {
  if (!isPlainObject(value)) throw new Error('data-model partition request must be an object');
  assertExactFields(value, REQUEST_FIELDS, 'request');
  if (value.schemaVersion !== 1) throw new Error('request schemaVersion must equal 1');
  const runId = requiredString(value.runId, 'request.runId');
  if (!Number.isInteger(value.attempt) || value.attempt < 1) {
    throw new Error('request.attempt must be a positive integer');
  }
  if (!isPlainObject(value.sharedContext)) throw new Error('request.sharedContext must be an object');
  if (!isPlainObject(value.topologyContext)) {
    throw new Error('request.topologyContext must be an object');
  }
  if (!Array.isArray(value.contextItems)) throw new Error('request.contextItems must be an array');
  const ids = new Set();
  const contextItems = value.contextItems.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`request.contextItems[${index}] must be an object`);
    assertExactFields(item, CONTEXT_ITEM_FIELDS, `request.contextItems[${index}]`);
    const contextItemId = requiredString(
      item.contextItemId,
      `request.contextItems[${index}].contextItemId`,
    );
    if (!Object.prototype.hasOwnProperty.call(item, 'summary')) {
      throw new Error(`request.contextItems[${index}].summary is required`);
    }
    if (!Object.prototype.hasOwnProperty.call(item, 'detail')) {
      throw new Error(`request.contextItems[${index}].detail is required`);
    }
    if (ids.has(contextItemId)) throw new Error(`duplicate context item ${contextItemId}`);
    ids.add(contextItemId);
    return { contextItemId, summary: item.summary, detail: item.detail };
  }).sort((left, right) => lexicalCompare(left.contextItemId, right.contextItemId));
  return JSON.parse(JSON.stringify({
    schemaVersion: 1,
    runId,
    attempt: value.attempt,
    sharedContext: value.sharedContext,
    topologyContext: value.topologyContext,
    contextItems,
  }));
}

function dataModelRequestHash(value) {
  return sha256(stableJson(normalizeRequest(value)));
}

function requestDescriptor(value) {
  const request = normalizeRequest(value);
  return {
    attempt: request.attempt,
    sharedContextHash: sha256(stableJson(request.sharedContext)),
    topologyContextHash: sha256(stableJson(request.topologyContext)),
    contextItems: request.contextItems.map((item) => ({
      contextItemId: item.contextItemId,
      summaryHash: sha256(stableJson(item.summary)),
      detailHash: sha256(stableJson(item.detail)),
    })),
  };
}

function resultDescriptor(resultId, resultType) {
  return { resultId, resultType };
}

function fullWorkOrder(request) {
  return {
    schemaVersion: 1,
    agent: 'data-model-architect',
    workOrderId: 'planning:data-model',
    attempt: request.attempt,
    context: {
      partition: { kind: 'single' },
      shared: request.sharedContext,
      topology: request.topologyContext,
      contextItems: request.contextItems.map((item) => ({
        contextItemId: item.contextItemId,
        content: item.detail,
      })),
      resultSchema: semanticSchema(),
    },
    artifacts: [],
    result: resultDescriptor('semantic:data-model', FULL_RESULT_TYPE),
  };
}

function topologyWorkOrder(request) {
  return {
    schemaVersion: 1,
    agent: 'data-model-architect',
    workOrderId: 'planning:data-model:topology',
    attempt: request.attempt,
    context: {
      partition: {
        kind: 'topology',
        instructions: [
          'Define global requirement coverage, entity shells, relationships, operation ownership, and fixture intent.',
          'Assign every context item to at least one entity through contextItemIds.',
          'Do not return entity fields or complete operations.',
        ],
      },
      shared: request.sharedContext,
      topology: request.topologyContext,
      contextItemSummaries: request.contextItems.map((item) => ({
        contextItemId: item.contextItemId,
        summary: item.summary,
      })),
      resultSchema: partitionSchemas().topology,
    },
    artifacts: [],
    result: resultDescriptor('semantic:data-model:topology', TOPOLOGY_RESULT_TYPE),
  };
}

function detailWorkOrder(request, topology, entityIds, partitionId) {
  const entityIdSet = new Set(entityIds);
  const entityById = new Map(topology.entities.map((entity) => [entity.entityId, entity]));
  const contextIds = new Set(entityIds.flatMap(
    (entityId) => entityById.get(entityId).contextItemIds,
  ));
  const contextItems = request.contextItems
    .filter((item) => contextIds.has(item.contextItemId))
    .map((item) => ({ contextItemId: item.contextItemId, content: item.detail }));
  const operationAssignments = topology.operationAssignments
    .filter((assignment) => entityIdSet.has(assignment.entityId));
  const hash = topologyHash(topology);
  return {
    schemaVersion: 1,
    agent: 'data-model-architect',
    workOrderId: `planning:data-model:${partitionId}`,
    attempt: request.attempt,
    context: {
      partition: {
        kind: 'detail',
        partitionId,
        topologyHash: hash,
        entityIds,
        operationAssignments,
        instructions: [
          'Return every assigned entity with complete fields and every assigned operation.',
          'Copy immutable entity shell fields exactly from topology.',
          'Do not return relationships, requirements, fixtures, or unassigned entities.',
        ],
      },
      shared: request.sharedContext,
      lockedTopology: topology,
      contextItems,
      resultSchema: partitionSchemas().detail,
    },
    artifacts: [],
    result: resultDescriptor(`semantic:data-model:${partitionId}`, DETAIL_RESULT_TYPE),
  };
}

function workOrderRecord(partitionId, relativePath, measurement) {
  return {
    partitionId,
    workOrderId: measurement.sealedWorkOrder.workOrderId,
    resultId: measurement.sealedWorkOrder.result.resultId,
    resultType: measurement.sealedWorkOrder.result.resultType,
    workOrderPath: relativePath,
    inputFingerprint: measurement.sealedWorkOrder.inputFingerprint,
    payloadBytes: measurement.payloadBytes,
    status: 'pending',
  };
}

function initializeDataModelPartitionPlan(value, {
  maxPayloadBytes,
  requestPath,
  singleWorkOrderPath = '.tmp/agent-work-orders/data-model.json',
  topologyWorkOrderPath = '.tmp/agent-work-orders/data-model-topology.json',
} = {}) {
  const request = normalizeRequest(value);
  const budget = resolveMaxPayloadBytes(maxPayloadBytes);
  const requestHash = dataModelRequestHash(request);
  const single = measureSealedWorkOrder(fullWorkOrder(request));
  const metrics = {
    candidateSinglePayloadBytes: single.payloadBytes,
    requestPayloadBytes: 0,
    responsePayloadBytes: 0,
    workOrderCount: 0,
    detailPartitionCount: 0,
    completedWorkOrderCount: 0,
    resumedWorkOrderCount: 0,
  };
  if (single.payloadBytes <= budget) {
    const record = workOrderRecord('single', singleWorkOrderPath, single);
    return {
      request,
      files: [{ path: singleWorkOrderPath, value: single.sealedWorkOrder }],
      state: {
        schemaVersion: STATE_SCHEMA_VERSION,
        runId: request.runId,
        requestHash,
        requestDescriptor: requestDescriptor(request),
        requestPath,
        maxPayloadBytes: budget,
        mode: 'single',
        status: 'awaiting_single',
        single: record,
        topology: null,
        partitions: [],
        metrics: {
          ...metrics,
          requestPayloadBytes: single.payloadBytes,
          workOrderCount: 1,
        },
      },
    };
  }
  const topology = measureSealedWorkOrder(topologyWorkOrder(request));
  if (topology.payloadBytes > budget) {
    throw new Error(
      `topology work order requires ${topology.payloadBytes} bytes, exceeding the ${budget}-byte payload budget; compact topologyContext or context-item summaries without reducing product scope`,
    );
  }
  const record = workOrderRecord('topology', topologyWorkOrderPath, topology);
  return {
    request,
    files: [{ path: topologyWorkOrderPath, value: topology.sealedWorkOrder }],
    state: {
      schemaVersion: STATE_SCHEMA_VERSION,
      runId: request.runId,
      requestHash,
      requestDescriptor: requestDescriptor(request),
      requestPath,
      maxPayloadBytes: budget,
      mode: 'partitioned',
      status: 'awaiting_topology',
      single: null,
      topology: record,
      partitions: [],
      metrics: {
        ...metrics,
        requestPayloadBytes: topology.payloadBytes,
        workOrderCount: 1,
      },
    },
  };
}

function assertStateBinding(state, request) {
  if (!isPlainObject(state) || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error('data-model partition state is invalid');
  }
  const normalizedRequest = normalizeRequest(request);
  if (state.runId !== normalizedRequest.runId) {
    throw new Error('data-model partition state belongs to a different run');
  }
  if (state.requestHash !== dataModelRequestHash(normalizedRequest)) {
    throw new Error('data-model partition request changed within the same run');
  }
  return normalizedRequest;
}

function refreshDataModelPartitionPlan(stateValue, nextRequestValue, topologyValue = null) {
  const state = structuredClone(stateValue);
  if (!isPlainObject(state) || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error('data-model partition state is invalid');
  }
  const nextRequest = normalizeRequest(nextRequestValue);
  if (state.runId !== nextRequest.runId) {
    throw new Error('data-model partition refresh belongs to a different run');
  }
  if (!isPlainObject(state.requestDescriptor)) {
    throw new Error('data-model partition state lacks a request descriptor');
  }
  if (nextRequest.attempt <= state.requestDescriptor.attempt) {
    throw new Error('refreshed data-model request must increment attempt');
  }
  const previousDescriptor = state.requestDescriptor;
  const nextDescriptor = requestDescriptor(nextRequest);
  const previousItems = new Map(previousDescriptor.contextItems.map(
    (item) => [item.contextItemId, item],
  ));
  const nextItems = new Map(nextDescriptor.contextItems.map(
    (item) => [item.contextItemId, item],
  ));
  const contextIdsChanged = stableJson([...previousItems.keys()].sort(lexicalCompare))
    !== stableJson([...nextItems.keys()].sort(lexicalCompare));
  const summariesChanged = contextIdsChanged || [...nextItems.entries()].some(
    ([contextItemId, item]) => previousItems.get(contextItemId)?.summaryHash !== item.summaryHash,
  );
  const topologyInputsChanged = previousDescriptor.sharedContextHash !== nextDescriptor.sharedContextHash
    || previousDescriptor.topologyContextHash !== nextDescriptor.topologyContextHash
    || summariesChanged;
  const changedDetailIds = [...nextItems.entries()]
    .filter(([contextItemId, item]) => (
      previousItems.get(contextItemId)?.detailHash !== item.detailHash
    ))
    .map(([contextItemId]) => contextItemId)
    .sort(lexicalCompare);

  if (topologyInputsChanged || state.mode === 'single') {
    const replanned = initializeDataModelPartitionPlan(nextRequest, {
      maxPayloadBytes: state.maxPayloadBytes,
      requestPath: state.requestPath,
      singleWorkOrderPath: state.single?.workOrderPath
        || '.tmp/agent-work-orders/data-model.json',
      topologyWorkOrderPath: state.topology?.workOrderPath
        || '.tmp/agent-work-orders/data-model-topology.json',
    });
    replanned.state.metrics.resumedWorkOrderCount = state.metrics.resumedWorkOrderCount || 0;
    return {
      ...replanned,
      invalidatedPartitionIds: state.mode === 'single'
        ? ['single']
        : ['topology', ...state.partitions.map((partition) => partition.partitionId)],
    };
  }

  state.requestHash = dataModelRequestHash(nextRequest);
  state.requestDescriptor = nextDescriptor;
  delete state.mergedSemanticHash;
  delete state.mergedSemanticPath;
  if (changedDetailIds.length === 0 || state.topology.status !== 'complete') {
    return { state, request: nextRequest, files: [], invalidatedPartitionIds: [] };
  }
  if (!topologyValue) throw new Error('completed topology is required for detail-only refresh');
  const topology = normalizeTopologyResult(topologyValue, {
    contextItemIds: nextRequest.contextItems.map((item) => item.contextItemId),
  });
  if (topologyHash(topology) !== state.topology.topologyHash) {
    throw new Error('completed topology hash no longer matches checkpoint state');
  }
  const affectedEntities = new Set(topology.entities
    .filter((entity) => entity.contextItemIds.some((itemId) => changedDetailIds.includes(itemId)))
    .map((entity) => entity.entityId));
  const affected = state.partitions.filter((partition) => (
    partition.entityIds.some((entityId) => affectedEntities.has(entityId))
  ));
  if (affected.length === 0) {
    throw new Error(`refreshed context items are not assigned: ${changedDetailIds.join(', ')}`);
  }
  const files = [];
  for (const partition of affected) {
    const measured = measureSealedWorkOrder(detailWorkOrder(
      nextRequest,
      topology,
      partition.entityIds,
      partition.partitionId,
    ));
    if (measured.payloadBytes > state.maxPayloadBytes) {
      throw new Error(
        `${partition.partitionId} refresh requires ${measured.payloadBytes} bytes, exceeding the ${state.maxPayloadBytes}-byte payload budget`,
      );
    }
    files.push({ path: partition.workOrderPath, value: measured.sealedWorkOrder });
    state.metrics.requestPayloadBytes += measured.payloadBytes - partition.payloadBytes;
    if (partition.status === 'complete') {
      state.metrics.responsePayloadBytes -= partition.responseBytes;
    }
    for (const key of ['resultPath', 'resultFileHash', 'resultHash', 'responseBytes']) {
      delete partition[key];
    }
    partition.status = 'pending';
    partition.inputFingerprint = measured.sealedWorkOrder.inputFingerprint;
    partition.payloadBytes = measured.payloadBytes;
  }
  state.metrics.completedWorkOrderCount = 1 + state.partitions.filter(
    (partition) => partition.status === 'complete',
  ).length;
  state.status = 'awaiting_details';
  return {
    state,
    request: nextRequest,
    files,
    invalidatedPartitionIds: affected.map((partition) => partition.partitionId),
  };
}

function extractTypedResult(value, expectedType, expectedId, expectedFingerprint) {
  if (!isPlainObject(value)
    || value.schemaVersion !== 1
    || !['ready', 'ready_with_concerns'].includes(value.status)
    || !Array.isArray(value.results)
    || !Number.isSafeInteger(value.responsePayloadBytes)
    || value.responsePayloadBytes < 0) {
    throw new Error('result file must be a validated agent-return-envelope result wrapper');
  }
  const matches = value.results.filter((entry) => (
    entry?.resultType === expectedType
      && entry?.resultId === expectedId
      && entry?.inputFingerprint === expectedFingerprint
  ));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${expectedId} ${expectedType} result bound to ${expectedFingerprint}, found ${matches.length}`,
    );
  }
  return matches[0].value;
}

function completedResultMetadata(resultValue, resultPath, sourceText, responsePayloadBytes) {
  return {
    status: 'complete',
    resultPath,
    resultFileHash: sha256(sourceText),
    resultHash: sha256(stableJson(resultValue)),
    responseBytes: responsePayloadBytes,
  };
}

function expandDataModelPartitionPlan(stateValue, requestValue, resultValue, {
  resultPath,
  resultSourceText,
  responsePayloadBytes = resultValue?.responsePayloadBytes,
  detailWorkOrderDirectory = '.tmp/agent-work-orders',
} = {}) {
  const state = structuredClone(stateValue);
  const request = assertStateBinding(state, requestValue);
  if (state.mode !== 'partitioned') throw new Error('single-call plans do not have topology expansion');
  const topologyResult = extractTypedResult(
    resultValue,
    TOPOLOGY_RESULT_TYPE,
    state.topology.resultId,
    state.topology.inputFingerprint,
  );
  const validation = validateTopologyResult(topologyResult, {
    contextItemIds: request.contextItems.map((item) => item.contextItemId),
  });
  if (!validation.valid) throw new Error(`Invalid data-model topology: ${validation.errors.join('; ')}`);
  const topology = normalizeTopologyResult(topologyResult, {
    contextItemIds: request.contextItems.map((item) => item.contextItemId),
  });
  const resultHash = sha256(stableJson(topology));
  if (state.topology.status === 'complete') {
    if (state.topology.resultHash !== resultHash) {
      throw new Error('completed topology changed; prepare a topology repair before expanding again');
    }
    return { state, files: [], resumed: true };
  }
  const files = [];
  const partitions = [];
  if (topology.entities.length > 0) {
    const dependencies = entityDependencies(topology);
    const packed = partitionByPayloadBudget(dependencies, {
      maxPayloadBytes: state.maxPayloadBytes,
      partitionId: (index) => `detail-${String(index + 1).padStart(3, '0')}`,
      buildWorkOrder: (items, partitionId) => detailWorkOrder(
        request,
        topology,
        items.map((item) => item.id),
        partitionId,
      ),
    });
    for (const packedPartition of packed.partitions) {
      const relativePath = path.posix.join(
        detailWorkOrderDirectory.replace(/\\/g, '/'),
        `data-model-${packedPartition.id}.json`,
      );
      files.push({ path: relativePath, value: packedPartition.sealedWorkOrder });
      partitions.push({
        ...workOrderRecord(packedPartition.id, relativePath, packedPartition),
        entityIds: packedPartition.itemIds,
      });
    }
  }
  const sourceText = resultSourceText || stableJson(resultValue);
  Object.assign(
    state.topology,
    completedResultMetadata(topology, resultPath, sourceText, responsePayloadBytes),
    { topologyHash: resultHash },
  );
  state.partitions = partitions;
  state.status = partitions.length > 0 ? 'awaiting_details' : 'ready_to_merge';
  state.metrics.responsePayloadBytes += state.topology.responseBytes;
  state.metrics.requestPayloadBytes += partitions.reduce(
    (total, partition) => total + partition.payloadBytes,
    0,
  );
  state.metrics.workOrderCount += partitions.length;
  state.metrics.detailPartitionCount = partitions.length;
  state.metrics.completedWorkOrderCount = 1;
  return { state, files, topology, resumed: false };
}

function resultRecord(state, partitionId) {
  if (state.mode === 'single' && partitionId === 'single') return state.single;
  return state.partitions.find((partition) => partition.partitionId === partitionId);
}

function recordDataModelPartitionResult(stateValue, requestValue, partitionId, resultValue, {
  resultPath,
  resultSourceText,
  responsePayloadBytes = resultValue?.responsePayloadBytes,
  topologyValue,
} = {}) {
  const state = structuredClone(stateValue);
  const request = assertStateBinding(state, requestValue);
  const record = resultRecord(state, partitionId);
  if (!record) throw new Error(`unknown data-model partition ${partitionId}`);
  const raw = extractTypedResult(
    resultValue,
    record.resultType,
    record.resultId,
    record.inputFingerprint,
  );
  let normalized;
  if (partitionId === 'single') {
    const validation = validateSemanticResult(raw);
    if (!validation.valid) throw new Error(`Invalid semantic data model: ${validation.errors.join('; ')}`);
    normalized = normalizeSemanticResult(raw);
  } else {
    if (!topologyValue) throw new Error('topologyValue is required for a detail result');
    normalized = normalizeDetailResult(raw, topologyValue, {
      partitionId,
      entityIds: record.entityIds,
    });
  }
  const sourceText = resultSourceText || stableJson(resultValue);
  const metadata = completedResultMetadata(
    normalized,
    resultPath,
    sourceText,
    responsePayloadBytes,
  );
  if (record.status === 'complete') {
    if (record.resultHash === metadata.resultHash
      && record.resultFileHash === metadata.resultFileHash) {
      return { state, result: normalized, resumed: true };
    }
    throw new Error(`${partitionId} is already complete; prepare a targeted repair first`);
  }
  Object.assign(record, metadata);
  state.metrics.responsePayloadBytes += metadata.responseBytes;
  state.metrics.completedWorkOrderCount = (state.mode === 'partitioned' ? 1 : 0)
    + (state.mode === 'single'
      ? Number(state.single.status === 'complete')
      : state.partitions.filter((partition) => partition.status === 'complete').length);
  const allComplete = state.mode === 'single'
    ? state.single.status === 'complete'
    : state.partitions.every((partition) => partition.status === 'complete');
  state.status = allComplete ? 'ready_to_merge' : (
    state.mode === 'single' ? 'awaiting_single' : 'awaiting_details'
  );
  return { state, result: normalized, resumed: false, request };
}

function prepareDataModelPartitionRepair(stateValue, requestValue, partitionId, findings, workOrder) {
  const state = structuredClone(stateValue);
  assertStateBinding(state, requestValue);
  if (!Array.isArray(findings) || findings.length === 0
    || findings.some((finding) => typeof finding !== 'string' || !finding.trim())) {
    throw new Error('repair findings must be a non-empty array of strings');
  }
  const record = partitionId === 'topology' ? state.topology : resultRecord(state, partitionId);
  if (!record) throw new Error(`unknown data-model partition ${partitionId}`);
  if (!isPlainObject(workOrder) || workOrder.inputFingerprint !== record.inputFingerprint) {
    throw new Error(`${partitionId} work order does not match checkpoint state`);
  }
  const revised = structuredClone(workOrder);
  delete revised.inputFingerprint;
  revised.attempt = Number(revised.attempt || 1) + 1;
  revised.context = {
    ...revised.context,
    repair: { findings: [...new Set(findings.map((finding) => finding.trim()))].sort(lexicalCompare) },
  };
  const measured = measureSealedWorkOrder(revised);
  if (measured.payloadBytes > state.maxPayloadBytes) {
    throw new Error(
      `${partitionId} repair requires ${measured.payloadBytes} bytes, exceeding the ${state.maxPayloadBytes}-byte payload budget`,
    );
  }
  const previousResponseBytes = record.status === 'complete' ? record.responseBytes : 0;
  for (const key of ['resultPath', 'resultFileHash', 'resultHash', 'responseBytes', 'topologyHash']) {
    delete record[key];
  }
  record.status = 'pending';
  record.inputFingerprint = measured.sealedWorkOrder.inputFingerprint;
  state.metrics.requestPayloadBytes += measured.payloadBytes - record.payloadBytes;
  state.metrics.responsePayloadBytes -= previousResponseBytes;
  record.payloadBytes = measured.payloadBytes;
  if (partitionId === 'topology') {
    state.partitions = [];
    state.metrics.requestPayloadBytes = measured.payloadBytes;
    state.metrics.responsePayloadBytes = 0;
    state.metrics.workOrderCount = 1;
    state.metrics.detailPartitionCount = 0;
    state.metrics.completedWorkOrderCount = 0;
    state.status = 'awaiting_topology';
  } else {
    state.metrics.completedWorkOrderCount = (state.mode === 'partitioned' ? 1 : 0)
      + (state.mode === 'single'
        ? 0
        : state.partitions.filter((partition) => partition.status === 'complete').length);
    state.status = state.mode === 'single' ? 'awaiting_single' : 'awaiting_details';
  }
  return { state, workOrder: measured.sealedWorkOrder };
}

function pendingDataModelWorkOrders(state) {
  if (state.mode === 'single') return state.single.status === 'pending' ? [state.single] : [];
  if (state.topology.status === 'pending') return [state.topology];
  return state.partitions.filter((partition) => partition.status === 'pending');
}

function completeDataModelWorkOrders(state) {
  const records = state.mode === 'single' ? [state.single] : [state.topology, ...state.partitions];
  return records.filter((record) => record?.status === 'complete');
}

function mergeCompletedDataModelPlan(stateValue, requestValue, resultValues, topologyValue = null) {
  const state = structuredClone(stateValue);
  assertStateBinding(state, requestValue);
  if (state.status !== 'ready_to_merge' && state.status !== 'merged') {
    throw new Error(`data-model plan is not ready to merge: ${state.status}`);
  }
  let semantic;
  if (state.mode === 'single') {
    const raw = resultValues.get('single');
    if (!raw) throw new Error('single semantic result is missing');
    semantic = normalizeSemanticResult(extractTypedResult(
      raw,
      state.single.resultType,
      state.single.resultId,
      state.single.inputFingerprint,
    ));
  } else {
    if (!topologyValue) throw new Error('topology result is missing');
    const details = state.partitions.map((partition) => {
      const raw = resultValues.get(partition.partitionId);
      if (!raw) throw new Error(`${partition.partitionId} result is missing`);
      return extractTypedResult(
        raw,
        partition.resultType,
        partition.resultId,
        partition.inputFingerprint,
      );
    });
    semantic = mergeDataModelSemanticPartitions(
      topologyValue,
      state.partitions.map((partition) => ({
        partitionId: partition.partitionId,
        entityIds: partition.entityIds,
      })),
      details,
    );
  }
  state.status = 'merged';
  state.mergedSemanticHash = sha256(stableJson(semantic));
  return { state, semantic };
}

module.exports = {
  CONTEXT_ITEM_FIELDS,
  dataModelRequestHash,
  FULL_RESULT_TYPE,
  REQUEST_FIELDS,
  STATE_SCHEMA_VERSION,
  completeDataModelWorkOrders,
  detailWorkOrder,
  expandDataModelPartitionPlan,
  extractTypedResult,
  fullWorkOrder,
  initializeDataModelPartitionPlan,
  mergeCompletedDataModelPlan,
  normalizeRequest,
  pendingDataModelWorkOrders,
  prepareDataModelPartitionRepair,
  refreshDataModelPartitionPlan,
  recordDataModelPartitionResult,
  requestDescriptor,
  topologyWorkOrder,
};