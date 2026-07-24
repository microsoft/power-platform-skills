const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { migrateAppSpec, validateAppSpec } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

test('migrates a legacy (name-referenced, top-level codeFile) spec to schemaVersion 2', () => {
  const legacy = {
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Contoso' },
    entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    pages: [{ name: 'Sales Overview', codeFile: 'sales.tsx' }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [{ title: 'Sales Overview', page: 'Sales Overview' }] }] }] },
  };
  const m = migrateAppSpec(legacy);
  assert.strictEqual(m.schemaVersion, 2);
  assert.strictEqual(m.pages[0].key, 'sales-overview');
  assert.deepStrictEqual(m.pages[0].source, { kind: 'tsx', codeFile: 'sales.tsx' });
  // appShell page subarea rewritten name -> key
  assert.strictEqual(m.appShell.areas[0].groups[0].subAreas[0].page, 'sales-overview');
  // The migrated spec passes deploy validation.
  assert.strictEqual(validateAppSpec(m).ok, true, JSON.stringify(validateAppSpec(m).errors));
});

test('de-duplicates keys minted from colliding names', () => {
  const legacy = {
    solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [],
    pages: [{ name: 'Overview', codeFile: 'a.tsx' }, { name: 'Overview', codeFile: 'b.tsx' }],
  };
  const m = migrateAppSpec(legacy);
  assert.strictEqual(m.pages[0].key, 'overview');
  assert.strictEqual(m.pages[1].key, 'overview-2');
});

test('is idempotent for a schemaVersion 2 spec (returns it unchanged)', () => {
  const v2 = { schemaVersion: 2, solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [], pages: [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }] };
  assert.deepStrictEqual(migrateAppSpec(v2), v2);
});

test('does not mutate its input', () => {
  const legacy = { solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [], pages: [{ name: 'Overview', codeFile: 'a.tsx' }] };
  const before = JSON.stringify(legacy);
  migrateAppSpec(legacy);
  assert.strictEqual(JSON.stringify(legacy), before);
});
