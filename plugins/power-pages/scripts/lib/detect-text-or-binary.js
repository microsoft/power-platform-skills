#!/usr/bin/env node
'use strict';

// Byte-sniff a buffer to decide if it is text or binary content.
//
// Used by the git-sync selective-merge resolver to route conflicting Web Files
// (type 3) by content rather than extension: text => VS Code 3-way merge,
// binary => in-chat per-file matrix.
//
// Fail-closed contract: ANY ambiguity => binary.
// Only the first 8000 bytes are inspected (NUL check, control-char ratio,
// UTF-8 validation) so huge files stay fast.

const SCAN_LIMIT = 8000;

// Control chars are bytes < 0x20 EXCEPT:
//   0x09 HT (tab), 0x0A LF, 0x0D CR, 0x0C FF (form-feed)
function isControlChar(byte) {
  return byte < 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D && byte !== 0x0C;
}

// Return the slice to validate with TextDecoder.
// Trim up to 3 bytes from the window boundary so a legitimate multi-byte
// UTF-8 sequence straddling byte 8000 doesn't produce a false "invalid UTF-8".
function utf8Sample(buf) {
  if (buf.length <= SCAN_LIMIT) return buf;
  return buf.slice(0, SCAN_LIMIT - 3);
}

/**
 * Sniff a buffer and determine whether it is text or binary.
 *
 * @param {Buffer|Uint8Array|string} input
 * @returns {{ isText: boolean, encoding: 'utf8'|'utf8-bom'|'utf16le'|'utf16be'|null, reason: string }}
 */
function sniffTextOrBinary(input) {
  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (input instanceof Uint8Array) {
    buf = Buffer.from(input);
  } else if (typeof input === 'string') {
    buf = Buffer.from(input, 'utf8');
  } else {
    buf = Buffer.alloc(0);
  }

  if (buf.length === 0) {
    return { isText: true, encoding: null, reason: 'empty' };
  }

  // Rule 1: BOM detection — checked BEFORE the NUL scan because UTF-16 LE/BE
  // text naturally contains NUL bytes for ASCII characters.
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { isText: true, encoding: 'utf8-bom', reason: 'bom-utf8' };
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return { isText: true, encoding: 'utf16le', reason: 'bom-utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return { isText: true, encoding: 'utf16be', reason: 'bom-utf16be' };
  }

  const scanLen = Math.min(buf.length, SCAN_LIMIT);

  // Rule 2: NUL byte anywhere in the first 8000 bytes => binary.
  for (let i = 0; i < scanLen; i++) {
    if (buf[i] === 0x00) {
      return { isText: false, encoding: null, reason: 'nul-byte' };
    }
  }

  // Rule 3: Strict UTF-8 decode must succeed.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(utf8Sample(buf));
  } catch {
    return { isText: false, encoding: null, reason: 'invalid-utf8' };
  }

  // Rule 3 (continued): Control-char ratio must be below threshold.
  let controlCount = 0;
  for (let i = 0; i < scanLen; i++) {
    if (isControlChar(buf[i])) controlCount++;
  }
  const ratio = controlCount / scanLen;
  if (ratio >= 0.30) {
    return { isText: false, encoding: null, reason: 'high-control-char-ratio' };
  }

  return { isText: true, encoding: 'utf8', reason: 'utf8-text' };
}

module.exports = { sniffTextOrBinary };
