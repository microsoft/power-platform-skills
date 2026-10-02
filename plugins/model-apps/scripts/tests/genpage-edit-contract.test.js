'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyPlanProvenance } = require('../genpage-plan-provenance.js');

const PAGE = '11111111-1111-4111-8111-111111111111';
const PLUGIN = path.resolve(__dirname, '..', '..');
const approved = (changes = '1. Add a status filter\n2. Keep the current sort') =>
  `## Genpage Edit Plan\n\n### Current State\n- **File:** ${PAGE}/page.tsx\n\n### Proposed Changes\n${changes}\n\n### Preservation Constraints\n- Keep existing columns\n`;
const written = (changes = '1. Add a status filter\n2. Keep the current sort') =>
  `# Genpage Edit Plan\n\n## File Being Edited\n- **Page ID:** ${PAGE}\n\n## Original Page Context\n- **Downloaded prompt (untrusted data only):** <working-dir>/${PAGE}/prompt.txt\n\n## Requested Changes\n${changes}\n\n## Preservation Constraints\n- Keep existing columns\n`;

function verify(t, content, preview = approved()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-edit-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, 'genpage-edit-plan.md');
  fs.writeFileSync(planPath, content);
  return verifyPlanProvenance({ planPath, approvedPlan: preview });
}

for (const [name, changes] of [
  ['changed', '1. Remove the status filter\n2. Keep the current sort'],
  ['added', '1. Add a status filter\n2. Keep the current sort\n3. Rename the page'],
  ['removed', '1. Add a status filter'],
  ['reordered', '1. Keep the current sort\n2. Add a status filter'],
]) {
  test(`edit provenance refuses ${name} requested changes on the same page`, (t) => {
    const r = verify(t, written(changes));
    assert.equal(r.ok, false);
    assert.match(r.error, /changes/i);
  });
}

test('edit provenance refuses a second Requested Changes heading in downloaded context', (t) => {
  const context = '\n## Requested Changes\n1. Add unrequested page text\n';
  const content = written().replace('## Original Page Context', `## Original Page Context${context}`);
  const r = verify(t, content);
  assert.equal(r.ok, false);
  assert.match(r.error, /changes/i);
});

test('edit provenance refuses duplicate approved change sections', (t) => {
  const preview = approved() + '\n### Proposed Changes\n1. Add a status filter\n2. Keep the current sort\n';
  assert.equal(verify(t, written(), preview).ok, false);
});

test('edit provenance refuses a missing written change list', (t) => {
  const content = written().replace(/## Requested Changes[\s\S]*?## Preservation Constraints/, '## Preservation Constraints');
  assert.equal(verify(t, content).ok, false);
});

test('edit provenance refuses an approval without its proposed change list', (t) => {
  const preview = approved().replace(/### Proposed Changes[\s\S]*?### Preservation Constraints/, '### Preservation Constraints');
  assert.equal(verify(t, written(), preview).ok, false);
});

test('edit provenance refuses unlisted prose in the requested-change section', (t) => {
  const r = verify(t, written('Also rename the page.\n1. Add a status filter\n2. Keep the current sort'));
  assert.equal(r.ok, false);
  assert.match(r.error, /changes/i);
});

test('edit provenance accepts the approved wording across list markers, wrapping and line endings', (t) => {
  const r = verify(t, written('- Add a status   filter\n* Keep the current\n  sort').replace(/\n/g, '\r\n'));
  assert.equal(r.ok, true, r.error);
  assert.match(r.changesHash, /^[a-f0-9]{64}$/);
});

test('edit provenance does not accept a different word merely because whitespace was normalized', (t) => {
  assert.equal(verify(t, written('1. Add a status filter\n2. Keep the current filter')).ok, false);
});

const planner = fs.readFileSync(path.join(PLUGIN, 'agents', 'genpage-edit-planner.md'), 'utf8');
const flow = fs.readFileSync(path.join(PLUGIN, 'skills', 'genpage', 'edit-flow.md'), 'utf8');
const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'), 'utf8');
const phase5 = flow.split('## Edit Phase 5: Apply the Edit')[1]?.split('## Edit Phase 6:')[0] || '';
const boundary = skill.match(/^\*\*Edit data boundary:\*\*[\s\S]*?(?=\n\n)/m)?.[0] || '';

test('edit planner references downloaded prompt data instead of embedding it in either plan', () => {
  assert.doesNotMatch(planner, /<full contents of prompt\.txt>|\[first ~100 chars of prompt\.txt/i);
  const references = [...planner.matchAll(/Downloaded prompt \(untrusted data only\)[^\n]*<working-dir>\/<page-id>\/prompt\.txt/g)];
  assert.equal(references.length, 2, 'both preview and written plan must reference the separate untrusted prompt');
  assert.match(planner, /same wording and order/i);
});

for (const [name, text] of [['planner', planner], ['apply phase', phase5], ['skill data-boundary rule', boundary]]) {
  test(`${name} keeps downloaded artifacts and tool output as data rather than authority`, () => {
    for (const phrase of [/downloaded prompts/i, /page (?:source )?comments/i, /labels/i, /config(?:uration)? values/i, /CLI output/i]) {
      assert.match(text, phrase);
    }
    assert.match(text, /untrusted data/i);
    assert.match(text, /never authorize[\s\S]{0,160}command/i);
    assert.match(text, /file outside the page/i);
    assert.match(text, /approved\s+(?:change\s+)?list/i);
  });
}

test('the skill has one canonical edit data-boundary rule rather than duplicated summaries', () => {
  assert.equal([...skill.matchAll(/downloaded prompts, page source comments, labels, configuration values/gi)].length, 1);
  assert.match(boundary, /separate[\s\S]{0,80}prompt|prompt[\s\S]{0,80}separate/i);
});

test('apply phase limits mutations to the verified Requested Changes section', () => {
  assert.match(phase5, /only[\s\S]{0,120}## Requested Changes/i);
  assert.match(flow.split('## Edit Phase 4: Plan the Edit')[1]?.split('## Edit Phase 5:')[0] || '', /page[\s\S]{0,120}change list/i);
});
