import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') ||
      value.includes('\\') || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value) ||
      value.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('Expected a portable, root-relative path without traversal');
  }
  return value;
}

export async function confinedPath(root, name, { missing = false } = {}) {
  relativePath(name);
  const resolvedRoot = await realpath(root);
  let current = resolvedRoot;
  for (const part of name.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error('Symbolic links are not allowed in evaluation files');
      }
    } catch (error) {
      if (missing && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return current;
}

export function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function assertKeys(value, allowed, label) {
  assertObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}
