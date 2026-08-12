'use strict';
// Contract tests for the transactional intent -> tsx promotion (scripts/promote-intent-pages.js).
//
// The property under test is ATOMICITY: /app-builder Phase 1.5 dispatches N page workers and any
// subset can fail, so a partial promotion would leave app-spec.json claiming a `.tsx` that was
// never written. These tests drive the real CLI in a child process (not the exported functions), so
// the exit code + on-disk spec are asserted exactly as the skill will observe them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'promote-intent-pages.js');

const GOOD = 'export default function P() { return <div>ok</div>; }\n';

function makeWorkspace(spec, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-'));
  fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify(spec, null, 2), 'utf8');
  for (const [name, code] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, name), code, 'utf8');
  return dir;
}

function run(dir) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, '--spec', '@' + path.join(dir, 'app-spec.json'), '--working-dir', dir], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

const readSpec = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'app-spec.json'), 'utf8'));

const twoPageSpec = () => ({
  app: { name: 'A' },
  pages: [
    { key: 'overview', name: 'Overview', source: { kind: 'intent' } },
    { key: 'detail', name: 'Detail', source: { kind: 'intent' } },
  ],
});

test('promotes every page in one write when all pass', () => {
  const dir = makeWorkspace(twoPageSpec(), { 'overview.tsx': GOOD, 'detail.tsx': GOOD });
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  const after = readSpec(dir);
  assert.deepEqual(after.pages.map((p) => p.source), [
    { kind: 'tsx', codeFile: 'overview.tsx' },
    { kind: 'tsx', codeFile: 'detail.tsx' },
  ]);
});

test('ONE failing page aborts the whole promotion and leaves the spec byte-identical', () => {
  // This is the regression the script exists for: page 1 succeeded, page 2 never got written.
  const dir = makeWorkspace(twoPageSpec(), { 'overview.tsx': GOOD });
  const before = fs.readFileSync(path.join(dir, 'app-spec.json'), 'utf8');
  const r = run(dir);
  assert.equal(r.code, 3, 'fail-closed exit code');
  assert.match(r.stderr, /detail\.tsx: file was never written/);
  assert.equal(fs.readFileSync(path.join(dir, 'app-spec.json'), 'utf8'), before, 'spec untouched');
});

test('rejects Sol-class prose that only LOOKS like a module', () => {
  // A plain `export default` substring search — even over pageref-resolver's stripNonCode, which
  // preserves ordinary string bodies — accepted every one of these, promoting prose as a page.
  for (const [name, code, expected] of [
    ['empty', '   \n', /file is empty/],
    ['no default export', 'export function P() {}\n', /no real `export default/],
    ['fenced prose', '```tsx\nexport default function P(){}\n```\n', /markdown code fence/],
    ['tilde-fenced prose', '~~~tsx\nexport default function P(){}\n~~~\n', /markdown code fence/],
    ['commented-out export', '/* export default */\nThis is prose\n', /no real `export default/],
    ['export default in a string', 'const bait = "export default GeneratedComponent";\n', /no real `export default/],
    ['export default in a template', 'const t = `\nexport default Foo\n`;\n', /no real `export default/],
    ['line-commented export', '// export default function P(){}\nThis is prose\n', /no real `export default/],
    ['empty default export', 'export default;\n', /no real `export default/],
    ['truncated write', 'export default function P() {\n  return <div>\n', /truncated/],
  ]) {
    const dir = makeWorkspace(
      { app: { name: 'A' }, pages: [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }] },
      { 'overview.tsx': code },
    );
    const r = run(dir);
    assert.equal(r.code, 3, `${name} should fail`);
    assert.match(r.stderr, expected, name);
  }
});

test('accepts the legitimate default-export forms a worker really emits', () => {
  for (const [name, code] of [
    ['function declaration', 'export default function P() { return <div/>; }\n'],
    ['arrow const', 'const P = () => <div/>;\nexport default P;\n'],
    ['wrapped in memo', 'import { memo } from "react";\nexport default memo(function P(){ return <div/>; });\n'],
    ['object-ish default', 'export default {\n  render() { return null; }\n};\n'],
    ['after a doc comment mentioning export default', '/**\n * export default is required\n */\nexport default function P(){ return <div/>; }\n'],
    ['aliased default export', 'function P(){ return <div/>; }\nexport { P as default };\n'],
    ['JSX text with an apostrophe', "export default function P(){ return <p>it's fine</p>; }\n"],
  ]) {
    const dir = makeWorkspace(
      { app: { name: 'A' }, pages: [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }] },
      { 'overview.tsx': code },
    );
    assert.equal(run(dir).code, 0, `${name} should be accepted`);
  }
});

test('holds cross-page navigation to the spec before promoting', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];

  // (a) declared edge the code never navigates -> abort
  let dir = makeWorkspace(spec, { 'overview.tsx': GOOD, 'detail.tsx': GOOD });
  let r = run(dir);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /declares detail but the code never navigates there/);

  // (b) the canonical double-quoted PAGEREF literal -> promotes
  const nav = `export default function P(){ navigateTo({ pageType: 'generative', pageId: "PAGEREF_detail" }); return <div/>; }\n`;
  dir = makeWorkspace(spec, { 'overview.tsx': nav, 'detail.tsx': GOOD });
  r = run(dir);
  assert.equal(r.code, 0, r.stderr);

  // (c) single-quoted token is malformed — the build would deploy a dead link, so abort here
  const bad = `export default function P(){ navigateTo({ pageType: 'generative', pageId: 'PAGEREF_detail' }); return <div/>; }\n`;
  dir = makeWorkspace(spec, { 'overview.tsx': bad, 'detail.tsx': GOOD });
  r = run(dir);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /malformed nav pageref/);
});

test('already-built pages are left alone and are not required to exist', () => {
  const dir = makeWorkspace({
    app: { name: 'A' },
    pages: [{ key: 'built', name: 'Built', source: { kind: 'tsx', codeFile: 'pages/9f2c/page.tsx' } }],
  }, {});
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no intent pages to promote/);
  assert.deepEqual(readSpec(dir).pages[0].source, { kind: 'tsx', codeFile: 'pages/9f2c/page.tsx' });
});

test('promotes a spec whose pages have no explicit key (key is derived from name)', () => {
  // Regression: the raw spec is what gets rewritten, and `key` is OPTIONAL there — migrateAppSpec
  // derives it by slugifying `name`. Matching raw pages BY KEY threw on exactly these specs.
  const dir = makeWorkspace(
    { app: { name: 'A' }, pages: [{ name: 'Supplier Detail' }, { name: 'Overview' }] },
    { 'supplier-detail.tsx': GOOD, 'overview.tsx': GOOD },
  );
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  const after = readSpec(dir);
  assert.deepEqual(after.pages.map((p) => p.source), [
    { kind: 'tsx', codeFile: 'supplier-detail.tsx' },
    { kind: 'tsx', codeFile: 'overview.tsx' },
  ]);
  assert.ok(after.pages.every((p) => p.key === undefined), 'derived keys are not persisted into the spec');
});

test('two pages cannot silently share a file', () => {
  // Upstream, migrateAppSpec de-duplicates slugified keys, so "Supplier Detail" and
  // "supplier-detail" become supplier-detail / supplier-detail-2 and get distinct files. Assert
  // that invariant here (it is what makes one-file-per-page true), and note the script keeps its
  // own same-file guard as a backstop if that ever changes.
  const dir = makeWorkspace({
    app: { name: 'A' },
    pages: [{ name: 'Supplier Detail' }, { name: 'supplier-detail' }],
  }, { 'supplier-detail.tsx': GOOD, 'supplier-detail-2.tsx': GOOD });
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readSpec(dir).pages.map((p) => p.source.codeFile), ['supplier-detail.tsx', 'supplier-detail-2.tsx']);
});

test('validatePage refuses a codeFile that escapes the working directory', () => {
  // Defence in depth: today `pageFile()` only returns a pinned codeFile for already-built pages
  // (which promotion skips), but codeFile is author-editable and download-derived, so the check
  // lives with the read rather than relying on that invariant holding forever.
  const { validatePage } = require('../promote-intent-pages.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-esc-'));
  fs.writeFileSync(path.join(dir, '..', 'outside.tsx'), GOOD, 'utf8');
  for (const codeFile of ['../outside.tsx', path.join(dir, '..', 'outside.tsx')]) {
    const r = validatePage({ key: 'evil', name: 'Evil', source: { kind: 'tsx', codeFile } }, dir);
    assert.deepEqual(r.problems.length, 1, codeFile);
    assert.match(r.problems[0], /escapes the working directory/, codeFile);
  }
});

test('a malformed or missing spec fails closed with the same exit contract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-bad-'));
  let r = run(dir);
  assert.equal(r.code, 3, 'missing spec');
  assert.match(r.stderr, /cannot read app spec/);

  fs.writeFileSync(path.join(dir, 'app-spec.json'), '{ not json', 'utf8');
  r = run(dir);
  assert.equal(r.code, 3, 'unparseable spec');

  fs.writeFileSync(path.join(dir, 'app-spec.json'), '{"app":{"name":"A"},"pages":"nope"}', 'utf8');
  r = run(dir);
  assert.equal(r.code, 3, 'pages not an array');
  assert.match(r.stderr, /"pages" must be an array/);
});

test('aborts if the spec changed while pages were being validated', () => {
  // Validation reads N page files, so a concurrent editor's save between our read and the rename
  // would otherwise be silently overwritten by our stale in-memory copy.
  //
  // Deterministic race: preload a module into the CLI's process that patches fs.readFileSync so the
  // FIRST .tsx read rewrites app-spec.json — exactly the window the compare-and-swap protects.
  const dir = makeWorkspace(twoPageSpec(), { 'overview.tsx': GOOD, 'detail.tsx': GOOD });
  const specFile = path.join(dir, 'app-spec.json');
  const hook = path.join(dir, 'race-hook.js');
  fs.writeFileSync(hook, `
    const fs = require('node:fs');
    const real = fs.readFileSync;
    let fired = false;
    fs.readFileSync = function (p, ...rest) {
      const out = real.call(this, p, ...rest);
      if (!fired && String(p).endsWith('.tsx')) {
        fired = true;
        real.call(fs, ${JSON.stringify(specFile)}, 'utf8');
        fs.writeFileSync(${JSON.stringify(specFile)}, JSON.stringify({ app: { name: 'Edited By Someone Else' }, pages: [] }, null, 2));
      }
      return out;
    };
  `, 'utf8');

  let r;
  try {
    execFileSync(process.execPath, ['--require', hook, CLI, '--spec', '@' + specFile, '--working-dir', dir], { encoding: 'utf8' });
    r = { code: 0 };
  } catch (e) {
    r = { code: e.status, stderr: String(e.stderr || '') };
  }
  assert.equal(r.code, 3, 'must fail closed on a concurrent edit');
  assert.match(r.stderr, /app spec changed while pages were being validated/);
  // The concurrent editor's content is intact — we did not overwrite it.
  assert.equal(readSpec(dir).app.name, 'Edited By Someone Else');
});

test('unrelated spec content survives the rewrite', () => {
  const spec = twoPageSpec();
  spec.entities = [{ logicalName: 'co_thing', columns: [{ logicalName: 'co_name', type: 'Text' }] }];
  spec.appShell = { areas: [{ title: 'Main' }] };
  const dir = makeWorkspace(spec, { 'overview.tsx': GOOD, 'detail.tsx': GOOD });
  assert.equal(run(dir).code, 0);
  const after = readSpec(dir);
  assert.deepEqual(after.entities, spec.entities);
  assert.deepEqual(after.appShell, spec.appShell);
});
