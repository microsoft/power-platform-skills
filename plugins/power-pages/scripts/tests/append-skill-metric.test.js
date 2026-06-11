'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { appendSkillMetric } = require('../lib/append-skill-metric');
const { innerLoopPath } = require('../lib/inner-loop-paths');

const SCRIPT = path.join(__dirname, '..', 'lib', 'append-skill-metric.js');

function mkTmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'append-skill-metric-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  return root;
}

test('appendSkillMetric: writes a JSONL line with ts + skill + payload merged', (t) => {
  const root = mkTmp(t);
  const r = appendSkillMetric({
    projectRoot: root,
    skill: 'CommitToGit',
    payload: { commitId: 'abc123', durationMs: 4200, status: 'succeeded' },
  });
  assert.equal(r.path, innerLoopPath(root, 'skillMetricsJsonl'));
  const content = fs.readFileSync(r.path, 'utf8');
  assert.ok(content.endsWith('\n'), 'line must terminate with newline');
  const parsed = JSON.parse(content.trim());
  assert.equal(parsed.skill, 'CommitToGit');
  assert.equal(parsed.commitId, 'abc123');
  assert.equal(parsed.durationMs, 4200);
  assert.equal(parsed.status, 'succeeded');
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/, 'ts is ISO-8601 UTC');
});

test('appendSkillMetric: appending multiple metrics produces NDJSON (one line each)', (t) => {
  const root = mkTmp(t);
  appendSkillMetric({ projectRoot: root, skill: 'CommitToGit', payload: { commitId: 'a' } });
  appendSkillMetric({ projectRoot: root, skill: 'CommitToGit', payload: { commitId: 'b' } });
  appendSkillMetric({ projectRoot: root, skill: 'SyncFromGit', payload: { updatesPulled: 3 } });
  const lines = fs.readFileSync(innerLoopPath(root, 'skillMetricsJsonl'), 'utf8')
    .split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].commitId, 'a');
  assert.equal(parsed[1].commitId, 'b');
  assert.equal(parsed[2].updatesPulled, 3);
  assert.equal(parsed[2].skill, 'SyncFromGit');
});

test('appendSkillMetric: caller-supplied ts/skill in payload do NOT override auto fields', (t) => {
  const root = mkTmp(t);
  appendSkillMetric({
    projectRoot: root,
    skill: 'CommitToGit',
    payload: { ts: '1999-01-01T00:00:00Z', skill: 'Sneaky', anything: 'else' },
    ts: new Date('2026-01-15T12:34:56Z'),
  });
  const parsed = JSON.parse(fs.readFileSync(innerLoopPath(root, 'skillMetricsJsonl'), 'utf8').trim());
  assert.equal(parsed.skill, 'CommitToGit');
  assert.equal(parsed.ts, '2026-01-15T12:34:56.000Z');
  assert.equal(parsed.anything, 'else');
});

test('appendSkillMetric: missing projectRoot or skill throws', () => {
  assert.throws(() => appendSkillMetric({ skill: 'X' }), /projectRoot is required/);
  assert.throws(() => appendSkillMetric({ projectRoot: '/tmp/x' }), /skill is required/);
  assert.throws(() => appendSkillMetric({ projectRoot: '/tmp/x', skill: 42 }), /skill is required/);
});

test('appendSkillMetric: payload type-checks (must be object)', () => {
  assert.throws(
    () => appendSkillMetric({ projectRoot: '/tmp/x', skill: 'X', payload: 'string' }),
    /payload must be an object/,
  );
});

test('appendSkillMetric: creates docs/inner-loop/ if it does not exist (no precondition)', (t) => {
  const root = mkTmp(t);
  assert.equal(fs.existsSync(path.join(root, 'docs', 'inner-loop')), false);
  appendSkillMetric({ projectRoot: root, skill: 'CommitToGit' });
  assert.ok(fs.existsSync(innerLoopPath(root, 'skillMetricsJsonl')));
});

test('append-skill-metric CLI: --project-root + --skill + --json writes JSONL', (t) => {
  const root = mkTmp(t);
  const r = spawnSync(process.execPath, [
    SCRIPT,
    '--project-root', root,
    '--skill', 'CommitToGit',
    '--json', JSON.stringify({ commitId: 'cli-test', durationMs: 100 }),
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `CLI must exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  const written = JSON.parse(fs.readFileSync(out.path, 'utf8').trim());
  assert.equal(written.skill, 'CommitToGit');
  assert.equal(written.commitId, 'cli-test');
  assert.equal(written.durationMs, 100);
});

test('append-skill-metric CLI: --json + --json-file together rejects', (t) => {
  const root = mkTmp(t);
  const r = spawnSync(process.execPath, [
    SCRIPT,
    '--project-root', root,
    '--skill', 'X',
    '--json', '{}',
    '--json-file', 'C:\\tmp\\anything.json',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'CLI must reject when both are passed');
  assert.match(r.stderr, /mutually exclusive/);
});
