'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sniffTextOrBinary } = require('../lib/detect-text-or-binary');

// ── NUL byte ──────────────────────────────────────────────────────────────────

test('NUL byte present => binary', () => {
  const buf = Buffer.from([0x48, 0x65, 0x6C, 0x00, 0x6C, 0x6F]); // "Hel\0lo"
  const r = sniffTextOrBinary(buf);
  assert.equal(r.isText, false);
  assert.equal(r.encoding, null);
  assert.equal(r.reason, 'nul-byte');
});

// ── Valid UTF-8 ───────────────────────────────────────────────────────────────

test('valid UTF-8 including multibyte => text utf8', () => {
  const buf = Buffer.from('héllo — 日本語', 'utf8');
  const r = sniffTextOrBinary(buf);
  assert.equal(r.isText, true);
  assert.equal(r.encoding, 'utf8');
});

// ── BOMs ──────────────────────────────────────────────────────────────────────

test('UTF-8 BOM (EF BB BF) => text utf8-bom', () => {
  const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('hello world', 'utf8')]);
  const r = sniffTextOrBinary(buf);
  assert.equal(r.isText, true);
  assert.equal(r.encoding, 'utf8-bom');
});

test('UTF-16 LE BOM (FF FE) => text utf16le', () => {
  const buf = Buffer.from([0xFF, 0xFE, 0x48, 0x00, 0x69, 0x00]); // FF FE + "Hi" in UTF-16 LE
  const r = sniffTextOrBinary(buf);
  assert.equal(r.isText, true);
  assert.equal(r.encoding, 'utf16le');
});

test('UTF-16 BE BOM (FE FF) => text utf16be', () => {
  const buf = Buffer.from([0xFE, 0xFF, 0x00, 0x48, 0x00, 0x69]); // FE FF + "Hi" in UTF-16 BE
  const r = sniffTextOrBinary(buf);
  assert.equal(r.isText, true);
  assert.equal(r.encoding, 'utf16be');
});

// ── Binary image formats ──────────────────────────────────────────────────────

test('PNG header (89 50 4E 47 ...) => binary', () => {
  // Real PNG magic + IHDR length which contains NUL bytes
  const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
  const r = sniffTextOrBinary(buf);
  assert.equal(r.isText, false);
});

test('JPEG header (FF D8 FF) with no NUL => binary via invalid UTF-8', () => {
  // Typical JFIF marker sequence — no NUL bytes, but 0xFF is invalid UTF-8
  const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x4A, 0x46, 0x49, 0x46]);
  const r = sniffTextOrBinary(buf);
  assert.equal(r.isText, false);
});

// ── Minified JS (long single line, no newline) ────────────────────────────────

test('minified one-line JS => text utf8', () => {
  const src = 'var x=function(a,b){return a+b;};' +
    'var y=function(a){return a*2;};' +
    'console.log(x(1,2),y(3));' +
    'module.exports={x,y};'.repeat(10);
  const r = sniffTextOrBinary(Buffer.from(src, 'utf8'));
  assert.equal(r.isText, true);
  assert.equal(r.encoding, 'utf8');
});

// ── Empty buffer ──────────────────────────────────────────────────────────────

test('empty buffer => text, reason empty', () => {
  const r = sniffTextOrBinary(Buffer.alloc(0));
  assert.equal(r.isText, true);
  assert.equal(r.reason, 'empty');
});

// ── High control-char ratio ───────────────────────────────────────────────────

test('high control-char ratio (many 0x01 bytes, no NUL) => binary', () => {
  // Interleave 0x01 (control, not \t/\n/\r/\f) with 'a' at 50 % ratio
  const bytes = [];
  for (let i = 0; i < 100; i++) {
    bytes.push(0x01); // counted as control char
    bytes.push(0x61); // 'a' — printable
  }
  const r = sniffTextOrBinary(Buffer.from(bytes));
  assert.equal(r.isText, false);
  assert.equal(r.reason, 'high-control-char-ratio');
});

// ── Invalid UTF-8 (no NUL) ────────────────────────────────────────────────────

test('lone 0xFF byte (invalid UTF-8, no NUL) => binary', () => {
  const buf = Buffer.from([0x68, 0x65, 0x6C, 0x6C, 0x6F, 0xFF, 0x77, 0x6F, 0x72, 0x6C, 0x64]);
  const r = sniffTextOrBinary(buf);
  assert.equal(r.isText, false);
  assert.equal(r.encoding, null);
  assert.equal(r.reason, 'invalid-utf8');
});

test('bad continuation byte (invalid UTF-8, no NUL) => binary', () => {
  // Start a 2-byte sequence (0xC3) then give an invalid continuation (0x28 = '(')
  const buf = Buffer.from([0x68, 0x65, 0xC3, 0x28, 0x6F]);
  const r = sniffTextOrBinary(buf);
  assert.equal(r.isText, false);
  assert.equal(r.reason, 'invalid-utf8');
});

// ── Input coercion ────────────────────────────────────────────────────────────

test('Uint8Array input is tolerated and detected as text', () => {
  const uint8 = new Uint8Array([0x68, 0x65, 0x6C, 0x6C, 0x6F]); // "hello"
  const r = sniffTextOrBinary(uint8);
  assert.equal(r.isText, true);
  assert.equal(r.encoding, 'utf8');
});

test('string input is tolerated and detected as text', () => {
  const r = sniffTextOrBinary('hello world');
  assert.equal(r.isText, true);
  assert.equal(r.encoding, 'utf8');
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test('tab / LF / CR / FF are NOT counted as control chars', () => {
  // A buffer full of \t \n \r \f — should not push ratio over threshold
  const bytes = [];
  for (let i = 0; i < 100; i++) {
    bytes.push(0x09, 0x0A, 0x0D, 0x0C); // all whitelisted
  }
  const r = sniffTextOrBinary(Buffer.from(bytes));
  assert.equal(r.isText, true);
});

test('NUL beyond byte 8000 is NOT detected (scan limit)', () => {
  // 8001 printable bytes followed by a NUL — only the first 8000 are scanned
  const buf = Buffer.concat([Buffer.alloc(8001, 0x61), Buffer.from([0x00])]);
  const r = sniffTextOrBinary(buf);
  assert.equal(r.isText, true);
  assert.equal(r.encoding, 'utf8');
});
