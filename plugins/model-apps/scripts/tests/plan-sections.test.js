'use strict';
// The three plan-section primitives moved from the eval harness into the plugin, unchanged: the eval module re-exports the very
// same functions (so every evaluator and every plugin reader agree), and their behaviour is pinned on the plan shapes the
// schema documents — level-two headings only, any letter case, the first table with the named columns, rows to the first
// non-row line.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sections = require('../lib/plan-sections.js');
const PLAN_EVIDENCE = path.join(__dirname, '..', '..', '..', '..', 'evals', 'model-apps', 'genpage', 'lib', 'plan-evidence.js');

test('the eval harness re-exports the plugin\'s plan-section primitives, the same functions', () => {
  const evals = require(PLAN_EVIDENCE);
  for (const name of ['planSection', 'findMarkdownTable', 'parseMarkdownRows']) {
    assert.equal(typeof sections[name], 'function', `${name} is a plugin export`);
    assert.equal(evals[name], sections[name], `plan-evidence.js re-exports the plugin's ${name}`);
  }
});

const PLAN = [
  '# Genpage Plan',
  '',
  '## User Requirements',
  'Show accounts.',
  '',
  '## pages',
  '| Page | File | Purpose | Entities |',
  '|------|------|---------|----------|',
  '| Overview | overview.tsx | Summary | account |',
  '|  |  |  |  |',
  '| Details | details.tsx | One record | account |',
  'Trailing prose ends the table.',
  '| Stray | stray.tsx | not a row of the table | account |',
  '',
  '### Pages (2 total)',
  '## Per-Page Specifications',
  '### Overview',
].join('\n');

test('planSection reads one level-two section by its heading, in any letter case, to the next level-two heading', () => {
  assert.equal(sections.planSection(PLAN, 'User Requirements'), 'Show accounts.');
  assert.match(sections.planSection(PLAN, 'Pages'), /^\| Page \| File[\s\S]*### Pages \(2 total\)$/);
  assert.equal(sections.planSection(PLAN, 'Pages (2 total)'), null, 'a level-three heading is not a section');
  assert.equal(sections.planSection(PLAN, 'Missing'), null);
  assert.equal(sections.planSection('', 'Pages'), null);
  assert.equal(sections.planSection(PLAN, 'Per-Page Specifications'), '### Overview');
});

test('parseMarkdownRows reads the first table with the named columns, skipping empty rows, up to the first non-row line', () => {
  const body = sections.planSection(PLAN, 'Pages');
  assert.deepEqual(sections.parseMarkdownRows(body, ['page', 'FILE']), [
    { page: 'Overview', file: 'overview.tsx', purpose: 'Summary', entities: 'account' },
    { page: 'Details', file: 'details.tsx', purpose: 'One record', entities: 'account' },
  ]);
  assert.deepEqual(sections.parseMarkdownRows(body, ['Page', 'Key']), [], 'no table with a Key column');
  const table = sections.findMarkdownTable(body, ['Purpose']);
  assert.equal(table.lineIndex, 0);
  assert.deepEqual(table.headers, ['page', 'file', 'purpose', 'entities']);
  assert.equal(sections.findMarkdownTable('no table here', ['Page']), null);
});
