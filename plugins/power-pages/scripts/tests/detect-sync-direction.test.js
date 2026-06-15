'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSyncDirection, parseDirectionArgs, classifyState, VALID_MODES } = require('../lib/detect-sync-direction');

// ===== classifyState =====

test('classifyState maps the 5 states from counts', () => {
  assert.equal(classifyState({ changes: 0, updates: 0, conflicts: 0 }), 'Clean');
  assert.equal(classifyState({ changes: 3, updates: 0, conflicts: 0 }), 'Dirty');
  assert.equal(classifyState({ changes: 0, updates: 2, conflicts: 0 }), 'Stale');
  assert.equal(classifyState({ changes: 3, updates: 2, conflicts: 0 }), 'Mixed');
  assert.equal(classifyState({ changes: 3, updates: 2, conflicts: 1 }), 'Conflicted');
});

// ===== parseDirectionArgs =====

test('parseDirectionArgs reads direction + ordering + passthrough flags', () => {
  assert.deepEqual(parseDirectionArgs(['--commit']), { forceCommit: true });
  assert.deepEqual(parseDirectionArgs(['--pull']), { forcePull: true });
  assert.deepEqual(parseDirectionArgs(['--commit-then-pull']), { ordering: 'commit-then-pull' });
  assert.deepEqual(parseDirectionArgs(['--hard-delete']), { hardDelete: true });
  assert.deepEqual(parseDirectionArgs(['--dry-run']), { dryRun: true });
  assert.deepEqual(parseDirectionArgs(['--unknown']), {});
});

test('VALID_MODES lists the 5 dispatch modes', () => {
  assert.deepEqual([...VALID_MODES].sort(), ['both', 'clean', 'commit', 'conflicts-first', 'pull'].sort());
});

// ===== detectSyncDirection: auto-detect =====

test('Clean → mode clean', () => {
  const r = detectSyncDirection({ counts: { changes: 0, updates: 0, conflicts: 0 } });
  assert.equal(r.mode, 'clean');
  assert.equal(r.state, 'Clean');
  assert.equal(r.requiresConflictFirst, false);
});

test('Dirty → commit', () => {
  const r = detectSyncDirection({ counts: { changes: 3, updates: 0, conflicts: 0 } });
  assert.equal(r.mode, 'commit');
  assert.equal(r.state, 'Dirty');
});

test('Stale → pull', () => {
  const r = detectSyncDirection({ counts: { changes: 0, updates: 2, conflicts: 0 } });
  assert.equal(r.mode, 'pull');
  assert.equal(r.state, 'Stale');
});

test('Mixed → both, default ordering pull-then-commit', () => {
  const r = detectSyncDirection({ counts: { changes: 3, updates: 2, conflicts: 0 } });
  assert.equal(r.mode, 'both');
  assert.equal(r.state, 'Mixed');
  assert.equal(r.ordering, 'pull-then-commit');
});

test('Mixed + --commit-then-pull overrides ordering', () => {
  const r = detectSyncDirection({ counts: { changes: 3, updates: 2, conflicts: 0 }, args: ['--commit-then-pull'] });
  assert.equal(r.mode, 'both');
  assert.equal(r.ordering, 'commit-then-pull');
});

// ===== conflicts gate everything =====

test('Conflicts → conflicts-first, requiresConflictFirst true, regardless of other counts', () => {
  const r = detectSyncDirection({ counts: { changes: 3, updates: 2, conflicts: 1 } });
  assert.equal(r.mode, 'conflicts-first');
  assert.equal(r.requiresConflictFirst, true);
  assert.equal(r.state, 'Conflicted');
});

test('Conflicts override an explicit --commit (conflicts gate wins)', () => {
  const r = detectSyncDirection({ counts: { changes: 1, updates: 0, conflicts: 1 }, args: ['--commit'] });
  assert.equal(r.mode, 'conflicts-first', 'conflicts gate even with --commit');
  assert.equal(r.requiresConflictFirst, true);
});

// ===== explicit overrides =====

test('--commit forces commit on a Stale env (with a "nothing to commit" reason)', () => {
  const r = detectSyncDirection({ counts: { changes: 0, updates: 5, conflicts: 0 }, args: ['--commit'] });
  assert.equal(r.mode, 'commit');
  assert.equal(r.explicitOverride, true);
  assert.match(r.reason, /nothing to commit/i);
});

test('--pull forces pull on a Dirty env', () => {
  const r = detectSyncDirection({ counts: { changes: 5, updates: 0, conflicts: 0 }, args: ['--pull'] });
  assert.equal(r.mode, 'pull');
  assert.equal(r.explicitOverride, true);
  assert.match(r.reason, /nothing to pull/i);
});

// ===== validation =====

test('throws when counts is missing', () => {
  assert.throws(() => detectSyncDirection({}), /counts .* is required/);
});

test('throws on negative counts', () => {
  assert.throws(() => detectSyncDirection({ counts: { changes: -1, updates: 0, conflicts: 0 } }), /non-negative/);
});

test('tolerates missing individual count fields (treated as 0)', () => {
  const r = detectSyncDirection({ counts: { changes: 2 } });
  assert.equal(r.mode, 'commit');
});
