#!/usr/bin/env node

// Deterministic line-based diff3 for the selective-merge flow. TWO uses:
//
//   1. detectConflicts() — the PRIMARY use now. Classifies the BASE/OURS/THEIRS
//      regions and returns ONLY a conflict count + region types. Used for routing
//      (is there a real overlap?) and UX (how many conflicting hunks). It produces
//      NO merged text — we never compute or present a "proposed" merge. The actual
//      3-way merge is done by VS Code's native Merge Editor (Dataverse | Merged |
//      Azure DevOps), which the human resolves.
//
//   2. threeWayMerge() — FALLBACK ONLY. When the native merge editor is
//      unavailable, this emits a git-style conflict-marker view (both sides shown
//      verbatim for overlaps; non-overlapping hunks merged) so the maker can
//      resolve markers in a plain editor. These markers SHOW both sides — they are
//      not an AI/computed "proposal" of the answer.
//
// NOTE (2026-06-19): the old "proposed.txt pre-seed" was removed. We do not
// propose merge content; we detect conflicts and stage the three sides.
//
// Algorithm: classic diff3 over lines, using an LCS alignment of BASE↔OURS and
// BASE↔THEIRS. Line endings are preserved (each "line" keeps its trailing
// newline), so a merged result re-serializes byte-exactly for unchanged regions.
//
// Output (JSON to stdout in CLI mode):
//   detect:  { clean, conflictCount, regions: [{ type }] }
//   merge:   { merged, clean, conflictCount, regions } (fallback marker view)
//
// Usage (CLI, for debugging):
//   node propose-merge.js --base <file> --ours <file> --theirs <file> [--detect]

'use strict';

const fs = require('fs');

const CONFLICT_START = '<<<<<<<';
const CONFLICT_MID = '=======';
const CONFLICT_END = '>>>>>>>';

/** Split text into lines, KEEPING the trailing newline on each line. */
function splitLines(text) {
  if (text == null || text === '') return [];
  // Keep the EOL with each line; a final line without newline stays as-is.
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * Longest Common Subsequence of two arrays → array of [iA, iB] matched index pairs
 * (ascending). Dispatches by size: the exact full-DP for small inputs (preserves
 * deterministic alignment), and a Hirschberg LINEAR-SPACE LCS once the DP matrix
 * would exceed DP_CELL_LIMIT cells — so a 10k-line minified bundle no longer
 * allocates an O(n×m) matrix (hundreds of MB) and OOMs. (Wave 3 #1.)
 */
const DP_CELL_LIMIT = 4_000_000; // ~16 MB of Uint32 — above this, go linear-space.

function lcsMatches(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return [];
  if (n * m <= DP_CELL_LIMIT) return lcsMatchesDP(a, b);
  return lcsMatchesHirschberg(a, b);
}

/** Exact full-DP LCS (O(n×m) time AND space). Used for small inputs. */
function lcsMatchesDP(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matches = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { matches.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return matches;
}

/** LCS length DP last row for a[a0..a1) vs b[b0..b1), O(width) space. */
function lcsRow(a, a0, a1, b, b0, b1) {
  const width = b1 - b0;
  let prev = new Uint32Array(width + 1);
  let curr = new Uint32Array(width + 1);
  for (let i = a0; i < a1; i++) {
    for (let j = 0; j < width; j++) {
      curr[j + 1] = a[i] === b[b0 + j] ? prev[j] + 1 : Math.max(prev[j + 1], curr[j]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev;
}

/** LCS length DP last row for the REVERSED a[a0..a1) vs REVERSED b[b0..b1). */
function lcsRowReverse(a, a0, a1, b, b0, b1) {
  const width = b1 - b0;
  let prev = new Uint32Array(width + 1);
  let curr = new Uint32Array(width + 1);
  for (let i = a1 - 1; i >= a0; i--) {
    for (let j = width - 1; j >= 0; j--) {
      curr[j] = a[i] === b[b0 + j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev;
}

/** Hirschberg linear-space LCS → matched index pairs ascending. O(min) space. */
function lcsMatchesHirschberg(a, b) {
  const matches = [];
  const rec = (a0, a1, b0, b1) => {
    const n = a1 - a0, m = b1 - b0;
    if (n === 0 || m === 0) return;
    if (n === 1) {
      for (let j = b0; j < b1; j++) if (a[a0] === b[j]) { matches.push([a0, j]); return; }
      return;
    }
    const aMid = a0 + (n >> 1);
    const L = lcsRow(a, a0, aMid, b, b0, b1);
    const R = lcsRowReverse(a, aMid, a1, b, b0, b1);
    let best = -1, bestK = b0;
    for (let k = b0; k <= b1; k++) {
      const s = L[k - b0] + R[k - b0];
      if (s > best) { best = s; bestK = k; }
    }
    rec(a0, aMid, b0, bestK);
    rec(aMid, a1, bestK, b1);
  };
  rec(0, a.length, 0, b.length);
  return matches;
}

/**
 * Build the diff3 chunk list from BASE (o), OURS (a), THEIRS (b) line arrays.
 * Each chunk is either:
 *   { stable: true, lines }                              — identical across all three
 *   { stable: false, o, a, b }                           — a region that differs
 */
function diff3Chunks(o, a, b) {
  const ma = lcsMatches(o, a); // [oIdx, aIdx]
  const mb = lcsMatches(o, b); // [oIdx, bIdx]

  // Map: for each matched base index, its counterpart in A and B.
  const aOf = new Map(ma.map(([oi, ai]) => [oi, ai]));
  const bOf = new Map(mb.map(([oi, bi]) => [oi, bi]));

  // Base indices matched in BOTH A and B, in order — these anchor stable chunks.
  const anchors = [];
  for (let oi = 0; oi < o.length; oi++) {
    if (aOf.has(oi) && bOf.has(oi)) anchors.push(oi);
  }

  const chunks = [];
  let oPrev = 0, aPrev = 0, bPrev = 0;

  const flushUnstable = (oEnd, aEnd, bEnd) => {
    const oSlice = o.slice(oPrev, oEnd);
    const aSlice = a.slice(aPrev, aEnd);
    const bSlice = b.slice(bPrev, bEnd);
    if (oSlice.length || aSlice.length || bSlice.length) {
      chunks.push({ stable: false, o: oSlice, a: aSlice, b: bSlice });
    }
  };

  for (const oi of anchors) {
    const ai = aOf.get(oi), bi = bOf.get(oi);
    // Region between previous anchor and this one is unstable (may be empty).
    flushUnstable(oi, ai, bi);
    // Coalesce consecutive stable lines.
    const last = chunks[chunks.length - 1];
    if (last && last.stable) last.lines.push(o[oi]);
    else chunks.push({ stable: true, lines: [o[oi]] });
    oPrev = oi + 1; aPrev = ai + 1; bPrev = bi + 1;
  }
  // Trailing region after the last anchor.
  flushUnstable(o.length, a.length, b.length);

  return chunks;
}

function arrEq(x, y) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Classify a single unstable diff3 chunk into a region type.
 * @returns {'unchanged'|'ours-only'|'theirs-only'|'both-same'|'conflict'}
 */
function classifyChunk(ch) {
  const aChanged = !arrEq(ch.a, ch.o);
  const bChanged = !arrEq(ch.b, ch.o);
  if (!aChanged && !bChanged) return 'unchanged';
  if (aChanged && !bChanged) return 'ours-only';
  if (!aChanged && bChanged) return 'theirs-only';
  if (arrEq(ch.a, ch.b)) return 'both-same';
  return 'conflict';
}

/**
 * DETECTION ONLY — classify the BASE/OURS/THEIRS regions and count true
 * conflicts (both sides changed the same region differently). Produces NO merged
 * text: this never proposes a merge, it only reports whether/where the two sides
 * overlap, for routing and UX. The actual merge is the human's, in the editor.
 *
 * @returns {{ clean:boolean, conflictCount:number, regions:{type:string}[] }}
 */
function detectConflicts(base, ours, theirs) {
  const o = splitLines(base);
  const a = splitLines(ours);
  const b = splitLines(theirs);
  const chunks = diff3Chunks(o, a, b);
  const regions = [];
  let conflictCount = 0;
  for (const ch of chunks) {
    if (ch.stable) continue;
    const type = classifyChunk(ch);
    if (type === 'conflict') conflictCount++;
    regions.push({ type });
  }
  return { clean: conflictCount === 0, conflictCount, regions };
}

/**
 * 3-way merge of plain text. Returns the merged text (with conflict markers when
 * both sides changed the same region differently) plus metadata.
 *
 * @param {string} base
 * @param {string} ours
 * @param {string} theirs
 * @param {object} [opts] { oursLabel, theirsLabel }
 * @returns {{ merged:string, clean:boolean, conflictCount:number, regions:object[] }}
 */
function threeWayMerge(base, ours, theirs, opts = {}) {
  const oursLabel = opts.oursLabel || 'OURS (environment)';
  const theirsLabel = opts.theirsLabel || 'THEIRS (incoming)';

  const o = splitLines(base);
  const a = splitLines(ours);
  const b = splitLines(theirs);

  const chunks = diff3Chunks(o, a, b);
  const out = [];
  const regions = [];
  let conflictCount = 0;

  for (const ch of chunks) {
    if (ch.stable) { out.push(...ch.lines); continue; }
    const aChanged = !arrEq(ch.a, ch.o);
    const bChanged = !arrEq(ch.b, ch.o);

    if (!aChanged && !bChanged) { out.push(...ch.o); regions.push({ type: 'unchanged' }); }
    else if (aChanged && !bChanged) { out.push(...ch.a); regions.push({ type: 'ours-only' }); }
    else if (!aChanged && bChanged) { out.push(...ch.b); regions.push({ type: 'theirs-only' }); }
    else if (arrEq(ch.a, ch.b)) { out.push(...ch.a); regions.push({ type: 'both-same' }); }
    else {
      // True conflict — emit a marked region.
      conflictCount++;
      regions.push({ type: 'conflict', ours: ch.a.join(''), theirs: ch.b.join(''), base: ch.o.join('') });
      const nl = inferEol(ch.a, ch.b, ch.o);
      out.push(`${CONFLICT_START} ${oursLabel}${nl}`);
      pushEnsuringEol(out, ch.a, nl);
      out.push(`${CONFLICT_MID}${nl}`);
      pushEnsuringEol(out, ch.b, nl);
      out.push(`${CONFLICT_END} ${theirsLabel}${nl}`);
    }
  }

  return { merged: out.join(''), clean: conflictCount === 0, conflictCount, regions };
}

function inferEol(...slices) {
  for (const s of slices) {
    for (const line of s) {
      if (line.endsWith('\r\n')) return '\r\n';
      if (line.endsWith('\n')) return '\n';
    }
  }
  return '\n';
}

// ---- EOL / BOM normalization (so independent edits anchor instead of
// collapsing into a whole-field conflict when OURS and THEIRS differ only in
// line endings or a leading BOM). ----

/** Strip a leading UTF-8 BOM if present. */
function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/** Convert all line endings to LF. */
function toLF(s) {
  return typeof s === 'string' ? s.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : s;
}

/** Detect the dominant EOL of a string: '\r\n', '\n', or null when undeterminable. */
function detectEol(s) {
  if (typeof s !== 'string') return null;
  if (s.includes('\r\n')) return '\r\n';
  if (s.includes('\n')) return '\n';
  return null;
}

/** Re-apply a target EOL to a (possibly mixed-EOL) string. */
function applyEol(s, eol) {
  const lf = toLF(s);
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

// Ensure the last line of an emitted side carries a newline so the following
// marker starts on its own line.
function pushEnsuringEol(out, lines, nl) {
  if (lines.length === 0) return;
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i];
    const isLast = i === lines.length - 1;
    if (isLast && !ln.endsWith('\n')) ln = ln + nl;
    out.push(ln);
  }
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { base: null, ours: null, theirs: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--base' && a[i + 1]) o.base = a[++i];
    else if (a[i] === '--ours' && a[i + 1]) o.ours = a[++i];
    else if (a[i] === '--theirs' && a[i + 1]) o.theirs = a[++i];
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  const read = (p) => (p ? fs.readFileSync(p, 'utf8') : '');
  if (process.argv.includes('--detect')) {
    const r = detectConflicts(read(args.base), read(args.ours), read(args.theirs));
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else {
    const r = threeWayMerge(read(args.base), read(args.ours), read(args.theirs));
    process.stdout.write(JSON.stringify({ ...r, merged: r.merged }, null, 2) + '\n');
  }
}

module.exports = { detectConflicts, threeWayMerge, classifyChunk, diff3Chunks, lcsMatches, lcsMatchesDP, lcsMatchesHirschberg, DP_CELL_LIMIT, splitLines, stripBom, toLF, detectEol, applyEol, CONFLICT_START, CONFLICT_MID, CONFLICT_END };
