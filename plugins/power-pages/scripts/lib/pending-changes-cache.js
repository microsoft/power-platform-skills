#!/usr/bin/env node

// Cross-run memo for `list-pending-changes` output, used by the
// validate-pending-changes skill so a re-run after fixing one blocker can
// skip the full Dataverse fetch when the underlying state is unchanged.
//
// File layout: <projectRoot>/docs/inner-loop/pending-changes-cache.json
//
// Cache shape on disk:
//   {
//     cacheKey: {
//       boundSyncedCommitId: "<sha>",
//       pendingChangesCount: <int>,
//       solutionUniqueName: "<name>"|null
//     },
//     cachedAt: "<ISO8601>",
//     ttlSec:   60,
//     items:    [ ...list-pending-changes items... ]
//   }
//
// Hit rules (ALL must pass):
//   1. File exists and is valid JSON
//   2. Stored cacheKey deep-equals the requested cacheKey (every field)
//   3. Age (now - cachedAt) is less than ttlSec
//   4. items is an array
//
// Anything else is a miss. Cache is best-effort and NEVER load-bearing — a
// corrupt/missing/expired/mismatched cache must degrade silently to a miss so
// the caller falls through to the full Dataverse list call.
//
// Why both commitId AND count + solutionUniqueName?
//   - boundSyncedCommitId catches "someone else committed against this branch"
//     (Dataverse state moved, cache is stale).
//   - pendingChangesCount catches local edits between runs.
//   - solutionUniqueName guards against accidental cache reuse if the user
//     switches the bound solution mid-session (rare but possible with
//     bindingType=solution + branch-switch).
//
// TTL of 60s is intentionally tight — the cache is for fast iterate-on-fix
// cycles, not durable state. A maker editing in parallel is the failure mode;
// 60s caps the window in which stale data could land.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { innerLoopPath, ensureInnerLoopDir } = require('./inner-loop-paths');

const DEFAULT_TTL_SEC = 60;

/**
 * Compute a normalised cache key. Null/undefined for unknown fields — the
 * caller must NOT call loadCache when any required field is missing.
 *
 * @param {object} key
 * @param {string} key.boundSyncedCommitId
 * @param {number} key.pendingChangesCount
 * @param {string|null} [key.solutionUniqueName]
 * @returns {object} a frozen, canonical key
 */
function buildCacheKey({ boundSyncedCommitId, pendingChangesCount, solutionUniqueName = null } = {}) {
  return Object.freeze({
    boundSyncedCommitId: boundSyncedCommitId || null,
    pendingChangesCount: typeof pendingChangesCount === 'number' ? pendingChangesCount : null,
    solutionUniqueName:  solutionUniqueName || null,
  });
}

function keysMatch(a, b) {
  if (!a || !b) return false;
  return a.boundSyncedCommitId === b.boundSyncedCommitId
    && a.pendingChangesCount === b.pendingChangesCount
    && a.solutionUniqueName  === b.solutionUniqueName;
}

function isKeyComplete(key) {
  return !!(key && key.boundSyncedCommitId && typeof key.pendingChangesCount === 'number');
}

/**
 * Try to load cached items[] for the given cache key.
 *
 * @param {string} projectRoot
 * @param {object} cacheKey                 result of buildCacheKey()
 * @param {object} [opts]
 * @param {number} [opts.nowMs]             override clock for tests
 * @returns {{hit: boolean, items?: Array, ageSec?: number, reason?: string}}
 */
function loadCache(projectRoot, cacheKey, { nowMs = Date.now() } = {}) {
  if (!projectRoot) return { hit: false, reason: 'no-project-root' };
  if (!isKeyComplete(cacheKey)) return { hit: false, reason: 'incomplete-key' };

  const cachePath = innerLoopPath(projectRoot, 'pendingChangesCache');
  if (!fs.existsSync(cachePath)) return { hit: false, reason: 'no-file' };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return { hit: false, reason: 'corrupt-json' };
  }
  if (!parsed || typeof parsed !== 'object') return { hit: false, reason: 'corrupt-shape' };
  if (!Array.isArray(parsed.items)) return { hit: false, reason: 'corrupt-items' };
  if (!keysMatch(parsed.cacheKey, cacheKey)) return { hit: false, reason: 'key-mismatch' };

  const cachedAtMs = Date.parse(parsed.cachedAt);
  if (!Number.isFinite(cachedAtMs)) return { hit: false, reason: 'corrupt-cachedAt' };

  const ttlSec = typeof parsed.ttlSec === 'number' ? parsed.ttlSec : DEFAULT_TTL_SEC;
  const ageSec = (nowMs - cachedAtMs) / 1000;
  if (ageSec < 0) return { hit: false, reason: 'future-cachedAt' };
  if (ageSec > ttlSec) return { hit: false, reason: 'expired', ageSec };

  return { hit: true, items: parsed.items, ageSec };
}

/**
 * Persist items[] for the given cache key. Returns { saved: false, reason }
 * on any failure — write errors are non-fatal (cache is best-effort).
 *
 * @param {string} projectRoot
 * @param {object} cacheKey                 result of buildCacheKey()
 * @param {Array<object>} items
 * @param {object} [opts]
 * @param {number} [opts.ttlSec]
 * @param {number} [opts.nowMs]
 * @returns {{saved: boolean, path?: string, reason?: string}}
 */
function saveCache(projectRoot, cacheKey, items, { ttlSec = DEFAULT_TTL_SEC, nowMs = Date.now() } = {}) {
  if (!projectRoot) return { saved: false, reason: 'no-project-root' };
  if (!isKeyComplete(cacheKey)) return { saved: false, reason: 'incomplete-key' };
  if (!Array.isArray(items)) return { saved: false, reason: 'items-not-array' };

  const payload = {
    cacheKey: {
      boundSyncedCommitId: cacheKey.boundSyncedCommitId,
      pendingChangesCount: cacheKey.pendingChangesCount,
      solutionUniqueName:  cacheKey.solutionUniqueName,
    },
    cachedAt: new Date(nowMs).toISOString(),
    ttlSec,
    items,
  };

  try {
    ensureInnerLoopDir(projectRoot);
    const cachePath = innerLoopPath(projectRoot, 'pendingChangesCache');
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2));
    return { saved: true, path: cachePath };
  } catch (e) {
    return { saved: false, reason: 'write-failed: ' + e.message };
  }
}

/**
 * Best-effort delete of the cache file. Useful when the caller knows the
 * Dataverse state has changed for a reason the cache key can't capture
 * (e.g. just ran commit-to-git successfully).
 */
function invalidateCache(projectRoot) {
  if (!projectRoot) return { invalidated: false, reason: 'no-project-root' };
  const cachePath = innerLoopPath(projectRoot, 'pendingChangesCache');
  if (!fs.existsSync(cachePath)) return { invalidated: false, reason: 'no-file' };
  try {
    fs.unlinkSync(cachePath);
    return { invalidated: true, path: cachePath };
  } catch (e) {
    return { invalidated: false, reason: 'unlink-failed: ' + e.message };
  }
}

// CLI entry point for ad-hoc inspection from the agent. Modes:
//   --load --projectRoot <p> --boundSyncedCommitId <sha> --pendingChangesCount <n> [--solutionUniqueName <name>]
//   --save --projectRoot <p> --itemsFile <path> --boundSyncedCommitId <sha> --pendingChangesCount <n> [--solutionUniqueName <name>] [--ttlSec <n>]
//   --invalidate --projectRoot <p>
function parseArgs(argv) {
  const a = argv.slice(2);
  const out = {
    load: false, save: false, invalidate: false,
    projectRoot: null, boundSyncedCommitId: null, pendingChangesCount: null,
    solutionUniqueName: null, itemsFile: null, ttlSec: null,
  };
  for (let i = 0; i < a.length; i++) {
    const k = a[i], v = a[i + 1];
    if (k === '--load') out.load = true;
    else if (k === '--save') out.save = true;
    else if (k === '--invalidate') out.invalidate = true;
    else if (k === '--projectRoot' && v)         { out.projectRoot = v; i++; }
    else if (k === '--boundSyncedCommitId' && v) { out.boundSyncedCommitId = v; i++; }
    else if (k === '--pendingChangesCount' && v) { out.pendingChangesCount = parseInt(v, 10); i++; }
    else if (k === '--solutionUniqueName' && v)  { out.solutionUniqueName = v; i++; }
    else if (k === '--itemsFile' && v)           { out.itemsFile = v; i++; }
    else if (k === '--ttlSec' && v)              { out.ttlSec = parseInt(v, 10); i++; }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.load) {
    const key = buildCacheKey({
      boundSyncedCommitId: args.boundSyncedCommitId,
      pendingChangesCount: args.pendingChangesCount,
      solutionUniqueName:  args.solutionUniqueName,
    });
    const r = loadCache(args.projectRoot, key);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  if (args.save) {
    if (!args.itemsFile) {
      process.stderr.write('pending-changes-cache: --save requires --itemsFile\n');
      process.exit(1);
    }
    const items = JSON.parse(fs.readFileSync(args.itemsFile, 'utf8'));
    const key = buildCacheKey({
      boundSyncedCommitId: args.boundSyncedCommitId,
      pendingChangesCount: args.pendingChangesCount,
      solutionUniqueName:  args.solutionUniqueName,
    });
    const ttlSec = args.ttlSec != null ? args.ttlSec : DEFAULT_TTL_SEC;
    const r = saveCache(args.projectRoot, key, items, { ttlSec });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  if (args.invalidate) {
    const r = invalidateCache(args.projectRoot);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  process.stderr.write(
    'pending-changes-cache: provide --load, --save, or --invalidate. ' +
    'See file header for full usage.\n'
  );
  process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (e) {
    process.stderr.write('pending-changes-cache: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = {
  buildCacheKey, loadCache, saveCache, invalidateCache,
  DEFAULT_TTL_SEC,
};
