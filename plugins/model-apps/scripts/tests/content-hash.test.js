'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { annotateContentHashes, pageContentPath } = require('../lib/content-hash.js');
const { diffPhases } = require('../lib/phase-diff.js');

// A minimal spec with one implemented tsx page + one contentPath web resource + one inline web resource.
const spec = () => ({
  solution: { uniqueName: 'S' },
  app: { name: 'A' },
  entities: [], relationships: [], globalChoices: [],
  views: [], charts: [], forms: [], commands: [], dashboards: [],
  webResources: [
    { name: 'wr_styles', type: 'css', contentPath: 'wr/styles.css' },
    { name: 'wr_inline', type: 'js', content: 'console.log(1)' },
  ],
  pages: [
    { key: 'overview', name: 'overview', source: { kind: 'tsx', codeFile: 'pages/overview.tsx' } },
    { key: 'design-only', name: 'design-only', source: { kind: 'intent' } },
  ],
});

// An in-memory content store → a readFile(relPath) resolver. Missing keys return null (fail-closed path).
const resolver = (store) => (rel) => (Object.prototype.hasOwnProperty.call(store, rel) ? store[rel] : null);

const baseStore = () => ({
  'pages/overview.tsx': 'export default function O(){return <div>v1</div>}',
  'wr/styles.css': '.a{color:red}',
});

test('annotateContentHashes: a .tsx BYTE edit (spec JSON identical) now flips the pages phase to changed', () => {
  const store = baseStore();
  const prior = annotateContentHashes(spec(), resolver(store)); // what a prior apply persisted
  // Edit ONLY the file bytes; the spec object is byte-for-byte identical.
  store['pages/overview.tsx'] = 'export default function O(){return <div>v2 EDITED</div>}';
  const cur = annotateContentHashes(spec(), resolver(store));
  assert.deepStrictEqual(diffPhases(cur, prior), ['pages'],
    'editing the .tsx must report ONLY pages changed — the bug this deliverable fixes');
});

test('annotateContentHashes: unchanged bytes -> pages NOT reported changed (no false positive)', () => {
  const store = baseStore();
  const prior = annotateContentHashes(spec(), resolver(store));
  const cur = annotateContentHashes(spec(), resolver(store)); // same bytes, same spec
  assert.deepStrictEqual(diffPhases(cur, prior), []);
});

test('annotateContentHashes: a web-resource contentPath BYTE edit flips the web-resources phase', () => {
  const store = baseStore();
  const prior = annotateContentHashes(spec(), resolver(store));
  store['wr/styles.css'] = '.a{color:blue}';
  const cur = annotateContentHashes(spec(), resolver(store));
  assert.deepStrictEqual(diffPhases(cur, prior), ['web-resources']);
});

test('annotateContentHashes: an inline-content web resource still diffs via its own field (not hidden by the hasher)', () => {
  const store = baseStore();
  const prior = annotateContentHashes(spec(), resolver(store));
  const curSpec = spec();
  curSpec.webResources[1].content = 'console.log(2)'; // inline edit
  const cur = annotateContentHashes(curSpec, resolver(store));
  assert.deepStrictEqual(diffPhases(cur, prior), ['web-resources']);
});

test('annotateContentHashes: a VANISHED source file reads as CHANGED (fail-closed), never a silent no-op', () => {
  const store = baseStore();
  const prior = annotateContentHashes(spec(), resolver(store)); // hashed real bytes
  delete store['pages/overview.tsx']; // file removed / unreadable → resolver returns null
  const cur = annotateContentHashes(spec(), resolver(store));
  assert.strictEqual(cur.pages[0].__contentSha, null, 'unreadable source hashes to null');
  assert.deepStrictEqual(diffPhases(cur, prior), ['pages'],
    'a real hash vs null must differ so a missing source is treated as changed');
});

test('annotateContentHashes: a readFile that THROWS is caught and yields null (never escapes the diff)', () => {
  const throwing = () => { throw new Error('EACCES'); };
  const cur = annotateContentHashes(spec(), throwing);
  assert.strictEqual(cur.pages[0].__contentSha, null);
  assert.strictEqual(cur.webResources[0].__contentSha, null);
});

test('annotateContentHashes: intent (design-only) pages carry NO __contentSha (nothing on disk)', () => {
  const cur = annotateContentHashes(spec(), resolver(baseStore()));
  const designOnly = cur.pages.find((p) => p.key === 'design-only');
  assert.ok(!('__contentSha' in designOnly), 'an intent page has no source file to hash');
  const overview = cur.pages.find((p) => p.key === 'overview');
  assert.match(overview.__contentSha, /^[0-9a-f]{64}$/, 'an implemented page gets a sha256');
});

test('annotateContentHashes: does NOT mutate the input spec (returns a clone)', () => {
  const original = spec();
  const snapshot = JSON.stringify(original);
  annotateContentHashes(original, resolver(baseStore()));
  assert.strictEqual(JSON.stringify(original), snapshot, 'the real spec handed to the build must be untouched');
});

test('annotateContentHashes: guards non-object spec / non-function readFile (returns input unchanged)', () => {
  assert.strictEqual(annotateContentHashes(null, () => 'x'), null);
  const s = spec();
  assert.strictEqual(annotateContentHashes(s, 'not-a-function'), s);
});

test('annotateContentHashes: legacy top-level codeFile page is hashed like a tsx source', () => {
  const legacy = {
    solution: { uniqueName: 'S' }, entities: [], views: [], charts: [], forms: [],
    pages: [{ key: 'p', name: 'p', codeFile: 'pages/legacy.tsx' }],
  };
  const store = { 'pages/legacy.tsx': 'legacy-bytes' };
  const cur = annotateContentHashes(legacy, resolver(store));
  assert.match(cur.pages[0].__contentSha, /^[0-9a-f]{64}$/);
});

test('pageContentPath: resolves tsx/legacy sources and returns null for intent/blank', () => {
  assert.strictEqual(pageContentPath({ source: { kind: 'tsx', codeFile: 'a.tsx' } }), 'a.tsx');
  assert.strictEqual(pageContentPath({ codeFile: 'b.tsx' }), 'b.tsx');
  assert.strictEqual(pageContentPath({ source: { kind: 'intent' } }), null);
  assert.strictEqual(pageContentPath({ source: { kind: 'tsx', codeFile: '   ' } }), null,
    'a whitespace-only codeFile is treated as absent by normalizePageSource');
});
