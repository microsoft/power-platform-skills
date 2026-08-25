'use strict';

const fs = require('node:fs');
const path = require('node:path');

function projectRoot(projectRoot) {
  return fs.realpathSync(path.resolve(projectRoot));
}

function targetInside(root, value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} path is required`);
  const target = path.resolve(root, value);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error(`${label} must remain inside the project root`);
  return target;
}

function relativeParts(root, target) {
  return path.relative(root, target).split(path.sep).filter(Boolean);
}

function safeExistingProjectFile(projectRootValue, value, label = 'project file') {
  const root = projectRoot(projectRootValue);
  const target = targetInside(root, value, label);
  let cursor = root;
  for (const part of relativeParts(root, target)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) throw new Error(`${label} is missing`);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`${label} path must not contain a symlink`);
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  const realParent = fs.realpathSync(path.dirname(target));
  if (realParent !== root && !realParent.startsWith(`${root}${path.sep}`)) throw new Error(`${label} parent escapes the project root`);
  return target;
}

function safeProjectOutput(projectRootValue, value, label = 'project output') {
  const root = projectRoot(projectRootValue);
  const target = targetInside(root, value, label);
  const parts = relativeParts(root, path.dirname(target));
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} parent must be a regular project directory without symlinks`);
  }
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file without symlinks`);
  }
  const realParent = fs.realpathSync(path.dirname(target));
  if (realParent !== root && !realParent.startsWith(`${root}${path.sep}`)) throw new Error(`${label} parent escapes the project root`);
  return target;
}

module.exports = { projectRoot, safeExistingProjectFile, safeProjectOutput, targetInside };
