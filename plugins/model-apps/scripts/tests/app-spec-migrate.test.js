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

// #545 Case 1 regression. A spec may declare schemaVersion 2 on each PAGE (and carry hand-authored
// stable keys and key-based refs) while omitting the TOP-LEVEL schemaVersion. Migration then runs,
// and pass 1 used to mint `p.key = slugify(p.name)` UNCONDITIONALLY — overwriting the author's keys.
// The refs are keys, not names, so pass 2 left them pointing at the now-discarded keys, and
// validateAppSpec reported one "not a known page key" / "unknown page" error per page, none of
// which named the real cause. Adding the top-level schemaVersion "fixed" it only because that made
// migration a no-op. An authored key must survive migration.
test('#545: preserves hand-authored page keys when only the top-level schemaVersion is missing', () => {
  const authored = {
    solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' },
    entities: [{ schemaName: 'c_order', primaryAttribute: { schemaName: 'c_name' }, columns: [] }],
    pages: [
      // Keys deliberately DIFFER from slugify(name), which is what makes the clobber observable.
      { schemaVersion: 2, key: 'orders', name: 'All Open Orders', source: { kind: 'tsx', codeFile: 'orders.tsx' }, navigatesTo: [{ targetKey: 'order-card' }] },
      { schemaVersion: 2, key: 'order-card', name: 'Order Details View', source: { kind: 'tsx', codeFile: 'card.tsx' } },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [{ title: 'Orders', page: 'orders' }, { title: 'Card', page: 'order-card' }] }] }] },
  };
  const m = migrateAppSpec(authored);
  assert.strictEqual(m.schemaVersion, 2);
  assert.strictEqual(m.pages[0].key, 'orders', 'authored key survives migration (not re-slugged from the name)');
  assert.strictEqual(m.pages[1].key, 'order-card');
  assert.strictEqual(m.pages[0].navigatesTo[0].targetKey, 'order-card', 'key-based navigatesTo still resolves');
  assert.deepStrictEqual(m.appShell.areas[0].groups[0].subAreas.map((s) => s.page), ['orders', 'order-card']);
  const r = validateAppSpec(m);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

// Mixed spec: some pages carry an authored key, others do not. Every authored key must be RESERVED
// before any key is minted, or a minted slug can collide with an authored key declared later and
// silently steal it.
test('#545: mints only for keyless pages, and never mints over a later authored key', () => {
  const authored = {
    solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [],
    pages: [
      { name: 'Orders', source: { kind: 'intent' } },                          // keyless -> slug would be 'orders'
      { key: 'orders', name: 'Legacy Orders', source: { kind: 'intent' } },     // authored 'orders' declared LATER
    ],
  };
  const m = migrateAppSpec(authored);
  assert.strictEqual(m.pages[1].key, 'orders', 'the authored key wins');
  assert.strictEqual(m.pages[0].key, 'orders-2', 'the minted key yields to the reserved authored key');
});

// An authored key that violates the key grammar must NOT be silently replaced: validateAppSpec
// reports it by name, which is a message the author can act on. Silently re-slugging it would
// resurrect the same dangling-reference failure this fix exists to remove.
test('#545: a malformed authored key is preserved so validation can name it', () => {
  const authored = {
    solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [],
    pages: [{ key: 'Not A Slug', name: 'Orders', source: { kind: 'intent' } }],
  };
  const m = migrateAppSpec(authored);
  assert.strictEqual(m.pages[0].key, 'Not A Slug');
  const r = validateAppSpec(m);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Not A Slug') && e.includes('invalid key grammar')), JSON.stringify(r.errors));
});

// Review finding on the #545 fix. Once authored keys survive migration, a reference can legitimately
// already BE a key — and a spec may hold a page whose authored key equals a DIFFERENT page's name.
// Rewriting name-first silently retargets the reference to the other page AND still validates,
// because the substituted value is itself a valid key. An exact key match must win.
test('#545: an authored key that equals another page\'s name is not retargeted by the name rewrite', () => {
  const authored = {
    solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [],
    pages: [
      { key: 'orders', name: 'All Orders', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'orders' }] },
      { key: 'report', name: 'orders', source: { kind: 'intent' } },
    ],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'M', subAreas: [{ title: 'O', page: 'orders' }] }] }] },
  };
  const m = migrateAppSpec(authored);
  assert.strictEqual(m.pages[0].navigatesTo[0].targetKey, 'orders', "the key ref stays on the page that OWNS the key, not the page NAMED 'orders'");
  assert.strictEqual(m.appShell.areas[0].groups[0].subAreas[0].page, 'orders');
});

// Review finding. The key-first rewrite must key off AUTHORED keys, not every final key. A MINTED
// key is derived from a name, so it collides with a different page's name by construction: pages
// "All Orders" and "all-orders" mint 'all-orders' and 'all-orders-2'. Treating a minted key as
// authoritative left a legacy name-ref to the SECOND page pointing at the first.
test('#545: a legacy name-ref is still resolved by name when the match is a MINTED key', () => {
  const legacy = {
    solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [],
    pages: [
      { name: 'All Orders', codeFile: 'a.tsx' },
      { name: 'all-orders', codeFile: 'b.tsx', navigatesTo: [{ targetKey: 'all-orders' }] },
    ],
  };
  const m = migrateAppSpec(legacy);
  assert.deepStrictEqual(m.pages.map((p) => p.key), ['all-orders', 'all-orders-2']);
  assert.strictEqual(m.pages[1].navigatesTo[0].targetKey, 'all-orders-2',
    'the name-ref names the SECOND page; a minted key must not capture it');
});

// Review finding. A key the author WROTE but got wrong must reach validation unchanged. Minting
// over it silently repairs a typo the author needs to see — and contradicts the preservation this
// pass documents. Only a page with no `key` property at all gets one minted.
test('#545: a present-but-malformed key is preserved verbatim for validation to name', () => {
  for (const key of [42, '', '   ', null]) {
    const s = { solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [], pages: [{ key, name: 'Orders', source: { kind: 'intent' } }] };
    const m = migrateAppSpec(s);
    assert.deepStrictEqual(m.pages[0].key, key, `key ${JSON.stringify(key)} must survive migration`);
    const r = validateAppSpec(m, { profile: 'plan' });
    assert.ok(r.errors.some((e) => /stable key|invalid key grammar/.test(e)),
      `validation must name the key problem for ${JSON.stringify(key)}: ${JSON.stringify(r.errors)}`);
  }
  // ...while a page with NO key property still gets one minted, as before.
  const s = { solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' }, entities: [], pages: [{ name: 'Orders', source: { kind: 'intent' } }] };
  assert.strictEqual(migrateAppSpec(s).pages[0].key, 'orders');
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
