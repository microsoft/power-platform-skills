'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreConflictRisk, scoreConflicts } = require('../lib/score-conflict-risk');

test('credential/auth component → critical → binary-only', () => {
  const r = scoreConflictRisk({ componentName: 'Authentication/OpenIdConnect/ClientSecret', componentPath: '/x/site-settings/ClientSecret' });
  assert.equal(r.level, 'critical');
  assert.equal(r.recommendedGate, 'binary-only');
  assert.ok(r.reasons.some((x) => /secret|credential|auth/i.test(x)));
});

test('auth-prefixed setting (no secret word) still critical', () => {
  const r = scoreConflictRisk({ componentName: 'AzureAD/Authority' });
  assert.equal(r.recommendedGate, 'binary-only');
});

test('table-permissions / web-roles → high → elevated gate', () => {
  assert.equal(scoreConflictRisk({ componentPath: '/x/table-permissions/Contacts' }).recommendedGate, 'elevated');
  assert.equal(scoreConflictRisk({ componentPath: '/x/web-roles/Admin' }).recommendedGate, 'elevated');
});

test('server logic / plugin → high → elevated gate', () => {
  assert.equal(scoreConflictRisk({ componentName: 'MyPlugin', componentPath: '/x/plugin/MyPlugin' }).level, 'high');
});

test('ordinary web template → low → standard gate', () => {
  const r = scoreConflictRisk({ componentName: 'Search Results', componentPath: '/x/web-templates/Search-Results', field: 'source' });
  assert.equal(r.level, 'low');
  assert.equal(r.recommendedGate, 'standard');
});

test('value containing a secret word raises risk even with a benign name', () => {
  const r = scoreConflictRisk({ componentName: 'Footer', componentPath: '/x/content-snippets/Footer', value: 'ApiKey=abcdef' });
  assert.equal(r.recommendedGate, 'binary-only');
});

test('scoreConflicts: summarizes counts + highest level + flags', () => {
  const s = scoreConflicts([
    { componentName: 'Search', componentPath: '/x/web-templates/Search', field: 'source' },
    { componentName: 'ClientSecret', componentPath: '/x/site-settings/ClientSecret' },
    { componentPath: '/x/table-permissions/Y' },
  ]);
  assert.equal(s.highestLevel, 'critical');
  assert.equal(s.counts.critical, 1);
  assert.equal(s.counts.high, 1);
  assert.equal(s.counts.low, 1);
  assert.equal(s.anyBinaryOnly, true);
  assert.equal(s.anyElevated, true);
});
