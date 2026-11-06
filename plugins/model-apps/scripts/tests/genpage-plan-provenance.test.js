'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { preparePlanProvenance, verifyPlanProvenance, planTargets } = require('../genpage-plan-provenance.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

// What the planner hands back for approval (agents/genpage-planner.md Step 5) — a PREVIEW, with full
// prefixed names — and what it then writes (Step 6): a different document, suffixes only. The gate
// must accept the pair; a whole-document hash never could.
const PREVIEW = [
  '## Genpage Plan',
  '',
  '### Pages (2 total)',
  '| Page | File | Purpose | Entities |',
  '|------|------|---------|----------|',
  '| Overview | overview.tsx | Summary cards | contoso_project |',
  '| Details | details.tsx | One record | contoso_project |',
  '',
  '### Data Strategy',
  '- Entities to create: contoso_project (contoso_name, contoso_stage)',
  '',
  '### Localization',
  '- English only — no localization needed',
].join('\n');
const WRITTEN = [
  '# Genpage Plan',
  '## User Requirements',
  'Projects overview and details.',
  '## Pages',
  '| Page | File | Purpose | Entities |',
  '|------|------|---------|----------|',
  '| Details | details.tsx | One record | project |',
  '| Overview | overview.tsx | Summary cards | project |',
  '## Entity Creation Required',
  '### project',
  '| Suffix | Type |',
  '|---|---|',
  '| name | Text |',
  '## Per-Page Specifications',
  '### Overview',
  '- **File:** overview.tsx',
].join('\r\n');
const PAGE_ID = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';
const EDIT_PREVIEW = `## Genpage Edit Plan\n\n### Current State\n- **File:** ${PAGE_ID}/page.tsx\n- **Data:** Mock data\n\n### Proposed Changes\n1. Add a search box\n`;
const EDIT_WRITTEN = `# Genpage Edit Plan\n\n## File Being Edited\n- **Absolute path:** D:\\work\\edit\\${PAGE_ID}\\page.tsx\n- **App ID:** 11111111-2222-3333-4444-555555555555\n- **Page ID:** ${PAGE_ID}\n\n## Requested Changes\n1. Add a search box\n`;

// An edit plan lives in `genpage-edit-plan.md` (skills/genpage/edit-flow.md), and verify reads each file as the
// kind its name says.
const EDIT = 'genpage-edit-plan.md';
function tmpPlan(content, name = 'genpage-plan.md') {
  const dir = makeTempDir('genpage-plan-prov-');
  const planPath = path.join(dir, name);
  if (content !== undefined) fs.writeFileSync(planPath, content, 'utf8');
  return planPath;
}

test('preparePlanProvenance quarantines a stale plan before planner dispatch', () => {
  const planPath = tmpPlan('# Genpage Plan\nstale\n');

  const result = preparePlanProvenance({ planPath });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(planPath), false, 'stale plan must not remain at the authoritative path');
  assert.ok(result.quarantinedPath, 'quarantine path reported');
  assert.equal(fs.readFileSync(result.quarantinedPath, 'utf8'), '# Genpage Plan\nstale\n');
});

test('what a plan targets: the Pages files of a create, the page id of an edit, in either document', () => {
  assert.deepEqual(planTargets(PREVIEW), { kind: 'create', targets: ['details.tsx', 'overview.tsx'] });
  assert.deepEqual(planTargets(WRITTEN), { kind: 'create', targets: ['details.tsx', 'overview.tsx'] });
  assert.deepEqual(planTargets(EDIT_PREVIEW), { kind: 'edit', targets: [PAGE_ID] });
  assert.deepEqual(planTargets(EDIT_WRITTEN), { kind: 'edit', targets: [PAGE_ID] });
  assert.equal(planTargets('## Genpage Plan\n### Data Strategy\n- none\n'), null);
  // A create plan's per-page File line holding a GUID path is still a create, decided by its table.
  const guidFile = WRITTEN.replace('- **File:** overview.tsx', `- **File:** ${PAGE_ID}/page.tsx`);
  assert.equal(planTargets(guidFile).kind, 'create');
});

// The preview approved in plan mode and the file the planner writes are different documents by design.
test('verifyPlanProvenance accepts the written plan when it targets exactly the approved pages', () => {
  const create = verifyPlanProvenance({ planPath: tmpPlan(WRITTEN), approvedPlan: PREVIEW });
  assert.equal(create.ok, true, create.error);
  assert.deepEqual(create.targets, ['details.tsx', 'overview.tsx']);
  assert.match(create.writtenHash, /^[a-f0-9]{64}$/, 'the verified file is recorded by hash for the log');
  const edit = verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN, EDIT), approvedPlan: EDIT_PREVIEW });
  assert.equal(edit.ok, true, edit.error);
});

// A stale plan from an earlier run, or one the planner re-derived, targets other pages.
test('verifyPlanProvenance halts when the written plan targets other pages than were approved', () => {
  for (const [what, written] of [
    ['an extra page', WRITTEN.replace('| Overview | overview.tsx | Summary cards | project |', '| Overview | overview.tsx | Summary cards | project |\r\n| Admin | admin.tsx | Settings | project |')],
    ['a missing page', WRITTEN.replace('| Details | details.tsx | One record | project |\r\n', '')],
    ['a renamed page file', WRITTEN.replace('| Details | details.tsx |', '| Details | detail-view.tsx |')],
    ['no Pages table at all', WRITTEN.replace(/## Pages[\s\S]*?## Entity/, '## Entity')],
    ['an edit plan instead', EDIT_WRITTEN],
  ]) {
    const result = verifyPlanProvenance({ planPath: tmpPlan(written), approvedPlan: PREVIEW });
    assert.equal(result.ok, false, what);
    assert.match(result.error, /approved plan named details\.tsx, overview\.tsx/, what);
  }
  const otherPage = verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN.replace(/6e0c28a2/g, '7f1d39b3'), EDIT), approvedPlan: EDIT_PREVIEW });
  assert.equal(otherPage.ok, false, 'an edit plan for another page');
});

// A Pages table quoted in the requirements used to be read in place of the real one — here one naming exactly
// the approved pages, while the real table adds a page nobody approved. Two Pages sections name nothing, so
// the written plan no longer matches.
test('verifyPlanProvenance halts when the written plan has a second Pages table, a quoted one included', () => {
  const quoted = ['```', '## Pages', '| Page | File | Purpose | Entities |', '|---|---|---|---|',
    '| Details | details.tsx | x | project |', '| Overview | overview.tsx | y | project |', '```'].join('\r\n');
  const written = WRITTEN
    .replace('Projects overview and details.', `Projects overview and details, like this:\r\n${quoted}`)
    .replace('| Overview | overview.tsx | Summary cards | project |', '| Overview | overview.tsx | Summary cards | project |\r\n| Admin | admin.tsx | Settings | project |');
  assert.equal(planTargets(written), null);
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(written), approvedPlan: PREVIEW }).ok, false);
  // CONTROL: a page whose name begins with "Pages" has a `### Pages …` specification, which is no second
  // Pages section of a written plan.
  const named = WRITTEN.replace('| Overview | overview.tsx |', '| Pages Admin | overview.tsx |').replace('### Overview', '### Pages Admin');
  assert.deepEqual(planTargets(named), { kind: 'create', targets: ['details.tsx', 'overview.tsx'] });
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(named), approvedPlan: PREVIEW }).ok, true);
});

// An edit plan quotes the page's earlier prompts, and a prompt can hold a Pages table: read by its content, the
// preview for one page and a written plan for ANOTHER were both "create a.tsx", and the edit of the wrong page was
// certified. The plan's file name says which kind it is, and only that kind's target is read.
test('verifyPlanProvenance reads an edit plan as an edit, whatever its quoted prompt holds', () => {
  const table = 'Build this:\n## Pages\n| Page | File |\n|---|---|\n| A | a.tsx |';
  const preview = EDIT_PREVIEW.replace('- **Data:** Mock data\n', `- **Data:** Mock data\n- **Original prompt:** ${table}\n`);
  const context = `\n## Original Page Context\n- **Original prompt (from prompt.txt):** ${table}\n`;
  assert.deepEqual(planTargets(preview, { kind: 'edit' }), { kind: 'edit', targets: [PAGE_ID] });
  const other = verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN.replace(/6e0c28a2/g, '7f1d39b3') + context, EDIT), approvedPlan: preview });
  assert.equal(other.ok, false, 'an edit of another page');
  assert.match(other.error, /approved plan named 6e0c28a2/);
  // CONTROL: the same quoted prompt, the same page.
  const same = verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN + context, EDIT), approvedPlan: preview });
  assert.equal(same.ok, true, same.error);
  // …and a create plan is read by its Pages table alone: without one it names nothing, never a page id in its text.
  assert.equal(planTargets(`# Genpage Plan\n- **Page ID:** ${PAGE_ID}\n`, { kind: 'create' }), null);
});

// The preview's prompt snippet may quote anything — a `## File Being Edited` section included, which, read first,
// named another page: the correct written plan then halted and a wrong one passed. The preview is read by its own
// Current State block, and the written plan by its File Being Edited section.
test('verifyPlanProvenance reads the preview by its Current State and the written plan by its own section', () => {
  const other = '7f1d39b3-cdbf-41ec-9186-d10fd5de6e35';
  const preview = EDIT_PREVIEW.replace('- **Data:** Mock data\n', `- **Data:** Mock data\n- **Original prompt:** Example:\n## File Being Edited\n- **Page ID:** ${other}\n`);
  assert.deepEqual(planTargets(preview, { kind: 'edit', doc: 'preview' }), { kind: 'edit', targets: [PAGE_ID] });
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN, EDIT), approvedPlan: preview }).ok, true, 'the approved page passes');
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN.replace(/6e0c28a2/g, '7f1d39b3'), EDIT), approvedPlan: preview }).ok, false, 'another page halts');
  // A written plan without its section names nothing, whatever else it quotes; nor does a preview without its block.
  assert.equal(planTargets(`# Genpage Edit Plan\n## Original Page Context\n- **File:** ${PAGE_ID}/page.tsx\n`, { kind: 'edit', doc: 'written' }), null);
  assert.equal(planTargets(`## Genpage Edit Plan\n## File Being Edited\n- **Page ID:** ${PAGE_ID}\n`, { kind: 'edit', doc: 'preview' }), null);
  // …and one whose section has neither a label nor a path names nothing: a page path quoted elsewhere in the plan is
  // not the page it edits.
  const bare = `# Genpage Edit Plan\n## File Being Edited\n- **App ID:** 11111111-2222-3333-4444-555555555555\n## Original Page Context\n- **File:** ${other}/page.tsx\n`;
  assert.equal(planTargets(bare, { kind: 'edit', doc: 'written' }), null);
  // CONTROL: a written plan whose section has no Page ID label is read by the page folder in the section's own path.
  const noLabel = EDIT_WRITTEN.replace(`- **Page ID:** ${PAGE_ID}\n`, '') + `\n## Original Page Context\n- **File:** ${other}/page.tsx\n`;
  assert.deepEqual(planTargets(noLabel, { kind: 'edit', doc: 'written' }), { kind: 'edit', targets: [PAGE_ID] });
});

test('verifyPlanProvenance halts when the planner wrote nothing, or the approval names no pages', () => {
  const missing = verifyPlanProvenance({ planPath: tmpPlan(), approvedPlan: PREVIEW });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /planner did not write/);
  const vague = verifyPlanProvenance({ planPath: tmpPlan(WRITTEN), approvedPlan: 'Approved!' });
  assert.equal(vague.ok, false);
  assert.match(vague.error, /approved plan body names no pages/);
});

// An overlong id was truncated to its first 36 characters and certified. Both GUID patterns are bounded
// like the id parsers elsewhere in the plugin (a page id is exactly 36 characters), and a Page ID label whose value is malformed
// makes the plan name nothing — never a GUID found elsewhere, since the edit worker reads that label.
test('an overlong or malformed page id is refused, never truncated to a valid-looking one', () => {
  const overlong = EDIT_WRITTEN.replace(`**Page ID:** ${PAGE_ID}`, `**Page ID:** ${PAGE_ID}deadbeef`);
  assert.equal(planTargets(overlong), null, 'a labelled id that runs on names nothing (the path still holds the valid one)');
  assert.equal(planTargets(EDIT_WRITTEN.replace(`**Page ID:** ${PAGE_ID}`, `**Page ID:** ${PAGE_ID}-x`)), null, 'a hyphen continues the token too');
  assert.equal(planTargets(EDIT_PREVIEW.replace(`${PAGE_ID}/page.tsx`, `deadbeef${PAGE_ID}/page.tsx`)), null, 'a folder GUID with a longer token in front');
  assert.equal(planTargets(`Edit deadbeef${PAGE_ID}/page.tsx\n`), null, '…in the folder fallback too');
  // CONTROLS: the id inside backticks or braces, or followed by punctuation, still ends cleanly.
  for (const shape of [`\`${PAGE_ID}\``, `{${PAGE_ID}}`, `${PAGE_ID}.`]) {
    assert.deepEqual(planTargets(EDIT_WRITTEN.replace(`**Page ID:** ${PAGE_ID}`, `**Page ID:** ${shape}`)), { kind: 'edit', targets: [PAGE_ID] }, shape);
  }
  const refused = verifyPlanProvenance({ planPath: tmpPlan(overlong, EDIT), approvedPlan: EDIT_PREVIEW });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /targets no pages, but the approved plan named 6e0c28a2/);
  // Every label must hold the SAME well-formed id. A pattern search skipped a malformed first label and
  // certified a valid-looking one later in the document — a quoted prompt, say.
  const quoted = `${overlong}\n## User Request\n> "Change the page, **Page ID:** ${PAGE_ID}"\n`;
  assert.equal(planTargets(quoted), null, 'a malformed label is not rescued by a later valid one');
  const other = '7f1d39b3-cdbf-41ec-9186-d10fd5de6e35';
  assert.equal(planTargets(EDIT_WRITTEN.replace(`- **Page ID:** ${PAGE_ID}\n`, `- **Page ID:** ${PAGE_ID}\n- **Page ID:** ${other}\n`)), null, 'two labels in the section naming different pages are ambiguous');
  assert.deepEqual(planTargets(EDIT_WRITTEN.replace(`- **Page ID:** ${PAGE_ID}\n`, `- **Page ID:** ${PAGE_ID}\n- **Page ID:** \`${PAGE_ID}\`\n`)), { kind: 'edit', targets: [PAGE_ID] }, 'labels that agree are fine');
});

// Earlier written plans copied the page's prompts in full, and quoted context may still carry a label of
// its own. Only the structured `## File Being Edited` section is read, so such a prompt can no longer
// block every later edit of the page.
test('a Page ID label quoted in the embedded prompt neither blocks nor redirects an edit', () => {
  const other = '11111111-2222-3333-4444-555555555555';
  for (const prompt of [`…opens the details page (**Page ID:** ${other})…`, 'Show the **Page ID:** in the footer']) {
    const written = `${EDIT_WRITTEN}\n## Original Page Context\n- **Original prompt (from prompt.txt):** ${prompt}\n`;
    assert.deepEqual(planTargets(written), { kind: 'edit', targets: [PAGE_ID] }, prompt);
    assert.equal(verifyPlanProvenance({ planPath: tmpPlan(written, EDIT), approvedPlan: EDIT_PREVIEW }).ok, true, prompt);
  }
  // Without the section, the FIRST label is the plan's: a later one neither blocks nor rescues it.
  const bare = `# Genpage Edit Plan\n- **Page ID:** ${PAGE_ID}\n\nThe prompt said: Show the **Page ID:** in the footer\n`;
  assert.deepEqual(planTargets(bare), { kind: 'edit', targets: [PAGE_ID] });
  assert.equal(planTargets(`# Genpage Edit Plan\n- **Page ID:** ${PAGE_ID}x\n\n(**Page ID:** ${PAGE_ID})\n`), null);
  // A section without a label falls back to the folder in its absolute path, never to a quoted label.
  const noLabel = EDIT_WRITTEN.replace(`- **Page ID:** ${PAGE_ID}\n`, '') + `\n## Original Page Context\n(**Page ID:** ${other})\n`;
  assert.deepEqual(planTargets(noLabel), { kind: 'edit', targets: [PAGE_ID] });
});

// The approval PREVIEW has no `## File Being Edited` section: it names its page in its own `- **File:**`
// line and quotes the first ~100 characters of the page's prompt a few lines later. A label read anywhere
// came out of that quote and decided the approved target — on every later edit of that page, since its
// first prompt never changes.
test('a Page ID label quoted in the preview\u2019s prompt snippet neither blocks nor redirects the approval', () => {
  const other = '11111111-2222-3333-4444-555555555555';
  for (const snippet of ['…1. Show the **Page ID:** in the footer', `…1. Like **Page ID:** ${other}`, `Copy the layout of **File:** ${other}/page.tsx`]) {
    const preview = EDIT_PREVIEW.replace('- **Data:** Mock data\n', `- **Data:** Mock data\n- **Original prompt:** ${snippet}\n`);
    assert.deepEqual(planTargets(preview), { kind: 'edit', targets: [PAGE_ID] }, snippet);
    const verified = verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN, EDIT), approvedPlan: preview });
    assert.equal(verified.ok, true, `${snippet}: ${verified.error}`);
    // …wherever the snippet sits relative to the File line.
    const snippetFirst = `## Genpage Edit Plan\n\n### Current State\n- **Original prompt:** ${snippet}\n- **File:** ${PAGE_ID}/page.tsx\n`;
    assert.deepEqual(planTargets(snippetFirst), { kind: 'edit', targets: [PAGE_ID] }, `${snippet}, before the File line`);
  }
  // The snippet is the prompt's first ~100 characters, newlines included, so a quoted label can even
  // BEGIN a line; the preview's own File line still decides.
  const multiLine = EDIT_PREVIEW.replace('- **Data:** Mock data\n', `- **Data:** Mock data\n- **Original prompt:** Build a details page\n- **Page ID:** ${other}\n`);
  assert.deepEqual(planTargets(multiLine), { kind: 'edit', targets: [PAGE_ID] });
  // Without a File line, a label that BEGINS a line is still read — and a mid-line one never is.
  assert.deepEqual(planTargets(`# Genpage Edit Plan\n- **Page ID:** ${PAGE_ID}\n`), { kind: 'edit', targets: [PAGE_ID] });
  assert.deepEqual(planTargets(`# Genpage Edit Plan\n**Page ID:** \`${PAGE_ID}\`\n`), { kind: 'edit', targets: [PAGE_ID] });
  assert.equal(planTargets(`# Genpage Edit Plan\nThe prompt said: like **Page ID:** ${other}\n`), null);
});

// The approval sidecar is written IN PLACE by the orchestrator after `prepare`, so a link at its
// conventional path — or a hard link, whose other name the write would rewrite — is refused up front.
test('prepare refuses an approval sidecar that is a link, a hard link or a folder, and keeps a plain stale one', (t) => {
  const planPath = tmpPlan('stale\n');
  const dir = path.dirname(planPath);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-outside-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const sidecar = path.join(dir, '.approved-genpage-plan.md');
  fs.writeFileSync(path.join(outside, 'victim.md'), 'keep me');
  fs.linkSync(path.join(outside, 'victim.md'), sidecar);
  const hard = preparePlanProvenance({ planPath });
  assert.equal(hard.ok, false);
  assert.match(hard.error, /\.approved-genpage-plan\.md is not a plain file/);
  assert.equal(fs.readFileSync(planPath, 'utf8'), 'stale\n', 'nothing is quarantined while it refuses');
  fs.unlinkSync(sidecar);
  fs.mkdirSync(sidecar);
  assert.equal(preparePlanProvenance({ planPath }).ok, false, 'a folder there is refused too');
  fs.rmdirSync(sidecar);
  if (linkOrSkip(t, path.join(outside, 'victim.md'), sidecar, 'file')) {
    assert.equal(preparePlanProvenance({ planPath }).ok, false, 'and a symbolic link');
    fs.unlinkSync(sidecar);
  }
  fs.writeFileSync(sidecar, 'last run\n');
  assert.equal(preparePlanProvenance({ planPath }).ok, true, 'a plain sidecar from an earlier run is simply overwritten later');
  assert.equal(fs.readFileSync(path.join(outside, 'victim.md'), 'utf8'), 'keep me');
});

// A link at either path this writes through is refused, dangling ones included: existsSync called a
// dangling link at the plan path absent and left it for the planner to write through, and
// mkdir({ recursive }) plus rename followed a link at `.genpage-provenance` out of the working directory.
function linkOrSkip(t, target, at, type) {
  try { fs.symlinkSync(target, at, type); return true; } catch (e) { t.skip(`cannot create a ${type} link here: ${e.message}`); return false; }
}

test('prepare refuses a link or a folder at the plan path, dangling links included', (t) => {
  const planPath = tmpPlan();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-outside-'));
  t.after(() => { fs.rmSync(path.dirname(planPath), { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  if (!linkOrSkip(t, path.join(outside, 'approved.md'), planPath, 'file')) return;
  const dangling = preparePlanProvenance({ planPath });
  assert.equal(dangling.ok, false, 'a dangling link is not "no plan here"');
  assert.match(dangling.error, /symbolic link or junction/);
  assert.ok(fs.lstatSync(planPath).isSymbolicLink(), 'left for the user to remove, not followed');
  fs.writeFileSync(path.join(outside, 'approved.md'), 'outside\n');
  assert.equal(preparePlanProvenance({ planPath }).ok, false, 'a live link too');
  assert.equal(fs.readFileSync(path.join(outside, 'approved.md'), 'utf8'), 'outside\n', 'its target is untouched');
  fs.unlinkSync(planPath);
  fs.mkdirSync(planPath);
  const folder = preparePlanProvenance({ planPath });
  assert.equal(folder.ok, false);
  assert.match(folder.error, /not a regular file/);
});

test('prepare refuses a quarantine folder that is a link or a file, and moves nothing', (t) => {
  const planPath = tmpPlan('stale\n');
  const dir = path.dirname(planPath);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-outside-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const quarantine = path.join(dir, '.genpage-provenance');
  if (!linkOrSkip(t, outside, quarantine, 'junction')) return;
  const linked = preparePlanProvenance({ planPath });
  assert.equal(linked.ok, false);
  assert.match(linked.error, /not a plain directory/);
  assert.equal(fs.readFileSync(planPath, 'utf8'), 'stale\n', 'the stale plan is not moved');
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing lands outside the working directory');
  fs.unlinkSync(quarantine);
  fs.writeFileSync(quarantine, 'not a folder');
  assert.match(preparePlanProvenance({ planPath }).error, /not a plain directory/);
});

// A dangling link already at the quarantine name is an entry like any other: the stale plan takes the
// next free slot, rather than replacing the link.
test('prepare never replaces an existing entry in the quarantine folder, a dangling link included', (t) => {
  const planPath = tmpPlan('stale\n');
  const dir = path.dirname(planPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quarantine = path.join(dir, '.genpage-provenance');
  fs.mkdirSync(quarantine);
  const hash = require('node:crypto').createHash('sha256').update('stale\n', 'utf8').digest('hex').slice(0, 12);
  const taken = path.join(quarantine, `genpage-plan.stale-${hash}.md`);
  const takenToo = path.join(quarantine, `genpage-plan.stale-${hash}-1.md`);
  if (!linkOrSkip(t, path.join(dir, 'gone.md'), taken, 'file')) return;
  fs.symlinkSync(path.join(dir, 'gone-too.md'), takenToo, 'file');
  const r = preparePlanProvenance({ planPath });
  assert.equal(r.ok, true, r.error);
  assert.equal(path.basename(r.quarantinedPath), `genpage-plan.stale-${hash}-2.md`, 'both the base name and the first suffix are taken');
  assert.ok(fs.lstatSync(taken).isSymbolicLink() && fs.lstatSync(takenToo).isSymbolicLink(), 'the existing entries are untouched');
});

test('prepare reports a failed quarantine as a result, not a throw', (t) => {
  const planPath = tmpPlan('stale\n');
  t.after(() => fs.rmSync(path.dirname(planPath), { recursive: true, force: true }));
  t.mock.method(fs, 'renameSync', () => { throw new Error('EBUSY: resource busy or locked'); });
  const r = preparePlanProvenance({ planPath });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not quarantine the earlier plan: EBUSY/);
});

// Only "nothing there" means nothing there: a path that cannot even be inspected is not a missing plan —
// reading it as one would skip the quarantine and let a stale plan pass for this run's.
test('a plan path that cannot be inspected or read fails the gate instead of reading as absent', (t) => {
  const planPath = tmpPlan(WRITTEN);
  t.after(() => fs.rmSync(path.dirname(planPath), { recursive: true, force: true }));
  const denied = () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; };
  const lstat = t.mock.method(fs, 'lstatSync', denied);
  const prep = preparePlanProvenance({ planPath });
  assert.equal(prep.ok, false);
  assert.match(prep.error, /could not quarantine the earlier plan: EACCES/);
  const inspect = verifyPlanProvenance({ planPath, approvedPlan: PREVIEW });
  assert.equal(inspect.ok, false);
  assert.match(inspect.error, /could not inspect .*EACCES/);
  lstat.mock.restore();
  t.mock.method(fs, 'readFileSync', denied);
  const read = verifyPlanProvenance({ planPath, approvedPlan: PREVIEW });
  assert.equal(read.ok, false);
  assert.match(read.error, /could not read .*EACCES/);
});

// What verify certifies must be the file written in place, not whatever a link points at.
test('verify refuses a written plan that is a link or a folder', (t) => {
  const planPath = tmpPlan();
  const dir = path.dirname(planPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'elsewhere.md'), WRITTEN);
  if (!linkOrSkip(t, path.join(dir, 'elsewhere.md'), planPath, 'file')) return;
  const linked = verifyPlanProvenance({ planPath, approvedPlan: PREVIEW });
  assert.equal(linked.ok, false, 'a link to a matching plan is still not the plan');
  assert.match(linked.error, /not a plain file \(a link, junction, hard link or folder\)/);
  fs.unlinkSync(planPath);
  fs.mkdirSync(planPath);
  assert.match(verifyPlanProvenance({ planPath, approvedPlan: PREVIEW }).error, /not a plain file \(a link, junction, hard link or folder\)/);
});

// The skill acts on the CLI's exit code and JSON line, so that contract is pinned end to end.
test('the CLI prepares and verifies by exit code: 0 on success, 3 on a failed gate, 1 on a usage error', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'genpage-plan-provenance.js');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-prov-cli-'));
  try {
    const planPath = path.join(dir, 'genpage-plan.md');
    const approved = path.join(dir, '.approved-genpage-plan.md');
    fs.writeFileSync(planPath, 'stale\n');
    const prep = run('prepare', '--plan', planPath);
    assert.equal(prep.status, 0, prep.stdout);
    assert.equal(JSON.parse(prep.stdout).ok, true);
    assert.equal(fs.existsSync(planPath), false, 'quarantined');
    // A second prepare with nothing to move is still a success, and a colliding stale name gets its own slot.
    assert.equal(run('prepare', '--plan', planPath).status, 0);
    fs.writeFileSync(planPath, 'stale\n');
    const again = JSON.parse(run('prepare', '--plan', planPath).stdout);
    assert.notEqual(again.quarantinedPath, JSON.parse(prep.stdout).quarantinedPath, 'an identical stale plan does not overwrite the first');

    fs.writeFileSync(approved, PREVIEW);
    const missing = run('verify', '--plan', planPath, '--approved', `@${approved}`);
    assert.equal(missing.status, 3);
    assert.match(JSON.parse(missing.stdout).error, /planner did not write/);
    fs.writeFileSync(planPath, WRITTEN);
    assert.equal(run('verify', '--plan', planPath, '--approved', `@${approved}`).status, 0);
    fs.writeFileSync(planPath, WRITTEN.replace('details.tsx', 'other.tsx'));
    assert.equal(run('verify', '--plan', planPath, '--approved', `@${approved}`).status, 3);

    assert.equal(run('verify', '--plan', planPath).status, 3, 'verify without --approved fails the gate');
    // An approved file that is missing, or a link rather than the file the orchestrator wrote, fails the
    // gate with a result — it used to throw out of the CLI.
    const gone = run('verify', '--plan', planPath, '--approved', `@${path.join(dir, 'no-such-approved.md')}`);
    assert.equal(gone.status, 3, gone.stderr);
    assert.match(JSON.parse(gone.stdout).error, /^could not read the approved plan: ENOENT/);
    const linkedApproved = path.join(dir, 'linked-approved.md');
    let linked = true;
    try { fs.symlinkSync(approved, linkedApproved, 'file'); } catch { linked = false; }
    if (linked) {
      const viaLink = run('verify', '--plan', planPath, '--approved', `@${linkedApproved}`);
      assert.equal(viaLink.status, 3);
      assert.match(JSON.parse(viaLink.stdout).error, /could not read the approved plan: .* is not a regular file/);
    }
    assert.equal(run('prepare').status, 3, 'prepare without --plan fails the gate');
    assert.equal(run('bogus').status, 1, 'an unknown command is a usage error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The working directory itself must not be a link — the rule the page-file gate and the manifest generator
// apply. With no plan there yet, prepare returned ok at once, and the planner then wrote the plan (and the
// orchestrator its approval sidecar) wherever a link planted at the working directory points.
test('prepare refuses a working directory that is itself a link or junction, even with no plan yet', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-rootlink-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const real = path.join(parent, 'real');
  fs.mkdirSync(real);
  const linked = path.join(parent, 'linked');
  fs.symlinkSync(real, linked, 'junction');
  const refused = preparePlanProvenance({ planPath: path.join(linked, 'genpage-plan.md') });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /is a symbolic link or junction — pass the directory it points to as the working directory$/);
  assert.equal(preparePlanProvenance({ planPath: path.join(real, 'genpage-plan.md') }).ok, true, 'the real directory is fine');
  fs.mkdirSync(path.join(real, 'app'));
  assert.equal(preparePlanProvenance({ planPath: path.join(linked, 'app', 'genpage-plan.md') }).ok, true, 'so is one below a linked ancestor');
});

// The page-file rule allows a harmless `.` segment and normalizes it for identity, so provenance compares
// the same spelling: an approved `./overview.tsx` and a written `overview.tsx` are one page.
test('create targets are compared with . segments dropped', () => {
  const dotted = PREVIEW.replace('| overview.tsx |', '| ./overview.tsx |');
  assert.notEqual(dotted, PREVIEW, 'precondition: the preview names ./overview.tsx');
  assert.deepEqual(planTargets(dotted), { kind: 'create', targets: ['details.tsx', 'overview.tsx'] });
  const verified = verifyPlanProvenance({ planPath: tmpPlan(WRITTEN), approvedPlan: dotted });
  assert.equal(verified.ok, true, verified.error);
});

// The page must END the preview's File line: `page\.tsx\b` also took `<guid>/page.tsx.bak`, a different file,
// and since an edit's provenance compares only the GUID, that approval certified a plan for the real page.
test('a File line or path naming something other than page.tsx itself names nothing', () => {
  for (const tail of ['page.tsx.bak', 'page.tsxx', 'page.tsx-old', 'page.tsx~', 'page.tsx+old', 'page.tsx#1', 'page.tsx/old.tsx', 'page.tsx(1)', 'page.tsx:alt', 'page.tsx\u00e9']) {
    assert.equal(planTargets(EDIT_PREVIEW.replace(`${PAGE_ID}/page.tsx`, `${PAGE_ID}/${tail}`)), null, tail);
  }
  // CONTROLS: a backticked value, trailing blanks, and Windows line endings still end cleanly.
  for (const shape of [`\`${PAGE_ID}/page.tsx\``, `${PAGE_ID}/page.tsx   `]) {
    assert.deepEqual(planTargets(EDIT_PREVIEW.replace(`${PAGE_ID}/page.tsx`, shape)), { kind: 'edit', targets: [PAGE_ID] }, shape);
  }
  assert.deepEqual(planTargets(EDIT_PREVIEW.replace(/\n/g, '\r\n')), { kind: 'edit', targets: [PAGE_ID] });
  // …and so does sentence punctuation, a closing mark or a note after the path, on the File line and in the
  // folder path. Another page's path sits AHEAD of the File line, so only the File line itself can answer.
  const other = '11111111-2222-3333-4444-555555555555';
  const ahead = `## Genpage Edit Plan\n\nLike ${other}/page.tsx\n\n${EDIT_PREVIEW.replace('## Genpage Edit Plan\n\n', '')}`;
  for (const shape of [`${PAGE_ID}/page.tsx.`, `${PAGE_ID}/page.tsx,`, `${PAGE_ID}/page.tsx;`, `\`${PAGE_ID}/page.tsx\`.`, `${PAGE_ID}/page.tsx)`, `${PAGE_ID}/page.tsx (edit)`]) {
    assert.deepEqual(planTargets(ahead.replace(`${PAGE_ID}/page.tsx`, shape)), { kind: 'edit', targets: [PAGE_ID] }, shape);
  }
  for (const tail of ['.', ':', ')', '"', '**', '|', '<br>', '}', '\u201d', '\u00bb', '\u2014the page']) {
    assert.deepEqual(planTargets(`Edit ${PAGE_ID}/page.tsx${tail}\n`), { kind: 'edit', targets: [PAGE_ID] }, tail);
  }
  assert.deepEqual(planTargets(`Edit ${PAGE_ID}/page.tsx`), { kind: 'edit', targets: [PAGE_ID] }, 'at the very end of the text');
  assert.equal(planTargets(`Edit ${PAGE_ID}/page.tsx.bak\n`), null, 'but an extension after it is another file');
});

// The rule says what CONTINUES a file name, not what ends one: a path the folder fallback cannot end is
// skipped, and the next one wins. Listing closers instead skipped a written plan's real path when HTML or a
// curly quote followed it, and the page quoted in its original prompt became the target.
test('the folder fallback is not diverted to a later path by a mark it does not list', () => {
  const other = '11111111-2222-3333-4444-555555555555';
  const written = (line) => `# Genpage Edit Plan\n\n## File Being Edited\n- **Absolute path:** ${line}\n- **App ID:** 1\n\n## Original Page Context\nsee ${other}/page.tsx\n`;
  for (const line of [`D:/work/edit/${PAGE_ID}/page.tsx<br>`, `\u201cD:\\work\\edit\\${PAGE_ID}\\page.tsx\u201d`, `D:\\work\\edit\\${PAGE_ID}\\page.tsx}`]) {
    assert.deepEqual(planTargets(written(line)), { kind: 'edit', targets: [PAGE_ID] }, line);
  }
  // CONTROL: a path that does name another file is still skipped for the next one.
  assert.deepEqual(planTargets(written(`D:/work/edit/${PAGE_ID}/page.tsx.bak`)), { kind: 'edit', targets: [other] });
});

// A preview names its page in its Current State block's File line and nowhere else. A block whose File line is
// missing or names another file names NOTHING: reading on found a path or a label quoted from the page's prompt,
// and approved another page.
test('a preview whose Current State block has no valid File line names nothing', () => {
  const other = '11111111-2222-3333-4444-555555555555';
  const preview = (fileLine) => `## Genpage Edit Plan\n\n### Current State\n${fileLine}- **Original prompt:** like ${other}/page.tsx\n- **Page ID:** ${other}\n`;
  assert.equal(planTargets(preview(`- **File:** ${PAGE_ID}/page.tsx.bak\n`)), null, 'a File line naming another file');
  assert.equal(planTargets(preview('')), null, 'no File line at all');
  assert.deepEqual(planTargets(preview(`- **File:** ${PAGE_ID}/page.tsx\n`)), { kind: 'edit', targets: [PAGE_ID] }, 'CONTROL: a valid File line');
  // …which may carry a path in front of the page folder, as the written plan's absolute path does.
  for (const at of ['D:\\work\\edit\\', 'D:/work/edit/', './', '`D:\\My Files\\edit\\']) {
    const tail = at.startsWith('`') ? `${PAGE_ID}\\page.tsx\`` : `${PAGE_ID}/page.tsx`;
    assert.deepEqual(planTargets(preview(`- **File:** ${at}${tail}\n`)), { kind: 'edit', targets: [PAGE_ID] }, at);
    assert.equal(planTargets(preview(`- **File:** ${at}${PAGE_ID}/page.tsx.bak\n`)), null, `${at}: still only page.tsx`);
    assert.equal(planTargets(preview(`- **File:** ${at}deadbeef${PAGE_ID}/page.tsx\n`)), null, `${at}: still a whole id`);
  }
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN.replace(/6e0c28a2/g, '7f1d39b3'), EDIT), approvedPlan: preview('') }).ok, false, 'and verify halts');
});

// The preview's File line is read from its own `### Current State` block: a `- **File:**` bullet quoted from the
// page's prompt ahead of that block decided the target.
test('the preview is read by the File line in its own Current State block', () => {
  const other = '11111111-2222-3333-4444-555555555555';
  const quotedFirst = `## Genpage Edit Plan\n\n> The maker asked:\n- **File:** ${other}/page.tsx\n\n${EDIT_PREVIEW.replace('## Genpage Edit Plan\n\n', '')}`;
  assert.deepEqual(planTargets(quotedFirst), { kind: 'edit', targets: [PAGE_ID] });
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN, EDIT), approvedPlan: quotedFirst }).ok, true);
});

// A hard link at the plan path is a plain file to lstat, yet quarantining it renamed only this name — the
// plan stayed reachable through the other — and the planner's write in place rewrites every name.
test('prepare and verify refuse a hard-linked plan', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-hardlink-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, 'genpage-edit-plan.md');
  const outside = path.join(dir, 'elsewhere.md');
  fs.writeFileSync(outside, EDIT_WRITTEN);
  fs.linkSync(outside, planPath);
  const prepared = preparePlanProvenance({ planPath });
  assert.equal(prepared.ok, false);
  assert.match(prepared.error, /is a hard link \(2 names for one file\) — remove it and re-run$/);
  assert.ok(fs.existsSync(planPath), 'nothing is quarantined');
  const verified = verifyPlanProvenance({ planPath, approvedPlan: EDIT_PREVIEW });
  assert.equal(verified.ok, false);
  assert.match(verified.error, /is not a plain file \(a link, junction, hard link or folder\)/);
});

// --- The plan's semantic records (references/plan-schema.md): what was assumed, each page's decisions and lookups --------------
// The approval preview carries them at its own levels (### Assumptions first; ### Data Semantics and ### Lookup Metadata after the
// Pages table, by page file) and the written plan at the plan's (## Assumptions; #### Data semantics / #### Lookup metadata in each
// page's specification). Same page files are not enough: a changed decision needs new approval.
const SEM_A1 = (decision) => [
  '- Decision: ' + decision,
  '- Alternatives considered: An empty form with no initial read; uncached loading.',
  '- Evidence: default: this page loads on mount, so Critical Rule 15 applies.',
  '- Resolution: planner-default',
].join('\n');
const SEM_LOOKUPS = (state = 'observed') => [
  '| Table | Column | Read property | Targets | Used by | Metadata state |',
  '|-------|--------|---------------|---------|---------|----------------|',
  `| contoso_project | contoso_ownerid | _contoso_ownerid_value | systemuser, team | F1; owner navigation | ${state} |`,
  '',
  '- Evidence: lookup-metadata.json; successful source/target metadata discovery.',
  '- Read target strategy: normalize the logical-name annotation and qualified prefix.',
].join('\n');
const SEM_FILTER = '##### F1\n- Kind: filter\n- Definition: Projects owned by the selected owner, matched by the bare id.\n- Source: User Requirements\n- Requirement quote: Projects overview';
function semPreview({ decision = 'De-duplicate and cache the initial list read.', assumptions = true, lookups = SEM_LOOKUPS(), semantics = SEM_FILTER } = {}) {
  return [
    '## Genpage Plan',
    '',
    ...(assumptions ? ['### Assumptions', '', '#### A1 — Initial-load caching', SEM_A1(decision), ''] : []),
    '### Pages (2 total)',
    '| Page | File | Purpose | Entities |',
    '|------|------|---------|----------|',
    '| Overview | overview.tsx | Summary cards | contoso_project |',
    '| Details | details.tsx | One record | contoso_project |',
    '',
    ...(semantics === null ? [] : ['### Data Semantics', '', '#### overview.tsx', '', semantics, '', '#### details.tsx', '', 'None.', '']),
    ...(lookups === null ? [] : ['### Lookup Metadata', '', '#### overview.tsx', '', lookups, '', '#### details.tsx', '', 'None.', '']),
    '### Data Strategy',
    '- Entities to create: contoso_project (contoso_name, contoso_stage)',
  ].join('\n');
}
function semWritten({ decision = 'De-duplicate and cache the initial list read.', assumptions = true, lookups = SEM_LOOKUPS(), semantics = SEM_FILTER } = {}) {
  return [
    '# Genpage Plan',
    '## User Requirements',
    'Projects overview and details.',
    ...(assumptions ? ['## Assumptions', '### A1 — Initial-load caching', SEM_A1(decision)] : []),
    '## Pages',
    '| Page | File | Purpose | Entities |',
    '|------|------|---------|----------|',
    '| Details | details.tsx | One record | project |',
    '| Overview | overview.tsx | Summary cards | project |',
    '## Per-Page Specifications',
    '### Overview',
    '- **File:** overview.tsx',
    ...(semantics === null ? [] : ['#### Data semantics', semantics]),
    ...(lookups === null ? [] : ['#### Lookup metadata', lookups]),
    '### Details',
    '- **File:** details.tsx',
    ...(semantics === null ? [] : ['#### Data semantics', 'None.']),
    ...(lookups === null ? [] : ['#### Lookup metadata', 'None.']),
  ].join('\r\n');
}
const LOOKUP_EVIDENCE = {
  ok: true,
  tables: [{ logicalName: 'contoso_project', primaryIdAttribute: 'contoso_projectid', primaryNameAttribute: 'contoso_name', lookups: [{
    column: 'contoso_ownerid', readProperty: '_contoso_ownerid_value', targets: ['systemuser', 'team'], paths: [],
    sharedPaths: [{ navigationProperty: 'contoso_ownerid', referencedEntity: 'owner', targets: ['systemuser', 'team'] }],
  }] }],
};
function evidenceFile(dir, content) {
  const file = path.join(dir, 'lookup-metadata.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('verifyPlanProvenance compares the approved and written semantic records, not only the page files', () => {
  const same = verifyPlanProvenance({ planPath: tmpPlan(semWritten()), approvedPlan: semPreview() });
  assert.equal(same.ok, true, `neighbour: ${same.error}`);
  assert.match(same.semanticsHash, /^[a-f0-9]{64}$/, 'the verified records are hashed for the log');
  const changed = verifyPlanProvenance({ planPath: tmpPlan(semWritten({ decision: 'Load the list without a cache.' })), approvedPlan: semPreview() });
  assert.equal(changed.ok, false, 'a written plan whose A1 decision differs from the approved preview must need re-approval');
  assert.match(changed.error, /A1 changed its Decision/);
  assert.deepEqual(changed.writtenTargets, ['details.tsx', 'overview.tsx'], 'the page files are the same');
  for (const [label, written] of [
    ['a changed filter', semWritten({ semantics: SEM_FILTER.replace('matched by the bare id', 'matched by the owner name') })],
    ['a narrowed target set', semWritten({ lookups: SEM_LOOKUPS().replace('systemuser, team', 'systemuser') })],
    ['an added assumption', semWritten().replace('## Pages', '### A2 — Sort\r\n' + SEM_A1('Sort by name.').replace(/\n/g, '\r\n') + '\r\n## Pages')],
  ]) {
    assert.equal(verifyPlanProvenance({ planPath: tmpPlan(written), approvedPlan: semPreview() }).ok, false, label);
  }
  // Preview formatting is not compared: wrapped values and blank lines differ, the records do not.
  const reflowed = semPreview().replace('- Decision: De-duplicate and cache the initial list read.', '- Decision: De-duplicate and cache\n  the initial list read.').replace(/\n\n/g, '\n\n\n');
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(semWritten()), approvedPlan: reflowed }).ok, true);
});

test('a one-sided semantic contract is never a legacy downgrade, and a malformed present section fails without any option', () => {
  for (const [label, written, approved] of [
    ['the preview has Assumptions, the written plan none', semWritten({ assumptions: false }), semPreview()],
    ['the written plan has Assumptions, the preview none', semWritten(), semPreview({ assumptions: false })],
    ['the written plan dropped its lookups', semWritten({ lookups: null }), semPreview()],
    ['the preview has no records at all', semWritten(), semPreview({ assumptions: false, lookups: null, semantics: null })],
  ]) {
    assert.equal(verifyPlanProvenance({ planPath: tmpPlan(written), approvedPlan: approved }).ok, false, label);
  }
  const malformed = semWritten().replace('- Resolution: planner-default', '- Resolution: assumed');
  const result = verifyPlanProvenance({ planPath: tmpPlan(malformed), approvedPlan: semPreview().replace('- Resolution: planner-default', '- Resolution: assumed') });
  assert.equal(result.ok, false);
  assert.match(result.error, /Resolution must be/);
  // An older pair, with neither document carrying the contract, is verified exactly as before.
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(WRITTEN), approvedPlan: PREVIEW }).ok, true);
});

test('--require-assumptions: a newly authored plan cannot evade the comparison by leaving the contract out of both documents', () => {
  const legacy = verifyPlanProvenance({ planPath: tmpPlan(WRITTEN), approvedPlan: PREVIEW, requireAssumptions: true });
  assert.equal(legacy.ok, false);
  assert.match(legacy.error, /no Assumptions section/);
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(semWritten()), approvedPlan: semPreview(), requireAssumptions: true }).ok, true);
  const empty = { assumptions: false, semantics: 'None.', lookups: 'None.' };
  const sentinels = (doc) => doc.replace(/^(#{2,3}) Pages/m, (all, hashes) => `${hashes} Assumptions\n\nNo assumptions.\n\n${all}`);
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(sentinels(semWritten(empty))), approvedPlan: sentinels(semPreview(empty)), requireAssumptions: true }).ok, true, 'the empty sentinels satisfy it');
  const partial = verifyPlanProvenance({ planPath: tmpPlan(semWritten({ lookups: null })), approvedPlan: semPreview({ lookups: null }), requireAssumptions: true });
  assert.equal(partial.ok, false, 'every page needs its Lookup metadata');
  // The options belong to a create plan; an edit plan keeps its own comparison and refuses them.
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN, EDIT), approvedPlan: EDIT_PREVIEW }).ok, true, 'neighbour: an edit without the options');
  assert.equal(verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN, EDIT), approvedPlan: EDIT_PREVIEW, requireAssumptions: true }).ok, false);
});

test('a planned lookup becomes observed only with successful lookup metadata evidence that matches it', () => {
  const planned = semPreview({ lookups: SEM_LOOKUPS('planned') });
  const dir = makeTempDir('genpage-plan-evidence-');
  const ok = (options) => verifyPlanProvenance({ planPath: tmpPlan(semWritten()), approvedPlan: planned, ...options });
  assert.equal(ok({}).ok, false, 'no evidence: the promotion is a change');
  assert.equal(ok({ lookupMetadataPath: evidenceFile(dir, LOOKUP_EVIDENCE) }).ok, true, 'with matching evidence');
  assert.equal(ok({ lookupMetadataPath: evidenceFile(dir, LOOKUP_EVIDENCE), requireObservedLookups: true }).ok, true);
  const narrowed = structuredClone(LOOKUP_EVIDENCE);
  narrowed.tables[0].lookups[0].targets = ['systemuser'];
  assert.equal(ok({ lookupMetadataPath: evidenceFile(dir, narrowed) }).ok, false, 'a target set the evidence does not hold');
  assert.equal(ok({ lookupMetadataPath: evidenceFile(dir, { ok: false, code: 'X', error: 'failed' }) }).ok, false, 'a failed read is no evidence');
  assert.equal(ok({ lookupMetadataPath: evidenceFile(dir, '{ not json') }).ok, false, 'an unreadable file is no evidence');
  assert.equal(ok({ lookupMetadataPath: path.join(dir, 'missing.json') }).ok, false, 'an absent file is no evidence');
  assert.equal(ok({ requireObservedLookups: true }).ok, false, '--require-observed-lookups needs the evidence file');
  const stillPlanned = verifyPlanProvenance({ planPath: tmpPlan(semWritten({ lookups: SEM_LOOKUPS('planned') })), approvedPlan: planned,
    lookupMetadataPath: evidenceFile(dir, LOOKUP_EVIDENCE), requireObservedLookups: true });
  assert.equal(stillPlanned.ok, false, 'a lookup still planned before generation');
  assert.match(stillPlanned.error, /planned/);
});

test('evidence that is read is validated whatever its value: JSON null is not "no evidence", and never passes an observed plan', () => {
  const dir = makeTempDir('genpage-plan-null-evidence-');
  // Already observed in both documents: nothing to promote, so only the evidence check can refuse it.
  const observed = (content, options = {}) => verifyPlanProvenance({ planPath: tmpPlan(semWritten()), approvedPlan: semPreview(),
    lookupMetadataPath: evidenceFile(dir, content), ...options });
  assert.equal(observed(LOOKUP_EVIDENCE, { requireObservedLookups: true, requireAssumptions: true }).ok, true, 'neighbour: matching evidence');
  for (const content of ['null', 'false', '0', '[]', '"ok"', '{}']) {
    const result = observed(content, { requireObservedLookups: true, requireAssumptions: true });
    assert.equal(result.ok, false, `${content}: refused`);
    assert.match(result.error, /not a successful get-lookup-metadata\.js answer/, content);
    assert.equal(observed(content).ok, false, `${content}: refused without the other flags too`);
  }
  // Nor does it authorize a promotion.
  const promoted = verifyPlanProvenance({ planPath: tmpPlan(semWritten()), approvedPlan: semPreview({ lookups: SEM_LOOKUPS('planned') }),
    lookupMetadataPath: evidenceFile(dir, 'null') });
  assert.equal(promoted.ok, false);
  // Fixture 26's own approved preview and written plan, both already observed, with a file holding only `null`.
  const fixture = path.join(__dirname, '..', '..', '..', '..', 'evals', 'model-apps', 'genpage', 'fixtures', '26-customer-lookup');
  const fixturePlan = tmpPlan(fs.readFileSync(path.join(fixture, 'genpage-plan.md'), 'utf8'));
  const approved = fs.readFileSync(path.join(fixture, 'approved-plan.md'), 'utf8');
  const withEvidence = verifyPlanProvenance({ planPath: fixturePlan, approvedPlan: approved, requireAssumptions: true,
    requireObservedLookups: true, lookupMetadataPath: path.join(fixture, 'lookup-metadata.json') });
  assert.equal(withEvidence.ok, true, `neighbour: fixture 26 with its own evidence: ${withEvidence.error}`);
  const fixtureResult = verifyPlanProvenance({ planPath: fixturePlan, approvedPlan: approved, requireAssumptions: true,
    requireObservedLookups: true, lookupMetadataPath: evidenceFile(dir, 'null') });
  assert.equal(fixtureResult.ok, false, 'fixture 26 with null evidence');
  assert.match(fixtureResult.error, /not a successful get-lookup-metadata\.js answer/);
});

test('a second specification of a page is refused, whichever block carries the records: the approved page is the one written', () => {
  const fixture = path.join(__dirname, '..', '..', '..', '..', 'evals', 'model-apps', 'genpage', 'fixtures', '26-customer-lookup');
  const plan = fs.readFileSync(path.join(fixture, 'genpage-plan.md'), 'utf8').replace(/\r\n/g, '\n');
  const approved = fs.readFileSync(path.join(fixture, 'approved-plan.md'), 'utf8');
  const evidence = path.join(fixture, 'lookup-metadata.json');
  const verify = (text) => verifyPlanProvenance({ planPath: tmpPlan(text), approvedPlan: approved, requireAssumptions: true,
    requireObservedLookups: true, lookupMetadataPath: evidence });
  assert.equal(verify(plan).ok, true, 'neighbour: the fixture plan');
  const start = plan.indexOf('\n### Customer Opportunities\n');
  assert.ok(start > 0, 'the fixture has the page specification');
  const fileLine = /\n- \*\*File:\*\* [^\n]+/.exec(plan.slice(start))[0];
  const duplicate = `\n### Customer Opportunities${fileLine}\n- **Purpose:** Browse opportunities by customer\n- **Data Binding:** customerid_contact/contactid\n`;
  for (const [label, text] of [
    ['a later duplicate without records', `${plan.trimEnd()}\n${duplicate}`],
    ['an earlier duplicate without records', plan.slice(0, start) + duplicate + plan.slice(start)],
  ]) {
    const result = verify(text);
    assert.equal(result.ok, false, label);
    assert.match(result.error, /another page specification/, label);
  }
});

test('the CLI takes the semantic options as declared flags and refuses an unknown or misspelled one', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'genpage-plan-provenance.js');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const dir = makeTempDir('genpage-plan-prov-flags-');
  const planPath = path.join(dir, 'genpage-plan.md');
  const approved = path.join(dir, '.approved-genpage-plan.md');
  fs.writeFileSync(planPath, semWritten());
  fs.writeFileSync(approved, semPreview({ lookups: SEM_LOOKUPS('planned') }));
  const evidence = evidenceFile(dir, LOOKUP_EVIDENCE);
  const ok = run('verify', '--plan', planPath, '--approved', `@${approved}`, '--require-assumptions', '--require-observed-lookups', '--lookup-metadata', evidence);
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  assert.equal(run('verify', '--plan', planPath, '--approved', `@${approved}`, '--require-assumptions').status, 3, 'the promotion has no evidence');
  for (const args of [
    ['--require-assumption'],
    ['--require-assumptions', 'yes'],
    ['--lookup-metadata'],
    ['stray'],
  ]) {
    const result = run('verify', '--plan', planPath, '--approved', `@${approved}`, ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
  assert.equal(run('prepare', '--plan', planPath, '--require-assumptions').status, 1, 'prepare takes no semantic option');
});
