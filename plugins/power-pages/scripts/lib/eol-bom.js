#!/usr/bin/env node

// EOL / BOM helpers for the clone-based selective-merge flow.
//
// When we recreate the Dataverse (OURS) side of a conflict as a commit in the
// cloned repo, we must write OURS so it matches the repo file's existing
// line-ending + BOM shape. Git compares line-by-line, so a pure EOL/BOM skew
// between OURS and the repo file would turn the WHOLE file into one conflict,
// burying the real edit (see plan Q7). detectShape() reads the repo file's shape
// and matchShape() re-applies it to OURS so only the lines you actually changed
// conflict.
//
// Pure string helpers — no fs, no network. Extracted from the now-removed
// propose-merge.js so the diff3 engine can be deleted while this contract stays.

'use strict';

const BOM = '\uFEFF';

/** Strip a leading UTF-8 BOM if present. */
function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/** True when the string starts with a UTF-8 BOM. */
function detectBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xFEFF;
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

/** Prepend a BOM when hasBom is true (idempotent); strip it when false. */
function applyBom(s, hasBom) {
  if (typeof s !== 'string') return s;
  const bare = stripBom(s);
  return hasBom ? BOM + bare : bare;
}

/**
 * Describe a reference (repo) file's byte shape so OURS can be written to match.
 * @param {string} reference  the repo (THEIRS/BASE) file content
 * @returns {{ eol: '\r\n'|'\n'|null, bom: boolean }}
 */
function detectShape(reference) {
  return { eol: detectEol(reference), bom: detectBom(reference) };
}

/**
 * Re-shape `content` to match a target { eol, bom } so a Git diff against the
 * reference file flags only real line changes — never pure EOL/BOM skew. Falls
 * back to LF when eol is null/undeterminable.
 * @param {string} content
 * @param {{ eol?: '\r\n'|'\n'|null, bom?: boolean }} shape
 * @returns {string}
 */
function matchShape(content, { eol = '\n', bom = false } = {}) {
  const targetEol = eol === '\r\n' ? '\r\n' : '\n';
  return applyBom(applyEol(stripBom(content), targetEol), !!bom);
}

module.exports = { BOM, stripBom, detectBom, toLF, detectEol, applyEol, applyBom, detectShape, matchShape };
