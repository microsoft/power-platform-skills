'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  MANIFEST_SCHEMA_VERSION,
  manifestResourceName,
  buildManifest,
  serializeManifest,
  parseManifest,
  parseManifestBase64,
  reconcilePageIds,
} = require(path.join(__dirname, '..', 'lib', 'page-manifest.js'));

// ---------- manifestResourceName ----------

test('manifestResourceName appends _pagemanifest to the app unique name', () => {
  assert.strictEqual(manifestResourceName('contoso_workorders'), 'contoso_workorders_pagemanifest');
});

// ---------- buildManifest ----------

test('buildManifest carries full page semantics keyed by key||name, omitting undefined fields', () => {
  const spec = {
    design: { theme: 'ocean' },
    pages: [
      {
        key: 'overview',
        name: 'Overview',
        purpose: 'At-a-glance',
        dataSources: ['contoso_wo'],
        navigatesTo: [{ targetKey: 'wo-detail', data: { id: 'string' } }],
        pageInput: { data: { id: 'string' } },
      },
      { name: 'Legacy' }, // no key → falls back to name; no optional fields → omitted
    ],
  };
  const m = buildManifest(spec, new Map([['overview', 'gp-1']]));
  assert.strictEqual(m.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.deepStrictEqual(m.design, { theme: 'ocean' });
  assert.deepStrictEqual(m.pages[0], {
    key: 'overview',
    name: 'Overview',
    pageId: 'gp-1',
    purpose: 'At-a-glance',
    dataSources: ['contoso_wo'],
    navigatesTo: [{ targetKey: 'wo-detail', data: { id: 'string' } }],
    pageInput: { data: { id: 'string' } },
  });
  assert.deepStrictEqual(m.pages[1], { key: 'Legacy', name: 'Legacy' });
});

// ---------- serializeManifest / parseManifest round-trip ----------

test('serializeManifest then parseManifest round-trips', () => {
  const m = buildManifest({ pages: [{ key: 'a', name: 'A' }] }, new Map());
  assert.deepStrictEqual(parseManifest(serializeManifest(m)), m);
});

// ---------- parseManifest: structure ----------

test('parseManifest is fail-closed on structure: bad JSON / wrong schemaVersion / non-array pages / missing version', () => {
  assert.strictEqual(parseManifest('not json{'), null);
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 999, pages: [] })), null);
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: 'x' })), null);
  assert.strictEqual(parseManifest(JSON.stringify({ pages: [] })), null);
});

// ---------- parseManifest: page schema (plan + addendum I5) ----------

test('parseManifest is fail-closed on page schema: missing key/name, duplicate key, malformed optional (I5)', () => {
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ name: 'NoKey' }] })), null);
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a' }] })), null); // no name
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A' }, { key: 'a', name: 'A2' }] })), null); // duplicate key
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', dataSources: 'x' }] })), null); // dataSources not array
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', navigatesTo: 'x' }] })), null); // navigatesTo not array
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', pageInput: [] }] })), null); // pageInput not object
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', pageId: '' }] })), null); // empty pageId
});

// ---- addendum I5: per-element dataSources validation ----

test('parseManifest REJECTS a non-string dataSources element (addendum I5)', () => {
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', dataSources: [123] }] })),
    null, 'number element',
  );
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', dataSources: [null] }] })),
    null, 'null element',
  );
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', dataSources: [{}] }] })),
    null, 'object element',
  );
});

// ---- addendum I5: per-entry navigatesTo validation ----

test('parseManifest REJECTS a malformed navigatesTo entry (addendum I5)', () => {
  // missing targetKey
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', navigatesTo: [{}] }] })),
    null, 'no targetKey',
  );
  // targetKey not a string
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', navigatesTo: [{ targetKey: 123 }] }] })),
    null, 'targetKey number',
  );
  // data present but not a plain object
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', navigatesTo: [{ targetKey: 'x', data: 'bad' }] }] })),
    null, 'data string',
  );
  // data is an array (not a plain object)
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', navigatesTo: [{ targetKey: 'x', data: [] }] }] })),
    null, 'data array',
  );
});

// ---- addendum I5: key grammar ----

test('parseManifest REJECTS a bad key grammar (addendum I5)', () => {
  // uppercase — grammar is lowercase alphanumeric + hyphens only
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'Overview', name: 'A' }] })), null, 'uppercase',
  );
  // underscore not allowed
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'wo_detail', name: 'A' }] })), null, 'underscore',
  );
  // must not start with dash
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: '-lead', name: 'A' }] })), null, 'leading dash',
  );
  // must not end with dash
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'lead-', name: 'A' }] })), null, 'trailing dash',
  );
  // space not allowed
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a b', name: 'A' }] })), null, 'space',
  );
});

// ---- addendum I5: purpose type ----

test('parseManifest REJECTS a non-string purpose field (addendum I5)', () => {
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', purpose: 123 }] })),
    null, 'number purpose',
  );
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', purpose: {} }] })),
    null, 'object purpose',
  );
});

// ---- addendum I5: source discriminated validation ----

test('parseManifest REJECTS a malformed source field (addendum I5)', () => {
  // source is not an object
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', source: 'tsx' }] })),
    null, 'source string',
  );
  // source.kind not recognized
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', source: { kind: 'bad' } }] })),
    null, 'bad kind',
  );
  // kind:tsx without a codeFile
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', source: { kind: 'tsx' } }] })),
    null, 'tsx no codeFile',
  );
});

test('parseManifest ACCEPTS valid source shapes (addendum I5)', () => {
  assert.notStrictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', source: { kind: 'intent' } }] })),
    null, 'intent shape',
  );
  assert.notStrictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', source: { kind: 'tsx', codeFile: 'pages/a.tsx' } }] })),
    null, 'tsx shape',
  );
});

// ---- addendum I5: top-level design ----

test('parseManifest REJECTS an invalid top-level design field (addendum I5)', () => {
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [], design: 'string' })),
    null, 'design string',
  );
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [], design: [] })),
    null, 'design array',
  );
  assert.strictEqual(
    parseManifest(JSON.stringify({ schemaVersion: 1, pages: [], design: null })),
    null, 'design null',
  );
});

// ---------- parseManifestBase64 ----------

test('parseManifestBase64 decodes then parses (fail-closed on garbage)', () => {
  const m = buildManifest({ pages: [{ key: 'a', name: 'A' }] }, new Map());
  const b64 = Buffer.from(serializeManifest(m), 'utf8').toString('base64');
  assert.deepStrictEqual(parseManifestBase64(b64), m);
  assert.strictEqual(parseManifestBase64('@@ not base64 json @@'), null);
});

// ---------- reconcilePageIds (4-arg: pages, manifest, existenceIds, sitemapIds) ----------
// Three-authority + provenance model (C3, Task 4): spec pageId (provenance-gated), manifest id
// (existence-confirmed, crash-safe), absent (create). No name-based lookup.
// Returns { keyToId, absentKeys, conflicts }.

const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_D = '5c0a4889-45fd-46ea-91a8-ff876914d644';
const MAN_2 = {
  schemaVersion: 1,
  pages: [
    { key: 'overview', name: 'Overview', pageId: GP_O },
    { key: 'order-detail', name: 'Order Detail', pageId: GP_D },
  ],
};

// (f) manifest id ∈ existenceIds → reuse (C1) — case-insensitive match
test('reconcilePageIds: manifest id ∈ existence → reuse (C1)', () => {
  const pages = [{ key: 'overview', name: 'Overview' }, { key: 'order-detail', name: 'Order Detail' }];
  const { keyToId, absentKeys, conflicts } = reconcilePageIds(pages, MAN_2, [GP_O.toUpperCase(), GP_D], []);
  assert.strictEqual(keyToId.get('overview'), GP_O);
  assert.strictEqual(keyToId.get('order-detail'), GP_D);
  assert.deepStrictEqual(absentKeys, []);
  assert.deepStrictEqual(conflicts, []);
});

// Crash-safety (C1): manifest id ∈ existence but NOT yet in sitemap (finalizer died) → reuse, not re-create
test('reconcilePageIds: crash-safety — manifest id in existence but not in sitemap → reused (C1)', () => {
  const { keyToId, absentKeys } = reconcilePageIds(
    [{ key: 'overview', name: 'Overview' }], MAN_2, [GP_O], [],
  );
  assert.strictEqual(keyToId.get('overview'), GP_O, 'reused from existence — not re-created');
  assert.deepStrictEqual(absentKeys, []);
});

// (g) manifest id NOT in existenceIds → absent (crash-safe / deleted in Maker)
test('reconcilePageIds: manifest id NOT in existence → absent (create)', () => {
  const { keyToId, absentKeys } = reconcilePageIds(
    [{ key: 'overview', name: 'Overview' }], MAN_2, [], [],
  );
  assert.strictEqual(keyToId.has('overview'), false);
  assert.deepStrictEqual(absentKeys, ['overview']);
});

// No manifest + no spec pageId → absent (no name lookup in the new implementation)
test('reconcilePageIds: no manifest, no spec pageId → absent', () => {
  const { absentKeys } = reconcilePageIds([{ key: 'new', name: 'New' }], null, [], []);
  assert.deepStrictEqual(absentKeys, ['new']);
});

// (a) spec pageId ∈ sitemapIds → binds (edit-snapshot adoption, ownership proven by membership)
test('reconcilePageIds: spec pageId ∈ sitemapIds → binds (edit-snapshot adoption, C3)', () => {
  const STRAY = 'aabbccdd-1234-4567-89ab-ccddeeff0011';
  const { keyToId, conflicts } = reconcilePageIds(
    [{ key: 'overview', name: 'Overview', pageId: STRAY }],
    null, [STRAY], [STRAY],
  );
  assert.strictEqual(keyToId.get('overview'), STRAY);
  assert.deepStrictEqual(conflicts, []);
});

// (b) spec pageId === manifest id → binds (manifest agreement — consistent edit-snapshot)
test('reconcilePageIds: spec pageId === manifest id → binds (manifest agreement, C3)', () => {
  const { keyToId, conflicts } = reconcilePageIds(
    [{ key: 'overview', name: 'Overview', pageId: GP_O }],
    MAN_2, [GP_O], [],
  );
  assert.strictEqual(keyToId.get('overview'), GP_O);
  assert.deepStrictEqual(conflicts, []);
});

// (c) spec pageId ∈ existence but NOT in sitemap, != stale manifest id → unprovenanced → NOT bound
test('reconcilePageIds: unprovenanced spec pageId (∈ existence, not in sitemap, != stale manId) → NOT bound, falls to absent', () => {
  const STRAY = 'aabbccdd-1234-4567-89ab-ccddeeff0011';
  // GP_D is the manifest id for 'overview' in MAN_STALE; it is stale (not in existenceIds).
  // STRAY is live env-wide but is NOT in this app's sitemap and != GP_D → unprovenanced.
  const MAN_STALE = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_D }] };
  const { keyToId, absentKeys, conflicts } = reconcilePageIds(
    [{ key: 'overview', name: 'Overview', pageId: STRAY }],
    MAN_STALE, [STRAY], [],
  );
  assert.notStrictEqual(keyToId.get('overview'), STRAY, 'stray id must NOT be bound');
  assert.deepStrictEqual(absentKeys, ['overview'], 'falls to absent — manifest id is also stale');
  assert.deepStrictEqual(conflicts, []);
});

// Stale spec pageId (not in existenceIds) falls through to the manifest
test('reconcilePageIds: stale spec pageId (not in existence) falls through to manifest', () => {
  const STALE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const { keyToId } = reconcilePageIds(
    [{ key: 'overview', name: 'Overview', pageId: STALE }],
    MAN_2, [GP_O], [],
  );
  assert.strictEqual(keyToId.get('overview'), GP_O, 'manifest id wins when spec id is stale');
});

// (d) spec pageId != manifest id, BOTH live → spec-manifest-disagree conflict (C3)
test('reconcilePageIds: spec pageId != manifest id, both live → spec-manifest-disagree conflict (C3)', () => {
  // spec says GP_D for key 'overview'; MAN_2 says GP_O for key 'overview'; BOTH are in existence
  const { keyToId, conflicts } = reconcilePageIds(
    [{ key: 'overview', name: 'Overview', pageId: GP_D }],
    MAN_2, [GP_O, GP_D], [],
  );
  assert.strictEqual(keyToId.has('overview'), false, 'must NOT bind when identities disagree');
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].reason, 'spec-manifest-disagree');
  assert.strictEqual(conflicts[0].key, 'overview');
  assert.strictEqual(conflicts[0].pageId, GP_D);
  assert.strictEqual(conflicts[0].manifestId, GP_O);
});

// (e) spec pageId not a valid 36-char GUID → invalid-pageid conflict
test('reconcilePageIds: spec pageId not a GUID → invalid-pageid conflict', () => {
  const { keyToId, conflicts } = reconcilePageIds(
    [{ key: 'overview', name: 'Overview', pageId: 'not-a-guid' }],
    null, [], [],
  );
  assert.strictEqual(keyToId.has('overview'), false, 'must NOT bind an invalid-format pageId');
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].reason, 'invalid-pageid');
  assert.strictEqual(conflicts[0].key, 'overview');
  assert.strictEqual(conflicts[0].pageId, 'not-a-guid');
});

// (h) two distinct keys resolving to the same live id → 1:1 identity conflict
test('reconcilePageIds: two keys → one live id → 1:1 identity conflict', () => {
  const pages = [
    { key: 'a', name: 'A', pageId: GP_O },
    { key: 'b', name: 'B', pageId: GP_O },
  ];
  // GP_O is in sitemap → both bind via provenance (proven this app's page); 1:1 guard then fires
  const { conflicts } = reconcilePageIds(pages, null, [GP_O], [GP_O]);
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].pageId, GP_O);
  assert.deepStrictEqual(conflicts[0].keys.sort(), ['a', 'b']);
});

// (i) parseManifest rejects duplicate pageIds (Imp11 — 1:1 key↔id identity, case-insensitive)
test('parseManifest REJECTS two keys mapping to the same pageId (case-insensitive, Imp11)', () => {
  const dup = JSON.stringify({
    schemaVersion: 1,
    pages: [
      { key: 'a', name: 'A', pageId: GP_O },
      { key: 'b', name: 'B', pageId: GP_O.toUpperCase() },
    ],
  });
  assert.strictEqual(parseManifest(dup), null);
});

// The manifest is a STORED artifact — it lives in the solution and can be edited, truncated or
// produced by an older build. Parsing it loosely defeats the point of parsing it at all: a
// `directEntry` whose behavior is bogus would round-trip into a rebuild and fail App Spec
// validation there, far from its cause. Reject it here instead.
test('parseManifest rejects a directEntry whose behavior is not a legal value', () => {
  const good = {
    schemaVersion: 1,
    pages: [{ key: 'detail', name: 'Detail', pageId: '11111111-1111-1111-1111-111111111111',
      pageInput: { data: { orderId: 'string' } }, directEntry: { behavior: 'selector' } }],
  };
  assert.ok(parseManifest(JSON.stringify(good)), 'a legal behavior parses');

  for (const behavior of ['shrug', '', null, 123, undefined]) {
    const bad = JSON.parse(JSON.stringify(good));
    bad.pages[0].directEntry = behavior === undefined ? {} : { behavior };
    assert.strictEqual(parseManifest(JSON.stringify(bad)), null,
      `directEntry.behavior=${JSON.stringify(behavior)} must be rejected whole`);
  }

  // Both legal behaviours parse, and an absent directEntry is still fine (only pages with
  // pageInput are required to carry one, and that rule lives in App Spec validation).
  for (const behavior of ['selector', 'emptyState']) {
    const ok = JSON.parse(JSON.stringify(good));
    ok.pages[0].directEntry = { behavior };
    assert.ok(parseManifest(JSON.stringify(ok)), behavior + ' must parse');
  }
  const noDe = JSON.parse(JSON.stringify(good));
  delete noDe.pages[0].directEntry;
  delete noDe.pages[0].pageInput;
  assert.ok(parseManifest(JSON.stringify(noDe)), 'a page with neither field parses');
});
