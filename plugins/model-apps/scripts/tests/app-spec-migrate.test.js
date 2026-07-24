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

test('rewrites navigatesTo.targetKey name -> key (forward and backward reference)', () => {
  const legacy = {
    solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [],
    pages: [
      { name: 'Alpha', codeFile: 'alpha.tsx', navigatesTo: [{ targetKey: 'Beta' }] },  // forward ref (Beta declared later)
      { name: 'Beta', codeFile: 'beta.tsx', navigatesTo: [{ targetKey: 'Alpha' }] },    // backward ref
    ],
  };
  const m = migrateAppSpec(legacy);
  assert.strictEqual(m.pages[0].key, 'alpha');
  assert.strictEqual(m.pages[1].key, 'beta');
  assert.strictEqual(m.pages[0].navigatesTo[0].targetKey, 'beta');  // Alpha -> Beta (forward ref resolves via 2nd pass)
  assert.strictEqual(m.pages[1].navigatesTo[0].targetKey, 'alpha'); // Beta -> Alpha (backward ref)
});

test('mints a fallback key for a page with a blank name', () => {
  const legacy = { solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [], pages: [{ name: '', codeFile: 'a.tsx' }] };
  assert.strictEqual(migrateAppSpec(legacy).pages[0].key, 'page');
});

// IMPORTANT #2 regression: a navigatesTo name-ref whose target name collides with a minted key
// for a DIFFERENT page must resolve to the correct (first) page and not be double-rewritten.
//
// Scenario: page "Detail" (key: "detail") and page "detail" (key: "detail-2", because "detail"
// is already taken). A navigatesTo with targetKey: "Detail" must become "detail" (the first
// page's key). The old two-pass code re-applied nameToKey in pass 2: it found the already-
// rewritten "detail" in the map (it's also the NAME of the second page) and wrongly mapped it
// to "detail-2".
test('collision: navigatesTo name-ref to "Detail" resolves to "detail" (first page), not "detail-2"', () => {
  const legacy = {
    solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [],
    pages: [
      { name: 'Detail', codeFile: 'detail-1.tsx' },                          // key: "detail"
      { name: 'detail', codeFile: 'detail-2.tsx',                            // key: "detail-2" (collision dedup)
        navigatesTo: [{ targetKey: 'Detail' }] },                             // name-ref to the FIRST page
    ],
  };
  const m = migrateAppSpec(legacy);
  assert.strictEqual(m.pages[0].key, 'detail',   'first page gets "detail"');
  assert.strictEqual(m.pages[1].key, 'detail-2', 'second page gets "detail-2" (dedup)');
  // The name-ref "Detail" should resolve to "detail" (the first page), not "detail-2".
  assert.strictEqual(m.pages[1].navigatesTo[0].targetKey, 'detail',
    'name-ref to first page stays "detail" after migration — not re-mapped to "detail-2"');
});
