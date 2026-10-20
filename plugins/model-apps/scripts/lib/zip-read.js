'use strict';
// A strict reader of ONE entry of a ZIP archive held in memory — what `--verify` needs to open a translation export (lib/translation-labels.js), and no more.
//
// WHY ITS OWN READER. The plugin has no dependency to read an archive with (every script runs as it is installed, with Node's own modules), and the export is
// read by a program that decides, from what it finds, whether a form's captions are right. A reader that is lenient — takes the data's place from a header
// that disagrees with another, inflates past the size the archive declares, skips the checksum — can turn a damaged answer into a pass. So an archive is read
// when every number in it agrees with every other, and is refused, with the reason, in every other case: a refusal costs `--verify` a caption it can only list
// as unverified, which is where it was before it read exports at all.
//
// WHAT IT READS: the layout every ZIP writer produces (https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)
//
//   [local header 0x04034b50 · name · extra][data] … [central header 0x02014b50 · name · extra · comment] … [end record 0x06054b50 · comment]
//
// The end record, found from the END of the file (the archive's comment may be anything up to 65,535 bytes, so the record is the last one whose comment length
// reaches the end of the file exactly), points at the central directory, which lists every entry with the place of its local header; the local header says again
// where its data starts. Both headers are read, because they are written by one program and disagree only when the archive is damaged or hand-made.
//   - The platform's own export, measured: two deflated entries, flags 0x0002 (the compressor's "maximum" hint, not a data descriptor), version needed 20 —
//     and an extra field of 28 bytes on each LOCAL header and none on the central one. So the data is found from the LOCAL header's own name and extra lengths, never
//     from the central directory's. Its entries lie end to end from the first byte, the central directory follows the last one at once, and the end record follows
//     the central directory at once: every byte of it belongs to an entry, the directory or the end record.
//   - A data descriptor (flag bit 3) is accepted when it is there: the local header's checksum and sizes may then be zero, and the descriptor that follows the data —
//     `0x08074b50` and the checksum and both sizes, or (the older form the format also allows) those three alone — must hold the central directory's numbers.
//
// THE LAYOUT IS CHECKED, for every entry and not only the one asked for: a deflate stream ends where it ends, whatever follows it, so an entry whose declared size runs
// four bytes into the next entry's header still inflates, to the right size and checksum. What says where an entry ends is therefore the layout as a whole — the
// entries, in the order of their places, must be every byte before the central directory, one after the other, each the local header, the data and its descriptor —
// and the deflate stream of the entry read must take up exactly the data the archive gives it.
//
// WHAT IT REFUSES, all of it as a `ZipReadError`: a file with no end record (or text after it), an archive in several parts, ZIP64 (the sizes and offsets of an
// export of this kind fit 32 bits, and a reader that half-understands ZIP64 can accept a file it has misread), a central directory that is outside the file, cut
// short, not the size of its entries or not followed by the end record at once, an entry that is encrypted, one that is neither stored nor deflated, a name that is
// in the archive twice, a local header that is missing or says something other than the central one, data that runs into the central directory, an entry that starts
// inside another or after bytes that belong to none, a data descriptor that the flags announce and that is not there or not the central directory's, data that does
// not inflate, a deflate stream that ends before its data does, data that is not the size the archive declares, and data whose CRC-32 is not the one declared.
// Inflating never goes past the declared size, so a small archive cannot be made to fill memory.
const zlib = require('node:zlib');

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
// The optional signature of a data descriptor (APPNOTE 4.3.9.3: "commonly adopted", not required — so a descriptor without it is read as well).
const DATA_DESCRIPTOR = 0x08074b50;
// The ZIP64 end-of-central-directory locator, which sits right before the end record of a ZIP64 archive (20 bytes).
const ZIP64_END_LOCATOR = 0x07064b50;
const END_RECORD_SIZE = 22;
const MAX_COMMENT_BYTES = 0xffff;

// Guards against an unexpectedly large answer, not limits of the service: the archive is held, and so is what it inflates to. A translation workbook of an app's
// solution is some tens of kilobytes, and one that is megabytes is a very large solution; these leave room for that and stop short of the memory a string can hold.
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;

// General-purpose flag bits: 0 = encrypted, 3 = the sizes and CRC follow the data, 6 = strong encryption, 11 = the name is UTF-8.
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8_NAME = 0x0800;

class ZipReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipReadError';
  }
}
const refuse = (message) => { throw new ZipReadError(message); };

// CRC-32 as the ZIP format has it (reflected, polynomial 0xEDB88320, https://www.w3.org/TR/png/#D-CRCAppendix). A table, because the check runs over the whole
// of an entry; `zlib.crc32` is Node 22.2 and later, and the plugin runs on Node 20 as well.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Where the end record is: the last one in the file whose comment ends the file.
function findEndRecord(archive) {
  const last = archive.length - END_RECORD_SIZE;
  for (let at = last; at >= Math.max(0, last - MAX_COMMENT_BYTES); at -= 1) {
    if (archive.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY && at + END_RECORD_SIZE + archive.readUInt16LE(at + 20) === archive.length) return at;
  }
  return refuse('the archive has no end-of-central-directory record');
}

// Every entry the central directory lists, each with the fields the data is read by. The numbers are the archive's and are not trusted: every read is bounded.
function readCentralDirectory(archive) {
  const end = findEndRecord(archive);
  const disk = archive.readUInt16LE(end + 4);
  const directoryDisk = archive.readUInt16LE(end + 6);
  const onThisDisk = archive.readUInt16LE(end + 8);
  const total = archive.readUInt16LE(end + 10);
  const size = archive.readUInt32LE(end + 12);
  const offset = archive.readUInt32LE(end + 16);
  if ((end >= 20 && archive.readUInt32LE(end - 20) === ZIP64_END_LOCATOR) || onThisDisk === 0xffff || total === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    refuse('a ZIP64 archive is not read');
  }
  if (disk !== 0 || directoryDisk !== 0 || onThisDisk !== total) refuse('an archive that spans more than one disk is not read');
  const directoryEnd = offset + size;
  if (directoryEnd > end) refuse('the central directory lies outside the archive');
  if (directoryEnd < end) refuse(`${end - directoryEnd} bytes between the central directory and the end record belong to neither`);
  const entries = [];
  let at = offset;
  for (let i = 0; i < total; i += 1) {
    if (at + 46 > directoryEnd) refuse('an entry of the central directory is cut short');
    if (archive.readUInt32LE(at) !== CENTRAL_DIRECTORY_HEADER) refuse('an entry of the central directory has a signature that is not 0x02014b50');
    const flags = archive.readUInt16LE(at + 8);
    const nameLength = archive.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
    if (next > directoryEnd) refuse('an entry of the central directory runs past the central directory');
    const entry = {
      flags,
      method: archive.readUInt16LE(at + 10),
      crc: archive.readUInt32LE(at + 16),
      compressedSize: archive.readUInt32LE(at + 20),
      uncompressedSize: archive.readUInt32LE(at + 24),
      startDisk: archive.readUInt16LE(at + 34),
      localHeaderOffset: archive.readUInt32LE(at + 42),
      nameBytes: archive.subarray(at + 46, at + 46 + nameLength),
    };
    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff || entry.localHeaderOffset === 0xffffffff) refuse('a ZIP64 entry is not read');
    if (entry.startDisk !== 0) refuse('an entry that starts on another disk is not read');
    // A name is UTF-8 when its flag says so, and otherwise the code page the archive was written in: what the names of an export use is ASCII, which latin1 reads as is.
    entry.name = entry.nameBytes.toString(flags & FLAG_UTF8_NAME ? 'utf8' : 'latin1');
    entries.push(entry);
    at = next;
  }
  if (at !== directoryEnd) refuse('the central directory is not the size its entries make');
  return { entries, directoryStart: offset };
}

// The size of the data descriptor at `at`, which the flags of `entry` say follows its data: 16 bytes with the signature, 12 without — and its numbers must be the
// central directory's. The bytes there are read as either form only up to `limit`, the start of the central directory.
function descriptorSize(archive, entry, at, limit) {
  const holdsTheNumbers = (p) => p + 12 <= limit
    && archive.readUInt32LE(p) === entry.crc && archive.readUInt32LE(p + 4) === entry.compressedSize && archive.readUInt32LE(p + 8) === entry.uncompressedSize;
  if (at + 16 <= limit && archive.readUInt32LE(at) === DATA_DESCRIPTOR && holdsTheNumbers(at + 4)) return 16;
  if (holdsTheNumbers(at)) return 12;
  return refuse(`the entry '${entry.name}' says a data descriptor follows its data and none does (neither the signature 0x08074b50 with the central directory's checksum and sizes, nor those alone)`);
}

// Where the local header of `entry` puts its data, and where the entry ends (after its data descriptor, if it has one) — once that header is found to say what the
// central directory says.
function placeOf(archive, entry, directoryStart) {
  const name = entry.name;
  const at = entry.localHeaderOffset;
  if (at + 30 > directoryStart) refuse(`the local header of '${name}' lies outside the data of the archive`);
  if (archive.readUInt32LE(at) !== LOCAL_FILE_HEADER) refuse(`the local header of '${name}' has a signature that is not 0x04034b50`);
  const nameStart = at + 30;
  const nameLength = archive.readUInt16LE(at + 26);
  const dataStart = nameStart + nameLength + archive.readUInt16LE(at + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > directoryStart) refuse(`the data of '${name}' runs past the central directory`);
  const descriptor = (entry.flags & FLAG_DATA_DESCRIPTOR) !== 0;
  // With a data descriptor the local header may hold zeros where the checksum and sizes go (a writer that streams does not know them yet), or the numbers themselves.
  const agrees = (offset, value) => archive.readUInt32LE(at + offset) === value || (descriptor && archive.readUInt32LE(at + offset) === 0);
  const disagrees = archive.readUInt16LE(at + 6) !== entry.flags
    || archive.readUInt16LE(at + 8) !== entry.method
    || !archive.subarray(nameStart, nameStart + nameLength).equals(entry.nameBytes)
    || !agrees(14, entry.crc) || !agrees(18, entry.compressedSize) || !agrees(22, entry.uncompressedSize);
  if (disagrees) refuse(`the local header of '${name}' does not agree with the central directory`);
  return { entry, start: at, dataStart, dataEnd, end: descriptor ? dataEnd + descriptorSize(archive, entry, dataEnd, directoryStart) : dataEnd };
}

// The places of every entry, checked to be what the platform writes: the entries, in the order of their places (which need not be the central directory's order),
// are every byte from the start of the archive to the central directory, one after the other. Nothing is hidden between them, and no entry's declared data reaches
// into another — which a deflate stream would not notice (see the header).
function layoutOf(archive, entries, directoryStart) {
  const places = entries.map((entry) => placeOf(archive, entry, directoryStart)).sort((a, b) => a.start - b.start);
  let previous = null;
  let cursor = 0;
  for (const place of places) {
    const name = place.entry.name;
    if (place.start < cursor) refuse(`the entry '${name}' starts inside the data of the entry before it ('${previous.entry.name}')`);
    if (place.start > cursor) {
      refuse(previous
        ? `${place.start - cursor} bytes between the entries '${previous.entry.name}' and '${name}' belong to no entry`
        : `${place.start} bytes of the archive before the entry '${name}' belong to no entry`);
    }
    previous = place;
    cursor = place.end;
  }
  if (cursor !== directoryStart) refuse(`${directoryStart - cursor} bytes between the last entry and the central directory belong to no entry`);
  return new Map(places.map((place) => [place.entry, place]));
}

// What a deflate stream is, when it inflates: the bytes it was made from, and how many bytes of `stored` the stream took up. zlib stops at the end of the stream and
// leaves what follows unread; `engine.bytesWritten` counts the bytes it took (measured on Node 20.20 and 22.13: a 42-byte stream followed by 0, 1, 4 or 100 other bytes
// reports 42 every time), so a stream that ends before the data does is told from one that fills it. https://nodejs.org/api/zlib.html#zlibbyteswritten
function inflateWhole(stored, maxOutputLength) {
  const { buffer, engine } = zlib.inflateRawSync(stored, { maxOutputLength, info: true });
  return { data: buffer, consumed: engine.bytesWritten };
}

function entryData(archive, place) {
  const { entry } = place;
  const name = entry.name;
  const stored = archive.subarray(place.dataStart, place.dataEnd);
  let data = stored;
  if (entry.method === 8) {
    let inflated;
    try {
      // One byte more than the declared size, so that data that inflates to more is told from data that inflates to exactly that: nothing larger is ever built.
      inflated = inflateWhole(stored, Math.max(1, entry.uncompressedSize + 1));
    } catch (err) {
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') refuse(`the entry '${name}' inflates to more than the ${entry.uncompressedSize} bytes the archive says`);
      return refuse(`the entry '${name}' did not inflate (${(err && err.message) || err})`);
    }
    if (inflated.consumed !== stored.length) refuse(`the deflate data of '${name}' ends ${stored.length - inflated.consumed} bytes before the end of the data the archive gives it`);
    data = inflated.data;
  }
  if (data.length !== entry.uncompressedSize) refuse(`the entry '${name}' is not the size the archive says (${data.length} bytes, not ${entry.uncompressedSize})`);
  if (crc32(data) !== entry.crc) refuse(`the entry '${name}' failed its CRC-32 check`);
  return data;
}

/**
 * The bytes of the entry named `name` of `archive`.
 * @param {Buffer} archive the whole archive
 * @param {string} name the entry's name, as the archive spells it
 * @param {{ maxArchiveBytes?: number, maxEntryBytes?: number }} [limits]
 * @returns {Buffer}
 * @throws {ZipReadError} when the archive is not one this reads with certainty, or has no such entry, or has two
 */
function readZipEntry(archive, name, { maxArchiveBytes = MAX_ARCHIVE_BYTES, maxEntryBytes = MAX_ENTRY_BYTES } = {}) {
  if (!Buffer.isBuffer(archive)) refuse('the archive is not a Buffer');
  if (archive.length > maxArchiveBytes) refuse(`the archive is larger than ${maxArchiveBytes} bytes`);
  if (archive.length < END_RECORD_SIZE) refuse('the archive has no end-of-central-directory record');
  const { entries, directoryStart } = readCentralDirectory(archive);
  const named = entries.filter((entry) => entry.name === name);
  if (named.length === 0) refuse(`the archive has no entry named '${name}'`);
  if (named.length > 1) refuse(`the entry '${name}' is in the archive twice`);
  const [entry] = named;
  // What the entry asked for must be before its place is looked at: an entry that cannot be read is refused as that, whatever the layout says.
  if (entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) refuse(`the entry '${name}' is encrypted`);
  if (entry.method !== 0 && entry.method !== 8) refuse(`the entry '${name}' uses compression method ${entry.method}, and only stored and deflated entries are read`);
  if (entry.uncompressedSize > maxEntryBytes) refuse(`the entry '${name}' is larger than ${maxEntryBytes} bytes`);
  return entryData(archive, layoutOf(archive, entries, directoryStart).get(entry));
}

module.exports = { readZipEntry, ZipReadError, crc32, MAX_ARCHIVE_BYTES, MAX_ENTRY_BYTES };
