'use strict';

// FUZZ / property tests for the diff3 merge engine (Wave 5 #3).
//
// The selective-merge feature's #1 safety promise is "never lose or invent a line."
// These throw thousands of random BASE/OURS/THEIRS triples at threeWayMerge and
// assert the invariants that protect that promise. This is the CI stand-in for the
// exhaustive correctness guarantee (the live-tenant matrix covers the I/O paths).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { threeWayMerge, detectConflicts, splitLines, CONFLICT_START, CONFLICT_MID, CONFLICT_END } = require('../lib/propose-merge');

// Deterministic PRNG so failures reproduce.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

function randomLines(r, n, alphabet) {
  return Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
}

// Derive a variant of `base` by random line edits (insert / delete / modify / keep).
// All emitted lines keep a trailing newline so splitLines round-trips cleanly.
function mutate(r, baseLines, tag) {
  const out = [];
  for (const line of baseLines) {
    const op = r();
    if (op < 0.15) continue;                                   // delete
    else if (op < 0.30) { out.push(`${tag}-${line}`); }        // modify (line already ends \n)
    else if (op < 0.40) { out.push(line); out.push(`${tag}-new\n`); } // insert after
    else out.push(line);                                       // keep
  }
  if (r() < 0.3) out.push(`${tag}-tail\n`);
  return out;
}

const isMarker = (l) => l.startsWith(CONFLICT_START) || l.startsWith(CONFLICT_MID) || l.startsWith(CONFLICT_END);

test('fuzz: threeWayMerge never throws, is deterministic, and never invents a line (trace-guard)', () => {
  const ALPHA = ['a\n', 'b\n', 'c\n', 'd\n', 'e\n', 'f\n', 'g\n', 'h\n'];
  for (let t = 0; t < 1500; t++) {
    const r = rng(t + 1);
    const baseLines = ALPHA.slice(0, 2 + Math.floor(r() * 6)).map((x) => x);
    const base = baseLines.join('');
    const ours = mutate(r, baseLines, 'O').join('');
    const theirs = mutate(r, baseLines, 'T').join('');

    let res1, res2;
    assert.doesNotThrow(() => { res1 = threeWayMerge(base, ours, theirs); }, `threw on trial ${t}`);
    res2 = threeWayMerge(base, ours, theirs);
    assert.equal(res1.merged, res2.merged, `non-deterministic on trial ${t}`);

    // Trace-guard: every non-marker output line must exist in OURS ∪ THEIRS ∪ BASE.
    const allowed = new Set([...splitLines(base), ...splitLines(ours), ...splitLines(theirs)]);
    for (const line of splitLines(res1.merged)) {
      if (isMarker(line)) continue;
      assert.ok(allowed.has(line), `invented line on trial ${t}: ${JSON.stringify(line)}`);
    }

    // detectConflicts must agree with threeWayMerge on the conflict count.
    assert.equal(detectConflicts(base, ours, theirs).conflictCount, res1.conflictCount, `detect/merge disagree on trial ${t}`);
  }
});

test('fuzz: one-sided changes apply cleanly (ours==base ⇒ accept theirs; theirs==base ⇒ keep ours)', () => {
  const ALPHA = ['a\n', 'b\n', 'c\n', 'd\n', 'e\n', 'f\n'];
  for (let t = 0; t < 800; t++) {
    const r = rng(1000 + t);
    const baseLines = ALPHA.slice(0, 2 + Math.floor(r() * 4));
    const base = baseLines.join('');
    const variant = mutate(r, baseLines, 'X').join('');

    // OURS unchanged → merged must equal THEIRS exactly (pure accept), no conflict.
    const a = threeWayMerge(base, base, variant);
    assert.equal(a.clean, true, `ours==base should be clean (trial ${t})`);
    assert.equal(a.merged, variant, `ours==base ⇒ merged==theirs (trial ${t})`);

    // THEIRS unchanged → merged must equal OURS exactly (pure keep), no conflict.
    const b = threeWayMerge(base, variant, base);
    assert.equal(b.clean, true, `theirs==base should be clean (trial ${t})`);
    assert.equal(b.merged, variant, `theirs==base ⇒ merged==ours (trial ${t})`);
  }
});

test('fuzz: identical edits on both sides collapse to that edit (no false conflict)', () => {
  const ALPHA = ['a\n', 'b\n', 'c\n', 'd\n', 'e\n'];
  for (let t = 0; t < 500; t++) {
    const r = rng(5000 + t);
    const baseLines = ALPHA.slice(0, 2 + Math.floor(r() * 3));
    const base = baseLines.join('');
    const same = mutate(r, baseLines, 'S').join('');
    const res = threeWayMerge(base, same, same);
    assert.equal(res.clean, true, `identical edits must not conflict (trial ${t})`);
    assert.equal(res.merged, same, `identical edits collapse to that edit (trial ${t})`);
  }
});
