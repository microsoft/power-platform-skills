'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMergeMetrics, recordMergeMetrics } = require('../lib/record-merge-metrics');

const manifest = {
  runId: 'run-1',
  units: [
    { unitId: 'a', hasConflicts: false, conflictCount: 0 },
    { unitId: 'b', hasConflicts: true, conflictCount: 2 },
    { unitId: 'c', hasConflicts: true, conflictCount: 1 },
  ],
  binaryComponents: [{}, {}],
  deferredUnits: [{}],
  secretWarnings: [],
  components: [
    { name: 'X', risk: { level: 'low' } },
    { name: 'Y', risk: { level: 'critical' } },
  ],
};

const applyResult = {
  status: 'succeeded',
  steps: [{ step: 'accept-incoming', portalFallback: false, results: [{ via: 'useraction' }, { via: 'useraction' }] }],
  marker: { remainingConflicts: 0, adoCommitId: 'deadbeef' },
  contentVerify: [{ result: 'verified' }, { result: 'verified' }],
};

test('buildMergeMetrics: privacy-safe counts/ratios — NO names, paths, or content', () => {
  const m = buildMergeMetrics({ manifest, applyResult, runId: 'run-1', durationMs: 1234 });
  assert.equal(m.mergeUnits, 3);
  assert.equal(m.conflictedUnits, 2);
  assert.equal(m.autoMergedUnits, 1);
  assert.equal(m.autoMergeRatio, 0.333);
  assert.equal(m.totalConflictRegions, 3);
  assert.equal(m.binaryComponents, 2);
  assert.equal(m.deferredUnits, 1);
  assert.equal(m.acceptVia, 'useraction');
  assert.equal(m.remainingConflicts, 0);
  assert.equal(m.status, 'succeeded');
  assert.equal(m.durationMs, 1234);
  assert.deepEqual(m.riskCounts, { low: 1, medium: 0, high: 0, critical: 1 });
  assert.deepEqual(m.contentVerify, { verified: 2, mismatch: 0, unverified: 0 });
  // privacy: the serialized metric must not contain component names/paths
  const json = JSON.stringify(m);
  assert.ok(!/"X"|"Y"|web-templates|ClientSecret/.test(json), 'no names/paths leaked');
});

test('buildMergeMetrics: detects maker-portal fallback path', () => {
  const m = buildMergeMetrics({ manifest, applyResult: { status: 'manual-resolution-required', steps: [{ step: 'accept-incoming', portalFallback: true, results: [{ result: 'action-absent' }] }] } });
  assert.equal(m.acceptVia, 'maker-portal');
});

test('buildMergeMetrics: handles empty/missing inputs without throwing', () => {
  const m = buildMergeMetrics({});
  assert.equal(m.mergeUnits, 0);
  assert.equal(m.autoMergeRatio, null);
  assert.equal(m.acceptVia, null);
});

test('recordMergeMetrics: appends via SelectiveMerge skill; best-effort (never throws)', () => {
  const calls = [];
  const r = recordMergeMetrics({ projectRoot: '/p', manifest, applyResult, runId: 'run-1', deps: { appendSkillMetric: (a) => { calls.push(a); return { path: '/p/x.jsonl', line: '{}' }; } } });
  assert.equal(r.ok, true);
  assert.equal(calls[0].skill, 'SelectiveMerge');
  assert.equal(calls[0].payload.runId, 'run-1');
});

test('recordMergeMetrics: swallows append errors (observability never breaks apply)', () => {
  const r = recordMergeMetrics({ projectRoot: '/p', manifest, applyResult, deps: { appendSkillMetric: () => { throw new Error('disk full'); } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /disk full/);
});
