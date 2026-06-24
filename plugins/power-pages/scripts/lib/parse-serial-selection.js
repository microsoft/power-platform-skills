#!/usr/bin/env node

// Robust parser for a PER-FILE serial-number selection (Task 2). The binary/scalar
// conflicts are presented as a numbered roster (reusing the serials from the
// displayed conflict matrix, e.g. 9–15) and the maker types which to ACCEPT
// INCOMING (Git wins); everything else KEEPS CURRENT (env wins).
//
// Accepts: comma- and/or whitespace-separated numbers and ranges (`9-11`), plus the
// shortcuts `all` (every valid serial) and `none`/empty (no incoming). Validates
// every token against the supplied valid-serial set; on any bad/out-of-range token
// it returns ok:false WITH the offending tokens so the caller can re-ask (it never
// silently drops or misassigns).
//
// Usage:
//   const { parseSerialSelection } = require('./parse-serial-selection');
//   const r = parseSerialSelection('9-11, 13', [9,10,11,12,13,14,15]);
//   // r = { ok:true, all:false, none:false, accepted:[9,10,11,13], invalidTokens:[], outOfRange:[] }

'use strict';

/**
 * @param {string} input            freeform user input (numbers/ranges/`all`/`none`)
 * @param {number[]|Set<number>} validSerials  the serials that may be selected
 * @returns {{ ok:boolean, all:boolean, none:boolean, accepted:number[], invalidTokens:string[], outOfRange:number[] }}
 */
function parseSerialSelection(input, validSerials) {
  const valid = validSerials instanceof Set ? validSerials : new Set((validSerials || []).map(Number));
  const raw = String(input == null ? '' : input).trim();

  // Shortcuts.
  const lower = raw.toLowerCase();
  if (lower === 'all' || lower === 'a' || lower === '*') {
    return { ok: true, all: true, none: false, accepted: [...valid].sort((a, b) => a - b), invalidTokens: [], outOfRange: [] };
  }
  if (raw === '' || lower === 'none' || lower === 'n' || lower === '-') {
    return { ok: true, all: false, none: true, accepted: [], invalidTokens: [], outOfRange: [] };
  }

  const accepted = new Set();
  const invalidTokens = [];
  const outOfRange = new Set();

  // Split on commas and/or any whitespace; drop empties.
  const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  for (const tok of tokens) {
    const range = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = parseInt(range[1], 10);
      let b = parseInt(range[2], 10);
      if (a > b) { const t = a; a = b; b = t; } // tolerate reversed ranges (11-9)
      // Bound iteration to just past the valid set's max so a fat-fingered span
      // (e.g. `9-2e9`) can't drive a multi-million-iteration loop / OOM, while small
      // overflows (e.g. `14-17`) still report each out-of-range member precisely.
      const maxValid = valid.size ? Math.max(...valid) : 0;
      const hi = Math.min(b, maxValid + 1);
      for (let n = a; n <= hi; n++) {
        if (valid.has(n)) accepted.add(n); else outOfRange.add(n);
      }
      if (a > maxValid) outOfRange.add(a);
      if (b > maxValid + 1) outOfRange.add(b);
      continue;
    }
    if (/^\d+$/.test(tok)) {
      const n = parseInt(tok, 10);
      if (valid.has(n)) accepted.add(n); else outOfRange.add(n);
      continue;
    }
    invalidTokens.push(tok); // non-numeric, non-range garbage
  }

  const ok = invalidTokens.length === 0 && outOfRange.size === 0;
  return {
    ok,
    all: false,
    none: ok && accepted.size === 0, // valid-but-empty (shouldn't normally happen after shortcuts)
    accepted: [...accepted].sort((a, b) => a - b),
    invalidTokens,
    outOfRange: [...outOfRange].sort((a, b) => a - b),
  };
}

/**
 * Build a short human-readable reason when a selection is invalid (for the re-ask).
 * @param {{invalidTokens:string[], outOfRange:number[]}} r
 * @returns {string}
 */
function describeInvalidSelection(r) {
  const parts = [];
  if (r.invalidTokens && r.invalidTokens.length) parts.push(`not a number/range: ${r.invalidTokens.join(', ')}`);
  if (r.outOfRange && r.outOfRange.length) parts.push(`out of range: ${r.outOfRange.join(', ')}`);
  return parts.join('; ') || 'invalid selection';
}

if (require.main === module) {
  const [, , input, ...rest] = process.argv;
  const valid = rest.length ? rest.map(Number) : [9, 10, 11, 12, 13, 14, 15];
  process.stdout.write(JSON.stringify(parseSerialSelection(input || '', valid), null, 2) + '\n');
}

module.exports = { parseSerialSelection, describeInvalidSelection };
