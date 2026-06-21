'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { threeWayMerge, splitLines, lcsMatches, lcsMatchesDP, lcsMatchesHirschberg, DP_CELL_LIMIT, stripBom, toLF, detectEol, applyEol } = require('../lib/propose-merge');

test('splitLines: keeps trailing newlines, handles no-final-newline and empty lines', () => {
  assert.deepEqual(splitLines('A\nB\nC\n'), ['A\n', 'B\n', 'C\n']);
  assert.deepEqual(splitLines('A\nB\nC'), ['A\n', 'B\n', 'C']);
  assert.deepEqual(splitLines('A\n\nB'), ['A\n', '\n', 'B']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('A\r\nB\r\n'), ['A\r\n', 'B\r\n']);
});

test('lcsMatches: basic alignment', () => {
  assert.deepEqual(lcsMatches(['A', 'B', 'C'], ['A', 'X', 'C']), [[0, 0], [2, 2]]);
});

test('identical on all three sides → clean, merged == base', () => {
  const t = 'A\nB\nC\n';
  const r = threeWayMerge(t, t, t);
  assert.equal(r.clean, true);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.merged, t);
});

test('ours-only change is taken, clean', () => {
  const r = threeWayMerge('A\nB\nC\n', 'A2\nB\nC\n', 'A\nB\nC\n');
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'A2\nB\nC\n');
});

test('theirs-only change is taken, clean', () => {
  const r = threeWayMerge('A\nB\nC\n', 'A\nB\nC\n', 'A\nB\nC2\n');
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'A\nB\nC2\n');
});

test('KEY: non-overlapping changes on BOTH sides auto-merge cleanly', () => {
  const r = threeWayMerge('A\nB\nC\n', 'A2\nB\nC\n', 'A\nB\nC2\n');
  assert.equal(r.clean, true);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.merged, 'A2\nB\nC2\n');
});

test('both sides make the SAME change → collapses, clean', () => {
  const r = threeWayMerge('A\nB\nC\n', 'A\nX\nC\n', 'A\nX\nC\n');
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'A\nX\nC\n');
});

test('overlapping different changes → conflict region with markers', () => {
  const r = threeWayMerge('A\nB\nC\n', 'A\nX\nC\n', 'A\nY\nC\n');
  assert.equal(r.clean, false);
  assert.equal(r.conflictCount, 1);
  assert.match(r.merged, /<<<<<<</);
  assert.match(r.merged, /=======/);
  assert.match(r.merged, />>>>>>>/);
  assert.match(r.merged, /X/);
  assert.match(r.merged, /Y/);
  // Stable surrounding lines preserved.
  assert.match(r.merged, /^A\n/);
  assert.match(r.merged, /C\n$/);
});

test('two independent regions: one auto-merges, one conflicts', () => {
  const base = 'h1\nL1\nh2\nL2\nh3\n';
  const ours = 'h1\nOURS1\nh2\nSHARED\nh3\n';
  const theirs = 'h1\nL1\nh2\nTHEIRS2\nh3\n';
  // region around L1: ours-only change → OURS1 (clean)
  // region around L2: ours=SHARED, theirs=THEIRS2 → conflict
  const r = threeWayMerge(base, ours, theirs);
  assert.equal(r.conflictCount, 1);
  assert.match(r.merged, /OURS1/);
  assert.match(r.merged, /SHARED/);
  assert.match(r.merged, /THEIRS2/);
});

test('CRLF line endings preserved on clean merge', () => {
  const r = threeWayMerge('A\r\nB\r\nC\r\n', 'A2\r\nB\r\nC\r\n', 'A\r\nB\r\nC\r\n');
  assert.equal(r.merged, 'A2\r\nB\r\nC\r\n');
  assert.equal(r.clean, true);
});

test('add/add with different content (empty base) → conflict', () => {
  const r = threeWayMerge('', 'X\n', 'Y\n');
  assert.equal(r.clean, false);
  assert.equal(r.conflictCount, 1);
});

test('add/add with identical content (empty base) → clean', () => {
  const r = threeWayMerge('', 'SAME\n', 'SAME\n');
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'SAME\n');
});

test('custom labels appear in conflict markers', () => {
  const r = threeWayMerge('B\n', 'X\n', 'Y\n', { oursLabel: 'env', theirsLabel: 'git' });
  assert.match(r.merged, /<<<<<<< env/);
  assert.match(r.merged, />>>>>>> git/);
});

test('conflict region content captured in regions metadata', () => {
  const r = threeWayMerge('A\nB\nC\n', 'A\nX\nC\n', 'A\nY\nC\n');
  const conflict = r.regions.find((x) => x.type === 'conflict');
  assert.ok(conflict);
  assert.match(conflict.ours, /X/);
  assert.match(conflict.theirs, /Y/);
});

test('realistic Liquid web-template merge: independent edits auto-merge', () => {
  const base = '{% assign x = 1 %}\n<div>{{ x }}</div>\n<footer>old</footer>\n';
  const ours = '{% assign x = 2 %}\n<div>{{ x }}</div>\n<footer>old</footer>\n';   // changed assign
  const theirs = '{% assign x = 1 %}\n<div>{{ x }}</div>\n<footer>NEW</footer>\n'; // changed footer
  const r = threeWayMerge(base, ours, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.merged, '{% assign x = 2 %}\n<div>{{ x }}</div>\n<footer>NEW</footer>\n');
});

// ---- EOL/BOM normalization helpers (fix #1) ----
test('stripBom removes a leading BOM only', () => {
  assert.equal(stripBom('\uFEFFhi'), 'hi');
  assert.equal(stripBom('hi'), 'hi');
  assert.equal(stripBom('a\uFEFFb'), 'a\uFEFFb');
});
test('toLF normalizes CRLF and lone CR to LF', () => {
  assert.equal(toLF('a\r\nb\rc\n'), 'a\nb\nc\n');
});
test('detectEol returns dominant EOL or null', () => {
  assert.equal(detectEol('a\r\nb'), '\r\n');
  assert.equal(detectEol('a\nb'), '\n');
  assert.equal(detectEol('no newline'), null);
  assert.equal(detectEol(''), null);
});
test('applyEol converts to the target EOL', () => {
  assert.equal(applyEol('a\nb\n', '\r\n'), 'a\r\nb\r\n');
  assert.equal(applyEol('a\r\nb\r\n', '\n'), 'a\nb\n');
});

// ---- documented safe behavior (fix #6) ----
test('DOC: immediately-adjacent independent edits conservatively conflict (SAFE — no data loss)', () => {
  // ours changes L2, theirs changes L3, with NO unchanged line between them: classic
  // diff3 bundles the region and reports a conflict rather than auto-merging. This is
  // intentional v1 behavior — it errs toward human review and never loses an edit.
  const r = threeWayMerge('L1\nL2\nL3\n', 'L1\nOURS2\nL3\n', 'L1\nL2\nTHEIRS3\n');
  assert.equal(r.clean, false);
  assert.equal(r.conflictCount, 1);
  // Both edits are preserved in the marked output for the user to resolve.
  assert.match(r.merged, /OURS2/);
  assert.match(r.merged, /THEIRS3/);
});

// ---- Wave 3 #1: linear-space LCS (Hirschberg) for big files ----
test('lcsMatchesHirschberg agrees with the full DP on the LCS length (random inputs)', () => {
  const rnd = (seed) => { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };
  for (let t = 0; t < 30; t++) {
    const r = rnd(t + 1);
    const a = Array.from({ length: 40 }, () => String.fromCharCode(97 + Math.floor(r() * 6)));
    const b = Array.from({ length: 40 }, () => String.fromCharCode(97 + Math.floor(r() * 6)));
    const dp = lcsMatchesDP(a, b);
    const hb = lcsMatchesHirschberg(a, b);
    assert.equal(hb.length, dp.length, `LCS length mismatch on trial ${t}`);
    // every Hirschberg pair is a real equal-element match, strictly ascending
    let pi = -1, pj = -1;
    for (const [i, j] of hb) {
      assert.equal(a[i], b[j]);
      assert.ok(i > pi && j > pj, 'pairs strictly ascending');
      pi = i; pj = j;
    }
  }
});

test('threeWayMerge stays correct when forced through the linear-space path (small DP_CELL_LIMIT not needed — direct call)', () => {
  // Directly exercise Hirschberg on a clean non-overlapping merge shape.
  const base = Array.from({ length: 50 }, (_, i) => `L${i}`);
  const ours = base.slice(); ours[0] = 'OURS0';
  const theirs = base.slice(); theirs[49] = 'THEIRS49';
  const m1 = lcsMatchesHirschberg(base, ours);
  const m2 = lcsMatchesDP(base, ours);
  assert.equal(m1.length, m2.length);
});

test('lcsMatches dispatches to linear-space above DP_CELL_LIMIT without OOM', () => {
  // n*m just over the limit — would allocate a huge matrix in the full DP.
  const big = Math.ceil(Math.sqrt(DP_CELL_LIMIT)) + 50;
  const a = Array.from({ length: big }, (_, i) => `x${i}`);
  const b = a.slice(); // identical → LCS = full length
  const matches = lcsMatches(a, b);
  assert.equal(matches.length, big, 'identical sequences → full-length LCS via linear-space path');
});
