#!/usr/bin/env node

// Secure, ephemeral artifact store for the selective-merge workspace.
//
// WHY: the merge flow materializes BASE/OURS/THEIRS/proposed/result text for each
// conflicted component. Those carry real component source (and may embed inline
// secrets). Writing them as durable plaintext under the project/session tree is a
// data-at-rest leak. This module keeps them:
//   - OFF the project/session tree, in an OS temp dir created with owner-only
//     permissions (0o700 dir, 0o600 files),
//   - EPHEMERAL: a secure wipe (overwrite-with-random then unlink) runs on
//     completion/cancel, and a TTL reaper removes orphaned runs,
//   - OPTIONALLY encrypted at rest (AES-256-GCM) with a per-run key held only in
//     memory — defense-in-depth for highly sensitive tenants (default OFF;
//     ephemeral + wipe is the baseline),
//   - SCANNED: a best-effort secret scan warns before persisting credential-like
//     content.
//
// All paths stay under a single root `<os.tmpdir()>/pp-merge/<runId>/` so a single
// reaper can clean every run. Nothing here is ever committed (it's not in the repo
// tree at all).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT_NAME = 'pp-merge';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h orphan reaper window
const ENC_MAGIC = Buffer.from('PPM1'); // file header for encrypted artifacts

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

function storeRoot() {
  // Default to the OS temp dir; allow ops to relocate the secure store (e.g. to
  // an encrypted volume) via PP_MERGE_STORE_ROOT. We always nest under ROOT_NAME
  // so the TTL reaper only ever touches <base>/pp-merge/* and never the base.
  const override = process.env.PP_MERGE_STORE_ROOT;
  const base = override && override.trim() ? path.resolve(override.trim()) : os.tmpdir();
  return path.join(base, ROOT_NAME);
}
function runDir(runId) {
  if (!runId || /[\\/]/.test(String(runId))) throw new Error('runId must be a non-empty path-safe id');
  return path.join(storeRoot(), String(runId));
}

/**
 * Create (or reuse) a secure run directory with owner-only permissions.
 * @param {string} runId
 * @param {object} [opts]
 * @param {boolean} [opts.encrypt]  Enable AES-256-GCM at-rest. Default false.
 * @returns {{ dir: string, encrypted: boolean, key: Buffer|null }}
 */
function createRunStore(runId, { encrypt = false } = {}) {
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { fs.chmodSync(dir, DIR_MODE); } catch (_) { /* best-effort on platforms w/o POSIX modes */ }
  const key = encrypt ? crypto.randomBytes(32) : null; // in-memory only; never persisted
  return { dir, encrypted: !!encrypt, key };
}

function resolveInside(dir, relPath) {
  const abs = path.resolve(dir, relPath);
  const root = path.resolve(dir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the run store: ${relPath}`);
  }
  return abs;
}

function encryptBuf(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENC_MAGIC, iv, tag, enc]); // magic(4) | iv(12) | tag(16) | ciphertext
}

function decryptBuf(buf, key) {
  if (buf.length < 32 || !buf.subarray(0, 4).equals(ENC_MAGIC)) {
    return buf; // not encrypted — return as-is (back-compat / encrypt=false)
  }
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const data = buf.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Write an artifact (owner-only, optionally encrypted).
 * @param {{dir:string, key?:Buffer|null}} store
 * @param {string} relPath
 * @param {string} content
 * @returns {string} absolute path written
 */
function writeArtifact(store, relPath, content) {
  const abs = resolveInside(store.dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: DIR_MODE });
  const plain = Buffer.from(content == null ? '' : String(content), 'utf8');
  const out = store.key ? encryptBuf(plain, store.key) : plain;
  fs.writeFileSync(abs, out, { mode: FILE_MODE });
  try { fs.chmodSync(abs, FILE_MODE); } catch (_) { /* best-effort */ }
  return abs;
}

/**
 * Read an artifact back (decrypting if a key is supplied / the file is encrypted).
 * @returns {string|null} content, or null if missing
 */
function readArtifact(store, relPath) {
  const abs = resolveInside(store.dir, relPath);
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  const plain = store.key ? decryptBuf(buf, store.key) : (buf.subarray(0, 4).equals(ENC_MAGIC) ? buf /* encrypted but no key */ : buf);
  return plain.toString('utf8');
}

/**
 * Securely wipe a run: overwrite every file with random bytes (same length),
 * unlink, then remove the directory tree. Best-effort — never throws.
 * @param {string} runId
 * @returns {{ wiped: boolean, files: number }}
 */
function secureWipeRun(runId) {
  const dir = runDir(runId);
  let files = 0;
  const walk = (p) => {
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) { walk(full); }
      else {
        try {
          const sz = fs.statSync(full).size;
          if (sz > 0) fs.writeFileSync(full, crypto.randomBytes(sz));
          fs.unlinkSync(full);
          files++;
        } catch (_) { /* best-effort */ }
      }
    }
  };
  try {
    walk(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { wiped: true, files };
  } catch (_) {
    return { wiped: false, files };
  }
}

/**
 * Remove orphaned run dirs older than ttlMs (by mtime). Best-effort.
 * @param {object} [opts] { ttlMs }
 * @returns {{ reaped: string[] }}
 */
function reapStaleRuns({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const root = storeRoot();
  const reaped = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { reaped }; }
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(root, e.name);
    try {
      const age = now - fs.statSync(full).mtimeMs;
      if (age > ttlMs) { secureWipeRun(e.name); reaped.push(e.name); }
    } catch (_) { /* best-effort */ }
  }
  return { reaped };
}

/**
 * Best-effort secret scan. Returns the names of any matched patterns (no values).
 * @param {string} content
 * @returns {string[]} matched pattern names (empty = clean)
 */
function scanForSecrets(content) {
  if (!content) return [];
  const hits = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) hits.push(name);
  }
  return hits;
}

module.exports = {
  storeRoot,
  runDir,
  createRunStore,
  writeArtifact,
  readArtifact,
  secureWipeRun,
  reapStaleRuns,
  scanForSecrets,
  SECRET_PATTERNS,
  DEFAULT_TTL_MS,
};
