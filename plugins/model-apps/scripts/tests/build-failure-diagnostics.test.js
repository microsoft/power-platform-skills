'use strict';
// The diagnostics a test's unexpectedly failed build carries (helpers/build-failure-diagnostics.js): the failure of a build
// that should have succeeded must explain itself from the assertion message alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { annotateBuildFailure, listTree, MAX_LISTING_ENTRIES } = require('./helpers/build-failure-diagnostics.js');

function workspaceWith(files) {
  const dir = makeTempDir('build-failure-diagnostics-');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

function realEnoent(file) {
  try { fs.readFileSync(file); } catch (error) { return error; }
  throw new Error(`${file} exists`);
}

test('build failure diagnostics: a failed build names its error chain, the missing path and the workspace', () => {
  const dir = workspaceWith({ 'manifest.json': '{}', 'forms/a.json': 'abc', '.metadata/forms/a.meta.json': 'abcdef' });
  const missing = path.join(dir, 'forms', 'gone', 'manifest.json');
  const cause = realEnoent(missing);
  const halt = Object.assign(new Error(`forms failed: Transport failure: ${cause.message}`), { name: 'BuildHalt', code: 'CONNECTION_ERROR', phase: 'forms', cause });
  const original = halt.message;

  const returned = annotateBuildFailure(halt, [{ label: 'scenario workspace', dir }]);

  assert.equal(returned, halt, 'the same error comes back, so code and phase checks still hold');
  assert.equal(halt.code, 'CONNECTION_ERROR');
  assert.equal(halt.phase, 'forms');
  assert.ok(halt.message.startsWith(`${original}\n`), 'the original message stays first, so a pattern test still matches');
  assert.match(halt.message, /\[0\] BuildHalt \(code="CONNECTION_ERROR", phase="forms"\): forms failed: Transport failure/);
  assert.match(halt.message, /\[1\] Error \(code="ENOENT", errno=-?\d+, syscall="open", path=/, 'the cause is described with its code, syscall and path');
  assert.match(halt.message, /\n {6,}at /, 'a stack is listed for the error and for its cause');
  assert.ok(halt.message.includes(`missing path: ${missing} (exists now: false; nearest existing folder: ${path.join(dir, 'forms')})`), halt.message);
  const listing = halt.message.split('\n').map((line) => line.trim());
  for (const entry of ['.metadata/', '.metadata/forms/a.meta.json (6 bytes)', 'forms/a.json (3 bytes)', 'manifest.json (2 bytes)']) {
    assert.ok(listing.includes(entry), `${entry} is listed: ${halt.message}`);
  }
  assert.ok(halt.message.includes(`scenario workspace: ${dir} (`), 'the folder is named');
});

test('build failure diagnostics: a path quoted only in the message is found, and its nearest existing folder is listed', () => {
  const root = workspaceWith({ 'kept/file.txt': 'x' });
  const elsewhere = workspaceWith({ 'other/one.txt': 'yy' });
  const missing = path.join(elsewhere, 'other', 'deeper', 'manifest.json');
  const error = new Error(`forms failed: ENOENT: no such file or directory, open '${missing}'`);

  annotateBuildFailure(error, [{ label: 'scenario workspace', dir: root }]);

  assert.ok(error.message.includes(`missing path: ${missing} (exists now: false; nearest existing folder: ${path.join(elsewhere, 'other')})`), error.message);
  assert.ok(error.message.includes(`folder holding the missing path: ${path.join(elsewhere, 'other')} (1 entries)`), error.message);
  assert.ok(error.message.includes('  one.txt (2 bytes)'), error.message);
  assert.ok(error.message.includes('  kept/file.txt (1 bytes)'), 'the scenario folder is listed as well');
});

test('build failure diagnostics: the listing stops at the entry limit and counts what it left out', () => {
  const files = {};
  for (let i = 0; i < MAX_LISTING_ENTRIES + 50; i += 1) files[`f${String(i).padStart(3, '0')}.json`] = '';
  const dir = workspaceWith(files);

  const tree = listTree(dir);
  assert.equal(tree.lines.length, MAX_LISTING_ENTRIES);
  assert.equal(tree.omitted, 50);
  assert.equal(tree.lines[0], 'f000.json (0 bytes)', 'entries come in name order');

  const error = new Error('build failed');
  annotateBuildFailure(error, [{ label: 'scenario workspace', dir }]);
  assert.ok(error.message.includes(`(${MAX_LISTING_ENTRIES + 50} entries, first ${MAX_LISTING_ENTRIES} listed)`), error.message);
  assert.ok(error.message.includes('… 50 more not listed'), error.message);
});

test('build failure diagnostics: a folder that is gone, a cause loop and a value that is not an Error are all handled', () => {
  const gone = path.join(makeTempDir('build-failure-diagnostics-'), 'removed');
  const loop = new Error('outer');
  const inner = new Error('inner', { cause: loop });
  loop.cause = inner;
  annotateBuildFailure(loop, [{ label: 'app folder', dir: gone }]);
  assert.ok(loop.message.includes(`app folder: ${gone} does not exist`), loop.message);
  assert.equal(loop.message.match(/\[\d\] /g).length, 2, 'each error of the loop is described once');

  const frozen = Object.freeze(new Error('frozen'));
  assert.equal(annotateBuildFailure(frozen, []), frozen);
  assert.equal(frozen.message, 'frozen', 'an error that cannot be changed is returned as it was');

  assert.equal(annotateBuildFailure('refused', []), 'refused');
  assert.equal(annotateBuildFailure(undefined, []), undefined);
});
