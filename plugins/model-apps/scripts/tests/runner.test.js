const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const registry = require(path.join(__dirname, '..', 'steps', 'registry.js'));

test('registry lists the 8 ordered steps with run/verify/rollback', () => {
  const ids = registry.map((s) => s.id);
  assert.deepStrictEqual(ids, [
    'data-model', 'publish-entities', 'sample-data', 'views',
    'charts', 'forms', 'app-shell', 'publish',
  ]);
  for (const s of registry) {
    assert.strictEqual(typeof s.run, 'function');
    assert.strictEqual(typeof s.title, 'string');
    assert.strictEqual(typeof s.verify, 'function');
    assert.strictEqual(typeof s.rollback, 'function');
  }
});
