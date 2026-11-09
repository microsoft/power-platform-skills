const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { safeReaddir } = require('../../skills/migrate-datamodel/scripts/snapshot-site');

test('missing optional snapshot directories remain empty', (t) => {
  t.mock.method(fs, 'readdirSync', () => {
    throw Object.assign(new Error('missing directory'), { code: 'ENOENT' });
  });
  assert.deepEqual(safeReaddir('missing'), []);
});

test('unreadable snapshot directories report errors rather than empty inventories', (t) => {
  t.mock.method(fs, 'readdirSync', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  assert.throws(() => safeReaddir('restricted'), /Could not read snapshot directory restricted: permission denied/);
});
