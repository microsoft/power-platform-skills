import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertModelSupport, evaluationMatrix, validateModelPair } from '../models.mjs';

test('default matrix pairs each evaluated model with a different medium-effort judge', () => {
  const matrix = evaluationMatrix({ skills: ['create-site', 'setup-auth'] });
  assert.equal(matrix.length, 8);
  assert.deepEqual(matrix.filter(item => item.skill === 'create-site').map(item => [item.model, item.judgeModel]), [
    ['claude-opus-4.8', 'gpt-6.1-sol'],
    ['claude-sonnet-5.5', 'claude-opus-4.8'],
    ['gpt-6-sol', 'claude-opus-4.8'],
    ['gpt-6.1-sol', 'claude-opus-4.8'],
  ]);
  for (const item of matrix) {
    assert.notEqual(item.model, item.judgeModel);
    assert.equal(item.reasoningEffort, 'medium');
    assert.equal(item.judgeReasoningEffort, 'medium');
  }
  const overridden = evaluationMatrix({
    skills: ['create-site'], models: 'test-agent-a, test-agent-b', judgeModel: 'test-judge',
    reasoningEffort: 'high', judgeReasoningEffort: 'low',
  });
  assert.deepEqual(overridden.map(item => [item.model, item.judgeModel, item.reasoningEffort, item.judgeReasoningEffort]),
    [['test-agent-a', 'test-judge', 'high', 'low'], ['test-agent-b', 'test-judge', 'high', 'low']]);
  assert.throws(() => evaluationMatrix({ skills: ['create-site'], models: 'a,a' }), /Duplicate/);
  assert.throws(() => evaluationMatrix({ skills: ['create-site'], models: 'a', judgeModel: 'a' }), /different model/);
  assert.throws(() => validateModelPair({ model: 'auto', judgeModel: 'other' }), /explicit model/);
  assert.throws(() => evaluationMatrix({ skills: ['create-site'], reasoningEffort: 'invalid' }), /reasoning effort/);
});

test('unsupported and disabled model/effort choices fail before inference', () => {
  const model = {
    id: 'test-model', capabilities: { supports: { reasoningEffort: true } },
    supportedReasoningEfforts: ['medium', 'high'],
  };
  assert.doesNotThrow(() => assertModelSupport([model], 'test-model', 'medium'));
  assert.throws(() => assertModelSupport([model], 'test-model', 'max'), /does not support/);
  assert.throws(() => assertModelSupport([model], 'missing', 'medium'), /unavailable/);
  assert.throws(() => assertModelSupport([{ ...model, policy: { state: 'disabled' } }], 'test-model', 'medium'), /unavailable/);
});
