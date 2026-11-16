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

// Read as LF: a Windows checkout with core.autocrlf=true stores these docs CRLF, and the paragraph
// lookahead below (`\n\n`) then never matched, so the boundary rule read as empty there only.
const readDoc = (...rel) => fs.readFileSync(path.join(PLUGIN, ...rel), 'utf8').replace(/\r\n?/g, '\n');
const planner = readDoc('agents', 'genpage-edit-planner.md');
const flow = readDoc('skills', 'genpage', 'edit-flow.md');
const skill = readDoc('skills', 'genpage', 'SKILL.md');
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

// Pull-to-repo and promotion (#675). Pulling pages into the project is a read of the environment and a local write, so
// the section must name no command that changes the environment, and an unattended pull must neither guess a page nor
// replace a local copy. The promotion guide is loaded only for a promote request and cites Microsoft Learn for its rules.
const readText = (...parts) => fs.readFileSync(path.join(PLUGIN, ...parts), 'utf8').replace(/\r\n/g, '\n');
const pullSection = () => {
  const skill = readText('skills', 'genpage', 'SKILL.md');
  const at = skill.indexOf('\n## Pulling existing pages into the project\n');
  assert.ok(at >= 0, 'SKILL.md has the pull section');
  const rest = skill.slice(at + 1);
  const next = rest.indexOf('\n## ', 3);
  return next < 0 ? rest : rest.slice(0, next);
};

test('pulling pages into the project reads the environment and never writes to it', () => {
  const pull = pullSection();
  const scripts = [...pull.matchAll(/scripts\/([\w-]+\.js)"(?: (\w+))?/g)].map((m) => `${m[1]} ${m[2] || ''}`.trim());
  assert.deepEqual([...new Set(scripts)].sort(), [
    'apps.js list', 'check-auth.js', 'genpage-base.js record', 'genpage.js download', 'genpage.js list',
  ]);
  assert.doesNotMatch(pull, /genpage-upload|add-to-app|remove-from-app|genpage\.js" delete|--overwrite-deployed/);
  assert.match(pull, /`<project-root>\/<page-id>\/`/);
  assert.match(pull, /--page-id '<page-id1>,<page-id2>' --output-directory '<project-root>'/);
  assert.match(pull.replace(/\s+/g, ' '), /on `ok: false` show the `message` verbatim and stop/, 'a failed sign-in check stops the pull');
});

test('an unattended pull neither guesses a page nor replaces a local copy', () => {
  const pull = pullSection().replace(/\s+/g, ' ');
  assert.match(pull, /\*\*Unattended:\*\* pull only the pages `\$ARGUMENTS` names by id or exact name; when none is named, or a name matches more than one page, halt/);
  assert.match(pull, /\*\*Unattended:\*\* skip it and report it\. A pull never replaces local work nobody agreed to replace\./);
  assert.match(pull, /Do not edit, build or upload the pulled pages in this request\./);
});

test('the promotion guide is read only for a promote request and cites Microsoft Learn for each rule', () => {
  const skill = readText('skills', 'genpage', 'SKILL.md');
  const loads = skill.split('\n').filter((line) => line.includes('promotion.md'));
  assert.equal(loads.length, 2);
  for (const line of loads) assert.match(line, /promot|\[promotion\.md\]/i);
  assert.match(skill.replace(/\s+/g, ' '), /\*\*Promote pages to another environment\*\*[^.]*: read \[promotion\.md\]\(\.\.\/\.\.\/references\/promotion\.md\) and follow it\. Read it only for such a request\./);

  const guide = readText('references', 'promotion.md');
  const sections = guide.split(/\n(?=## \d+\. )/).slice(1);
  assert.equal(sections.length, 10);
  const titles = sections.map((s) => s.split('\n')[0]);
  for (const s of sections.slice(0, 9)) {
    assert.match(s, /\(https:\/\/learn\.microsoft\.com\/[^)\s]+\)/, `${s.split('\n')[0]} cites Microsoft Learn`);
  }
  assert.deepEqual(titles.map((t) => t.replace(/^## \d+\. /, '')), [
    'Package the pages first', 'Managed or unmanaged', 'Full solution or patch', 'Version number', 'Dependency check',
    'Import order', 'Connections and the import', 'Rollback', 'What travels with a page, and what does not', 'Record the promotion',
  ]);
  assert.match(guide, /The full authoring conversation: in the target, the designer shows only the first prompt and the published code/);
  // Learn qualifies both promises: a managed component may be customized in the target through an unmanaged layer when its
  // managed properties allow it, and an upgrade deletes the components a new version drops, with their data, which no
  // roll-forward brings back. So neither may be stated as absolute, and the backup advice covers such an upgrade too.
  const flat = (title) => (sections.find((s) => s.startsWith(title)) || '').replace(/\s+/g, ' ');
  const managed = flat('## 2. Managed or unmanaged');
  assert.doesNotMatch(managed, /its components cannot be edited in the target/);
  assert.match(managed, /cannot be edited in the target directly\. A component it brings can still be customized there when its managed properties allow it/);
  const rollback = flat('## 8. Rollback');
  assert.doesNotMatch(rollback, /loses nothing/);
  assert.match(rollback, /it does not bring back data an earlier upgrade or migration deleted/);
  assert.match(rollback, /Back up the target before an import that cannot be undone:\*\* any unmanaged import, and any upgrade that removes components/);
  // Guidance, not automation: the guide exports nothing and changes no page; the one write it runs is the documented import.
  assert.doesNotMatch(guide, /genpage-upload\.js|pac solution export|ExportSolution/);
  const writes = [...guide.matchAll(/scripts\/([\w-]+\.js)"(?: (\w+))?/g)].map((m) => `${m[1]} ${m[2] || ''}`.trim());
  assert.deepEqual([...new Set(writes)].sort(), ['genpage.js types', 'list-custom-apis.js', 'list-tables.js', 'solution-settings.js import', 'solution-settings.js template']);
});