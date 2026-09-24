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

const { pageFileProblems, pageFilesFromPlan } = require('../lib/page-file-targets.js');
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
