'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  writeRunTrace, pruneTraces, redactTrace, TRACES_SUBDIR, ALLOWED_TRACE_KEYS,
} = require('../lib/write-run-trace');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'run-trace-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// ===== redactTrace (security) =====

test('redactTrace keeps only allowed keys and drops smuggled fields', () => {
  const safe = redactTrace({
    mode: 'setup', status: 'success',
    token: 'SECRET.JWT', stdout: 'raw helper output', adoToken: 'pat',
  });
  assert.equal(safe.mode, 'setup');
  assert.equal(safe.status, 'success');
  assert.equal(safe.token, undefined, 'token must never reach the trace');
  assert.equal(safe.stdout, undefined, 'raw stdout must never reach the trace');
  assert.equal(safe.adoToken, undefined);
});

test('ALLOWED_TRACE_KEYS does not include token/stdout', () => {
  assert.ok(!ALLOWED_TRACE_KEYS.includes('token'));
  assert.ok(!ALLOWED_TRACE_KEYS.includes('stdout'));
});

// ===== writeRunTrace =====

test('writes a timestamped trace file under docs/inner-loop/git-configure-traces', (t) => {
  const root = tmp(t);
  const fixedDate = new Date('2026-06-13T19:11:04.163Z');
  const r = writeRunTrace({
    projectRoot: root,
    trace: { mode: 'setup', status: 'success', token: 'LEAK' },
    _dateImpl: () => fixedDate,
  });
  assert.equal(r.ok, true);
  assert.ok(r.tracePath.includes(path.join('docs', 'inner-loop', 'git-configure-traces')));
  assert.match(path.basename(r.tracePath), /^2026-06-13T19-11-04-163Z\.json$/);
  const written = JSON.parse(fs.readFileSync(r.tracePath, 'utf8'));
  assert.equal(written.mode, 'setup');
  assert.equal(written.token, undefined, 'on-disk trace must not contain the token');
  assert.ok(written.tracedAt, 'tracedAt stamped');
});

test('returns ok:false when projectRoot is missing', () => {
  const r = writeRunTrace({ trace: { mode: 'setup' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /projectRoot is required/);
});

// ===== pruneTraces (retention) =====

test('pruneTraces deletes files older than the retention window', (t) => {
  const root = tmp(t);
  const dir = path.join(root, TRACES_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });

  const oldFile = path.join(dir, 'old.json');
  const newFile = path.join(dir, 'new.json');
  fs.writeFileSync(oldFile, '{}');
  fs.writeFileSync(newFile, '{}');
  // Backdate oldFile 40 days.
  const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldFile, new Date(fortyDaysAgo), new Date(fortyDaysAgo));

  const pruned = pruneTraces(dir, { retentionDays: 30 });
  assert.equal(pruned, 1);
  assert.ok(!fs.existsSync(oldFile), 'old trace pruned');
  assert.ok(fs.existsSync(newFile), 'recent trace kept');
});

test('pruneTraces caps the directory at maxFiles, deleting the oldest', (t) => {
  const root = tmp(t);
  const dir = path.join(root, TRACES_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });

  // Create 5 files with increasing mtimes.
  for (let i = 0; i < 5; i++) {
    const f = path.join(dir, `t${i}.json`);
    fs.writeFileSync(f, '{}');
    const when = Date.now() - (5 - i) * 60 * 1000; // t0 oldest … t4 newest
    fs.utimesSync(f, new Date(when), new Date(when));
  }
  const pruned = pruneTraces(dir, { maxFiles: 2, retentionDays: 3650 });
  assert.equal(pruned, 3, 'oldest 3 of 5 removed');
  const remaining = fs.readdirSync(dir).sort();
  assert.deepEqual(remaining, ['t3.json', 't4.json'], 'two newest survive');
});

test('writeRunTrace prunes before writing (integration of write + retention)', (t) => {
  const root = tmp(t);
  const dir = path.join(root, TRACES_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'stale.json');
  fs.writeFileSync(stale, '{}');
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  fs.utimesSync(stale, new Date(old), new Date(old));

  const r = writeRunTrace({ projectRoot: root, trace: { mode: 'disconnect' } });
  assert.equal(r.ok, true);
  assert.equal(r.pruned, 1, 'stale file pruned during the write');
  assert.ok(!fs.existsSync(stale));
});
