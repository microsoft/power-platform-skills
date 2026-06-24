#!/usr/bin/env node

// Filesystem hardening and wipe helpers for persistent per-branch clones.
//
// Clone roots live under the user-chosen cloneDir (see resolve-clone-path.js).
// This module keeps cache directories owner-only where supported and provides
// a single-clone wipe and best-effort secret scan.

'use strict';

const fs = require('fs');
const path = require('path');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Best-effort inline-secret patterns (warn, don't block). Intentionally broad.
const SECRET_PATTERNS = Object.freeze([
  { name: 'aad-client-secret', re: /\b[A-Za-z0-9._~-]{3}\dQ~[A-Za-z0-9._~-]{31,}\b/ },
  { name: 'bearer-jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'connection-string-password', re: /\bpassword\s*=\s*[^;\s"']{6,}/i },
  { name: 'sas-token', re: /\bsig=[A-Za-z0-9%]{20,}\b/i },
  { name: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'generic-secret-assignment', re: /\b(?:api[_-]?key|client[_-]?secret|secret|token|pwd)\b["']?\s*[:=]\s*["'][^"']{8,}["']/i },
]);

function hardenDir(dir, fsImpl = fs) {
  try { fsImpl.chmodSync(dir, DIR_MODE); } catch (_) { /* best-effort on Windows/non-POSIX filesystems */ }
}

function hardenFile(file, fsImpl = fs) {
  try { fsImpl.chmodSync(file, FILE_MODE); } catch (_) { /* best-effort on Windows/non-POSIX filesystems */ }
}

/**
 * Creates cloneDir, repoDir, and ppMergeDir with owner-only ACLs.
 *
 * @param {{ cloneDir: string, repoDir: string, ppMergeDir: string }} layout
 * @param {typeof fs} [fsImpl]
 * @returns {{ cloneDir: string, repoDir: string, ppMergeDir: string }}
 */
function prepareCacheDirs({ cloneDir, repoDir, ppMergeDir } = {}, fsImpl = fs) {
  for (const dir of [cloneDir, repoDir, ppMergeDir]) {
    if (!dir) throw new Error('prepareCacheDirs: cloneDir, repoDir, and ppMergeDir are required');
    fsImpl.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    hardenDir(dir, fsImpl);
  }
  return { cloneDir, repoDir, ppMergeDir };
}

/**
 * Removes the entire clone directory tree.
 *
 * @param {{ cloneDir: string }} opts
 * @param {typeof fs} [fsImpl]
 * @returns {{ wiped: boolean }}
 */
function wipeClone({ cloneDir } = {}, fsImpl = fs) {
  if (!cloneDir) return { wiped: false };
  if (!path.isAbsolute(cloneDir)) throw new Error('wipeClone: cloneDir must be absolute');
  try {
    fsImpl.rmSync(cloneDir, { recursive: true, force: true });
    return { wiped: true };
  } catch (_) {
    return { wiped: false };
  }
}

/**
 * Scans text for inline-secret patterns. Returns an array of matched pattern names.
 *
 * @param {string} text
 * @returns {string[]}
 */
function scanForSecrets(text) {
  if (!text) return [];
  const hits = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(String(text))) hits.push(name);
  }
  return hits;
}

module.exports = {
  DIR_MODE,
  FILE_MODE,
  SECRET_PATTERNS,
  prepareCacheDirs,
  hardenDir,
  hardenFile,
  wipeClone,
  scanForSecrets,
};
