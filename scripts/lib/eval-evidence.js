'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const SKIP = new Set(['node_modules', '.git', 'dist', '__pycache__', '.DS_Store']);

function listSuiteNames(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'eval.yaml')))
    .map(entry => entry.name).sort();
}

function hashFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('Evidence hashes require regular files');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashTree(root) {
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Evidence tree must be a directory');
  const files = [];
  function walk(dir, relative) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Evidence trees cannot contain symlinks');
      if (entry.isDirectory()) walk(file, name);
      else if (entry.isFile()) files.push([name, file]);
      else throw new Error('Evidence trees require regular files');
    }
  }
  walk(root, '');
  const hash = createHash('sha256');
  // Paths use "/" on every platform; NUL separates paths and raw file bytes so
  // {"ab": "c"} cannot collide with {"a": "bc"} through concatenation.
  for (const [name, file] of files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(name).update('\0').update(fs.readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

module.exports = { hashFile, hashTree, listSuiteNames };
