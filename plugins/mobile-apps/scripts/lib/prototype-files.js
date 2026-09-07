'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, sha256Hex } = require('./product-experience-contracts');

function inside(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const name = path.relative(base, target);
  if (!name || name === '..' || name.startsWith(`..${path.sep}`) || path.isAbsolute(name)) {
    throw new Error(`Path must be a file inside the project: ${relative}`);
  }
  let current = base;
  for (const part of name.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported for generated inputs/outputs: ${relative}`);
    }
  }
  return target;
}

function readJson(root, relative) {
  const file = inside(root, relative);
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 4 * 1024 * 1024) {
    throw new Error(`Expected bounded regular JSON file: ${relative}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function atomicWrite(root, relative, value) {
  const file = inside(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pending = `${file}.pending-${process.pid}`;
  let created = false;
  try {
    fs.writeFileSync(pending, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    created = true;
    fs.renameSync(pending, file);
  } finally {
    if (created) fs.rmSync(pending, { force: true });
  }
}

function revision(value) {
  return sha256Hex(canonicalJson(value));
}

function assertRevision(value, field, label) {
  const content = structuredClone(value);
  const expected = content[field];
  delete content[field];
  if (expected !== revision(content)) throw new Error(`${label} revision is missing or stale`);
  return value;
}

// Only this manifest's app-owned outputs may be refreshed. A local edit is a
// conflict, not permission to overwrite it or repair official generated files.
function writeOwnedFiles(root, files, inputRevisions, manifestPath = '.tmp/prototype-generated.json') {
  const prior = fs.existsSync(inside(root, manifestPath)) ? readJson(root, manifestPath) : { files: {} };
  for (const [relative, content] of Object.entries(files)) {
    if (!relative.startsWith('src/data/') || relative.split('/').includes('..')) {
      throw new Error(`Prototype generator cannot own ${relative}`);
    }
    const target = inside(root, relative);
    if (!fs.existsSync(target)) continue;
    const current = sha256Hex(fs.readFileSync(target));
    if (current !== sha256Hex(content) && prior.files?.[relative] !== current) {
      throw new Error(`App-owned generated file changed outside its compiler: ${relative}`);
    }
  }
  const hashes = { ...prior.files };
  for (const [relative, content] of Object.entries(files)) {
    atomicWrite(root, relative, content);
    hashes[relative] = sha256Hex(content);
  }
  const manifest = { schemaVersion: 1, inputRevisions, files: hashes };
  atomicWrite(root, manifestPath, manifest);
  return manifest;
}

module.exports = { inside, readJson, atomicWrite, revision, assertRevision, writeOwnedFiles };
