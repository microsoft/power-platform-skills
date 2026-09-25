'use strict';
// #588 item 4: page filenames come from a plan an AI planner wrote, and parallel workers write to them
// unattended. One rule (lib/page-file-targets.js) decides which names are safe, and /genpage runs it
// through check-page-files.js before it dispatches any worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { pageFileProblems, pageFilesFromPlan, pagesTables } = require('../lib/page-file-targets.js');
const { checkPageFiles } = require('../check-page-files.js');

const SCRIPT = path.join(__dirname, '..', 'check-page-files.js');
const codes = (files, opts) => pageFileProblems(files, opts).map((p) => `${p.code}:${p.file}`);

test('unsafe page file names are refused, one problem code per shape', () => {
  assert.deepEqual(codes(['C:\\pages\\a.tsx', '/tmp/b.tsx', 'C:g.tsx', 'pages\\c.tsx', '../d.tsx', 'x/../f.tsx', '']), [
    'absolute:C:\\pages\\a.tsx', 'absolute:/tmp/b.tsx', 'absolute:C:g.tsx', 'backslash:pages\\c.tsx',
    'traversal:../d.tsx', 'traversal:x/../f.tsx', 'empty:',
  ]);
  // A lone "." cannot climb out: it is a harmless spelling, not a reason to force a re-plan. It still
  // collides with the plain name it normalizes to.
  assert.deepEqual(codes(['./e.tsx']), []);
  assert.deepEqual(codes(['e.tsx', './e.tsx']), ['collision:./e.tsx']);
});

test('two names one case-insensitive filesystem stores as the same file collide, including Unicode spellings', () => {
  assert.deepEqual(codes(['Page.tsx', 'page.tsx']), ['collision:page.tsx']);
  // "é" precomposed (U+00E9) and decomposed (e + U+0301) are one name on disk too.
  assert.deepEqual(codes(['caf\u00e9.tsx', 'cafe\u0301.tsx']), ['collision:cafe\u0301.tsx']);
  // CONTROL: distinct names, nested folders and a leading-dot-free name all pass.
  assert.deepEqual(codes(['overview.tsx', 'details/edit.tsx', 'details/view.tsx']), []);
});

test('a parent that resolves through a link or junction to outside the working directory is refused', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-outside-'));
  t.after(() => {
    fs.rmSync(path.join(root, 'linked'), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  try {
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  } catch (e) {
    t.skip(`cannot create a directory link here: ${e.message}`);
    return;
  }
  assert.deepEqual(codes(['linked/page.tsx', 'fine.tsx', 'nested/new.tsx'], { workingDir: root }), ['realpath-escape:linked/page.tsx']);
  // Without a working directory there is nothing to resolve against: the lexical rules still apply.
  assert.deepEqual(codes(['linked/page.tsx']), []);
});

// Every Pages File is a page `.tsx` (references/plan-schema.md). Any other name is some other file of the
// working directory — the manifest, the generated types, the plan itself — which a worker would then
// overwrite with a page.
test('a name that is not a .tsx page file is refused', () => {
  assert.deepEqual(codes(['package.json', 'genpage.d.ts', 'RuntimeTypes.ts', 'genpage-plan.md', '.tsx', 'pages/.tsx', 'page.tsx.bak']), [
    'extension:package.json', 'extension:genpage.d.ts', 'extension:RuntimeTypes.ts', 'extension:genpage-plan.md',
    'extension:.tsx', 'extension:pages/.tsx', 'extension:page.tsx.bak',
  ]);
  // CONTROLS: any case of the extension, dotted stems and nested folders are pages.
  assert.deepEqual(codes(['Upper.TSX', 'a.b.tsx', 'pages/home.tsx']), []);
});

// existsSync follows a link and calls a DANGLING one absent, so the walk stepped past a planted link to
// the in-directory folder above it, and the worker then wrote through the link. A link AT the target is
// refused wherever it points — `page.tsx → package.json` inside the directory would put a page into the
// manifest — and a parent link that cannot be resolved is refused rather than waved through.
test('a link at the page path, or a parent link that cannot be resolved, is refused', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-outside-'));
  t.after(() => {
    // Unlink every link FIRST — `up` points at the temp folder itself — so the recursive removal below
    // only ever sees this test's own entries.
    for (const name of ['up', 'alias', 'dead', 'ghost.tsx', 'page.tsx', 'hard.tsx', 'inside.tsx']) {
      try { fs.unlinkSync(path.join(root, name)); } catch { fs.rmSync(path.join(root, name), { force: true, recursive: true }); }
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  try {
    fs.symlinkSync(path.join(outside, 'gone'), path.join(root, 'dead'), 'junction');
  } catch (e) {
    t.skip(`cannot create a directory link here: ${e.message}`);
    return;
  }
  assert.deepEqual(codes(['dead/page.tsx', 'fine.tsx'], { workingDir: root }), ['unresolvable:dead/page.tsx']);
  // A link to the working directory's own PARENT is outside it too (the relative path is exactly "..").
  fs.symlinkSync(path.dirname(root), path.join(root, 'up'), 'junction');
  assert.deepEqual(codes(['up/page.tsx'], { workingDir: root }), ['realpath-escape:up/page.tsx']);
  let fileLinks = true;
  try {
    fs.symlinkSync(path.join(outside, 'target.tsx'), path.join(root, 'ghost.tsx'), 'file');
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.symlinkSync(path.join(root, 'package.json'), path.join(root, 'page.tsx'), 'file');
  } catch { fileLinks = false; }
  if (fileLinks) {
    assert.deepEqual(codes(['ghost.tsx', 'page.tsx', 'fine.tsx'], { workingDir: root }), ['link:ghost.tsx', 'link:page.tsx']);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was created through the dangling link');
  }
  // A HARD link has no link bit — lstat calls it a plain file and realpath leaves it where it is — yet a
  // worker writing it rewrites the other name too, outside the directory included. No privilege needed
  // on Windows, so it is the easier route.
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
  fs.linkSync(path.join(outside, 'precious.txt'), path.join(root, 'hard.tsx'));
  const hard = pageFileProblems(['hard.tsx'], { workingDir: root });
  assert.deepEqual(hard.map((p) => `${p.code}:${p.file}`), ['link:hard.tsx']);
  assert.match(hard[0].message, /hard link \(2 names for one file\)/);
  // Two names that reach ONE file through a link inside the directory are two workers on one file.
  fs.mkdirSync(path.join(root, 'sub'));
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'alias'), 'junction');
  const alias = pageFileProblems(['alias/a.tsx', 'sub/a.tsx', 'sub/b.tsx'], { workingDir: root });
  assert.deepEqual(alias.map((p) => `${p.code}:${p.file}`), ['collision:sub/a.tsx']);
  assert.match(alias[0].message, /"alias\/a\.tsx" and "sub\/a\.tsx" are the same file, reached through a link or junction/);
  // Two spellings of one name still read as a case collision with a working directory, not as a link.
  const cased = pageFileProblems(['Other.tsx', 'other.tsx'], { workingDir: root });
  assert.deepEqual(cased.map((p) => `${p.code}:${p.file}`), ['collision:other.tsx']);
  assert.match(cased[0].message, /"Other\.tsx" and "other\.tsx" collide on a case-insensitive filesystem/);
});

// /app-builder's implemented pages are in the plan for the navigation graph only — no worker writes
// them — so they are held to the lexical rules and to collisions, never to the write-target rules.
test('built pages keep the lexical rules and collisions, but not the write-target rules', () => {
  assert.deepEqual(codes(['next.tsx'], { built: ['pages/home.jsx', 'report.ts'] }), [], 'no extension rule for a built page');
  assert.deepEqual(codes(['next.tsx'], { built: ['x/../y.tsx', 'C:\\a.tsx'] }), ['traversal:x/../y.tsx', 'absolute:C:\\a.tsx']);
  assert.deepEqual(codes(['home.tsx'], { built: ['Home.tsx'] }), ['collision:home.tsx'], 'a new page is never written over a built one');
  assert.deepEqual(codes([], { built: ['Home.tsx', 'home.tsx'] }), ['collision:home.tsx'], 'two built pages still collide');
});

// Windows cannot store these, whatever the planner's platform — and `page:alt.tsx` is worse than refused:
// it writes an NTFS alternate stream `alt.tsx` on a file `page`, so the page lands where no one looks.
// (A single letter before the colon, `a:b.tsx`, is already refused as a drive-relative path.)
test('a name Windows cannot store is refused on every platform', () => {
  const bad = ['CON.tsx', 'nul.tsx', 'con.page.tsx', 'COM1.tsx', 'lpt9.x.tsx', 'page:alt.tsx', 'q?.tsx', 'pipe|x.tsx', 'x./a.tsx', 'x /a.tsx', 'REPORT~1.TSX', 'pages~2/a.tsx'];
  assert.deepEqual(codes(bad), bad.map((f) => `unportable:${f}`));
  assert.match(pageFileProblems(['page:alt.tsx'])[0].message, /a character Windows reserves in "page:alt\.tsx", which Windows cannot store as a file name$/);
  // Windows stores a short-name form fine; the problem is that it can BE another file.
  assert.match(pageFileProblems(['REPORT~1.TSX'])[0].message, /a Windows short-name form \(`~1`\) in "REPORT~1\.TSX", which on Windows can be the short name of another file$/);
  // CONTROLS: names that only resemble a device, dotted stems, and a lone "." segment. An inner space and a tilde
  // without a digit are storable, and are refused by the shell rule instead (the next test).
  assert.deepEqual(codes(['console.tsx', 'con-page.tsx', 'a.b.tsx', './e.tsx', 'com10.tsx']), []);
  assert.deepEqual(codes(['my page.tsx', 'tilde~page.tsx']), ['shell:my page.tsx', 'shell:tilde~page.tsx']);
  // Built pages are not written, so the write-target rules — this one included — do not apply to them.
  assert.deepEqual(codes(['next.tsx'], { built: ['CON.tsx'] }), []);
});

test('a page path that exists but is not a regular file is refused before any worker runs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-notfile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'folder.tsx'));
  assert.deepEqual(codes(['folder.tsx', 'fine.tsx'], { workingDir: root }), ['not-a-file:folder.tsx']);
});

// "Could not look" is not "nothing there". Every lstat and readdir error except ENOENT/ENOTDIR — and a
// working directory that exists but cannot be resolved — used to read as absence and wave the file through.
test('a disk error other than "not there" refuses the file instead of reading as absence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-eacces-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'locked'));
  const denied = (e) => Object.assign(new Error(`${e}: permission denied`), { code: e });
  const realLstat = fs.lstatSync;
  const lstat = t.mock.method(fs, 'lstatSync', (p, ...rest) => {
    if (String(p).includes(`${path.sep}locked${path.sep}`)) throw denied('EACCES');
    return realLstat(p, ...rest);
  });
  assert.deepEqual(codes(['locked/page.tsx', 'fine.tsx'], { workingDir: root }), ['unresolvable:locked/page.tsx']);
  lstat.mock.restore();
  const realReaddir = fs.readdirSync;
  const readdir = t.mock.method(fs, 'readdirSync', (p, ...rest) => {
    if (String(p).endsWith(`${path.sep}locked`)) throw denied('EPERM');
    return realReaddir(p, ...rest);
  });
  const listed = pageFileProblems(['locked/page.tsx'], { workingDir: root });
  assert.deepEqual(listed.map((p) => p.code), ['unresolvable']);
  assert.match(listed[0].message, /cannot be checked on disk \(EPERM\)/);
  readdir.mock.restore();
  t.mock.method(fs.realpathSync, 'native', (p) => { throw denied('EIO'); });
  const rootless = pageFileProblems(['a.tsx', 'b.tsx'], { workingDir: root });
  assert.deepEqual(rootless.map((p) => p.code), ['unresolvable', 'unresolvable']);
  assert.match(rootless[0].message, /the working directory cannot be resolved \(EIO\)/);
  // …and so does a working directory that cannot even be INSPECTED: its lstat is read before its realpath now.
  t.mock.restoreAll();
  t.mock.method(fs, 'lstatSync', (p, ...rest) => {
    if (path.resolve(String(p)) === path.resolve(root)) throw denied('EACCES');
    return realLstat(p, ...rest);
  });
  const uninspectable = pageFileProblems(['a.tsx'], { workingDir: root });
  assert.deepEqual(uninspectable.map((p) => p.code), ['unresolvable']);
  assert.match(uninspectable[0].message, /the working directory cannot be resolved \(EACCES\)/);
});

// A name one case-insensitive filesystem stores as a page ALREADY in its folder is that page: the worker
// would overwrite it. The plan's own names were compared with each other only.
test('a name that differs only in case from a page already in its folder collides with it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-existing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Page.tsx'), 'export default () => null;\n');
  fs.mkdirSync(path.join(root, 'pages'));
  fs.writeFileSync(path.join(root, 'pages', 'Home.tsx'), 'export default () => null;\n');
  const problems = pageFileProblems(['page.tsx', 'pages/home.tsx', 'Page.tsx', 'pages/Home.tsx', 'new/page.tsx', 'PAGES/extra.tsx'], { workingDir: root });
  assert.deepEqual(problems.map((p) => `${p.code}:${p.file}`), ['collision:page.tsx', 'collision:pages/home.tsx', 'collision:PAGES/extra.tsx']);
  assert.match(problems[0].message, /the existing "Page\.tsx"/);
  assert.match(problems[1].message, /the existing "pages\/Home\.tsx"/);
  // A FOLDER under another spelling is the same folder on a case-insensitive filesystem, and a second
  // tree beside it on a case-sensitive one — so the plan's path is refused at the folder already.
  assert.match(problems[2].message, /the existing "pages"/);
  // The identical spelling is that very page, rewritten — and with no working directory nothing is listed.
  assert.deepEqual(codes(['Page.tsx'], { workingDir: root }), []);
  assert.deepEqual(codes(['page.tsx']), []);
});

test('the File column is read from the plan\'s Pages table, and a plan without one is not "no pages"', () => {
  const plan = [
    '## Pages',
    '| Page | File | Purpose | Entities |',
    '|------|------|---------|----------|',
    '| Overview | overview.tsx | Totals \\| trends | account |',
    '| Details | details.tsx | One record | account |',
    '',
    '## Entity Creation Required',
    '| Not | A | Pages | Table |',
  ].join('\r\n');
  assert.deepEqual(pageFilesFromPlan(plan), ['overview.tsx', 'details.tsx']);
  assert.equal(pageFilesFromPlan('## Environment\n- URL: x\n'), null);
  assert.equal(pageFilesFromPlan('## Pages\n| Page | Purpose |\n|---|---|\n| A | b |\n'), null, 'no File column');
});

// The plan's `## User Requirements` is the maker's text, verbatim, ahead of `## Pages`: a Pages table quoted
// there decided the files the gate checked, while the workers wrote the real table's. A second Pages table with
// a File column is refused — a fenced one too, since a fence left open would swallow the real section — while
// a maker's own `## Pages` list, which names no file, is no second table.
test('a plan with more than one Pages table is refused, not read by its first', () => {
  const real = ['## Pages', '| Page | File | Purpose | Entities |', '|---|---|---|---|', '| A | approved.tsx | x | account |'];
  const quoted = ['## Pages', '| Page | File | Purpose | Entities |', '|---|---|---|---|', '| X | outside.tsx | y | account |'];
  const plan = (...requirements) => ['# Genpage Plan', '## User Requirements', 'Build one page.', ...requirements,
    '## Working Directory', 'D:/work', ...real, '## Entity Creation Required', 'No entity creation required.'].join('\n');
  for (const [what, block] of [
    ['fenced', ['```markdown', ...quoted, '```']],
    ['fenced, with the fence left open', ['```', ...quoted]],
    ['not fenced', quoted],
    ['quoted from an approval preview', ['### Pages (1 total)', ...quoted.slice(1)]],
    ['quoted with ">"', quoted.map((l) => `> ${l}`)],
    ['quoted, over an unquoted table', ['> ## Pages', ...quoted.slice(1)]],
    ['indented', quoted.map((l) => `    ${l}`)],
  ]) {
    assert.deepEqual(pagesTables(plan(...block)).tables, [['outside.tsx'], ['approved.tsx']], what);
    assert.equal(pageFilesFromPlan(plan(...block)), null, what);
  }
  // CONTROLS: a maker's own `## Pages` list, prose, or a table without a File column names no file, so the real
  // table is read; and a plan with one Pages table is read.
  for (const [what, block] of [
    ['a list of pages', ['## Pages', '- Overview: summary cards', '- Details: one record']],
    ['prose', ['## Pages', 'The pages are listed below.']],
    ['a table without a File column', ['## Pages', '| Page | Purpose |', '|---|---|', '| Overview | cards |']],
    ['a page named "Pages Admin" specified', ['### Pages Admin', '- **File:** admin.tsx', '- **Purpose:** settings']],
  ]) {
    assert.deepEqual(pagesTables(plan(...block)).tables, [['approved.tsx']], what);
    assert.deepEqual(pageFilesFromPlan(plan(...block)), ['approved.tsx'], what);
  }
  assert.deepEqual(pageFilesFromPlan(plan()), ['approved.tsx']);
  // The gate says why, and checks no file of either table.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-two-'));
  try {
    const p = path.join(dir, 'genpage-plan.md');
    fs.writeFileSync(p, plan('```', ...quoted, '```'));
    const res = checkPageFiles({ planPath: p });
    assert.equal(res.exit, 1);
    assert.match(res.result.error, /has 2 Pages tables with a File column, so which one the pages come from is ambiguous/);
    assert.equal(res.result.files, undefined);
    // CONTROL: a maker's own `## Pages` list is no second table — the gate reads the real one.
    fs.writeFileSync(p, plan('## Pages', '- Overview: summary cards'));
    const listed = checkPageFiles({ planPath: p });
    assert.equal(listed.exit, 0, JSON.stringify(listed.result));
    assert.deepEqual(listed.result.files, ['approved.tsx']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A section was judged by its first table: a `| Page | Purpose |` table ahead of the `| Page | File |` one hid it, and
// a Pages table quoted elsewhere then passed as the plan's only one. Every table under a Pages heading counts.
test('every table under a Pages heading counts on its own, and rows that are not its File table\'s make the plan unreadable', () => {
  const purpose = ['| Page | Purpose |', '|---|---|', '| Overview | cards |'];
  const files = ['| Page | File | Purpose | Entities |', '|---|---|---|---|', '| A | ../outside.tsx | x | account |'];
  const quoted = ['```', '## Pages', '| Page | File |', '|---|---|', '| A | approved.tsx |', '```'];
  const plan = (requirements, pages) => ['# Genpage Plan', '## User Requirements', 'Build one page.', ...requirements,
    '## Pages', ...pages, '## Entity Creation Required', 'None.'].join('\n');
  // The review's case: the real table after a Purpose table, and a quoted example — two File tables, refused.
  assert.deepEqual(pagesTables(plan(quoted, [...purpose, '', ...files])).tables, [['approved.tsx'], ['../outside.tsx']]);
  assert.equal(pageFilesFromPlan(plan(quoted, [...purpose, '', ...files])), null);
  // Alone, a Purpose table beside the File table still leaves rows no File column claims — rows a reader could take
  // for pages the gates never saw — so the plan is unreadable, not read by its File table alone.
  const beside = plan([], [...purpose, '', ...files]);
  assert.deepEqual(pagesTables(beside), { tables: [['../outside.tsx']], unreadable: true });
  assert.equal(pageFilesFromPlan(beside), null);
  // A blank line inside a table does not end it: its later rows are still its rows, and are checked.
  assert.deepEqual(pageFilesFromPlan(plan([], [...files, '', '| B | b.tsx | y | account |'])), ['../outside.tsx', 'b.tsx']);
  // Rows ahead of the first header belong to no table: the plan is unreadable, rather than those rows dropped.
  const stray = plan([], ['| X | stray.tsx |', '', ...files]);
  assert.equal(pagesTables(stray).unreadable, true);
  assert.equal(pageFilesFromPlan(stray), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-stray-'));
  try {
    const p = path.join(dir, 'genpage-plan.md');
    fs.writeFileSync(p, stray);
    const res = checkPageFiles({ planPath: p });
    assert.equal(res.exit, 1);
    assert.match(res.result.error, /has table rows in a Pages section that are not its File table's rows/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // CONTROL: stray rows in a section that names no file are no table, and change nothing.
  assert.deepEqual(pageFilesFromPlan(plan(['## Pages', '| just | a row |'], files)), ['../outside.tsx']);
});

// A delimiter row repeated under a page row made that row the header of a second table — one with no File column, so
// it was dropped, and its page with it: both gates passed a plan whose `../outside.tsx` neither ever saw.
test('a repeated delimiter row cannot turn a page row into a header and hide it', () => {
  const plan = (pages) => ['# Genpage Plan', '## User Requirements', 'Build two pages.', '## Pages', ...pages,
    '## Entity Creation Required', 'None.'].join('\n');
  const header = ['| Page | File | Purpose | Entities |', '|---|---|---|---|'];
  const a = '| A | approved.tsx | Overview | mock data |';
  const b = '| B | ../outside.tsx | Details | mock data |';
  const delimiter = '|---|---|---|---|';
  for (const [what, pages] of [
    ['a delimiter under the last row', [...header, a, b, delimiter]],
    ['a delimiter under a row after a blank line', [...header, a, '', b, delimiter, '| C | c.tsx | x | mock data |']],
    ['a second delimiter directly under the header', [...header, delimiter, a]],
    ['a row that names a File column over a delimiter', [...header, a, '| B | File | Details | mock data |', delimiter, b]],
  ]) {
    const got = pagesTables(plan(pages));
    assert.equal(pageFilesFromPlan(plan(pages)), null, what);
    assert.ok(got.unreadable || got.tables.length > 1, `${what}: ${JSON.stringify(got)}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-delimiter-'));
  try {
    const p = path.join(dir, 'genpage-plan.md');
    fs.writeFileSync(p, plan([...header, a, b, delimiter]));
    const res = checkPageFiles({ planPath: p });
    assert.equal(res.exit, 1, JSON.stringify(res.result));
    assert.match(res.result.error, /has table rows in a Pages section that are not its File table's rows/);
    assert.equal(res.result.files, undefined, 'no file of the plan is reported as checked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // CONTROL: the same rows under one header and one delimiter are read, the unsafe name included.
  assert.deepEqual(pageFilesFromPlan(plan([...header, a, b])), ['approved.tsx', '../outside.tsx']);
});

// The skill's commands put page paths in double quotes, and some in none, and the orchestrator substitutes the name
// as text: `$(Join-Path .. outside).tsx` passed every rule, and PowerShell expanded it inside the quotes — the
// dispatch stamp landed outside the working directory. A `;` or a space in an unquoted argument ends it.
test('a page name a shell would expand or split on is refused', () => {
  const bad = ['$(Join-Path .. outside).tsx', 'a`b.tsx', 'a;rm -rf ~ #.tsx', 'my page.tsx', 'pages/$HOME/x.tsx',
    "it's.tsx", 'a&b.tsx', 'a%PATH%.tsx', 'wow!.tsx', 'a,b.tsx', 'a(1).tsx', 'a+b.tsx', 'a\u201cb\u201d.tsx', 'a\u2013b.tsx'];
  assert.deepEqual(codes(bad), bad.map((f) => `shell:${f}`));
  const [dollar] = pageFileProblems(['$(Join-Path .. outside).tsx']);
  assert.match(dollar.message, /has "\$" in "\$\(Join-Path \.\. outside\)\.tsx", which a shell command line would expand or split on/);
  assert.match(pageFileProblems(['my page.tsx'])[0].message, /has a space in/);
  // CONTROLS: letters and digits of any script, with their combining marks, `.`, `-` and `_`, in folders too.
  assert.deepEqual(codes(['project-overview.tsx', 'under_score.tsx', 'a.b.tsx', 'pages/home.tsx', './x.tsx',
    '\u00dcbersicht.tsx', '\u6982\u8981.tsx', 'cafe\u0301.tsx', '\u0645\u0644\u062e\u0635.tsx']), []);
});

test('check-page-files.js gates dispatch: exit 0 when safe, 3 with the problems when not, 1 when unreadable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-cli-'));
  try {
    const write = (rows) => {
      const p = path.join(dir, 'genpage-plan.md');
      fs.writeFileSync(p, ['## Pages', '| Page | File | Purpose | Entities |', '|---|---|---|---|', ...rows, ''].join('\n'));
      return p;
    };
    const run = (planPath) => spawnSync(process.execPath, [SCRIPT, '--plan', planPath], { encoding: 'utf8' });

    const ok = run(write(['| A | a.tsx | x | account |', '| B | b.tsx | y | account |']));
    assert.equal(ok.status, 0, ok.stdout);
    assert.deepEqual(JSON.parse(ok.stdout).files, ['a.tsx', 'b.tsx']);

    const bad = run(write(['| A | Page.tsx | x | account |', '| B | page.tsx | y | account |', '| C | ..\\out.tsx | z | account |']));
    assert.equal(bad.status, 3, bad.stdout);
    const out = JSON.parse(bad.stdout);
    assert.equal(out.ok, false);
    assert.deepEqual(out.problems.map((p) => p.code).sort(), ['backslash', 'collision']);

    const none = run(write([]));
    assert.equal(none.status, 1, 'a plan that lists no pages is not a pass');
    assert.equal(checkPageFiles({ planPath: path.join(dir, 'missing.md') }).exit, 1);
    assert.equal(checkPageFiles({}).exit, 1);
    // --working-dir overrides the plan's own directory as the root the names must stay inside.
    const plan = write(['| A | a.tsx | x | account |']);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-other-'));
    try {
      const r = spawnSync(process.execPath, [SCRIPT, '--plan', plan, '--working-dir', other], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout);
      assert.equal(JSON.parse(r.stdout).workingDir, path.resolve(other));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The working directory ITSELF must not be a link, the rule generate-page-manifest.js applies to the same
// directory: each target resolved inside the link's realpath and passed, and every page a worker wrote went
// wherever it points. A linked ANCESTOR is still followed — a normal setup.
test('a working directory that is itself a link or junction refuses every page written into it', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-rootlink-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const real = path.join(parent, 'real');
  fs.mkdirSync(real);
  const linked = path.join(parent, 'linked');
  fs.symlinkSync(real, linked, 'junction');
  assert.deepEqual(codes(['overview.tsx', 'pages/details.tsx'], { workingDir: linked }), ['link:overview.tsx', 'link:pages/details.tsx']);
  assert.match(pageFileProblems(['overview.tsx'], { workingDir: linked })[0].message, /working directory, which is itself a symbolic link or junction; pass the directory it points to$/);
  // Built pages are not written, so they are not refused for it; the real directory, and one BELOW a
  // linked ancestor, are fine.
  assert.deepEqual(codes([], { workingDir: linked, built: ['home.tsx'] }), []);
  assert.deepEqual(codes(['overview.tsx'], { workingDir: real }), []);
  fs.mkdirSync(path.join(real, 'app'));
  assert.deepEqual(codes(['overview.tsx'], { workingDir: path.join(linked, 'app') }), []);
  // A DANGLING link has no realpath, and reading that as "not created yet" left only the lexical checks, so a
  // worker's `mkdir -p` created the directory through it. It is refused like any other link — while a working
  // directory that is simply not there yet still gets the lexical checks alone.
  const dangling = path.join(parent, 'dangling');
  fs.symlinkSync(path.join(parent, 'nowhere'), dangling, 'junction');
  assert.deepEqual(codes(['overview.tsx'], { workingDir: dangling }), ['link:overview.tsx']);
  assert.deepEqual(codes(['overview.tsx'], { workingDir: path.join(parent, 'not-yet') }), []);
});

// A built page is not refused for its disk state, but a new page must not reach it through a link: with
// `alias -> sub`, `alias/a.tsx` IS `sub/a.tsx`, and a worker writing the latter overwrote the built page.
test('a new page that is a built page reached through a junction collides with it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-files-builtalias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'a.tsx'), 'export default function A() { return null; }\n');
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'alias'), 'junction');
  const problems = pageFileProblems(['sub/a.tsx'], { workingDir: root, built: ['alias/a.tsx'] });
  assert.deepEqual(problems.map((p) => `${p.code}:${p.file}`), ['collision:sub/a.tsx']);
  assert.match(problems[0].message, /"alias\/a\.tsx" and "sub\/a\.tsx" are the same file, reached through a link or junction/);
  // CONTROL: a different built page is no collision.
  assert.deepEqual(codes(['sub/b.tsx'], { workingDir: root, built: ['alias/a.tsx'] }), []);
});
