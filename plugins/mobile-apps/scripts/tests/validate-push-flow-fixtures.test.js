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
  assert.strictEqual(loaded.length, 12);

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
  assert.strictEqual(result.stdout.trim().split('\n').length, 12);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\/|token|secret/i);
});

test('WIF passes only with its secure action tree and no fallback', () => {
  const loaded = loadFixtures();
  const wif = loaded.find(({ fixture }) => fixture.name === 'valid WIF sender action tree');
  const invalid = loaded.filter(({ fixture }) => fixture.name.includes('fallback'));

  assert.deepStrictEqual(validateFixture(wif.fixture), []);
  assert.strictEqual(invalid.length, 1);
  for (const { fixture } of invalid) {
    assert.notDeepStrictEqual(validateFixture(fixture), []);
  }
});
