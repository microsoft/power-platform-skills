'use strict';
// Tests for the single structural nav oracle (pageref-resolver.js).
// All tests must pass for every nav-related change — this module is the correctness spine
// of forward resolution (Task 8), reverse-normalization (Task 11), and verification (Task 10).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  extractNavTargets,
  navReferencedKeys,
  navMalformedRefs,
  resolvePageRefs,
  reverseResolveNavIds,
  navTargetParity,
} = require(path.join(__dirname, '..', 'lib', 'pageref-resolver.js'));

// Helper: produces a realistic generative navigateTo call with a given pageId token.
const NAV = (id) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: ${id}, data: {} });`;

// ─── extractNavTargets ────────────────────────────────────────────────────────

test('extractNavTargets classifies a canonical PAGEREF nav pageId (structural — real call site only)', () => {
  const t = extractNavTargets(NAV('"PAGEREF_detail"'));
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'pageref');
  assert.strictEqual(t[0].key, 'detail');
});

test('extractNavTargets IGNORES a decoy "PAGEREF_" string that is NOT a nav pageId (C1 oracle)', () => {
  const code = `const label = "PAGEREF_detail"; // decoy, not navigation\n${NAV('"PAGEREF_gallery"')}`;
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1, 'only the real nav call site counts');
  assert.strictEqual(t[0].key, 'gallery');
  assert.deepStrictEqual(navReferencedKeys(code), ['gallery'], 'the decoy "detail" is not a referenced key');
});

test('extractNavTargets classifies a resolved GUID literal, and a dynamic (variable) pageId', () => {
  assert.strictEqual(extractNavTargets(NAV('"5d29d8ce-1111-2222-3333-444455556666"'))[0].kind, 'literal');
  assert.strictEqual(extractNavTargets(NAV('targetPageId'))[0].kind, 'dynamic');
});

test('extractNavTargets only counts pageType:"generative" call sites', () => {
  const code = 'Xrm.Navigation.navigateTo({ pageType: "entityrecord", pageId: "PAGEREF_detail" });';
  assert.deepStrictEqual(extractNavTargets(code), []);
});

test('extractNavTargets handles pageId BEFORE pageType and a nested data:{} object', () => {
  const code = 'navigateTo({ pageId: "PAGEREF_detail", pageType: "generative", data: { recordId: "PAGEREF_notakey", nested: { x: 1 } } });';
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'pageref');
  assert.strictEqual(t[0].key, 'detail', 'the top-level pageId is the target — a PAGEREF-looking string inside data:{} is NOT');
});

// ─── Comment and template-literal stripping (addendum Crit 1) ────────────────
//
// A navigateTo inside a comment or template literal is NOT a real call site.  The
// stripping pass blanks those regions (same-length space substitution) before the
// NAV_CALL regex runs, so an in-comment or in-template navigateTo is invisible to
// the oracle.  These three tests are REQUIRED by the Plan-3 implementer addendum.

test('extractNavTargets IGNORES a navigateTo inside a // line comment (addendum Crit 1)', () => {
  const real = NAV('"PAGEREF_real"');
  const code = `// ${NAV('"PAGEREF_commented"')}\n${real}`;
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1, 'only the real call site counts; the commented-out one is ignored');
  assert.strictEqual(t[0].key, 'real');
  assert.deepStrictEqual(navReferencedKeys(code), ['real'], 'the commented navigateTo is not a referenced key');
});

test('extractNavTargets IGNORES a navigateTo inside a /* */ block comment (addendum Crit 1)', () => {
  const real = NAV('"PAGEREF_real"');
  const code = `/* ${NAV('"PAGEREF_block"')} */\n${real}`;
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1, 'block-commented call site is ignored');
  assert.strictEqual(t[0].key, 'real');
  assert.deepStrictEqual(navReferencedKeys(code), ['real'], 'the block-commented navigateTo is not a referenced key');
});

test('extractNavTargets IGNORES a navigateTo inside a backtick template literal (addendum Crit 1)', () => {
  const real = NAV('"PAGEREF_real"');
  // The backtick string contains the navigateTo as template-literal TEXT, not a real call.
  // eslint-disable-next-line no-template-curly-in-string
  const code = 'const s = `template ' + NAV('"PAGEREF_templ"') + ' body`;\n' + real;
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1, 'template-literal call site is ignored');
  assert.strictEqual(t[0].key, 'real');
  assert.deepStrictEqual(navReferencedKeys(code), ['real'], 'the template-literal navigateTo is not a referenced key');
});

// ─── navMalformedRefs ─────────────────────────────────────────────────────────

test('navMalformedRefs flags a single-quoted PAGEREF_ used as a nav pageId (C4 grammar)', () => {
  const code = "Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: 'PAGEREF_detail' });";
  assert.deepStrictEqual(navMalformedRefs(code), ['PAGEREF_detail']);
  assert.deepStrictEqual(navReferencedKeys(code), [], 'a malformed ref is NOT a valid canonical reference');
});

test('navMalformedRefs flags a backtick-quoted PAGEREF_ used as a nav pageId (C4 — backtick cannot be resolved)', () => {
  // A backtick-quoted PAGEREF cannot be substituted by the resolver (only the canonical
  // double-quoted token is substitutable), so it is malformed and must HALT.
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: `PAGEREF_detail` });';
  assert.deepStrictEqual(navMalformedRefs(code), ['PAGEREF_detail']);
  assert.deepStrictEqual(navReferencedKeys(code), [], 'a backtick-quoted PAGEREF is NOT a valid canonical reference');
});

// ─── navReferencedKeys + navTargetParity ─────────────────────────────────────

test('navReferencedKeys returns [] for a literal GUID pageId; parity flags declared edge as unreferenced (M3)', () => {
  // A deployed/stale GUID in the source is not a canonical PAGEREF, so it is not a referenced
  // key and parity correctly reports the declared edge as unreferenced.
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "5d29d8ce-1111-2222-3333-444455556666" });';
  assert.deepStrictEqual(navReferencedKeys(code), [], 'a GUID literal is not a canonical PAGEREF key');
  assert.deepStrictEqual(
    navTargetParity(['detail'], navReferencedKeys(code)).declaredNotReferenced,
    ['detail'],
    'the declared "detail" edge is unreferenced because the source holds a resolved GUID, not PAGEREF_detail'
  );
});

test('extractNavTargets classifies a "a" + "b" concat pageId as dynamic, not literal (M4)', () => {
  // A string concat is not a single literal — the tightened QUOTED regex excludes cross-quote spans
  // and topLevelValue detects the trailing '+' and widens the span to the full expression.
  const code = NAV('"a" + "b"');
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'dynamic', 'a string concat is not a single literal');
});

// ─── resolvePageRefs ──────────────────────────────────────────────────────────

test('resolvePageRefs replaces each canonical nav pageId with the quoted genPageId (span-based, no partial collide)', () => {
  const sources = new Map([['x', { code: `${NAV('"PAGEREF_pet"')}\n${NAV('"PAGEREF_pet-gallery"')}` }]]);
  const keyToId = new Map([['pet', 'id-pet'], ['pet-gallery', 'id-gallery']]);
  const { deployment, unresolved } = resolvePageRefs(sources, keyToId);
  assert.ok(deployment.get('x').includes('pageId: "id-pet"'));
  assert.ok(deployment.get('x').includes('pageId: "id-gallery"'));
  assert.deepStrictEqual(unresolved, []);
});

test('resolvePageRefs collects dangling targets (sorted, unique) and leaves them verbatim', () => {
  const sources = new Map([
    ['a', { code: `${NAV('"PAGEREF_missing"')}\n${NAV('"PAGEREF_gone"')}` }],
    ['b', { code: NAV('"PAGEREF_gone"') }],
  ]);
  const { deployment, unresolved } = resolvePageRefs(sources, new Map());
  assert.deepStrictEqual(unresolved, ['gone', 'missing']);
  assert.ok(deployment.get('a').includes('"PAGEREF_missing"'), 'a dangling ref must not be dropped or mangled — the caller halts on it');
});

test('resolvePageRefs is idempotent — resolved code has no canonical nav PAGEREF left', () => {
  const once = resolvePageRefs(new Map([['x', { code: NAV('"PAGEREF_detail"') }]]), new Map([['detail', 'gp-1']])).deployment.get('x');
  assert.deepStrictEqual(navReferencedKeys(once), []);
});

// ─── reverseResolveNavIds ─────────────────────────────────────────────────────

test('reverseResolveNavIds rewrites ONLY the nav pageId literal back to "PAGEREF_<key>" (case-insensitive), never a recordId', () => {
  const idToKey = new Map([['5d29d8ce-1111-2222-3333-444455556666', 'detail']]);
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "5D29D8CE-1111-2222-3333-444455556666", recordId: "5d29d8ce-1111-2222-3333-444455556666" });';
  const out = reverseResolveNavIds(code, idToKey);
  assert.ok(out.includes('pageId: "PAGEREF_detail"'), 'nav pageId reversed');
  assert.ok(out.includes('recordId: "5d29d8ce-1111-2222-3333-444455556666"'), 'the SAME guid used as a recordId is NOT reversed (scoped to nav pageId)');
});

test('resolve then reverse round-trips the navigation literal', () => {
  const original = NAV('"PAGEREF_detail"');
  const resolved = resolvePageRefs(new Map([['x', { code: original }]]), new Map([['detail', 'gp-42']])).deployment.get('x');
  assert.ok(resolved.includes('pageId: "gp-42"'));
  assert.strictEqual(reverseResolveNavIds(resolved, new Map([['gp-42', 'detail']])), original);
});

// ─── navTargetParity ──────────────────────────────────────────────────────────

test('navTargetParity reports declared-not-referenced and referenced-not-declared (both directions)', () => {
  assert.deepStrictEqual(navTargetParity(['detail', 'ghost'], ['detail', 'extra']), { declaredNotReferenced: ['ghost'], referencedNotDeclared: ['extra'] });
  assert.deepStrictEqual(navTargetParity(['a'], ['a']), { declaredNotReferenced: [], referencedNotDeclared: [] });
});

test('DECOY end-to-end: declared "detail" but the real nav points at "wrong" — parity REJECTS it', () => {
  const code = `const decoy = "PAGEREF_detail";\n${NAV('"PAGEREF_wrong"')}`;
  assert.deepStrictEqual(navTargetParity(['detail'], navReferencedKeys(code)), { declaredNotReferenced: ['detail'], referencedNotDeclared: ['wrong'] });
});
