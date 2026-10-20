'use strict';
// lib/zip-read.js: the strict reader of one entry of a ZIP archive that `--verify` uses on a translation export.
//
// The export is read by a program that decides, from what it reads, whether a form's captions are right. A reader that guesses — takes the data's
// place from a header that disagrees with another, inflates past the size the archive declares, skips a checksum, reads a payload that is longer
// than the data it holds, believes a data descriptor that is not there — can turn a damaged answer into a pass. So an archive is read when every
// number in it agrees with every other, and its entries are every byte before the central directory, one after the other; and it is refused, with
// the reason, in every other case. The first test reads the archive the way the platform was measured to write it (see
// helpers/translation-export.js); the others each break one rule.
const test = require('node:test');
const assert = require('node:assert');
const { readZipEntry, ZipReadError } = require('../lib/zip-read.js');
const { zipOf, exportZip, crc32 } = require('./helpers/translation-export.js');

const XML = '<?xml version="1.0"?><Workbook>caf\u00e9 \u2014 Pesta\u00f1a Uno</Workbook>';
const archiveOf = (options) => zipOf([{ name: 'CrmTranslations.xml', data: XML }, { name: '[Content_Types].xml', data: '<Types/>' }], options);

// The offsets of the first entry's headers in an archive made by zipOf: its local header is at 0, the central directory follows the data.
const endOf = (archive) => archive.length - 22;
const centralAt = (archive) => archive.readUInt32LE(endOf(archive) + 16);
// Where each entry of an archive made by zipOf is, read from its central directory: the central header, the local header, the data and the end of it (a data descriptor starts there).
function layoutOf(archive) {
  const end = endOf(archive);
  let at = archive.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < archive.readUInt16LE(end + 10); i += 1) {
    const local = archive.readUInt32LE(at + 42);
    const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const compressed = archive.readUInt32LE(at + 20);
    entries.push({ central: at, local, dataStart, dataEnd: dataStart + compressed, compressed });
    at += 46 + archive.readUInt16LE(at + 28) + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return entries;
}
// An archive with `bytes` inserted at `at`, a place in its own bytes: the places that say where things are — the central directory's offset in the end record, and the local header offset of
// every entry that starts at or after `at` — are moved to match, so that the archive says what it says of the entries and nothing of what was put between them.
function withBytesAt(archive, at, bytes) {
  const moved = layoutOf(archive).map((entry, index) => ({ index, local: entry.local })).filter((entry) => entry.local >= at).map((entry) => entry.index);
  const grown = Buffer.concat([archive.subarray(0, at), bytes, archive.subarray(at)]);
  const end = endOf(grown);
  grown.writeUInt32LE(grown.readUInt32LE(end + 16) + bytes.length, end + 16);
  for (const index of moved) {
    const central = layoutOf(grown)[index].central;
    grown.writeUInt32LE(grown.readUInt32LE(central + 42) + bytes.length, central + 42);
  }
  return grown;
}

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

test('zip-read: an entry that is followed by its data descriptor — with the signature or without — is read by the central directory, whose sizes and checksum it trusts', () => {
  for (const descriptor of ['signed', 'unsigned']) {
    const archive = archiveOf({ descriptor });
    // With bit 3 set the local header carries zeros: the real values are in the descriptor after the data and in the central directory.
    assert.strictEqual(archive.readUInt16LE(6) & 0x0008, 0x0008, descriptor);
    assert.deepStrictEqual([archive.readUInt32LE(14), archive.readUInt32LE(18), archive.readUInt32LE(22)], [0, 0, 0], descriptor);
    assert.strictEqual(readZipEntry(archive, 'CrmTranslations.xml').toString('utf8'), XML, descriptor);
    assert.strictEqual(readZipEntry(archive, '[Content_Types].xml').toString('utf8'), '<Types/>', `${descriptor}: the entry after the first one starts where the descriptor ends`);
    assert.strictEqual(readZipEntry(archiveOf({ descriptor, method: 0 }), 'CrmTranslations.xml').toString('utf8'), XML, `${descriptor}: a stored entry as well`);
  }
  // A writer that fills the local header in as well as the descriptor is read the same.
  const filled = archiveOf({ descriptor: 'signed' });
  const [first] = layoutOf(filled);
  for (const [local, central] of [[14, 16], [18, 20], [22, 24]]) filled.writeUInt32LE(filled.readUInt32LE(first.central + central), local);
  assert.strictEqual(readZipEntry(filled, 'CrmTranslations.xml').toString('utf8'), XML);
});

test('zip-read: refuses an entry whose flags say a data descriptor follows its data when none does', () => {
  const archive = archiveOf({ descriptor: 'missing' });
  assert.strictEqual(archive.readUInt16LE(6) & 0x0008, 0x0008);
  assert.throws(() => readZipEntry(archive, 'CrmTranslations.xml'), (e) => e instanceof ZipReadError && /'CrmTranslations\.xml' says a data descriptor follows its data .*none/.test(e.message));
  // The second entry has none either — and the archive is as damaged to a reader that asks for the other one.
  assert.throws(() => readZipEntry(archive, '[Content_Types].xml'), /data descriptor/);
});

test('zip-read: refuses a data descriptor that is not the central directory\u2019s — another checksum, size or signature', () => {
  const base = archiveOf({ descriptor: 'signed' });
  const [first] = layoutOf(base);
  const at = first.dataEnd;
  const mutate = (change) => { const copy = Buffer.from(base); change(copy); return copy; };
  for (const [what, offset] of [['checksum', 4], ['compressed size', 8], ['uncompressed size', 12]]) {
    assert.throws(() => readZipEntry(mutate((b) => b.writeUInt32LE(b.readUInt32LE(at + offset) ^ 1, at + offset)), 'CrmTranslations.xml'), /data descriptor/, what);
  }
  // Neither a signature followed by the values nor the values alone.
  assert.throws(() => readZipEntry(mutate((b) => b.writeUInt32LE(0x12345678, at)), 'CrmTranslations.xml'), /data descriptor/, 'a signature that is not the format\u2019s');
  assert.throws(() => readZipEntry(mutate((b) => b.fill(0, at, at + 16)), 'CrmTranslations.xml'), /data descriptor/, 'zeros');
  // The unsigned form has the three values alone: a signed one read as unsigned (and the reverse) has the wrong ones.
  const unsigned = archiveOf({ descriptor: 'unsigned' });
  const [second] = layoutOf(unsigned);
  const damaged = Buffer.from(unsigned);
  damaged.writeUInt32LE(damaged.readUInt32LE(second.dataEnd + 8) + 1, second.dataEnd + 8);
  assert.throws(() => readZipEntry(damaged, 'CrmTranslations.xml'), /data descriptor/);
  // The descriptor is the one of its own entry: the first entry\u2019s numbers after the second entry\u2019s data are not the second\u2019s.
  const swapped = Buffer.from(base);
  const entries = layoutOf(base);
  base.copy(swapped, entries[1].dataEnd, entries[0].dataEnd, entries[0].dataEnd + 16);
  assert.throws(() => readZipEntry(swapped, '[Content_Types].xml'), /data descriptor/);
});

test('zip-read: with a data descriptor the local header holds zeros or the central directory\u2019s numbers — no others', () => {
  const base = archiveOf({ descriptor: 'signed' });
  for (const [what, offset] of [['checksum', 14], ['compressed size', 18], ['uncompressed size', 22]]) {
    const damaged = Buffer.from(base);
    damaged.writeUInt32LE(0x01020304, offset);
    assert.throws(() => readZipEntry(damaged, 'CrmTranslations.xml'), /local header of 'CrmTranslations\.xml' does not agree with the central directory/, what);
  }
});

test('zip-read: refuses data that is longer than the deflate stream it holds — into the next entry\u2019s header, or into bytes that are no entry\u2019s', () => {
  // The entry declares four bytes more than its stream: the archive\u2019s own numbers (the next entry\u2019s offset) put those bytes in the next entry\u2019s local header.
  const into = archiveOf();
  const [first, second] = layoutOf(into);
  into.writeUInt32LE(first.compressed + 4, 18);
  into.writeUInt32LE(first.compressed + 4, first.central + 20);
  assert.ok(second.local < first.dataEnd + 4, 'the fixture\u2019s payload now overlaps the next local header');
  assert.throws(() => readZipEntry(into, 'CrmTranslations.xml'), /starts inside the data of the entry before it/);
  assert.throws(() => readZipEntry(into, '[Content_Types].xml'), /starts inside the data of the entry before it/);
  // The one entry of an archive, with four bytes after its stream that both headers count in its size: nothing overlaps, and the stream still ends four bytes short of what is declared.
  const single = zipOf([{ name: 'CrmTranslations.xml', data: XML }]);
  const [only] = layoutOf(single);
  const padded = withBytesAt(single, only.dataEnd, Buffer.alloc(4, 0x50));
  padded.writeUInt32LE(only.compressed + 4, 18);
  padded.writeUInt32LE(only.compressed + 4, layoutOf(padded)[0].central + 20);
  assert.throws(() => readZipEntry(padded, 'CrmTranslations.xml'), /deflate data of 'CrmTranslations\.xml' ends 4 bytes before the end of the data the archive gives it/);
  // A stream that ends exactly where the archive says is what it always was.
  assert.strictEqual(readZipEntry(single, 'CrmTranslations.xml').toString('utf8'), XML);
});

test('zip-read: refuses an archive whose entries are not, one after the other, every byte before the central directory', () => {
  const base = archiveOf();
  const [first, second] = layoutOf(base);
  assert.strictEqual(first.local, 0);
  assert.strictEqual(second.local, first.dataEnd, 'the fixture lays its entries end to end, as the platform does');
  assert.strictEqual(second.dataEnd, centralAt(base));
  // Bytes before the first entry.
  assert.throws(() => readZipEntry(withBytesAt(base, 0, Buffer.from('PADDING!')), 'CrmTranslations.xml'), /8 bytes of the archive before the entry 'CrmTranslations\.xml' belong to no entry/);
  // Bytes between two entries, a hidden entry that the central directory does not list among them.
  assert.throws(() => readZipEntry(withBytesAt(base, second.local, Buffer.from('PK\u0003\u0004 hidden')), 'CrmTranslations.xml'), /belong to no entry/);
  // Bytes between the last entry and the central directory.
  assert.throws(() => readZipEntry(withBytesAt(base, second.dataEnd, Buffer.from('trailing')), 'CrmTranslations.xml'), /8 bytes between the last entry and the central directory belong to no entry/);
  // The central directory lists the second entry where the first one is: they are not two entries.
  const alias = Buffer.from(base);
  alias.writeUInt32LE(first.local, second.central + 42);
  assert.throws(() => readZipEntry(alias, 'CrmTranslations.xml'), /does not agree with the central directory|starts inside/);
  // The central directory lists the entries in another order than they are in: a layout, not a list, is what is checked.
  const reordered = zipOf([{ name: 'CrmTranslations.xml', data: XML }, { name: '[Content_Types].xml', data: '<Types/>' }]);
  const swapped = Buffer.from(reordered);
  const [a, b] = layoutOf(reordered);
  reordered.copy(swapped, a.central, b.central, b.central + 46 + 19);
  reordered.copy(swapped, b.central, a.central, a.central + 46 + 19);
  assert.strictEqual(readZipEntry(swapped, 'CrmTranslations.xml').toString('utf8'), XML);
  assert.strictEqual(readZipEntry(swapped, '[Content_Types].xml').toString('utf8'), '<Types/>');
});

test('zip-read: refuses bytes between the central directory and the end record — the end record follows the directory at once, as the platform writes it', () => {
  const base = archiveOf();
  const end = endOf(base);
  assert.strictEqual(centralAt(base) + base.readUInt32LE(end + 12), end, 'the fixture ends its directory where the end record starts');
  const gap = Buffer.concat([base.subarray(0, end), Buffer.from('gap!'), base.subarray(end)]);
  assert.throws(() => readZipEntry(gap, 'CrmTranslations.xml'), /4 bytes between the central directory and the end record belong to neither/);
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
