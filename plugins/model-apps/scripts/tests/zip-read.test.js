'use strict';
// lib/zip-read.js: the strict reader of one entry of a ZIP archive that `--verify` uses on a translation export.
//
// The export is read by a program that decides, from what it reads, whether a form's captions are right. A reader that guesses — takes the data's
// place from a header that disagrees with another, inflates past the size the archive declares, skips a checksum — can turn a damaged answer into a
// pass. So an archive is read when every number in it agrees with every other, and is refused, with the reason, in every other case. The first test
// reads the archive the way the platform was measured to write it (see helpers/translation-export.js); the others each break one rule.
const test = require('node:test');
const assert = require('node:assert');
const { readZipEntry, ZipReadError } = require('../lib/zip-read.js');
const { zipOf, exportZip, crc32 } = require('./helpers/translation-export.js');

const XML = '<?xml version="1.0"?><Workbook>caf\u00e9 \u2014 Pesta\u00f1a Uno</Workbook>';
const archiveOf = (options) => zipOf([{ name: 'CrmTranslations.xml', data: XML }, { name: '[Content_Types].xml', data: '<Types/>' }], options);

// The offsets of the first entry's headers in an archive made by zipOf: its local header is at 0, the central directory follows the data.
const endOf = (archive) => archive.length - 22;
const centralAt = (archive) => archive.readUInt32LE(endOf(archive) + 16);

test('zip-read: reads an entry of the archive as the platform writes it — deflated, an extra field on the local header only, flags 0x0002', () => {
  const archive = exportZip(XML);
  assert.strictEqual(readZipEntry(archive, 'CrmTranslations.xml').toString('utf8'), XML);
  assert.strictEqual(readZipEntry(archive, '[Content_Types].xml').length > 0, true, 'the other entry is read as well, by its own headers');
  const local = archive.readUInt16LE(28);
  assert.strictEqual(local, 28, 'the fixture has what the live archive has: an extra field the central directory does not');
});

test('zip-read: reads a stored entry, an archive with a comment, and a name written as UTF-8', () => {
  assert.strictEqual(readZipEntry(archiveOf({ method: 0 }), 'CrmTranslations.xml').toString('utf8'), XML);
  assert.strictEqual(readZipEntry(archiveOf({ comment: 'made by a test' }), 'CrmTranslations.xml').toString('utf8'), XML);
  assert.strictEqual(readZipEntry(archiveOf({ localExtra: 0, flags: 0x0800 }), 'CrmTranslations.xml').toString('utf8'), XML);
  const named = zipOf([{ name: 'Traducci\u00f3n.xml', data: '<a/>' }], { flags: 0x0800 });
  assert.strictEqual(readZipEntry(named, 'Traducci\u00f3n.xml').toString('utf8'), '<a/>');
});

test('zip-read: an entry that follows a data descriptor is read by the central directory, whose sizes and checksum it trusts', () => {
  const archive = archiveOf({ flags: 0x000a });
  // With bit 3 set the local header may carry zeros, the real values being in the descriptor after the data and in the central directory.
  archive.writeUInt32LE(0, 14);
  archive.writeUInt32LE(0, 18);
  archive.writeUInt32LE(0, 22);
  assert.strictEqual(readZipEntry(archive, 'CrmTranslations.xml').toString('utf8'), XML);
});

test('zip-read: refuses what is not a Buffer holding an archive', () => {
  for (const [what, value] of [['a string', 'PK'], ['nothing', undefined], ['an empty buffer', Buffer.alloc(0)], ['a short buffer', Buffer.from('PK\u0005\u0006')], ['text', Buffer.from('not a zip file at all, only text that goes on for a while')]]) {
    assert.throws(() => readZipEntry(value, 'CrmTranslations.xml'), (e) => e instanceof ZipReadError, what);
  }
  assert.throws(() => readZipEntry(Buffer.from('not a zip file at all, only text that goes on for a while'), 'x'), /no end-of-central-directory record/);
});

test('zip-read: refuses an archive that is longer than the limit — and an entry whose size is', () => {
  const archive = exportZip(XML);
  assert.throws(() => readZipEntry(archive, 'CrmTranslations.xml', { maxArchiveBytes: archive.length - 1 }), /archive is larger than/);
  assert.strictEqual(readZipEntry(archive, 'CrmTranslations.xml', { maxArchiveBytes: archive.length }).length > 0, true);
  const size = Buffer.byteLength(XML);
  assert.throws(() => readZipEntry(archive, 'CrmTranslations.xml', { maxEntryBytes: size - 1 }), /'CrmTranslations\.xml' is larger than/);
  assert.strictEqual(readZipEntry(archive, 'CrmTranslations.xml', { maxEntryBytes: size }).length, size);
});

test('zip-read: refuses an entry that is missing, and a name that is in the archive twice', () => {
  assert.throws(() => readZipEntry(exportZip(XML), 'Other.xml'), /no entry named 'Other\.xml'/);
  const twice = zipOf([{ name: 'CrmTranslations.xml', data: XML }, { name: 'CrmTranslations.xml', data: '<other/>' }]);
  assert.throws(() => readZipEntry(twice, 'CrmTranslations.xml'), /'CrmTranslations\.xml' is in the archive twice/);
});

test('zip-read: refuses an end record that does not end the archive, ZIP64 and an archive in parts', () => {
  const archive = exportZip(XML);
  assert.throws(() => readZipEntry(Buffer.concat([archive, Buffer.from('trailing bytes')]), 'CrmTranslations.xml'), /no end-of-central-directory record/);
  const end = endOf(archive);
  const zip64 = Buffer.from(archive);
  zip64.writeUInt16LE(0xffff, end + 10);
  zip64.writeUInt16LE(0xffff, end + 8);
  assert.throws(() => readZipEntry(zip64, 'CrmTranslations.xml'), /ZIP64/);
  const sizeMarker = Buffer.from(archive);
  sizeMarker.writeUInt32LE(0xffffffff, end + 16);
  assert.throws(() => readZipEntry(sizeMarker, 'CrmTranslations.xml'), /ZIP64/);
  const parts = Buffer.from(archive);
  parts.writeUInt16LE(1, end + 4);
  assert.throws(() => readZipEntry(parts, 'CrmTranslations.xml'), /more than one disk/);
  const locator = Buffer.concat([archive.subarray(0, end), Buffer.from([0x50, 0x4b, 0x06, 0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), archive.subarray(end)]);
  assert.throws(() => readZipEntry(locator, 'CrmTranslations.xml'), /ZIP64/);
});

test('zip-read: refuses a central directory that is outside the archive, cut short, mis-signed or of another size than its entries', () => {
  const archive = exportZip(XML);
  const end = endOf(archive);
  const outside = Buffer.from(archive);
  outside.writeUInt32LE(archive.length, end + 16);
  assert.throws(() => readZipEntry(outside, 'CrmTranslations.xml'), /central directory lies outside/);
  const longer = Buffer.from(archive);
  longer.writeUInt32LE(longer.readUInt32LE(end + 12) + 1, end + 12);
  assert.throws(() => readZipEntry(longer, 'CrmTranslations.xml'), /central directory/);
  const signature = Buffer.from(archive);
  signature.writeUInt32LE(0x12345678, centralAt(archive));
  assert.throws(() => readZipEntry(signature, 'CrmTranslations.xml'), /entry of the central directory has a signature that is not/);
  const more = Buffer.from(archive);
  more.writeUInt16LE(3, end + 8);
  more.writeUInt16LE(3, end + 10);
  assert.throws(() => readZipEntry(more, 'CrmTranslations.xml'), /central directory/);
  const fewer = Buffer.from(archive);
  fewer.writeUInt16LE(1, end + 8);
  fewer.writeUInt16LE(1, end + 10);
  assert.throws(() => readZipEntry(fewer, 'CrmTranslations.xml'), /central directory/);
  const nameRuns = Buffer.from(archive);
  nameRuns.writeUInt16LE(0xfff0, centralAt(archive) + 28);
  assert.throws(() => readZipEntry(nameRuns, 'CrmTranslations.xml'), /runs past the central directory/);
});

test('zip-read: refuses an encrypted entry and a compression it does not read', () => {
  const encrypted = archiveOf();
  encrypted.writeUInt16LE(encrypted.readUInt16LE(centralAt(encrypted) + 8) | 0x0001, centralAt(encrypted) + 8);
  assert.throws(() => readZipEntry(encrypted, 'CrmTranslations.xml'), /is encrypted/);
  const strong = archiveOf();
  strong.writeUInt16LE(0x0040, centralAt(strong) + 8);
  assert.throws(() => readZipEntry(strong, 'CrmTranslations.xml'), /is encrypted/);
  const method = archiveOf();
  method.writeUInt16LE(12, centralAt(method) + 10);
  assert.throws(() => readZipEntry(method, 'CrmTranslations.xml'), /uses compression method 12, and only stored and deflated entries are read/);
});

test('zip-read: refuses a local header that is missing, mis-signed, truncated, or that says something else than the central directory', () => {
  const base = archiveOf();
  const mutate = (change) => { const copy = Buffer.from(base); change(copy); return copy; };
  assert.throws(() => readZipEntry(mutate((b) => b.writeUInt32LE(0, 0)), 'CrmTranslations.xml'), /local header of 'CrmTranslations\.xml' has a signature that is not/);
  assert.throws(() => readZipEntry(mutate((b) => b.writeUInt32LE(b.length, centralAt(b) + 42)), 'CrmTranslations.xml'), /local header of 'CrmTranslations\.xml' (?:is missing|lies outside)/);
  assert.throws(() => readZipEntry(mutate((b) => b.writeUInt16LE(0x0000, 6)), 'CrmTranslations.xml'), /local header of 'CrmTranslations\.xml' does not agree with the central directory/);
  assert.throws(() => readZipEntry(mutate((b) => b.writeUInt16LE(0, 8)), 'CrmTranslations.xml'), /local header of 'CrmTranslations\.xml' does not agree with the central directory/);
  assert.throws(() => readZipEntry(mutate((b) => { b[30] = 0x58; }), 'CrmTranslations.xml'), /local header of 'CrmTranslations\.xml' does not agree with the central directory/);
  assert.throws(() => readZipEntry(mutate((b) => b.writeUInt32LE(b.readUInt32LE(18) + 1, 18)), 'CrmTranslations.xml'), /local header of 'CrmTranslations\.xml' does not agree with the central directory/);
  assert.throws(() => readZipEntry(mutate((b) => b.writeUInt32LE(b.readUInt32LE(14) ^ 1, 14)), 'CrmTranslations.xml'), /local header of 'CrmTranslations\.xml' does not agree with the central directory/);
  assert.throws(() => readZipEntry(mutate((b) => b.writeUInt16LE(0xff00, 28)), 'CrmTranslations.xml'), /data of 'CrmTranslations\.xml' runs past the central directory/);
  assert.throws(() => readZipEntry(mutate((b) => b.writeUInt32LE(b.readUInt32LE(centralAt(b) + 20) + 50, centralAt(b) + 20)), 'CrmTranslations.xml'), /does not agree with the central directory|runs past the central directory/);
});

test('zip-read: refuses data that does not inflate, that inflates to another size than the archive says, or that fails its checksum', () => {
  const base = archiveOf();
  const dataAt = 30 + 'CrmTranslations.xml'.length + 28;
  const damaged = Buffer.from(base);
  damaged.fill(0xff, dataAt, dataAt + 8);
  assert.throws(() => readZipEntry(damaged, 'CrmTranslations.xml'), /'CrmTranslations\.xml' (?:did not inflate|failed its CRC-32 check|is not the size)/);
  // A stored entry with one byte changed inflates fine and has the right size: only the checksum says so.
  const stored = archiveOf({ method: 0 });
  stored[30 + 'CrmTranslations.xml'.length + 28 + 3] ^= 0x01;
  assert.throws(() => readZipEntry(stored, 'CrmTranslations.xml'), /'CrmTranslations\.xml' failed its CRC-32 check/);
  // A size smaller than the data inflates to — what a decompression bomb declares — is refused without inflating past it.
  const bomb = Buffer.from(base);
  bomb.writeUInt32LE(8, centralAt(bomb) + 24);
  bomb.writeUInt32LE(8, 22);
  assert.throws(() => readZipEntry(bomb, 'CrmTranslations.xml'), /'CrmTranslations\.xml' inflates to more than the 8 bytes the archive says/);
  // A size larger than the data is no better.
  const larger = Buffer.from(base);
  larger.writeUInt32LE(larger.readUInt32LE(centralAt(larger) + 24) + 5, centralAt(larger) + 24);
  larger.writeUInt32LE(larger.readUInt32LE(22) + 5, 22);
  assert.throws(() => readZipEntry(larger, 'CrmTranslations.xml'), /'CrmTranslations\.xml' is not the size the archive says/);
});

test('zip-read: the checksum is the one of the ZIP format (the table CRC-32, as the zlib that ships with newer Node has it)', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926, 'the standard check value of CRC-32');
  const zlib = require('node:zlib');
  if (typeof zlib.crc32 === 'function') assert.strictEqual(crc32(Buffer.from(XML)), zlib.crc32(Buffer.from(XML)));
});
