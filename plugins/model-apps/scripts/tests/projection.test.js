'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  sha256, formProjection, formProjectionHash, sitemapProjection, sitemapProjectionHash,
  cellProjection, normId,
} = require('../lib/projection.js');

// Minimal NEW-topology form intent: tabs → columns → sections → rows → cells.
const field = (name, required) => ({ control: { fieldName: name, ...(required ? { isRequired: true } : {}) } });
const subgrid = (rel, target, view, label) => ({ control: { classId: 'E7A81278-8635-4D9E-8D4D-59480B391C5B', label, parameters: { RelationshipName: rel, TargetEntityType: target, ViewId: view } } });
const form = (entity, sections) => ({
  entityLogicalName: entity, formType: 'Main',
  tabs: [{ label: 'General', columns: [{ sections }] }],
});
const section = (label, cols, rows) => ({ label, columns: cols, rows });

// === Adversarial test #1 — Form-placement collision ==========================================
// Two forms with IDENTICAL field NAMES must project DIFFERENTLY when tab/section/cell placement,
// requiredness, or subgrid differ — so a mis-placed field add is CAUGHT, never blessed.

test('#1 form projection: same field names but different SECTION placement ⇒ different hash', () => {
  const a = form('new_x', [section('S1', 1, [{ cells: [field('new_a'), field('new_b')] }])]);
  const b = form('new_x', [
    section('S1', 1, [{ cells: [field('new_a')] }]),
    section('S2', 1, [{ cells: [field('new_b')] }]), // new_b moved to a second section
  ]);
  assert.notStrictEqual(formProjectionHash(a), formProjectionHash(b), 'placement move must change the projection');
});

test('#1 form projection: same fields but different REQUIREDNESS ⇒ different hash', () => {
  const a = form('new_x', [section('S', 1, [{ cells: [field('new_a', false)] }])]);
  const b = form('new_x', [section('S', 1, [{ cells: [field('new_a', true)] }])]);
  assert.notStrictEqual(formProjectionHash(a), formProjectionHash(b), 'isRequired change must change the projection');
});

test('#1 form projection: same fields but different CELL ORDER ⇒ different hash', () => {
  const a = form('new_x', [section('S', 2, [{ cells: [field('new_a'), field('new_b')] }])]);
  const b = form('new_x', [section('S', 2, [{ cells: [field('new_b'), field('new_a')] }])]);
  assert.notStrictEqual(formProjectionHash(a), formProjectionHash(b), 'cell reorder must change the projection');
});

test('#1 form projection: same fields but different SUBGRID view ⇒ different hash', () => {
  const a = form('new_x', [section('S', 1, [{ cells: [field('new_a')] }, { cells: [subgrid('new_x_new_y', 'new_y', '{AAAA0000-0000-0000-0000-000000000001}', 'Ys')] }])]);
  const b = form('new_x', [section('S', 1, [{ cells: [field('new_a')] }, { cells: [subgrid('new_x_new_y', 'new_y', '{BBBB0000-0000-0000-0000-000000000002}', 'Ys')] }])]);
  assert.notStrictEqual(formProjectionHash(a), formProjectionHash(b), 'subgrid view id change must change the projection');
});

test('#1 form projection: identical placement (subgrid view id only differs in CASE/braces) ⇒ SAME hash', () => {
  const a = form('new_x', [section('S', 1, [{ cells: [subgrid('new_x_new_y', 'new_y', '{AAAA0000-0000-0000-0000-000000000001}', 'Ys')] }])]);
  const b = form('new_x', [section('S', 1, [{ cells: [subgrid('NEW_X_NEW_Y', 'NEW_Y', 'aaaa0000-0000-0000-0000-000000000001', 'Ys')] }])]);
  assert.strictEqual(formProjectionHash(a), formProjectionHash(b), 'id casing/braces are normalized ⇒ equal projection');
});

test('#1 form projection: identical forms ⇒ SAME hash (stable)', () => {
  const mk = () => form('new_x', [section('S', 1, [{ cells: [field('new_a', true), field('new_b')] }])]);
  assert.strictEqual(formProjectionHash(mk()), formProjectionHash(mk()));
});

// === Adversarial test #2 — Page source/deployed dual-hash ====================================
// Cross-page-nav rewrites the canonical `PAGEREF_x` source into GUID-resolved deployed bytes at upload,
// so the deployed hash ≠ the source hash. The DIFF uses sourceSha (detects the next author edit); the
// post-verifier uses deployedSha (downloaded deployed bytes must match ONLY deployedSha).

test('#2 page dual-hash: PAGEREF source vs resolved deployed bytes hash DIFFERENTLY', () => {
  const source = 'navigateTo({ pageType: "generative", pageId: "PAGEREF_order-detail" })';
  const deployed = source.replace('PAGEREF_order-detail', 'd4ba77b5-0000-4000-8000-000000000abc');
  const sourceSha = sha256(source);
  const deployedSha = sha256(deployed);
  assert.notStrictEqual(sourceSha, deployedSha, 'PAGEREF resolution changes the bytes ⇒ different hash');
  // The downloaded deployed bytes match ONLY deployedSha (the post-verifier), NOT sourceSha.
  const downloaded = deployed;
  assert.strictEqual(sha256(downloaded), deployedSha, 'deployed download matches deployedSha');
  assert.notStrictEqual(sha256(downloaded), sourceSha, 'deployed download does NOT match sourceSha');
});

test('#2 page dual-hash: an author edit to the SOURCE changes sourceSha (diff detects it)', () => {
  const v1 = 'export default function P(){ return <div>Overview</div>; }';
  const v2 = 'export default function P(){ return <div>Overview v2</div>; }';
  assert.notStrictEqual(sha256(v1), sha256(v2), 'a .tsx byte edit changes the source hash — this is what the diff must catch');
});

test('#2 page dual-hash: byte-identical source ⇒ identical hash (no false change)', () => {
  const s = 'export default function P(){ return null; }';
  assert.strictEqual(sha256(s), sha256('' + s));
});

// === Adversarial test #3 — Sitemap normalization ============================================
// Equivalent sitemaps (GUID casing/braces + env-url noise) compare EQUAL; a reordered / renamed /
// retargeted subarea compares UNEQUAL.

const sm = (subAreas) => ({ areas: [{ title: 'Main', groups: [{ title: 'Records', subAreas }] }] });

test('#3 sitemap: GUID casing/braces + env-url noise normalize to EQUAL', () => {
  const a = sm([{ type: 'GenPage', genPageId: '{D4BA77B5-0000-4000-8000-000000000ABC}' }, { type: 'URL', url: 'https://org1.crm.dynamics.com/x/y' }]);
  const b = sm([{ type: 'GenPage', genPageId: 'd4ba77b5-0000-4000-8000-000000000abc' }, { type: 'URL', url: 'https://ORG2.crm.dynamics.com/x/y' }]);
  assert.strictEqual(sitemapProjectionHash(a), sitemapProjectionHash(b), 'id casing/braces + env host are normalized ⇒ equal');
});

test('#3 sitemap: REORDERED subareas compare UNEQUAL', () => {
  const a = sm([{ entity: 'new_a' }, { entity: 'new_b' }]);
  const b = sm([{ entity: 'new_b' }, { entity: 'new_a' }]);
  assert.notStrictEqual(sitemapProjectionHash(a), sitemapProjectionHash(b), 'order is semantic ⇒ different');
});

test('#3 sitemap: RENAMED area/group label compares UNEQUAL', () => {
  const a = sm([{ entity: 'new_a' }]);
  const b = { areas: [{ title: 'Main', groups: [{ title: 'RENAMED', subAreas: [{ entity: 'new_a' }] }] }] };
  assert.notStrictEqual(sitemapProjectionHash(a), sitemapProjectionHash(b));
});

test('#3 sitemap: RETARGETED subarea (entity → different entity) compares UNEQUAL', () => {
  const a = sm([{ entity: 'new_a' }]);
  const b = sm([{ entity: 'new_c' }]);
  assert.notStrictEqual(sitemapProjectionHash(a), sitemapProjectionHash(b));
});

test('#3 sitemap: an out-of-band ADDED dashboard subarea (the drift case) compares UNEQUAL', () => {
  const expected = sm([{ entity: 'new_a' }]);
  const liveDrifted = sm([{ entity: 'new_a' }, { type: 'Dashboard', dashboardId: 'dash-ops' }]); // Maker added a dashboard
  assert.notStrictEqual(sitemapProjectionHash(expected), sitemapProjectionHash(liveDrifted), 'drift must be detected');
});

test('form projection treats quick-view and timeline controls as controls, not fields', () => {
  const quickView = cellProjection({
    control: {
      classId: '{5c5600e0-1d6e-4205-a272-be80da87fd42}',
      fieldName: 'New_CustomerId',
      label: 'Customer card',
    },
  });
  assert.deepStrictEqual(quickView, {
    control: '5C5600E0-1D6E-4205-A272-BE80DA87FD42',
    field: 'new_customerid',
    label: 'Customer card',
  });

  const timeline = cellProjection({
    control: {
      classId: '{06375649-c143-495e-a496-c962e5b4488e}',
      label: 'Notes',
    },
  });
  assert.deepStrictEqual(timeline, { control: '06375649-C143-495E-A496-C962E5B4488E', label: 'Notes' });
});

test('projections tolerate malformed fetched shapes without fabricating identity', () => {
  assert.strictEqual(normId(null), '');
  assert.deepStrictEqual(formProjection(null), { entity: '', formType: 'Main', tabs: [] });

  // Fetched sitemap fragments can contain placeholders like `{}` or `null` when an adapter could not
  // classify a SubArea; projecting them as `unknown` keeps the verifier deterministic instead of
  // throwing and skipping the rest of the sitemap comparison.
  assert.deepStrictEqual(sitemapProjection({ areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [null, {}] }] }] }), {
    areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [
      { type: 'unknown', ref: '' },
      { type: 'unknown', ref: '' },
    ] }] }],
  });
});
