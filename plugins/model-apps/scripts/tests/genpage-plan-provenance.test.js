'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { preparePlanProvenance, verifyPlanProvenance, planTargets } = require('../genpage-plan-provenance.js');

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
const EDIT_WRITTEN = `# Genpage Edit Plan\n\n## File Being Edited\n- **Absolute path:** D:\\work\\edit\\${PAGE_ID}\\page.tsx\n- **App ID:** 11111111-2222-3333-4444-555555555555\n- **Page ID:** ${PAGE_ID}\n`;

function tmpPlan(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-prov-'));
  const planPath = path.join(dir, 'genpage-plan.md');
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
  const edit = verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN), approvedPlan: EDIT_PREVIEW });
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
  const otherPage = verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN.replace(/6e0c28a2/g, '7f1d39b3')), approvedPlan: EDIT_PREVIEW });
  assert.equal(otherPage.ok, false, 'an edit plan for another page');
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
// like the upload parser's (lib/genpage-cli.js parsePageId), and a Page ID label whose value is malformed
// makes the plan name nothing — never a GUID found elsewhere, since the edit worker reads that label.
test('an overlong or malformed page id is refused, never truncated to a valid-looking one', () => {
  const overlong = EDIT_WRITTEN.replace(`**Page ID:** ${PAGE_ID}`, `**Page ID:** ${PAGE_ID}deadbeef`);
  assert.equal(planTargets(overlong), null, 'a labelled id that runs on names nothing (the path still holds the valid one)');
  assert.equal(planTargets(EDIT_WRITTEN.replace(`**Page ID:** ${PAGE_ID}`, `**Page ID:** ${PAGE_ID}-x`)), null, 'a hyphen continues the token too');
  assert.equal(planTargets(EDIT_PREVIEW.replace(`${PAGE_ID}/page.tsx`, `deadbeef${PAGE_ID}/page.tsx`)), null, 'a folder GUID with a longer token in front');
  // CONTROLS: the id inside backticks or braces, or followed by punctuation, still ends cleanly.
  for (const shape of [`\`${PAGE_ID}\``, `{${PAGE_ID}}`, `${PAGE_ID}.`]) {
    assert.deepEqual(planTargets(EDIT_WRITTEN.replace(`**Page ID:** ${PAGE_ID}`, `**Page ID:** ${shape}`)), { kind: 'edit', targets: [PAGE_ID] }, shape);
  }
  const refused = verifyPlanProvenance({ planPath: tmpPlan(overlong), approvedPlan: EDIT_PREVIEW });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /targets no pages, but the approved plan named 6e0c28a2/);
  // Every label must hold the SAME well-formed id. A pattern search skipped a malformed first label and
  // certified a valid-looking one later in the document — a quoted prompt, say.
  const quoted = `${overlong}\n## User Request\n> "Change the page, **Page ID:** ${PAGE_ID}"\n`;
  assert.equal(planTargets(quoted), null, 'a malformed label is not rescued by a later valid one');
  const other = '7f1d39b3-cdbf-41ec-9186-d10fd5de6e35';
  assert.equal(planTargets(`${EDIT_WRITTEN}\n- **Page ID:** ${other}\n`), null, 'two labels in the section naming different pages are ambiguous');
  assert.deepEqual(planTargets(`${EDIT_WRITTEN}\n- **Page ID:** \`${PAGE_ID}\`\n`), { kind: 'edit', targets: [PAGE_ID] }, 'labels that agree are fine');
});

// The written plan copies the page's earlier prompts in full, and quoted text there may carry a label of
// its own. Only the structured `## File Being Edited` section is read, so such a prompt can no longer
// block every later edit of the page.
test('a Page ID label quoted in the embedded prompt neither blocks nor redirects an edit', () => {
  const other = '11111111-2222-3333-4444-555555555555';
  for (const prompt of [`…opens the details page (**Page ID:** ${other})…`, 'Show the **Page ID:** in the footer']) {
    const written = `${EDIT_WRITTEN}\n## Original Page Context\n- **Original prompt (from prompt.txt):** ${prompt}\n`;
    assert.deepEqual(planTargets(written), { kind: 'edit', targets: [PAGE_ID] }, prompt);
    assert.equal(verifyPlanProvenance({ planPath: tmpPlan(written), approvedPlan: EDIT_PREVIEW }).ok, true, prompt);
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
    const verified = verifyPlanProvenance({ planPath: tmpPlan(EDIT_WRITTEN), approvedPlan: preview });
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
  assert.match(linked.error, /not a regular file/);
  fs.unlinkSync(planPath);
  fs.mkdirSync(planPath);
  assert.match(verifyPlanProvenance({ planPath, approvedPlan: PREVIEW }).error, /not a regular file/);
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
