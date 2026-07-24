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

// ---------- reconcilePageIds ----------

test('reconcilePageIds: manifest key->id CONFIRMED LIVE wins over a different page with the same display name (C5)', () => {
  const pages = [{ key: 'overview', name: 'Overview' }];
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'A' }] };
  // live has the confirmed page (id A, now renamed) AND a different page also named 'Overview' (id B)
  const live = [{ pageId: 'A', name: 'Renamed In Maker' }, { pageId: 'B', name: 'Overview' }];
  const { keyToId, absentKeys, ambiguous } = reconcilePageIds(pages, manifest, live);
  assert.strictEqual(keyToId.get('overview'), 'A');
  assert.deepStrictEqual(absentKeys, []);
  assert.deepStrictEqual(ambiguous, []);
});

test('reconcilePageIds: a manifest id NOT present in live falls back to the unique live name-match (stale imported id)', () => {
  const pages = [{ key: 'overview', name: 'Overview' }];
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'imported-from-other-env' }] };
  const live = [{ pageId: 'live-id', name: 'Overview' }];
  const { keyToId, absentKeys } = reconcilePageIds(pages, manifest, live);
  assert.strictEqual(keyToId.get('overview'), 'live-id');
  assert.deepStrictEqual(absentKeys, []);
});

test('reconcilePageIds: app-only page (no manifest) adopts the unique live name-match', () => {
  const { keyToId, absentKeys } = reconcilePageIds(
    [{ key: 'overview', name: 'Overview' }],
    null,
    [{ pageId: 'live-id', name: 'Overview' }],
  );
  assert.strictEqual(keyToId.get('overview'), 'live-id');
  assert.deepStrictEqual(absentKeys, []);
});

test('reconcilePageIds: deleted manifest page (id absent in live, no name match) -> absent (create)', () => {
  const manifest = { schemaVersion: 1, pages: [{ key: 'gone', name: 'Gone', pageId: 'deleted-id' }] };
  const { keyToId, absentKeys } = reconcilePageIds([{ key: 'gone', name: 'Gone' }], manifest, []);
  assert.strictEqual(keyToId.has('gone'), false);
  assert.deepStrictEqual(absentKeys, ['gone']);
});

test('reconcilePageIds: no manifest, no live match -> absent', () => {
  const { keyToId, absentKeys } = reconcilePageIds([{ key: 'new', name: 'New' }], null, []);
  assert.strictEqual(keyToId.size, 0);
  assert.deepStrictEqual(absentKeys, ['new']);
});

test('reconcilePageIds: duplicate live names with no confirmed manifest id -> AMBIGUOUS (halt), not bound/absent (C5)', () => {
  const live = [{ pageId: 'x1', name: 'Overview' }, { pageId: 'x2', name: 'Overview' }];
  const { keyToId, absentKeys, ambiguous } = reconcilePageIds(
    [{ key: 'overview', name: 'Overview' }],
    null,
    live,
  );
  assert.strictEqual(keyToId.has('overview'), false);
  assert.deepStrictEqual(absentKeys, []);
  assert.strictEqual(ambiguous.length, 1);
  assert.strictEqual(ambiguous[0].name, 'Overview');
  assert.deepStrictEqual(ambiguous[0].matches.sort(), ['x1', 'x2']);
});
