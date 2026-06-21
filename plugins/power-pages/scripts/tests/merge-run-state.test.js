'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the secure store (run-state lives there).
const STORE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'run-state-store-'));
process.env.PP_MERGE_STORE_ROOT = STORE_BASE;
process.on('exit', () => { try { fs.rmSync(STORE_BASE, { recursive: true, force: true }); } catch { /* best-effort */ } });

const {
  writeRunState, readRunState, clearRunState, runStateFilePath,
  phaseRank, isAtOrBeyond, PHASES, TERMINAL,
} = require('../lib/merge-run-state');
const { secureWipeRun, runDir } = require('../lib/merge-artifact-store');

test('phaseRank orders the apply phases; unknown -> -1', () => {
  assert.equal(phaseRank('started'), 0);
  assert.ok(phaseRank('committed') < phaseRank('accepted'));
  assert.ok(phaseRank('accepted') < phaseRank('pulled'));
  assert.ok(phaseRank('pulled') < phaseRank('verified'));
  assert.equal(phaseRank('nope'), -1);
});

test('isAtOrBeyond: a phase can skip everything at or below it', () => {
  assert.equal(isAtOrBeyond('accepted', 'committed'), true);
  assert.equal(isAtOrBeyond('accepted', 'accepted'), true);
  assert.equal(isAtOrBeyond('accepted', 'pulled'), false);
  assert.equal(isAtOrBeyond('committed', 'accepted'), false);
});

test('PHASES / TERMINAL are the expected sets', () => {
  assert.deepEqual(PHASES, ['started', 'committed', 'accepted', 'pulled', 'verified']);
  assert.ok(TERMINAL.includes('verified'));
  assert.ok(TERMINAL.includes('rolledback'));
});

test('write/read round-trip; stored in the secure store, off the project tree', () => {
  const id = 'rs-rt-1';
  try {
    const p = writeRunState(id, { phase: 'committed', commitId: 'sha1', components: [{ safe: 'x' }] });
    assert.ok(p.replace(/\\/g, '/').includes('/pp-merge/rs-rt-1/run-state.json'));
    assert.ok(p.startsWith(runDir(id)), 'lives in the run store');
    const st = readRunState(id);
    assert.equal(st.phase, 'committed');
    assert.equal(st.commitId, 'sha1');
    assert.equal(st.runId, id);
    assert.ok(st.updatedAt, 'stamped');
  } finally { secureWipeRun(id); }
});

test('readRunState returns null when absent', () => {
  assert.equal(readRunState('rs-missing-' + Date.now()), null);
});

test('clearRunState removes only the state file', () => {
  const id = 'rs-clear-1';
  try {
    writeRunState(id, { phase: 'started' });
    assert.ok(fs.existsSync(runStateFilePath(id)));
    assert.equal(clearRunState(id), true);
    assert.equal(fs.existsSync(runStateFilePath(id)), false);
    assert.equal(readRunState(id), null);
  } finally { secureWipeRun(id); }
});

test('writeRunState requires a runId', () => {
  assert.throws(() => writeRunState(null, {}), /runId is required/);
});
