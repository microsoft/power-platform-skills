'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  DEFAULT_FIXTURE_DIR,
  loadFixtures,
  validateFixture,
} = require('../validate-push-flow-fixtures');

const SCRIPT = path.join(__dirname, '..', 'validate-push-flow-fixtures.js');

test('all sanitized fixtures produce exactly their intended reasons', () => {
  const loaded = loadFixtures();
  assert.strictEqual(loaded.length, 15);

  for (const { fixturePath, fixture } of loaded) {
    assert.deepStrictEqual(
      validateFixture(fixture),
      [...fixture.expected.reasons].sort(),
      path.basename(fixturePath),
    );
  }
});

test('the valid Dataverse fixture passes without findings', () => {
  const valid = loadFixtures().find(({ fixture }) => fixture.expected.valid);
  assert.ok(valid);
  assert.deepStrictEqual(validateFixture(valid.fixture), []);
});

test('the fixture validator runs deterministically without network access', () => {
  const result = spawnSync(process.execPath, [SCRIPT, DEFAULT_FIXTURE_DIR], {
    encoding: 'utf8',
    env: {
      PATH: '',
    },
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout.trim().split('\n').length, 15);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\/|token|secret/i);
});

test('malformed Function actions and hosts return findings instead of throwing', () => {
  const fixture = loadFixtures().find(
    ({ fixture: candidate }) => candidate.name === 'malformed Function invocation action and host',
  ).fixture;

  assert.doesNotThrow(() => validateFixture(fixture));
  assert.deepStrictEqual(validateFixture(fixture), [...fixture.expected.reasons].sort());

  const malformedAction = structuredClone(fixture);
  malformedAction.requested.definition.actions.Invoke_FCM_Sender_Function = null;
  assert.ok(validateFixture(malformedAction).includes('function-invoke-action-must-be-object'));

  for (const [inputs, expected] of [
    [null, 'function-invoke-inputs-must-be-object'],
    [{ host: {} }, 'function-operation-id-required'],
    [{ host: { operationId: 'InvokeEntraProtectedFunction' } }, 'function-connection-reference-required'],
  ]) {
    const candidate = structuredClone(fixture);
    const action = candidate.requested.definition.actions.Invoke_FCM_Sender_Function;
    action.type = 'OpenApiConnection';
    action.inputs = inputs;
    assert.doesNotThrow(() => validateFixture(candidate));
    assert.ok(validateFixture(candidate).includes(expected));
  }
});

test('both sender modes pass only with their own secure action tree and connection', () => {
  const loaded = loadFixtures();
  const wif = loaded.find(({ fixture }) => fixture.name === 'valid WIF sender action tree');
  const endpoint = loaded.find(
    ({ fixture }) => fixture.name === 'valid Function endpoint sender action tree',
  );
  const invalid = loaded.filter(({ fixture }) => fixture.name.includes('fallback')
    || fixture.name.includes('wrong operation'));

  assert.deepStrictEqual(validateFixture(wif.fixture), []);
  assert.deepStrictEqual(validateFixture(endpoint.fixture), []);
  assert.strictEqual(invalid.length, 2);
  for (const { fixture } of invalid) {
    assert.notDeepStrictEqual(validateFixture(fixture), []);
  }
});
