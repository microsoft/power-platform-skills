'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  dependencyOrder,
  measureSealedWorkOrder,
  partitionByPayloadBudget,
  resolveMaxPayloadBytes,
  utf8ByteLength,
} = require('../lib/agent-payload-budget');

function workOrderFor(items, partitionId) {
  return {
    schemaVersion: 1,
    agent: 'data-model-architect',
    workOrderId: `planning:data-model:${partitionId}`,
    attempt: 1,
    context: { items: items.map((item) => ({ id: item.id, content: item.content })) },
    artifacts: [],
    result: { resultId: partitionId, resultType: 'data-model-detail-v1' },
  };
}

test('UTF-8 measurement counts serialized multibyte content exactly', () => {
  const value = 'caf\u00e9';
  assert.equal(utf8ByteLength('ASCII'), 5);
  assert.equal(utf8ByteLength(value), 5);
  assert.equal(
    utf8ByteLength({ value }),
    Buffer.byteLength(`${JSON.stringify({ value }, null, 2)}\n`, 'utf8'),
  );
});

test('sealed work-order measurement includes its deterministic fingerprint', () => {
  const first = measureSealedWorkOrder(workOrderFor([
    { id: 'entity:a', content: 'one' },
  ], 'detail-001'));
  const second = measureSealedWorkOrder(workOrderFor([
    { id: 'entity:a', content: 'one' },
  ], 'detail-001'));
  assert.match(first.sealedWorkOrder.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.payloadBytes, utf8ByteLength(first.sealedWorkOrder));
  assert.deepEqual(first, second);
});

test('dependency order and packing are deterministic across input ordering', () => {
  const items = [
    { id: 'entity:child', dependsOn: ['entity:parent'], content: 'c'.repeat(6000) },
    { id: 'entity:reference', dependsOn: [], content: 'r'.repeat(6000) },
    { id: 'entity:parent', dependsOn: [], content: 'p'.repeat(6000) },
  ];
  assert.deepEqual(
    dependencyOrder(items).map((item) => item.id),
    ['entity:parent', 'entity:child', 'entity:reference'],
  );
  const options = { maxPayloadBytes: 8500, buildWorkOrder: workOrderFor };
  const first = partitionByPayloadBudget(items, options);
  const second = partitionByPayloadBudget([...items].reverse(), options);
  assert.deepEqual(
    first.partitions.map((partition) => partition.itemIds),
    second.partitions.map((partition) => partition.itemIds),
  );
  assert.deepEqual(first.partitions.flatMap((partition) => partition.itemIds), [
    'entity:parent',
    'entity:child',
    'entity:reference',
  ]);
  assert.equal(first.partitions.every((partition) => partition.payloadBytes <= 8500), true);
});

test('packing fails instead of dropping an indivisible over-budget item', () => {
  assert.throws(() => partitionByPayloadBudget([
    { id: 'entity:large', dependsOn: [], content: 'x'.repeat(9000) },
  ], {
    maxPayloadBytes: 8192,
    buildWorkOrder: workOrderFor,
  }), /entity:large requires \d+ bytes, exceeding the 8192-byte payload budget/);
});

test('dependency validation rejects unknown edges and cycles', () => {
  assert.throws(() => dependencyOrder([
    { id: 'entity:a', dependsOn: ['entity:missing'] },
  ]), /unknown dependency/);
  assert.throws(() => dependencyOrder([
    { id: 'entity:a', dependsOn: ['entity:b'] },
    { id: 'entity:b', dependsOn: ['entity:a'] },
  ]), /dependency cycle detected/);
});

test('payload budget accepts defaults and rejects unsafe values', () => {
  assert.equal(resolveMaxPayloadBytes(undefined), 64 * 1024);
  assert.equal(resolveMaxPayloadBytes('32768'), 32768);
  assert.throws(() => resolveMaxPayloadBytes('4096'), /at least 8192/);
});