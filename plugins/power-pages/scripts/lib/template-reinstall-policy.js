'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { compareVersions } = require('./bump-solution-version');

function decideReinstall({ installed, installedVersion, availableVersion, detectionFailed } = {}) {
  if (detectionFailed) return 'ask';
  if (!installed) return 'import';
  if (!installedVersion || !availableVersion) return 'ask';
  if (compareVersions(availableVersion, installedVersion) > 0) return 'confirm-update';
  return 'offer-clone';
}

function decodeZipEntry({ method, bytes }) {
  if (method === 0) return bytes;
  if (method === 8) return zlib.inflateRawSync(bytes);
  throw new Error(`Unsupported ZIP compression method for solution.xml: ${method}`);
}

function readEntryFromCentralDirectory(data, wantedName) {
  for (let i = 0; i <= data.length - 46; i++) {
    if (data.readUInt32LE(i) !== 0x02014b50) continue;
    const method = data.readUInt16LE(i + 10);
    const compressedSize = data.readUInt32LE(i + 20);
    const fileNameLength = data.readUInt16LE(i + 28);
    const extraLength = data.readUInt16LE(i + 30);
    const commentLength = data.readUInt16LE(i + 32);
    const localHeaderOffset = data.readUInt32LE(i + 42);
    const nameStart = i + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > data.length) continue;
    const name = data.subarray(nameStart, nameEnd).toString('utf8');
    if (name.toLowerCase() !== wantedName) {
      i = Math.max(i, nameEnd + extraLength + commentLength - 1);
      continue;
    }
    if (localHeaderOffset + 30 > data.length || data.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error('solution.xml ZIP local header is missing or invalid');
    }
    const localNameLength = data.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = data.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > data.length) throw new Error('solution.xml ZIP entry is truncated');
    return decodeZipEntry({ method, bytes: data.subarray(dataStart, dataEnd) }).toString('utf8');
  }
  return null;
}

function readEntryFromLocalHeaders(data, wantedName) {
  for (let i = 0; i <= data.length - 30; i++) {
    if (data.readUInt32LE(i) !== 0x04034b50) continue;
    const method = data.readUInt16LE(i + 8);
    const compressedSize = data.readUInt32LE(i + 18);
    const fileNameLength = data.readUInt16LE(i + 26);
    const extraLength = data.readUInt16LE(i + 28);
    const nameStart = i + 30;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > data.length) continue;
    const name = data.subarray(nameStart, nameEnd).toString('utf8');
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (name.toLowerCase() === wantedName) {
      if (compressedSize === 0 || dataEnd > data.length) throw new Error('solution.xml ZIP entry is truncated');
      return decodeZipEntry({ method, bytes: data.subarray(dataStart, dataEnd) }).toString('utf8');
    }
    i = Math.max(i, dataEnd - 1);
  }
  return null;
}

function readSolutionXml(zipPath, deps = {}) {
  // Dataverse solution zips contain a root `solution.xml` descriptor with:
  //   <UniqueName>contoso_template</UniqueName>
  //   <Version>1.0.0.0</Version>
  //   <Managed>0</Managed>
  // Read it directly from ZIP headers instead of shelling out to `unzip`: Windows
  // plugin hosts often do not have that utility on PATH.
  const fsImpl = deps.fs || fs;
  const data = fsImpl.readFileSync(zipPath);
  const xml = readEntryFromCentralDirectory(data, 'solution.xml') || readEntryFromLocalHeaders(data, 'solution.xml');
  if (!xml) throw new Error('solution.xml not found in template solution zip');
  return xml;
}

function getTag(xml, tagName) {
  const match = String(xml || '').match(new RegExp(`<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`, 'i'));
  return match ? match[1].trim() : null;
}

function inspectSolutionXml(xml) {
  const uniqueName = getTag(xml, 'UniqueName');
  const version = getTag(xml, 'Version');
  const managed = getTag(xml, 'Managed');
  if (!uniqueName || !version) {
    return { ok: false, error: 'solution.xml did not include UniqueName and Version' };
  }
  return { ok: true, uniqueName, version, managed: managed === '1' };
}

function inspectSolutionZip(zipPath, deps = {}) {
  try {
    return inspectSolutionXml(deps.solutionXml || readSolutionXml(zipPath, deps));
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function inspectSolutionDirectory(solutionPath, deps = {}) {
  try {
    const fsImpl = deps.fs || fs;
    const rootStat = fsImpl.lstatSync(solutionPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { ok: false, error: 'Template solution source must be a directory and not a symbolic link' };
    }
    const solutionXmlPath = path.join(solutionPath, 'Other', 'Solution.xml');
    const xmlStat = fsImpl.lstatSync(solutionXmlPath);
    if (!xmlStat.isFile() || xmlStat.isSymbolicLink()) {
      return { ok: false, error: 'Template solution source is missing Other/Solution.xml' };
    }
    return inspectSolutionXml(fsImpl.readFileSync(solutionXmlPath, 'utf8'));
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  decideReinstall,
  inspectSolutionDirectory,
  inspectSolutionXml,
  inspectSolutionZip,
  readSolutionXml,
};
