'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openZipReader } = require('./safe-zip.js');

const MAX_INPUT_FILES = 100000;
const MAX_INPUT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 1024 * 1024 * 1024;
const ROOT_FILES = new Set(['Properties.json', 'Header.json', 'ComponentsMetadata.json']);
const REFERENCE_FILES = new Set([
  'References/DataSources.json',
  'References/Resources.json',
  'References/Themes.json',
  'References/ModernThemes.json',
  'References/Templates.json',
]);

function portable(relativePath) {
  const value = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`unsafe Canvas source input path: ${relativePath}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`unsafe Canvas source input path: ${relativePath}`);
  }
  return path.posix.normalize(value);
}

function isSupportedCanvasInput(relativePath) {
  const value = portable(relativePath);
  if (ROOT_FILES.has(value) || REFERENCE_FILES.has(value)) return true;
  if (/^(?:Src|src)\/.+\.pa\.yaml$/.test(value)) return true;
  if (/^(?:Tests|tests)\/[^/]+\.(?:fx|pa)\.yaml$/.test(value)) return true;
  if (/^(?:Connections|connections)\/[^/]+\.json$/.test(value)) return true;
  if (/^(?:Controls|Components)\/[^/]+\.json$/.test(value)) return true;
  if (/^Resources\/[^/]+$/.test(value)) return true;
  if (/^Assets\/Images\/[^/]+$/.test(value)) return true;
  if (/^pkgs\/Components\/[^/]+\/[^/]+\.json$/.test(value)) return true;
  return false;
}

function findMsapr(root) {
  return fs.readdirSync(root)
    .filter((name) => name.toLowerCase().endsWith('.msapr'))
    .map((name) => path.join(root, name))
    .filter((file) => {
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink();
    })
    .sort()[0] || null;
}

function readDiskInputs(root) {
  const inputs = new Map();
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in Canvas source: ${relative}`);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || !isSupportedCanvasInput(relative)) continue;
      const stat = fs.lstatSync(absolute);
      if (stat.size > MAX_INPUT_FILE_BYTES) throw new Error(`Canvas source input exceeds ${MAX_INPUT_FILE_BYTES} bytes: ${relative}`);
      inputs.set(portable(relative), fs.readFileSync(absolute));
    }
  }
  return inputs;
}

function mergeArchiveInputs(root, inputs) {
  const msapr = findMsapr(root);
  if (!msapr) return;
  const archive = openZipReader(msapr, { label: 'MSAPR' });
  for (const entry of archive.entries().sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory || !entry.name.startsWith('msapp/')) continue;
    const relative = portable(entry.name.slice('msapp/'.length));
    if (!isSupportedCanvasInput(relative) || inputs.has(relative)) continue;
    const bytes = archive.readEntry(entry.name);
    if (bytes == null) throw new Error(`Unable to read supported MSAPR source input: ${entry.name}`);
    if (bytes.length > MAX_INPUT_FILE_BYTES) throw new Error(`Canvas source input exceeds ${MAX_INPUT_FILE_BYTES} bytes: ${relative}`);
    inputs.set(relative, bytes);
  }
}

function computeCanvasSourceInputDigest(sourceRoot) {
  const requestedRoot = path.resolve(sourceRoot);
  if (!fs.existsSync(requestedRoot) || !fs.lstatSync(requestedRoot).isDirectory()) {
    throw new Error('Canvas source root does not exist or is not a directory');
  }
  const root = fs.realpathSync(requestedRoot);
  const inputs = readDiskInputs(root);
  mergeArchiveInputs(root, inputs);
  const rows = [...inputs.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (rows.length === 0) throw new Error('Canvas source contains no supported semantic inputs');
  if (rows.length > MAX_INPUT_FILES) throw new Error(`Canvas source exceeds ${MAX_INPUT_FILES} supported input files`);
  let totalBytes = 0;
  const hasher = crypto.createHash('sha256');
  for (const [relative, bytes] of rows) {
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_INPUT_BYTES) throw new Error(`Canvas source inputs exceed ${MAX_TOTAL_INPUT_BYTES} aggregate bytes`);
    hasher.update(Buffer.from(`${relative}\0${bytes.length}\0`, 'utf8'));
    hasher.update(bytes);
  }
  return {
    sourceInputSha256: hasher.digest('hex'),
    sourceInputFileCount: rows.length,
    sourceInputBytes: totalBytes,
    files: rows.map(([relative]) => relative),
  };
}

module.exports = {
  MAX_INPUT_FILES,
  MAX_INPUT_FILE_BYTES,
  MAX_TOTAL_INPUT_BYTES,
  computeCanvasSourceInputDigest,
  isSupportedCanvasInput,
};
