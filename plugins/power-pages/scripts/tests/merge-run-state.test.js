'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeRunState, readRunState, clearRunState, runStateFilePath,
  phaseRank, isAtOrBeyond, PHASES, TERMINAL,
} = require('../lib/merge-run-state');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-merge-runstate-'));
}

test('phaseRank orders the clone-flow phases; unknown -> -1', () => {
  assert.equal(phaseRank('started'), 0);
  assert.ok(phaseRank('staged') < phaseRank('resolved'));
  assert.ok(phaseRank('resolved') < phaseRank('pushed'));
  assert.ok(phaseRank('pushed') < phaseRank('refreshed'));
  assert.ok(phaseRank('accepted') < phaseRank('pulled'));
  assert.ok(phaseRank('pulled') < phaseRank('verified'));
  assert.equal(phaseRank('nope'), -1);
});

test('isAtOrBeyond: a phase can skip everything at or below it', () => {
  assert.equal(isAtOrBeyond('accepted', 'refreshed'), true);
  assert.equal(isAtOrBeyond('accepted', 'accepted'), true);
  assert.equal(isAtOrBeyond('accepted', 'pulled'), false);
  assert.equal(isAtOrBeyond('staged', 'resolved'), false);
});

test('PHASES / TERMINAL are the clone-flow sets', () => {
  assert.deepEqual(PHASES, ['started', 'staged', 'resolved', 'pushed', 'refreshed', 'accepted', 'pulled', 'verified']);
  assert.ok(TERMINAL.includes('verified'));
  assert.ok(TERMINAL.includes('rolledback'));
});

test('E3: createdAt is preserved across writes while updatedAt advances (ISO-8601 UTC)', async () => {
  const dir = tmpDir();
  try {
    writeRunState(dir, { phase: 'started' });
    const first = readRunState(dir);
    assert.match(first.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(first.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await new Promise((r) => setTimeout(r, 5));
    writeRunState(dir, { phase: 'staged' });
    const second = readRunState(dir);
    assert.equal(second.createdAt, first.createdAt, 'createdAt preserved');
    assert.notEqual(second.updatedAt, first.updatedAt, 'updatedAt advanced');
    assert.equal(second.phase, 'staged');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('write/read round-trip in the clone .pp-merge dir', () => {
  const dir = tmpDir();
  try {
    const p = writeRunState(dir, { phase: 'pushed', mergeCommit: 'sha1', status: 'awaiting-pr', prId: 42, components: [{ safe: 'x' }] });
    assert.equal(p, runStateFilePath(dir));
    assert.ok(p.replace(/\\/g, '/').endsWith('/run-state.json'));
    const st = readRunState(dir);
    assert.equal(st.phase, 'pushed');
    assert.equal(st.mergeCommit, 'sha1');
    assert.equal(st.status, 'awaiting-pr');
    assert.equal(st.prId, 42);
    assert.ok(st.updatedAt, 'stamped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeRunState creates the dir if missing', () => {
  const base = tmpDir();
  const dir = path.join(base, 'nested', '.pp-merge');
  try {
    writeRunState(dir, { phase: 'started' });
    assert.ok(fs.existsSync(runStateFilePath(dir)));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('readRunState returns null when absent', () => {
  const dir = tmpDir();
  try { assert.equal(readRunState(dir), null); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clearRunState removes only the state file', () => {
  const dir = tmpDir();
  try {
    writeRunState(dir, { phase: 'started' });
    assert.ok(fs.existsSync(runStateFilePath(dir)));
    assert.equal(clearRunState(dir), true);
    assert.equal(fs.existsSync(runStateFilePath(dir)), false);
    assert.equal(readRunState(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeRunState requires a dir', () => {
  assert.throws(() => writeRunState(null, {}), /run-state dir is required/);
});
