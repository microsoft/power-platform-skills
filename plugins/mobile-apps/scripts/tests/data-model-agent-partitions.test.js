'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { stableJson } = require('../build-dataverse-operation-manifest');
const { run } = require('../data-model-agent-partitions');
const {
  initializeDataModelPartitionPlan,
  mergeCompletedDataModelPlan,
} = require('../lib/data-model-agent-partitions');
const { topologyHash } = require('../lib/data-model-semantic-partitions');

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-model-partitions-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp', 'agent-results'), { recursive: true });
  return root;
}

function request(detailSize = 100) {
  return {
    schemaVersion: 1,
    runId: 'run-current',
    attempt: 1,
    sharedContext: {
      mode: 'dataverse-required',
      brief: 'Maintain equipment at company locations.',
    },
    topologyContext: {
      requirements: ['Find equipment by code.', 'Show its location.'],
    },
    contextItems: [{
      contextItemId: 'evidence:equipment',
      summary: 'Equipment metadata evidence.',
      detail: { text: 'e'.repeat(detailSize) },
    }, {
      contextItemId: 'evidence:location',
      summary: 'Location metadata evidence.',
      detail: { text: 'l'.repeat(detailSize) },
    }],
  };
}

function semanticEntity(id, name, primaryField, fields) {
  return {
    entityId: id,
    displayName: name,
    pluralDisplayName: `${name} records`,
    purpose: `${name} records support equipment maintenance work.`,
    lifecycle: `${name} records remain available throughout maintenance work.`,
    scopeRole: 'workflow record',
    ownershipIntent: 'organization',
    decision: 'new',
    primaryDisplayField: primaryField,
    serviceRequired: true,
    owningRequirementIds: ['requirement:find-equipment'],
    behavior: { activities: false, notes: false, offlineAvailable: true, changeTracking: true },
    targetEvidence: { status: 'missing', summary: 'The proposed name is verified absent.' },
    fields,
  };
}

function partitionResults() {
  const equipment = semanticEntity(
    'entity:equipment',
    'Equipment',
    'field:equipment-name',
    [{
      fieldId: 'field:equipment-name', displayName: 'Equipment name', typeIntent: 'text',
      required: true, purpose: 'Identifies equipment for users.', decision: 'new',
    }, {
      fieldId: 'field:equipment-code', displayName: 'Equipment code', typeIntent: 'text',
      required: true, purpose: 'Supports exact equipment lookup.', decision: 'new',
    }],
  );
  const location = semanticEntity(
    'entity:location',
    'Location',
    'field:location-name',
    [{
      fieldId: 'field:location-name', displayName: 'Location name', typeIntent: 'text',
      required: true, purpose: 'Identifies locations for users.', decision: 'new',
    }],
  );
  const shell = (entity, contextItemId) => {
    const result = structuredClone(entity);
    delete result.fields;
    result.contextItemIds = [contextItemId];
    return result;
  };
  const topology = {
    schemaVersion: 1,
    status: 'ready',
    mode: 'dataverse-required',
    summary: {
      productDomain: 'equipment maintenance',
      persistenceRationale: 'Teams share equipment and location records.',
    },
    requirements: [{
      requirementId: 'requirement:find-equipment',
      statement: 'Find equipment and show its location.',
      coveredBy: ['entity:equipment', 'operation:find-equipment'],
    }],
    entities: [
      shell(equipment, 'evidence:equipment'),
      shell(location, 'evidence:location'),
    ],
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
    operationAssignments: [{
      operationId: 'operation:find-equipment',
      entityId: 'entity:equipment',
    }],
    fixtureScenarios: [{
      scenarioId: 'scenario:equipment-at-location',
      purpose: 'Show equipment assigned to a location.',
      entityIds: ['entity:equipment', 'entity:location'],
      requirementIds: ['requirement:find-equipment'],
    }],
    assumptions: [],
    risks: [],
    concerns: [],
  };
  const operation = {
    operationId: 'operation:find-equipment',
    kind: 'read-one',
    entityId: 'entity:equipment',
    inputIntent: ['equipmentCode'],
    selectFieldIds: ['field:equipment-code', 'field:equipment-name'],
    filterIntent: [{ fieldId: 'field:equipment-code', operator: 'equals', input: 'equipmentCode' }],
    sortIntent: [],
    mutationFieldIds: [],
    paginationIntent: 'not-applicable',
    purpose: 'Find equipment by its code.',
  };
  return { equipment, location, topology, operation };
}

function checkpoint(root, partitionId) {
  const state = JSON.parse(fs.readFileSync(
    path.join(root, '.tmp', 'data-model-partition-state.json'),
    'utf8',
  ));
  if (partitionId === 'topology') return state.topology;
  if (partitionId === 'single') return state.single;
  return state.partitions.find((partition) => partition.partitionId === partitionId);
}

function envelopeResult(resultId, resultType, value, inputFingerprint) {
  return {
    schemaVersion: 1,
    status: 'ready',
    responsePayloadBytes: Buffer.byteLength(stableJson(value), 'utf8'),
    results: [{
      agent: 'data-model-architect',
      inputFingerprint,
      resultId,
      resultType,
      value,
    }],
  };
}

test('small requests remain one complete semantic work order', () => {
  const initialized = initializeDataModelPartitionPlan(request(), {
    maxPayloadBytes: 64 * 1024,
    requestPath: '.tmp/request.json',
  });
  assert.equal(initialized.state.mode, 'single');
  assert.equal(initialized.files.length, 1);
  assert.equal(initialized.state.single.resultType, 'data-model-semantic-v1');
  assert.ok(initialized.state.single.payloadBytes <= initialized.state.maxPayloadBytes);
});

test('partition CLI rejects derived work-order paths that traverse a symlink', (context) => {
  const root = project(context);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'data-model-partitions-outside-'));
  context.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, '.tmp', 'agent-work-orders'));
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(request()));
  assert.throws(() => run({
    action: 'initialize', projectRoot: root, request: '.tmp/request.json',
  }), /derived file is unsafe: targetPath traverses a symbolic link/);
});

test('large requests produce topology first and budgeted dependency detail partitions', (context) => {
  const root = project(context);
  const requestFile = path.join(root, '.tmp', 'request.json');
  fs.writeFileSync(requestFile, stableJson(request(12000)));
  const initialized = run({
    action: 'initialize',
    projectRoot: root,
    request: '.tmp/request.json',
    maxPayloadBytes: '40960',
  });
  assert.equal(initialized.mode, 'partitioned');
  assert.deepEqual(initialized.pendingPartitionIds, ['topology']);

  const { topology } = partitionResults();
  const topologyResult = envelopeResult(
    'semantic:data-model:topology',
    'data-model-topology-v1',
    topology,
    checkpoint(root, 'topology').inputFingerprint,
  );
  fs.writeFileSync(path.join(root, '.tmp', 'agent-results', 'topology.json'), stableJson(topologyResult));
  const expanded = run({
    action: 'expand-topology',
    projectRoot: root,
    request: '.tmp/request.json',
    result: '.tmp/agent-results/topology.json',
  });
  assert.equal(expanded.status, 'awaiting_details');
  assert.equal(expanded.metrics.detailPartitionCount, 2);
  assert.deepEqual(expanded.pendingPartitionIds, ['detail-001', 'detail-002']);
  const state = JSON.parse(fs.readFileSync(
    path.join(root, '.tmp', 'data-model-partition-state.json'),
    'utf8',
  ));
  assert.deepEqual(state.partitions.map((partition) => partition.entityIds), [
    ['entity:location'],
    ['entity:equipment'],
  ]);
  assert.equal(state.partitions.every(
    (partition) => partition.payloadBytes <= state.maxPayloadBytes,
  ), true);
});

test('topology-input refresh rebuilds topology within the same run', (context) => {
  const root = project(context);
  const original = request(12000);
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(original));
  run({
    action: 'initialize', projectRoot: root, request: '.tmp/request.json', maxPayloadBytes: '40960',
  });
  const originalFingerprint = checkpoint(root, 'topology').inputFingerprint;
  const refreshed = request(12000);
  refreshed.attempt = 2;
  refreshed.topologyContext.requirements.push('Retain maintenance history.');
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(refreshed));
  const result = run({
    action: 'refresh-request', projectRoot: root, request: '.tmp/request.json',
  });
  assert.deepEqual(result.invalidatedPartitionIds, ['topology']);
  assert.deepEqual(result.pendingPartitionIds, ['topology']);
  assert.notEqual(checkpoint(root, 'topology').inputFingerprint, originalFingerprint);
});

test('checkpoint resume skips complete siblings and repairs only one detail partition', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(request(12000)));
  run({
    action: 'initialize', projectRoot: root, request: '.tmp/request.json', maxPayloadBytes: '40960',
  });
  const { topology, location } = partitionResults();
  fs.writeFileSync(
    path.join(root, '.tmp', 'agent-results', 'topology.json'),
    stableJson(envelopeResult(
      'semantic:data-model:topology',
      'data-model-topology-v1',
      topology,
      checkpoint(root, 'topology').inputFingerprint,
    )),
  );
  run({
    action: 'expand-topology', projectRoot: root, request: '.tmp/request.json',
    result: '.tmp/agent-results/topology.json',
  });
  const detail = {
    schemaVersion: 1,
    status: 'ready',
    partitionId: 'detail-001',
    topologyHash: topologyHash(topology),
    entityIds: ['entity:location'],
    entities: [location],
    operations: [],
    assumptions: [], risks: [], concerns: [],
  };
  fs.writeFileSync(
    path.join(root, '.tmp', 'agent-results', 'detail-001.json'),
    stableJson(envelopeResult(
      'semantic:data-model:detail-001',
      'data-model-detail-v1',
      detail,
      checkpoint(root, 'detail-001').inputFingerprint,
    )),
  );
  run({
    action: 'record-result', projectRoot: root, request: '.tmp/request.json',
    result: '.tmp/agent-results/detail-001.json', partitionId: 'detail-001',
  });
  const resumed = run({ action: 'resume', projectRoot: root, request: '.tmp/request.json' });
  assert.deepEqual(resumed.completedPartitionIds, ['topology', 'detail-001']);
  assert.deepEqual(resumed.pendingPartitionIds, ['detail-002']);
  const repaired = run({
    action: 'prepare-repair', projectRoot: root, request: '.tmp/request.json',
    partitionId: 'detail-001', findings: ['Field purpose needs clarification.'],
  });
  assert.deepEqual(repaired.pendingPartitionIds, ['detail-001', 'detail-002']);
  const state = JSON.parse(fs.readFileSync(
    path.join(root, '.tmp', 'data-model-partition-state.json'),
    'utf8',
  ));
  assert.equal(state.partitions[1].status, 'pending');
  assert.equal(state.partitions[0].status, 'pending');
  const repairedWorkOrder = JSON.parse(fs.readFileSync(
    path.join(root, state.partitions[0].workOrderPath),
    'utf8',
  ));
  assert.deepEqual(repairedWorkOrder.context.repair.findings, [
    'Field purpose needs clarification.',
  ]);
});

test('same-run changed requests cannot reuse completed checkpoints', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(request()));
  run({ action: 'initialize', projectRoot: root, request: '.tmp/request.json' });
  const changed = request();
  changed.sharedContext.brief = 'A changed brief in the same run.';
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(changed));
  assert.throws(
    () => run({ action: 'initialize', projectRoot: root, request: '.tmp/request.json' }),
    /request changed within the same run/,
  );
});

test('same-run initialization normalizes context-item ordering before hashing', (context) => {
  const root = project(context);
  const original = request();
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(original));
  run({ action: 'initialize', projectRoot: root, request: '.tmp/request.json' });
  const reordered = structuredClone(original);
  reordered.contextItems.reverse();
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(reordered));
  const resumed = run({
    action: 'initialize', projectRoot: root, request: '.tmp/request.json',
  });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.pendingPartitionIds, ['single']);
});

test('recording rejects an unvalidated raw semantic object', (context) => {
  const root = project(context);
  const req = request();
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(req));
  run({ action: 'initialize', projectRoot: root, request: '.tmp/request.json' });
  fs.writeFileSync(path.join(root, '.tmp', 'agent-results', 'raw.json'), stableJson({
    schemaVersion: 1,
    status: 'ready',
    mode: 'no-persistence',
  }));
  assert.throws(() => run({
    action: 'record-result', projectRoot: root, request: '.tmp/request.json',
    result: '.tmp/agent-results/raw.json', partitionId: 'single',
  }), /validated agent-return-envelope result wrapper/);
});

test('recording rejects a valid result bound to another work order', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(request()));
  run({ action: 'initialize', projectRoot: root, request: '.tmp/request.json' });
  const { equipment, location, topology, operation } = partitionResults();
  const semantic = {
    schemaVersion: 1,
    status: 'ready',
    mode: topology.mode,
    summary: topology.summary,
    requirements: topology.requirements,
    entities: [equipment, location],
    relationships: topology.relationships,
    operations: [operation],
    fixtureScenarios: topology.fixtureScenarios,
    assumptions: [], risks: [], concerns: [],
  };
  fs.writeFileSync(
    path.join(root, '.tmp', 'agent-results', 'wrong-fingerprint.json'),
    stableJson(envelopeResult(
      'semantic:data-model',
      'data-model-semantic-v1',
      semantic,
      'a'.repeat(64),
    )),
  );
  assert.throws(() => run({
    action: 'record-result', projectRoot: root, request: '.tmp/request.json',
    result: '.tmp/agent-results/wrong-fingerprint.json', partitionId: 'single',
  }), /bound to [a-f0-9]{64}, found 0/);
});

test('resume recomputes fingerprints and rejects same-byte work-order edits', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(request()));
  run({ action: 'initialize', projectRoot: root, request: '.tmp/request.json' });
  const record = checkpoint(root, 'single');
  const workOrderPath = path.join(root, record.workOrderPath);
  const workOrder = JSON.parse(fs.readFileSync(workOrderPath, 'utf8'));
  workOrder.context.shared.brief = workOrder.context.shared.brief.replace('Maintain', 'maintain');
  fs.writeFileSync(workOrderPath, stableJson(workOrder));
  assert.equal(Buffer.byteLength(fs.readFileSync(workOrderPath)), record.payloadBytes);
  assert.throws(
    () => run({ action: 'resume', projectRoot: root, request: '.tmp/request.json' }),
    /work-order content no longer matches its fingerprint/,
  );
});

test('completed partition result tampering is detected during resume', (context) => {
  const root = project(context);
  const req = request();
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(req));
  run({ action: 'initialize', projectRoot: root, request: '.tmp/request.json' });
  const { equipment, location, topology, operation } = partitionResults();
  const semantic = {
    schemaVersion: 1,
    status: 'ready',
    mode: topology.mode,
    summary: topology.summary,
    requirements: topology.requirements,
    entities: [equipment, location],
    relationships: topology.relationships,
    operations: [operation],
    fixtureScenarios: topology.fixtureScenarios,
    assumptions: [], risks: [], concerns: [],
  };
  fs.writeFileSync(
    path.join(root, '.tmp', 'agent-results', 'single.json'),
    stableJson(envelopeResult(
      'semantic:data-model',
      'data-model-semantic-v1',
      semantic,
      checkpoint(root, 'single').inputFingerprint,
    )),
  );
  run({
    action: 'record-result', projectRoot: root, request: '.tmp/request.json',
    result: '.tmp/agent-results/single.json', partitionId: 'single',
  });
  fs.appendFileSync(path.join(root, '.tmp', 'agent-results', 'single.json'), ' ');
  assert.throws(
    () => run({ action: 'resume', projectRoot: root, request: '.tmp/request.json' }),
    /result file changed after completion/,
  );
});

test('topology result tampering is detected before a detail result is accepted', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(request(12000)));
  run({
    action: 'initialize', projectRoot: root, request: '.tmp/request.json', maxPayloadBytes: '40960',
  });
  const { topology, location } = partitionResults();
  const topologyPath = path.join(root, '.tmp', 'agent-results', 'topology.json');
  fs.writeFileSync(
    topologyPath,
    stableJson(envelopeResult(
      'semantic:data-model:topology',
      'data-model-topology-v1',
      topology,
      checkpoint(root, 'topology').inputFingerprint,
    )),
  );
  run({
    action: 'expand-topology', projectRoot: root, request: '.tmp/request.json',
    result: '.tmp/agent-results/topology.json',
  });
  fs.appendFileSync(topologyPath, ' ');
  const detail = {
    schemaVersion: 1,
    status: 'ready',
    partitionId: 'detail-001',
    topologyHash: topologyHash(topology),
    entityIds: ['entity:location'],
    entities: [location],
    operations: [],
    assumptions: [], risks: [], concerns: [],
  };
  fs.writeFileSync(
    path.join(root, '.tmp', 'agent-results', 'detail-001.json'),
    stableJson(envelopeResult(
      'semantic:data-model:detail-001',
      'data-model-detail-v1',
      detail,
      checkpoint(root, 'detail-001').inputFingerprint,
    )),
  );
  assert.throws(() => run({
    action: 'record-result', projectRoot: root, request: '.tmp/request.json',
    result: '.tmp/agent-results/detail-001.json', partitionId: 'detail-001',
  }), /topology result file changed after completion/);
});

test('all complete partition results merge to one compiler-ready semantic file', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(request(12000)));
  run({
    action: 'initialize', projectRoot: root, request: '.tmp/request.json', maxPayloadBytes: '40960',
  });
  const { topology, equipment, location, operation } = partitionResults();
  const topologyEnvelope = envelopeResult(
    'semantic:data-model:topology',
    'data-model-topology-v1',
    topology,
    checkpoint(root, 'topology').inputFingerprint,
  );
  fs.writeFileSync(
    path.join(root, '.tmp', 'agent-results', 'topology.json'),
    stableJson(topologyEnvelope),
  );
  run({
    action: 'expand-topology', projectRoot: root, request: '.tmp/request.json',
    result: '.tmp/agent-results/topology.json',
  });
  const state = JSON.parse(fs.readFileSync(
    path.join(root, '.tmp', 'data-model-partition-state.json'),
    'utf8',
  ));
  const entityById = new Map([[equipment.entityId, equipment], [location.entityId, location]]);
  for (const partition of state.partitions) {
    const value = {
      schemaVersion: 1,
      status: 'ready',
      partitionId: partition.partitionId,
      topologyHash: topologyHash(topology),
      entityIds: partition.entityIds,
      entities: partition.entityIds.map((entityId) => entityById.get(entityId)),
      operations: partition.entityIds.includes('entity:equipment') ? [operation] : [],
      assumptions: [], risks: [], concerns: [],
    };
    const relative = `.tmp/agent-results/${partition.partitionId}.json`;
    fs.writeFileSync(
      path.join(root, relative),
      stableJson(envelopeResult(
        partition.resultId,
        partition.resultType,
        value,
        partition.inputFingerprint,
      )),
    );
    run({
      action: 'record-result', projectRoot: root, request: '.tmp/request.json',
      result: relative, partitionId: partition.partitionId,
    });
  }
  const merged = run({
    action: 'merge', projectRoot: root, request: '.tmp/request.json',
  });
  assert.equal(merged.status, 'merged');
  const semantic = JSON.parse(fs.readFileSync(path.join(root, merged.output), 'utf8'));
  assert.equal(semantic.entities.length, 2);
  assert.equal(semantic.operations.length, 1);
  assert.notEqual(merged.semanticResultHash, state.topology.topologyHash);

  const completedState = JSON.parse(fs.readFileSync(
    path.join(root, '.tmp', 'data-model-partition-state.json'),
    'utf8',
  ));
  const locationResultHash = completedState.partitions.find(
    (partition) => partition.entityIds.includes('entity:location'),
  ).resultHash;
  const refreshedRequest = request(12000);
  refreshedRequest.attempt = 2;
  refreshedRequest.contextItems.find(
    (item) => item.contextItemId === 'evidence:equipment',
  ).detail.text = 'E'.repeat(12000);
  fs.writeFileSync(path.join(root, '.tmp', 'request.json'), stableJson(refreshedRequest));
  const refreshed = run({
    action: 'refresh-request', projectRoot: root, request: '.tmp/request.json',
  });
  assert.deepEqual(refreshed.invalidatedPartitionIds, ['detail-002']);
  assert.deepEqual(refreshed.completedPartitionIds, ['topology', 'detail-001']);
  assert.deepEqual(refreshed.pendingPartitionIds, ['detail-002']);
  assert.equal(checkpoint(root, 'detail-001').resultHash, locationResultHash);
  assert.equal(checkpoint(root, 'detail-002').status, 'pending');
});

test('pure merge never accepts an incomplete detail result map', () => {
  const initialized = initializeDataModelPartitionPlan(request(), {
    maxPayloadBytes: 64 * 1024,
    requestPath: '.tmp/request.json',
  });
  initialized.state.status = 'ready_to_merge';
  assert.throws(
    () => mergeCompletedDataModelPlan(
      initialized.state,
      initialized.request,
      new Map(),
    ),
    /single semantic result is missing/,
  );
});