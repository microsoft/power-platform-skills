'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveConflictsBulk, decideForConflict } = require('../lib/resolve-conflicts-bulk');

test('decideForConflict: first matching rule wins, else default', () => {
  const policy = {
    default: 'keep-current',
    rules: [
      { match: { pathIncludes: 'web-files' }, decision: 'accept-incoming' },
      { match: { type: 8 }, decision: 'skip' },
    ],
  };
  assert.equal(decideForConflict({ componentPath: '/x/web-files/app.css' }, policy), 'accept-incoming');
  assert.equal(decideForConflict({ componentType: 8, componentPath: '/x/web-templates/Y' }, policy), 'skip');
  assert.equal(decideForConflict({ componentType: 2, componentPath: '/x/web-pages/Z' }, policy), 'keep-current');
  assert.equal(decideForConflict({}, {}), 'skip', 'no default → skip');
});

test('resolveConflictsBulk: applies a blanket accept-incoming policy across all conflicts', async () => {
  const calls = [];
  const deps = { resolveGitConflictUserAction: async (a) => { calls.push(a); return { ok: true, useraction: a.decision === 'accept-incoming' ? 2 : 1 }; } };
  const conflicts = [
    { conflictId: 'a', componentId: 'c-a', componentName: 'A' },
    { conflictId: 'b', componentId: 'c-b', componentName: 'B' },
  ];
  const r = await resolveConflictsBulk({ conflicts, policy: { default: 'accept-incoming' }, envUrl: 'https://e', solutionId: 'sol', deps });
  assert.equal(r.total, 2);
  assert.equal(r.resolved, 2);
  assert.equal(r.failed, 0);
  assert.ok(calls.every((c) => c.decision === 'accept-incoming' && c.solutionId === 'sol'));
});

test('resolveConflictsBulk: rule-based — accept bundle churn, keep mine for templates, skip others', async () => {
  const deps = { resolveGitConflictUserAction: async (a) => ({ ok: true, useraction: a.decision === 'accept-incoming' ? 2 : 1 }) };
  const policy = {
    default: 'skip',
    rules: [
      { match: { pathIncludes: 'web-files' }, decision: 'accept-incoming' },
      { match: { type: 8 }, decision: 'keep-current' },
    ],
  };
  const conflicts = [
    { conflictId: '1', componentId: 'c1', componentName: 'app.css', componentType: 3, componentPath: '/x/web-files/app.css' },
    { conflictId: '2', componentId: 'c2', componentName: 'Header', componentType: 8, componentPath: '/x/web-templates/Header' },
    { conflictId: '3', componentId: 'c3', componentName: 'Page', componentType: 2, componentPath: '/x/web-pages/Page' },
  ];
  const r = await resolveConflictsBulk({ conflicts, policy, envUrl: 'https://e', solutionId: 'sol', deps });
  assert.equal(r.resolved, 2);   // css (accept) + header (keep)
  assert.equal(r.skipped, 1);    // page (default skip)
  assert.equal(r.results.find((x) => x.name === 'app.css').decision, 'accept-incoming');
  assert.equal(r.results.find((x) => x.name === 'Header').decision, 'keep-current');
  assert.equal(r.results.find((x) => x.name === 'Page').result, 'skipped');
});

test('resolveConflictsBulk: a custom decide() function overrides policy', async () => {
  const deps = { resolveGitConflictUserAction: async () => ({ ok: true, useraction: 2 }) };
  const conflicts = [{ conflictId: '1', componentId: 'c1', componentName: 'X' }];
  const r = await resolveConflictsBulk({ conflicts, decide: () => 'accept-incoming', envUrl: 'https://e', solutionId: 'sol', deps });
  assert.equal(r.resolved, 1);
});

test('resolveConflictsBulk: missing componentId → failed (never silently lost)', async () => {
  const deps = { resolveGitConflictUserAction: async () => ({ ok: true }) };
  const conflicts = [{ conflictId: '1', componentName: 'NoId' }];
  const r = await resolveConflictsBulk({ conflicts, policy: { default: 'accept-incoming' }, envUrl: 'https://e', solutionId: 'sol', deps });
  assert.equal(r.failed, 1);
  assert.match(r.results[0].error, /componentId/);
});

test('resolveConflictsBulk: validates required args', async () => {
  await assert.rejects(resolveConflictsBulk({ conflicts: [], envUrl: 'https://e' }), /solutionId/);
  await assert.rejects(resolveConflictsBulk({ conflicts: [], solutionId: 's' }), /envUrl/);
  await assert.rejects(resolveConflictsBulk({ envUrl: 'e', solutionId: 's' }), /conflicts must be an array/);
});
