'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validatePageOutput, stampPageTarget } = require('../genpage-worker-output.js');

function write(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-worker-output-'));
  const filePath = path.join(dir, 'page.tsx');
  fs.writeFileSync(filePath, code, 'utf8');
  return filePath;
}

test('validatePageOutput rejects a truncated worker file before dispatch is accepted', () => {
  const filePath = write('export default function GeneratedComponent() {\n  return <div>truncated\n');

  const result = validatePageOutput({ filePath });

  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /unbalanced brackets|truncated/i);

  // Cut right after a complete statement: the file ends in plain code, so only the bracket count
  // sees that the function never closed.
  const balancedTail = validatePageOutput({ filePath: write('export default function GeneratedComponent() {\n  const a = 1;\n  return null;\n') });
  assert.equal(balancedTail.ok, false);
  assert.deepEqual(balancedTail.problems, ['unbalanced brackets — output looks truncated']);

  // Cut INSIDE the export statement, nothing is open yet, so the brackets balance — the export
  // itself has to be complete: a function reaches its body, a bare name is one the module has.
  for (const code of [
    'import * as React from "react";\nexport default function GeneratedComponent(props: Props)',
    'import * as React from "react";\nexport default func',
    'const GeneratedComponent = () => <div/>;\nexport default GeneratedComp',
  ]) {
    const cut = validatePageOutput({ filePath: write(code) });
    assert.equal(cut.ok, false, code);
    assert.match(cut.problems.join('\n'), /default export/, code);
  }

  // A cut that leaves every bracket balanced and the export intact: inside the JSX of an arrow
  // export, or after an operator.
  for (const code of [
    'export default (props) => <GeneratedComponent title="x',
    'export default () => <div>Loading',
    'const GeneratedComponent = () => <div/>;\nexport default GeneratedComponent;\nconst total = count *',
  ]) {
    const cut = validatePageOutput({ filePath: write(code) });
    assert.equal(cut.ok, false, code);
    assert.match(cut.problems.join('\n'), /stops mid-statement/, code);
  }
});

test('validatePageOutput rejects prose or fenced output that only mentions a default export', () => {
  for (const code of [
    'The worker should write export default GeneratedComponent here.\n',
    '```tsx\nexport default function GeneratedComponent() { return <div/>; }\n```\n',
  ]) {
    const result = validatePageOutput({ filePath: write(code) });
    assert.equal(result.ok, false, code);
  }
});

test('validatePageOutput accepts a complete TSX module', () => {
  const filePath = write('export default function GeneratedComponent() {\n  return <div>ok</div>;\n}\n');

  const result = validatePageOutput({ filePath });

  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

// The skill runs the CLI and acts on its exit code: 0 accepts the worker's file, 3 sends the page to
// the inline fallback. A missing or empty file is output that failed, never a pass.
test('the CLI accepts with exit 0 and sends a failed page to the fallback with exit 3', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'genpage-worker-output.js');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const good = run('--file', write('export default function GeneratedComponent() {\n  return <div>ok</div>;\n}\n'));
  assert.equal(good.status, 0, good.stdout);
  assert.equal(JSON.parse(good.stdout).ok, true);
  const truncated = run('--file', write('export default function GeneratedComponent() {\n  return <div>truncated\n'));
  assert.equal(truncated.status, 3);
  assert.equal(JSON.parse(truncated.stdout).ok, false);
  const absent = run('--file', path.join(os.tmpdir(), `genpage-never-written-${process.pid}.tsx`));
  assert.equal(absent.status, 3);
  assert.deepEqual(JSON.parse(absent.stdout).problems, ['file was never written']);
  assert.deepEqual(JSON.parse(run('--file', write('   \n')).stdout).problems, ['file is empty']);
  assert.equal(run().status, 3, 'no --file is not a pass');
});

// A folder or an unreadable file at the page path threw out of readFileSync — an uncaught CLI failure
// instead of the ok:false that sends the page to its one inline rewrite. A link there is not a page
// written in place (the dispatch gate refuses one before any worker runs).
test('a folder, a link or an unreadable file at the page path is a failed validation, never a throw', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-worker-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'folder.tsx');
  fs.mkdirSync(folder);
  assert.deepEqual(validatePageOutput({ filePath: folder }).problems, ['is not a regular file']);
  const real = path.join(dir, 'real.tsx');
  fs.writeFileSync(real, 'export default function GeneratedComponent() {\n  return <div>ok</div>;\n}\n');
  const linked = path.join(dir, 'linked.tsx');
  let linkedOk = true;
  try { fs.symlinkSync(real, linked, 'file'); } catch { linkedOk = false; }
  if (linkedOk) {
    const r = validatePageOutput({ filePath: linked });
    assert.equal(r.ok, false, 'a complete page behind a link is still not the page written in place');
    assert.deepEqual(r.problems, ['is a symbolic link or junction, not a page file written in place']);
  }
  t.mock.method(fs, 'readFileSync', () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; });
  assert.deepEqual(validatePageOutput({ filePath: real }).problems, ['file could not be read (EACCES)']);
  t.mock.method(fs, 'lstatSync', () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; });
  assert.deepEqual(validatePageOutput({ filePath: real }).problems, ['file could not be inspected (EPERM)']);
});

// A worker that returns without writing leaves an earlier attempt's page in place, and that page passes
// every content check. Each target is stamped right before it is dispatched, and a page exactly as it was
// stamped is refused, so the inline fallback runs instead of the stale page being deployed.
const COMPLETE = 'export default function GeneratedComponent() {\n  return <div>ok</div>;\n}\n';
test('a page unchanged since its dispatch stamp is refused, and any write is accepted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-worker-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const page = path.join(dir, 'overview.tsx');
  const sidecar = path.join(dir, '.overview.tsx.dispatch-stamp.json');
  fs.writeFileSync(page, COMPLETE);
  assert.deepEqual(stampPageTarget({ filePath: page }), { ok: true, action: 'stamp', filePath: page, existed: true });
  assert.ok(fs.existsSync(sidecar));
  assert.deepEqual(validatePageOutput({ filePath: page }).problems, ['file is unchanged since the page was dispatched — the worker did not write it']);
  // The stamp is KEPT while the page is unchanged: the retry the skill prescribes, or the same check run
  // again, is refused the same way. Consuming it on the failure let the next check pass the stale page.
  assert.ok(fs.existsSync(sidecar), 'an unchanged page keeps its stamp');
  assert.deepEqual(validatePageOutput({ filePath: page }).problems, ['file is unchanged since the page was dispatched — the worker did not write it']);
  // The same bytes written again still count: a write moves the modification time. And a page found
  // changed consumes its stamp.
  stampPageTarget({ filePath: page });
  const later = new Date(fs.statSync(page).mtimeMs + 5000);
  fs.writeFileSync(page, COMPLETE);
  fs.utimesSync(page, later, later);
  assert.equal(validatePageOutput({ filePath: page }).ok, true);
  assert.ok(!fs.existsSync(sidecar), 'a page found changed consumes its stamp');
  // …and so does new content with the old modification time.
  stampPageTarget({ filePath: page });
  const same = fs.statSync(page);
  fs.writeFileSync(page, COMPLETE.replace('ok', 'OK'));
  fs.utimesSync(page, same.atime, same.mtime);
  assert.equal(validatePageOutput({ filePath: page }).ok, true);
  // A target that did not exist at dispatch: never written stays "never written" (its stamp kept), and
  // written is accepted.
  const fresh = path.join(dir, 'details.tsx');
  const freshStamp = path.join(dir, '.details.tsx.dispatch-stamp.json');
  assert.equal(stampPageTarget({ filePath: fresh }).existed, false);
  assert.deepEqual(validatePageOutput({ filePath: fresh }).problems, ['file was never written']);
  assert.ok(fs.existsSync(freshStamp));
  fs.writeFileSync(fresh, COMPLETE);
  assert.equal(validatePageOutput({ filePath: fresh }).ok, true);
  assert.ok(!fs.existsSync(freshStamp));
  // Without a stamp, only the content is judged.
  assert.equal(validatePageOutput({ filePath: page }).ok, true);
  // A page whose folder does not exist yet cannot be stale: nothing to stamp, and no folder is created.
  const nested = path.join(dir, 'pages', 'new.tsx');
  assert.deepEqual(stampPageTarget({ filePath: nested }), { ok: true, action: 'stamp', filePath: nested, existed: false });
  assert.equal(fs.existsSync(path.join(dir, 'pages')), false);
  assert.deepEqual(validatePageOutput({ filePath: nested }).problems, ['file was never written']);
});

// A stamp that cannot be trusted fails closed: the check can no longer tell this run's write from what was
// there. The sidecar is written in place, so a link or a hard link at its path is refused, not written through.
test('a dispatch stamp that cannot be trusted fails closed, and a linked stamp path is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-worker-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const page = path.join(dir, 'overview.tsx');
  const sidecar = path.join(dir, '.overview.tsx.dispatch-stamp.json');
  fs.writeFileSync(page, COMPLETE);
  // A stamp is trusted only whole and only for this page: a truncated one compared nothing and let an unchanged
  // page through, and one copied from another page compared that page's state.
  const other = { filePath: path.join(dir, 'other.tsx'), existed: true, size: 1, mtimeMs: 1, sha256: 'a'.repeat(64) };
  for (const [what, content, why] of [
    ['unparseable', '{ not json', /could not be read/],
    ['not a stamp', '{"filePath":"x"}', /is not a dispatch stamp/],
    ['truncated', JSON.stringify({ filePath: page, existed: true }), /is not a dispatch stamp/],
    ['a bad digest', JSON.stringify({ filePath: page, existed: true, size: 1, mtimeMs: 1, sha256: 'nope' }), /is not a dispatch stamp/],
    ['another page\u2019s', JSON.stringify(other), /belongs to another page/],
  ]) {
    fs.writeFileSync(sidecar, content);
    const r = validatePageOutput({ filePath: page });
    assert.equal(r.ok, false, what);
    assert.match(r.problems[0], /^the dispatch stamp /, what);
    assert.match(r.problems[0], why, what);
    assert.ok(fs.existsSync(sidecar), `${what}: kept, so the check keeps failing until the page is stamped again`);
  }
  fs.rmSync(sidecar);
  const elsewhere = path.join(dir, 'elsewhere.json');
  fs.writeFileSync(elsewhere, '{}');
  fs.linkSync(elsewhere, sidecar);
  const refused = stampPageTarget({ filePath: page });
  assert.equal(refused.ok, false);
  assert.match(refused.problems[0], /is not a plain file/);
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), '{}', 'nothing is written through the hard link');
  assert.match(validatePageOutput({ filePath: page }).problems[0], /^the dispatch stamp is not a plain file; remove it and re-run$/);
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), '{}', 'and the check leaves the other name alone');
  fs.rmSync(sidecar);
  const { spawnSync } = require('node:child_process');
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'genpage-worker-output.js'), '--stamp', '--file', page], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout);
  assert.deepEqual(JSON.parse(cli.stdout), { ok: true, action: 'stamp', filePath: page, existed: true });
});

// Elision is judged where it can mean elision — a comment, or a bare line standing in for code. The
// same words as UI copy are fine, and rejecting them would throw away a good page and regenerate it.
test('elided code is rejected, but the same words as UI copy are not', () => {
  const page = (body) => `export default function GeneratedComponent() {\n${body}\n  return <div>ok</div>;\n}\n`;
  for (const [what, body] of [
    ['a TODO comment', '  // TODO: wire the save handler'],
    ['a TODO opening a comment', '  // TODO wire paging'],
    ['a FIXME block comment', '  /* FIXME: real query */'],
    ['a lowercase todo: marker', '  // Todo: add paging'],
    ['a TODO: inside a comment', '  // load rows first — TODO: paging'],
    ['a lowercase fixme', '  // fixme before release'],
    ['a TODO opening a JSDoc block', '  /**\n   * TODO implement save\n   */'],
    ['a TODO comment inside a template expression', '  const s = `${/* TODO: format it */ total}`;'],
    ['an elision comment', '  // ... rest of the component'],
    ['an elision block comment', '  /* ... */'],
    ['an omitted-for-brevity comment', '  // Implementation omitted for brevity'],
    ['a bare ellipsis line', '  ...'],
    ['a bare ellipsis line inside executable template code', '  const title = `${(() => {\n    ...\n  })()}`;'],
  ]) {
    const result = validatePageOutput({ filePath: write(page(body)) });
    assert.equal(result.ok, false, what);
    assert.match(result.problems.join('\n'), /TODO\/FIXME|elides code|bare `\.\.\.` line/, what);
  }
  for (const [what, body] of [
    ['an ellipsis in a label', '  const label = "Loading…";'],
    ['a legal multiline spread', '  const rows = [1, 2];\n  const copy = [\n    ...\n    rows\n  ];'],
    ['a TODO status value', "  const STATUSES = ['TODO', 'DOING', 'DONE'];"],
    ['todo as prose in a comment', '  // Render the todo list, newest first'],
    ['todo as prose in a JSDoc block', '  /**\n   * Renders the todo list.\n   * @returns the page\n   */'],
    ['layout prose about the rest of the page', '  // Sticky header; the rest of the page scrolls'],
    ['a file-handling comment', '  // Upload the rest of the file in 4 MB chunks'],
    ['board order naming TODO', '  // Status columns in board order: TODO -> IN_PROGRESS -> DONE'],
    ['a todo: in prose', '  // each todo: title, due date and owner'],
    ['an ellipsis in JSX text', '  const el = <Spinner label="Search documents…">Loading... please wait</Spinner>;'],
    ['a URL string', '  const docs = "https://contoso.example/...";'],
    ['a spread', '  const merged = { ...base, extra: 1 };'],
    ['a fence inside strings', '  const md = "```tsx";\n  const help = `\n\\`\\`\\`\ncode\n\\`\\`\\`\n`;'],
    ['a fence inside a block comment', '  /* usage:\n```\n<Page />\n```\n  */'],
    // Lexer shapes that once made a complete page read as truncated: a `}` in a nested template's
    // text ended the outer template early, a `//` comment right before JSX hid the element, and a
    // comment inside `${…}` made the division after it read as a regex.
    ['a nested template with braces in its text', '  const toJson = (rows) => `[${rows.map((r) => `{"id":"${r.id}"}`).join(",")}]`;'],
    ['a comment right before the root JSX', '  const el = (\n    // Instructions\n    <Text>1) Pick a record</Text>\n  );'],
    ['a comment right before a regex', '  const endsWithBrace = (v) =>\n    // drop a trailing brace\n    /\\}$/.test(v);'],
    ['a comment before a division inside a template expression', '  const label = `${total // per row, then:\n    / count} items`;'],
    // A template's `${…}` is code, JSX included; and a property named like a keyword, a non-null
    // assertion or a postfix increment is an operand, so the `/` after it divides.
    ['JSX inside a template expression', "  const x = `${<p>it's {n}</p>}`;"],
    ['a keyword-named property divided', '  const pct = <Text>{counts.new / total}</Text>;'],
    ['a non-null assertion divided', '  const pct = <Text>{closed! / total}</Text>;'],
    ['a postfix increment divided', '  const half = <Text>{i++ / 2}</Text>;'],
    ['a prefix ! before a regex', '  const noParen = (s) => !/\\(/.test(s);'],
  ]) {
    const result = validatePageOutput({ filePath: write(page(body)) });
    assert.equal(result.ok, true, `${what}: ${result.problems.join('; ')}`);
  }
});

// Corpus: every committed sample and captured page is a complete page, so the gate must accept each
// one — six of them carry "Loading…"-style copy, and an earlier draft of this gate refused all six.
test('every committed sample and fixture page passes the worker-output gate', (t) => {
  const repoRoot = path.join(__dirname, '..', '..', '..', '..');
  const { spawnSync } = require('node:child_process');
  const ls = spawnSync('git', ['ls-files', '--', 'plugins/model-apps/samples/*.tsx', 'evals/model-apps/genpage/fixtures/*.tsx', 'evals/model-apps/genpage/fixtures/**/*.tsx'],
    { cwd: repoRoot, encoding: 'utf8' });
  if (ls.status !== 0) return t.skip('not a git checkout');
  const files = [...new Set(ls.stdout.split('\n').map((f) => f.trim()).filter(Boolean))];
  assert.ok(files.length >= 20, `the corpus is populated (${files.length})`);
  for (const rel of files) {
    const result = validatePageOutput({ filePath: path.join(repoRoot, rel) });
    assert.equal(result.ok, true, `${rel}: ${result.problems.join('; ')}`);
  }
  return undefined;
});
