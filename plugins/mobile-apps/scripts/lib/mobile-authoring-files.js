'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson } = require('./product-experience-contracts');

const JOURNAL_ROOT = '.devplayer-builder/logs/authoring';
const MAX_JSON_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function plainDirectory(directory) {
  const resolved = path.resolve(directory);
  let current = resolved;
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Authoring directories must not contain links');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || path.isAbsolute(value)
    || /[\\\u0000-\u001f\u007f:]/.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('An authoring artifact requires a safe project-relative path');
  }
  return value;
}

function inside(root, relative, { createParents = false } = {}) {
  const base = plainDirectory(root);
  const parts = relativePath(relative).split('/');
  let current = base;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (createParents && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Authoring paths must not traverse links');
  }
  const file = path.join(current, parts.at(-1));
  if (!within(base, file)) throw new Error('Authoring artifact escapes the project');
  if (fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('Authoring artifacts must be unaliased regular files');
    }
  }
  return file;
}

function readFile(file, maximum = MAX_JSON_BYTES) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
    throw new Error('Authoring artifact is not a bounded regular file');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw new Error('Authoring artifact changed during opening');
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (bytes.length > maximum || current.isSymbolicLink() || current.nlink !== 1
      || current.dev !== opened.dev || current.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('Authoring artifact changed during reading');
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(root, relative) {
  try {
    return JSON.parse(readFile(inside(root, relative), MAX_ARTIFACT_BYTES).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Authoring artifact is not valid JSON');
    throw error;
  }
}

function exists(root, relative) {
  try {
    return fs.existsSync(inside(root, relative));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function atomicWrite(root, relative, value, { bytes = false, exclusive = false } = {}) {
  const file = inside(root, relative, { createParents: true });
  const content = bytes ? value : `${canonicalJson(value)}\n`;
  const stagingRelative = `${relative}.write-${crypto.randomUUID()}`;
  const staging = inside(root, stagingRelative);
  try {
    const fd = fs.openSync(staging, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    inside(root, relative);
    if (exclusive) {
      // A hard link is used only as an exclusive install primitive; the staging
      // link is removed before any reader is allowed to use the final artifact.
      fs.linkSync(staging, file);
      fs.unlinkSync(staging);
    } else fs.renameSync(staging, file);
    const parent = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
  return relative;
}

function journalPath(descriptor, leaf) {
  return `${JOURNAL_ROOT}/${digest(descriptor.jobId)}/${digest(descriptor.attemptId)}/${relativePath(leaf)}`;
}

module.exports = {
  JOURNAL_ROOT, MAX_JSON_BYTES, MAX_ARTIFACT_BYTES, digest, canonicalJson, within, plainDirectory,
  relativePath, inside, readFile, readJson, exists, atomicWrite, journalPath,
};
