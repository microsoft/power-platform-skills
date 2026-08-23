'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableClone(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableClone(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function readJson(filePath, label = filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, stableJson(value), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function writeTextAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, contents, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function isWithinRoot(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function resolveInside(root, relativePath, label = 'path') {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const rootReal = fs.realpathSync(root);
  const requested = path.resolve(rootReal, relativePath);
  if (!isWithinRoot(requested, rootReal)) throw new Error(`${label} escapes project root`);
  return requested;
}

function walkFiles(root, options = {}) {
  const include = options.include || (() => true);
  const excludeDirectory = options.excludeDirectory || (() => false);
  const files = [];

  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!excludeDirectory(entryPath, entry.name)) visit(entryPath);
      } else if (entry.isFile() && include(entryPath, entry.name)) {
        files.push(entryPath);
      }
    }
  }

  visit(root);
  return files.sort();
}

function hashFiles(root, files) {
  const records = files.map((filePath) => {
    const absolutePath = path.resolve(filePath);
    if (!isWithinRoot(absolutePath, root)) throw new Error(`file escapes root: ${absolutePath}`);
    return {
      path: path.relative(root, absolutePath).split(path.sep).join('/'),
      sha256: hashFile(absolutePath),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return { files: records, sha256: sha256(stableJson(records)) };
}

function sanitizeId(value, label = 'id') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error(`${label} is empty after normalization`);
  return normalized;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function sourceSnapshot(projectRoot) {
  const candidates = [];
  for (const relativeRoot of ['app', 'src', 'brand']) {
    const absoluteRoot = path.join(projectRoot, relativeRoot);
    candidates.push(...walkFiles(absoluteRoot, {
      include: (filePath) => /\.(?:ts|tsx|js|jsx|json|md|html|css)$/i.test(filePath),
      excludeDirectory: (filePath) => (
        filePath.includes(`${path.sep}node_modules`)
        || filePath.includes(`${path.sep}.git`)
        || filePath === path.join(projectRoot, 'src', 'generated')
      ),
    }));
  }
  for (const relativePath of ['native-app-plan.md', 'tsconfig.json', 'package.json']) {
    const filePath = path.join(projectRoot, relativePath);
    if (fs.existsSync(filePath)) candidates.push(filePath);
  }
  return hashFiles(projectRoot, [...new Set(candidates)]);
}

module.exports = {
  hashFile,
  hashFiles,
  isWithinRoot,
  readJson,
  requireString,
  resolveInside,
  sanitizeId,
  sha256,
  sourceSnapshot,
  stableClone,
  stableJson,
  walkFiles,
  writeJsonAtomic,
  writeTextAtomic,
};
