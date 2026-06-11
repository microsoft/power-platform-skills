'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  buildCacheKey, loadCache, saveCache, invalidateCache, DEFAULT_TTL_SEC,
} = require('../lib/pending-changes-cache');
const { innerLoopPath } = require('../lib/inner-loop-paths');

function makeTmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-changes-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const sampleKey = () => buildCacheKey({
  boundSyncedCommitId: 'abc123',
  pendingChangesCount: 44,
  solutionUniqueName:  'InternLearning',
});

const sampleItems = [
  { componentId: 'c1', componentName: 'A', componentType: 'Web Template', changeType: 'Modify' },
  { componentId: 'c2', componentName: 'B', componentType: 'Web Page',     changeType: 'Add' },
];

// ===== buildCacheKey =====

test('buildCacheKey normalises optional fields to null and freezes the result', () => {
  const k = buildCacheKey({ boundSyncedCommitId: 'sha', pendingChangesCount: 5 });
  assert.equal(k.boundSyncedCommitId, 'sha');
  assert.equal(k.pendingChangesCount, 5);
  assert.equal(k.solutionUniqueName, null);
  assert.throws(() => { k.boundSyncedCommitId = 'other'; }, /read.?only|assign|cannot/i);
});

test('buildCacheKey: missing required fields produce nulls (caller validates completeness)', () => {
  const k = buildCacheKey({});
  assert.equal(k.boundSyncedCommitId, null);
  assert.equal(k.pendingChangesCount, null);
});

test('DEFAULT_TTL_SEC is 60 seconds (intentionally tight; cache is for iterate-on-fix only)', () => {
  assert.equal(DEFAULT_TTL_SEC, 60);
});

// ===== loadCache: miss paths =====

test('loadCache: no-project-root', () => {
  const r = loadCache(null, sampleKey());
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'no-project-root');
});

test('loadCache: incomplete key (no commitId) → incomplete-key', () => {
  const r = loadCache('/tmp/x', buildCacheKey({ pendingChangesCount: 1 }));
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'incomplete-key');
});

test('loadCache: incomplete key (no count) → incomplete-key', () => {
  const r = loadCache('/tmp/x', buildCacheKey({ boundSyncedCommitId: 'sha' }));
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'incomplete-key');
});

test('loadCache: cache file does not exist → no-file', (t) => {
  const root = makeTmp(t);
  const r = loadCache(root, sampleKey());
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'no-file');
});

test('loadCache: corrupt JSON → corrupt-json (graceful)', (t) => {
  const root = makeTmp(t);
  fs.mkdirSync(path.join(root, 'docs', 'inner-loop'), { recursive: true });
  fs.writeFileSync(innerLoopPath(root, 'pendingChangesCache'), '{not-valid-json');
  const r = loadCache(root, sampleKey());
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'corrupt-json');
});

test('loadCache: items not an array → corrupt-items', (t) => {
  const root = makeTmp(t);
  saveCache(root, sampleKey(), sampleItems);
  // Re-write with bad items shape
  const p = innerLoopPath(root, 'pendingChangesCache');
  const bad = JSON.parse(fs.readFileSync(p, 'utf8'));
  bad.items = { not: 'an-array' };
  fs.writeFileSync(p, JSON.stringify(bad));
  const r = loadCache(root, sampleKey());
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'corrupt-items');
});

test('loadCache: cacheKey commitId mismatch → key-mismatch', (t) => {
  const root = makeTmp(t);
  saveCache(root, sampleKey(), sampleItems);
  const other = buildCacheKey({
    boundSyncedCommitId: 'DIFFERENT_SHA',
    pendingChangesCount: 44,
    solutionUniqueName:  'InternLearning',
  });
  const r = loadCache(root, other);
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'key-mismatch');
});

test('loadCache: cacheKey count mismatch → key-mismatch', (t) => {
  const root = makeTmp(t);
  saveCache(root, sampleKey(), sampleItems);
  const other = buildCacheKey({
    boundSyncedCommitId: 'abc123',
    pendingChangesCount: 99,
    solutionUniqueName:  'InternLearning',
  });
  const r = loadCache(root, other);
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'key-mismatch');
});

test('loadCache: cacheKey solutionUniqueName mismatch → key-mismatch', (t) => {
  const root = makeTmp(t);
  saveCache(root, sampleKey(), sampleItems);
  const other = buildCacheKey({
    boundSyncedCommitId: 'abc123',
    pendingChangesCount: 44,
    solutionUniqueName:  'OtherSolution',
  });
  const r = loadCache(root, other);
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'key-mismatch');
});

test('loadCache: corrupt cachedAt → corrupt-cachedAt', (t) => {
  const root = makeTmp(t);
  saveCache(root, sampleKey(), sampleItems);
  const p = innerLoopPath(root, 'pendingChangesCache');
  const bad = JSON.parse(fs.readFileSync(p, 'utf8'));
  bad.cachedAt = 'not-a-date';
  fs.writeFileSync(p, JSON.stringify(bad));
  const r = loadCache(root, sampleKey());
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'corrupt-cachedAt');
});

test('loadCache: age past ttlSec → expired (with ageSec field)', (t) => {
  const root = makeTmp(t);
  const nowMs = Date.parse('2026-06-11T10:00:00Z');
  saveCache(root, sampleKey(), sampleItems, { nowMs });
  // 61s later — should be expired (default ttl = 60)
  const laterMs = nowMs + 61_000;
  const r = loadCache(root, sampleKey(), { nowMs: laterMs });
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'expired');
  assert.ok(r.ageSec >= 60);
});

test('loadCache: future cachedAt (clock skew) → future-cachedAt', (t) => {
  const root = makeTmp(t);
  const futureMs = Date.parse('2030-01-01T00:00:00Z');
  saveCache(root, sampleKey(), sampleItems, { nowMs: futureMs });
  const r = loadCache(root, sampleKey(), { nowMs: Date.parse('2026-06-11T00:00:00Z') });
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'future-cachedAt');
});

// ===== loadCache: hit path =====

test('loadCache: matching key within TTL → hit, returns cached items + ageSec', (t) => {
  const root = makeTmp(t);
  const nowMs = Date.parse('2026-06-11T10:00:00Z');
  saveCache(root, sampleKey(), sampleItems, { nowMs });
  // 30s later — within ttl
  const r = loadCache(root, sampleKey(), { nowMs: nowMs + 30_000 });
  assert.equal(r.hit, true);
  assert.deepEqual(r.items, sampleItems);
  assert.ok(r.ageSec >= 30 - 0.001 && r.ageSec <= 30 + 0.001);
});

test('loadCache: respects custom ttlSec from cache file (not just default)', (t) => {
  const root = makeTmp(t);
  const nowMs = Date.parse('2026-06-11T10:00:00Z');
  saveCache(root, sampleKey(), sampleItems, { nowMs, ttlSec: 5 });
  // 6s later — past custom ttl
  const r = loadCache(root, sampleKey(), { nowMs: nowMs + 6_000 });
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'expired');
});

test('loadCache: solutionUniqueName=null (no scope) round-trips through save/load', (t) => {
  const root = makeTmp(t);
  const key = buildCacheKey({ boundSyncedCommitId: 'sha', pendingChangesCount: 0 });
  saveCache(root, key, []);
  const r = loadCache(root, key);
  assert.equal(r.hit, true);
  assert.deepEqual(r.items, []);
});

// ===== saveCache =====

test('saveCache: writes cache file with expected shape', (t) => {
  const root = makeTmp(t);
  const r = saveCache(root, sampleKey(), sampleItems);
  assert.equal(r.saved, true);
  assert.equal(r.path, innerLoopPath(root, 'pendingChangesCache'));
  const parsed = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.equal(parsed.cacheKey.boundSyncedCommitId, 'abc123');
  assert.equal(parsed.cacheKey.pendingChangesCount, 44);
  assert.equal(parsed.cacheKey.solutionUniqueName, 'InternLearning');
  assert.equal(parsed.ttlSec, DEFAULT_TTL_SEC);
  assert.ok(typeof parsed.cachedAt === 'string');
  assert.deepEqual(parsed.items, sampleItems);
});

test('saveCache: creates docs/inner-loop/ if missing (ensureInnerLoopDir)', (t) => {
  const root = makeTmp(t);
  assert.equal(fs.existsSync(path.join(root, 'docs', 'inner-loop')), false);
  const r = saveCache(root, sampleKey(), sampleItems);
  assert.equal(r.saved, true);
  assert.ok(fs.statSync(path.join(root, 'docs', 'inner-loop')).isDirectory());
});

test('saveCache: incomplete key → not saved', (t) => {
  const root = makeTmp(t);
  const r = saveCache(root, buildCacheKey({}), sampleItems);
  assert.equal(r.saved, false);
  assert.equal(r.reason, 'incomplete-key');
});

test('saveCache: items not array → not saved', (t) => {
  const root = makeTmp(t);
  const r = saveCache(root, sampleKey(), 'not-an-array');
  assert.equal(r.saved, false);
  assert.equal(r.reason, 'items-not-array');
});

test('saveCache: respects custom ttlSec', (t) => {
  const root = makeTmp(t);
  const r = saveCache(root, sampleKey(), sampleItems, { ttlSec: 10 });
  assert.equal(r.saved, true);
  const parsed = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.equal(parsed.ttlSec, 10);
});

// ===== invalidateCache =====

test('invalidateCache: deletes existing cache file', (t) => {
  const root = makeTmp(t);
  saveCache(root, sampleKey(), sampleItems);
  const cachePath = innerLoopPath(root, 'pendingChangesCache');
  assert.equal(fs.existsSync(cachePath), true);
  const r = invalidateCache(root);
  assert.equal(r.invalidated, true);
  assert.equal(fs.existsSync(cachePath), false);
});

test('invalidateCache: no cache file → not-an-error (returns reason)', (t) => {
  const root = makeTmp(t);
  const r = invalidateCache(root);
  assert.equal(r.invalidated, false);
  assert.equal(r.reason, 'no-file');
});

test('invalidateCache: no-project-root', () => {
  const r = invalidateCache(null);
  assert.equal(r.invalidated, false);
  assert.equal(r.reason, 'no-project-root');
});
