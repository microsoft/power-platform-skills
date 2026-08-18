#!/usr/bin/env node

// Validates that export-solution completed: checks that a solution zip was written to disk
// and that Solution.xml is present inside it.
// Gracefully exits 0 when no solution zip is found (not an export-solution session).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { approve, block, runValidation, findProjectRoot, readDeferralMarker } = require('../../../scripts/lib/validation-helpers');

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT_LENGTH = 0xffff;
const MIN_END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_SOLUTION_ZIP_SIZE = 100 * 1024 * 1024;
const MAX_SOLUTION_XML_SIZE = 100 * 1024 * 1024;

function findEndOfCentralDirectory(archive) {
  const firstPossibleOffset = Math.max(
    0,
    archive.length - MIN_END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ZIP_COMMENT_LENGTH
  );

  for (let offset = archive.length - MIN_END_OF_CENTRAL_DIRECTORY_SIZE; offset >= firstPossibleOffset; offset--) {
    if (archive.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;

    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + MIN_END_OF_CENTRAL_DIRECTORY_SIZE + commentLength === archive.length) {
      return offset;
    }
  }

  throw new Error('the ZIP end-of-central-directory record is missing');
}

/**
 * Reads ZIP entry metadata without extracting files.
 *
 * ZIP archives end with an EOCD record that points to central-directory entries:
 *   0x02014b50 | metadata | name length | extra length | comment length | file name
 * The offsets and lengths are untrusted, so every read is bounded before use. ZIP64
 * and multi-disk archives are rejected because Power Platform solution packages do
 * not need either format and partially parsing them could approve a malformed file.
 * See: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */
function readZipEntries(archive) {
  const eocdOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = archive.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error('multi-disk ZIP archives are not supported');
  }
  if (
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 archives are not supported');
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryEnd > eocdOffset || centralDirectoryEnd > archive.length) {
    throw new Error('the ZIP central directory is outside the archive');
  }

  const entries = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index++) {
    if (offset + 46 > centralDirectoryEnd) {
      throw new Error('a ZIP central-directory entry is truncated');
    }
    if (archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
      throw new Error('a ZIP central-directory entry has an invalid signature');
    }

    const flags = archive.readUInt16LE(offset + 8);
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraFieldLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const startingDisk = archive.readUInt16LE(offset + 34);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + fileNameLength + extraFieldLength + commentLength;

    if (entryEnd > centralDirectoryEnd) {
      throw new Error('a ZIP central-directory entry exceeds its declared bounds');
    }
    if (startingDisk !== 0) {
      throw new Error('multi-disk ZIP entries are not supported');
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error('ZIP64 entries are not supported');
    }

    const nameBytes = archive.subarray(offset + 46, offset + 46 + fileNameLength);
    entries.push({
      name: nameBytes.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1'),
      nameBytes,
      flags,
      compressionMethod,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      centralDirectoryStart: centralDirectoryOffset,
    });
    offset = entryEnd;
  }

  if (offset !== centralDirectoryEnd) {
    throw new Error('the ZIP central directory size does not match its entries');
  }

  return entries;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readCompressedEntryData(archive, entry) {
  const localHeaderEnd = entry.localHeaderOffset + 30;
  if (localHeaderEnd > entry.centralDirectoryStart || localHeaderEnd > archive.length) {
    throw new Error(`the local header for '${entry.name}' is truncated`);
  }
  if (archive.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`the local header for '${entry.name}' has an invalid signature`);
  }

  const localFlags = archive.readUInt16LE(entry.localHeaderOffset + 6);
  const localCompressionMethod = archive.readUInt16LE(entry.localHeaderOffset + 8);
  const localCrc = archive.readUInt32LE(entry.localHeaderOffset + 14);
  const localCompressedSize = archive.readUInt32LE(entry.localHeaderOffset + 18);
  const localUncompressedSize = archive.readUInt32LE(entry.localHeaderOffset + 22);
  const localFileNameLength = archive.readUInt16LE(entry.localHeaderOffset + 26);
  const localExtraFieldLength = archive.readUInt16LE(entry.localHeaderOffset + 28);
  const fileNameStart = localHeaderEnd;
  const dataStart = fileNameStart + localFileNameLength + localExtraFieldLength;
  const dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > entry.centralDirectoryStart || dataEnd > archive.length) {
    throw new Error(`the compressed data for '${entry.name}' is truncated`);
  }
  if (localFlags !== entry.flags || localCompressionMethod !== entry.compressionMethod) {
    throw new Error(`the local header for '${entry.name}' disagrees with the central directory`);
  }
  if (
    (entry.flags & 0x0008) === 0 &&
    (
      localCrc !== entry.crc ||
      localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize
    )
  ) {
    throw new Error(`the local header sizes or checksum for '${entry.name}' disagree with the central directory`);
  }
  if (!archive.subarray(fileNameStart, fileNameStart + localFileNameLength).equals(entry.nameBytes)) {
    throw new Error(`the local header name for '${entry.name}' disagrees with the central directory`);
  }

  return archive.subarray(dataStart, dataEnd);
}

function readEntryData(archive, entry) {
  const compressedData = readCompressedEntryData(archive, entry);
  if ((entry.flags & 0x0001) !== 0) {
    throw new Error(`the required entry '${entry.name}' is encrypted`);
  }
  if (entry.uncompressedSize > MAX_SOLUTION_XML_SIZE) {
    throw new Error(`the required entry '${entry.name}' is unexpectedly large`);
  }

  let data;
  if (entry.compressionMethod === 0) {
    data = compressedData;
  } else if (entry.compressionMethod === 8) {
    data = zlib.inflateRawSync(compressedData, {
      maxOutputLength: Math.max(1, entry.uncompressedSize + 1),
    });
  } else {
    throw new Error(`the required entry '${entry.name}' uses unsupported compression method ${entry.compressionMethod}`);
  }

  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc) {
    throw new Error(`the required entry '${entry.name}' failed its integrity check`);
  }

  return data;
}

function validateZipContainsSolutionXml(zipPath) {
  const archive = fs.readFileSync(zipPath);
  const entries = readZipEntries(archive);

  // Checking every local header catches truncated payloads and mismatched metadata
  // without expanding arbitrary entries. Only Solution.xml is decompressed because
  // it is the required manifest and its CRC must prove the entry itself is intact.
  for (const entry of entries) {
    readCompressedEntryData(archive, entry);
  }

  const solutionEntries = entries.filter((entry) => {
    return entry.name.replace(/\\/g, '/').toLowerCase() === 'solution.xml';
  });

  if (solutionEntries.length === 0) {
    return false;
  }
  if (solutionEntries.length > 1) {
    throw new Error('the ZIP contains duplicate Solution.xml entries');
  }

  readEntryData(archive, solutionEntries[0]);
  return true;
}

runValidation(async (cwd) => {
  if (readDeferralMarker(findProjectRoot(cwd) || cwd)) return approve();  // ALM deferred — silent-approve.
  const projectRoot = findProjectRoot(cwd) || cwd;

  // Search for solution zip files written this session
  // Look for *_managed.zip or *_unmanaged.zip patterns in the project root and subdirs
  const zipFiles = [];

  function scanForZips(dir, depth = 0) {
    if (depth > 2) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          scanForZips(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile() && (entry.name.endsWith('_managed.zip') || entry.name.endsWith('_unmanaged.zip'))) {
          zipFiles.push(path.join(dir, entry.name));
        }
      }
    } catch {}
  }

  scanForZips(projectRoot);

  // No solution zip found — not an export-solution session
  if (zipFiles.length === 0) return approve();

  // Validate each zip found
  for (const zipPath of zipFiles) {
    let stat;
    try {
      stat = fs.statSync(zipPath);
    } catch (error) {
      return block(`Solution zip '${path.basename(zipPath)}' could not be read: ${error.message}`);
    }

    if (stat.size < 1000) {
      return block(`Solution zip '${path.basename(zipPath)}' is too small (${stat.size} bytes). The export may have been truncated or failed.`);
    }
    if (stat.size > MAX_SOLUTION_ZIP_SIZE) {
      return block(`Solution zip '${path.basename(zipPath)}' exceeds the supported 100 MiB package size.`);
    }

    try {
      if (!validateZipContainsSolutionXml(zipPath)) {
        return block(`Solution zip '${path.basename(zipPath)}' does not contain solution.xml. The export appears corrupt.`);
      }
    } catch (error) {
      return block(`Solution zip '${path.basename(zipPath)}' could not be validated: ${error.message}`);
    }
  }

  return approve();
});
