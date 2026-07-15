'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxEntries: 50000,
  maxCompressionRatio: 500,
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function normalizeEntryName(rawName) {
  const portable = String(rawName || '').replace(/\\/g, '/');
  if (!portable
      || portable.startsWith('/')
      || /^[A-Za-z]:/.test(portable)
      || /[\u0000-\u001f\u007f]/.test(portable)) {
    throw new Error(`Unsafe ZIP entry path: ${rawName}`);
  }
  const segments = portable.split('/').filter((segment, index, all) => segment !== '' || index === all.length - 1);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Unsafe ZIP entry path: ${rawName}`);
  }
  for (const segment of segments.filter(Boolean)) {
    if (/[<>:"|?*]/.test(segment)
        || /[. ]$/.test(segment)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) {
      throw new Error(`ZIP entry path is not cross-platform safe: ${rawName}`);
    }
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    throw new Error(`Unsafe ZIP entry path: ${rawName}`);
  }
  return normalized.replace(/\/$/, '');
}

function normalizeEntryPrefix(rawPrefix) {
  const portable = String(rawPrefix || '').replace(/\\/g, '/');
  const normalized = normalizeEntryName(portable);
  return portable.endsWith('/') ? `${normalized}/` : normalized;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function unixFileType(versionMadeBy, externalAttributes) {
  const platform = (versionMadeBy >>> 8) & 0xff;
  if (platform !== 3 && platform !== 19) return 0;
  return ((externalAttributes >>> 16) & 0xffff) & 0o170000;
}

function readArchiveBuffer(zipPath, label, limits) {
  try {
    const stat = fs.lstatSync(zipPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('archive must be a regular file');
    if (stat.size > limits.maxArchiveBytes) throw new Error(`archive exceeds ${limits.maxArchiveBytes} bytes`);
    return fs.readFileSync(zipPath);
  } catch (error) {
    throw new Error(`Failed to read ${label} archive ${zipPath}: ${error.message}`);
  }
}

/**
 * Opens a bounded ZIP reader after validating every central-directory entry.
 *
 * The complete archive is read only after the compressed-size cap is checked.
 * Each entry is decompressed independently with its own output cap and CRC
 * verification. This keeps Canvas package handling dependency-free while
 * preventing zip-slip, symlink, duplicate-path, and decompression-bomb writes.
 */
function openZipReader(zipPath, options = {}) {
  const label = options.label || 'ZIP';
  const unsupportedMethod = options.unsupportedMethod || 'error';
  const onWarning = typeof options.onWarning === 'function' ? options.onWarning : () => {};
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const buffer = readArchiveBuffer(zipPath, label, limits);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error(`${label} is not a readable ZIP archive: ${zipPath}`);
  if (eocdOffset + 22 > buffer.length) throw new Error(`Truncated ZIP end record: ${zipPath}`);
  const archiveCommentLength = buffer.readUInt16LE(eocdOffset + 20);
  if (eocdOffset + 22 + archiveCommentLength !== buffer.length) {
    throw new Error(`Invalid ZIP end record or trailing data: ${zipPath}`);
  }

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error(`Multi-disk ZIP archives are not supported: ${zipPath}`);
  }
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error(`ZIP64 archives are not supported: ${zipPath}`);
  }
  if (entryCount > limits.maxEntries) throw new Error(`Archive exceeds ${limits.maxEntries} entries: ${zipPath}`);
  if (centralDirectoryOffset >= eocdOffset
      || centralDirectoryOffset + centralDirectorySize > eocdOffset) {
    throw new Error(`Invalid ZIP central directory bounds: ${zipPath}`);
  }

  const entries = new Map();
  const caseFoldedNames = new Map();
  let totalUncompressed = 0;
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory entry ${index}: ${zipPath}`);
    }
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > buffer.length) throw new Error(`Truncated ZIP entry ${index}: ${zipPath}`);
    if (diskStart !== 0) throw new Error(`Multi-disk ZIP entry is not supported: ${zipPath}`);
    if ((flags & 0x1) !== 0) throw new Error(`Encrypted ZIP entries are not supported: ${zipPath}`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error(`ZIP64 entry is not supported: ${zipPath}`);
    }

    const rawName = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (rawName.includes('\ufffd')) throw new Error(`ZIP entry name is not valid UTF-8: entry ${index}`);
    const name = normalizeEntryName(rawName);
    const fileType = unixFileType(versionMadeBy, externalAttributes);
    if (fileType === 0o120000) throw new Error(`Symbolic links are not allowed in ZIP archives: ${name}`);
    if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
      throw new Error(`Special files are not allowed in ZIP archives: ${name}`);
    }
    const isDirectory = rawName.replace(/\\/g, '/').endsWith('/') || fileType === 0o040000;
    if (!isDirectory && uncompressedSize > limits.maxEntryBytes) {
      throw new Error(`ZIP entry exceeds ${limits.maxEntryBytes} bytes: ${name}`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxTotalBytes) {
      throw new Error(`Archive exceeds ${limits.maxTotalBytes} uncompressed bytes: ${zipPath}`);
    }
    if (uncompressedSize > 0
        && (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio)) {
      throw new Error(`Suspicious ZIP compression ratio for ${name}`);
    }
    if (![0, 8].includes(method) && unsupportedMethod === 'error') {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    if (localHeaderOffset + 30 > centralDirectoryOffset
        || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header for ${name}`);
    }
    const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
    const localMethod = buffer.readUInt16LE(localHeaderOffset + 8);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if ((localFlags & 0x1) !== 0 || localMethod !== method || dataStart + compressedSize > centralDirectoryOffset) {
      throw new Error(`Invalid ZIP local entry bounds for ${name}`);
    }
    const localRawName = buffer.slice(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength).toString('utf8');
    if (normalizeEntryName(localRawName) !== name) throw new Error(`ZIP local/central name mismatch for ${name}`);
    if (entries.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    const folded = name.normalize('NFC').toLocaleLowerCase('en-US');
    if (caseFoldedNames.has(folded)) {
      throw new Error(`Case-insensitive ZIP path collision: ${caseFoldedNames.get(folded)} and ${name}`);
    }
    caseFoldedNames.set(folded, name);
    entries.set(name, {
      name,
      method,
      compressedSize,
      uncompressedSize,
      expectedCrc32,
      localHeaderOffset,
      dataStart,
      isDirectory,
    });
    offset = nextOffset;
  }
  if (offset !== centralDirectoryOffset + centralDirectorySize) {
    throw new Error(`ZIP central directory size mismatch: ${zipPath}`);
  }
  const foldedPrefixes = new Map();
  for (const entry of entries.values()) {
    const segments = entry.name.split('/');
    for (let count = 1; count <= segments.length; count += 1) {
      const prefixName = segments.slice(0, count).join('/');
      const foldedPrefix = prefixName.normalize('NFC').toLocaleLowerCase('en-US');
      const existingPrefix = foldedPrefixes.get(foldedPrefix);
      if (existingPrefix && existingPrefix !== prefixName) {
        throw new Error(`Case-insensitive ZIP path collision: ${existingPrefix} and ${prefixName}`);
      }
      foldedPrefixes.set(foldedPrefix, prefixName);
    }
    for (let count = 1; count < segments.length; count += 1) {
      const parentName = segments.slice(0, count).join('/');
      const explicitParentName = caseFoldedNames.get(parentName.normalize('NFC').toLocaleLowerCase('en-US'));
      const explicitParent = explicitParentName ? entries.get(explicitParentName) : null;
      if (explicitParent && !explicitParent.isDirectory) {
        throw new Error(`ZIP file/directory path collision: ${explicitParent.name} contains ${entry.name}`);
      }
    }
  }

  function readEntry(name) {
    const entry = entries.get(normalizeEntryName(name));
    if (!entry || entry.isDirectory) return entry && entry.isDirectory ? Buffer.alloc(0) : null;
    if (![0, 8].includes(entry.method)) {
      onWarning(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
      return null;
    }
    const compressed = buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    const output = entry.method === 0
      ? Buffer.from(compressed)
      : zlib.inflateRawSync(compressed, { maxOutputLength: limits.maxEntryBytes });
    if (output.length !== entry.uncompressedSize) throw new Error(`ZIP size mismatch for ${entry.name}`);
    if (crc32(output) !== entry.expectedCrc32) throw new Error(`ZIP CRC mismatch for ${entry.name}`);
    return output;
  }

  return {
    getEntry(name) {
      return entries.get(normalizeEntryName(name)) || null;
    },
    entries() {
      return [...entries.values()].map((entry) => ({ ...entry }));
    },
    hasPrefix(prefixPath) {
      const prefix = normalizeEntryPrefix(prefixPath);
      for (const name of entries.keys()) if (name.startsWith(prefix)) return true;
      return false;
    },
    listEntries(prefixPath, suffix) {
      const prefix = normalizeEntryPrefix(prefixPath);
      return [...entries.keys()]
        .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
        .sort();
    },
    readEntry,
    extractTo(destinationRoot) {
      const root = path.resolve(destinationRoot);
      fs.mkdirSync(root, { recursive: true });
      for (const entry of [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))) {
        const destination = path.resolve(root, ...entry.name.split('/'));
        if (!isContained(root, destination)) throw new Error(`ZIP entry escapes extraction root: ${entry.name}`);
        if (entry.isDirectory) {
          fs.mkdirSync(destination, { recursive: true });
          continue;
        }
        const data = readEntry(entry.name);
        if (data == null) throw new Error(`Unable to extract ZIP entry: ${entry.name}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, data, { flag: 'wx' });
      }
    },
  };
}

module.exports = {
  DEFAULT_LIMITS,
  crc32,
  normalizeEntryName,
  openZipReader,
};
