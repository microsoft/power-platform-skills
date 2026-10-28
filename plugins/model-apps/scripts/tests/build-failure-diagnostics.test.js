'use strict';
// The diagnostics a test's unexpectedly failed build keeps (helpers/build-failure-diagnostics.js): the failure of a build that
// should have succeeded must explain itself from the test output alone, without changing what the test asserts and without
// looking outside the folders the scenario owns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const {
  recordBuildFailure, flushBuildFailureDiagnostics, describeBuildFailure, listTree, MAX_LISTING_ENTRIES, MAX_DEPTH,
} = require('./helpers/build-failure-diagnostics.js');

function workspaceWith(files, prefix = 'build-failure-diagnostics-') {
  const dir = makeTempDir(prefix);
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

// What a test file's afterEach hook receives; `recorded` is what t.diagnostic printed.
const contextOf = (passed) => { const recorded = []; return { passed, diagnostic: (text) => recorded.push(text), recorded }; };
const discard = () => flushBuildFailureDiagnostics(contextOf(true));

test('build failure diagnostics: a failed build keeps its error chain, the missing path and the workspace apart from the error', () => {
  const dir = workspaceWith({ 'manifest.json': '{}', 'forms/a.json': 'abc', '.metadata/forms/a.meta.json': 'abcdef' });
  const missing = path.join(dir, 'forms', 'gone', 'manifest.json');
  const cause = realEnoent(missing);
  const halt = Object.assign(new Error(`forms failed: Transport failure: ${cause.message}`), { name: 'BuildHalt', code: 'CONNECTION_ERROR', phase: 'forms', cause });
  const original = halt.message;

  const returned = recordBuildFailure(halt, [{ label: 'scenario workspace', dir }]);

  assert.equal(returned, halt, 'the same error comes back');
  assert.equal(halt.message, original, 'its message is exactly what the build threw');
  assert.equal(halt.cause, cause);
  assert.equal(halt.code, 'CONNECTION_ERROR');
  assert.equal(halt.phase, 'forms');
  assert.equal(Object.keys(halt).includes('buildFailureDiagnostics'), false, 'the diagnostics are not an enumerable property of the error');
  const text = halt.buildFailureDiagnostics;
  assert.match(text, /\[0\] BuildHalt \(code="CONNECTION_ERROR", phase="forms"\): forms failed: Transport failure/);
  assert.match(text, /\[1\] Error \(code="ENOENT", errno=-?\d+, syscall="open", path=/, 'the cause is described with its code, syscall and path');
  assert.match(text, /\n {6,}at /, 'a stack is listed for the error and for its cause');
  assert.ok(text.includes(`missing path: ${missing} (exists now: false; nearest existing folder: ${path.join(dir, 'forms')})`), text);
  const listing = text.split('\n').map((line) => line.trim());
  for (const entry of ['.metadata/', '.metadata/forms/a.meta.json (6 bytes)', 'forms/a.json (3 bytes)', 'manifest.json (2 bytes)']) {
    assert.ok(listing.includes(entry), `${entry} is listed: ${text}`);
  }
  assert.ok(text.includes(`scenario workspace: ${dir} (`), 'the folder is named');
  discard();
});

test('build failure diagnostics: a word or number in the listing cannot make an unrelated error satisfy a rejection pattern', () => {
  // The pattern the rebuild-writes tests use to say "this is the failure the test provoked".
  const provoked = /push|500|simulated/i;
  const dir = workspaceWith({ 'artifact.json': 'x'.repeat(500), 'pushed/simulated.json': '' });
  const unrelated = new Error('unrelated failure before the write');
  assert.doesNotMatch(unrelated.message, provoked);

  recordBuildFailure(unrelated, [{ label: 'scenario workspace', dir }]);

  assert.doesNotMatch(unrelated.message, provoked, 'the message is untouched');
  assert.doesNotMatch(String(unrelated.stack).split('\n')[0], provoked);
  assert.match(unrelated.buildFailureDiagnostics, /artifact\.json \(500 bytes\)/, 'the listing, which does hold the words, is kept apart');
  assert.match(unrelated.buildFailureDiagnostics, /pushed\/simulated\.json/);
  discard();
});

test('build failure diagnostics: they are printed only when the test that threw them fails, and only once', () => {
  const error = recordBuildFailure(new Error('boom'), []);
  const passing = contextOf(true);
  flushBuildFailureDiagnostics(passing);
  assert.deepEqual(passing.recorded, [], 'a test that provoked and rejected the failure prints nothing');

  recordBuildFailure(new Error('second'), []);
  const failing = contextOf(false);
  flushBuildFailureDiagnostics(failing);
  assert.equal(failing.recorded.length, 1, 'only what was recorded since the last test');
  assert.match(failing.recorded[0], /\[0\] Error: second/);
  const again = contextOf(false);
  flushBuildFailureDiagnostics(again);
  assert.deepEqual(again.recorded, []);
  assert.ok(error.buildFailureDiagnostics, 'the error keeps its own copy');
});

test('build failure diagnostics: a missing workspace lists nothing of its parent or of a path outside the scenario folders', () => {
  const parent = workspaceWith({ 'unrelated-private-project/private-file-name.txt': 'secret', 'scenario/placeholder.txt': 'x' }, 'build-failure-scope-');
  const scenario = path.join(parent, 'scenario');
  const missing = path.join(scenario, 'manifest.json');
  fs.rmSync(scenario, { recursive: true, force: true });
  const outside = workspaceWith({ 'elsewhere/other-name.json': '{}' }, 'build-failure-outside-');
  const outsidePath = path.join(outside, 'elsewhere', 'gone', 'manifest.json');

  const text = describeBuildFailure(
    new Error(`forms failed: ENOENT: no such file or directory, open '${missing}'; then ENOENT: no such file or directory, open '${outsidePath}'`),
    [{ label: 'scenario workspace', dir: scenario }],
  );

  assert.ok(text.includes(`missing path: ${missing} (its scenario workspace no longer exists)`), text);
  assert.ok(text.includes(`scenario workspace: ${scenario} does not exist`), text);
  assert.ok(text.includes(`missing path: ${outsidePath} (outside the folders listed below; not looked at)`), text);
  for (const name of ['unrelated-private-project', 'private-file-name', 'other-name.json', 'placeholder.txt']) {
    assert.equal(text.includes(name), false, `${name} is not disclosed: ${text}`);
  }
});

test('build failure diagnostics: the walk stops at its entry budget, does not count the rest and does not follow links', (t) => {
  const files = {};
  for (let i = 0; i < MAX_LISTING_ENTRIES + 30; i += 1) files[`f${String(i).padStart(3, '0')}.json`] = '';
  const dir = workspaceWith(files);
  const linked = workspaceWith({ 'inside-the-link.txt': 'x' }, 'build-failure-link-target-');
  let linkMade = true;
  try { fs.symlinkSync(linked, path.join(dir, 'aaa-link'), 'junction'); } catch { linkMade = false; }

  const stats = [];
  const original = fs.lstatSync;
  fs.lstatSync = function countingLstat(file, ...rest) { stats.push(file); return original.call(this, file, ...rest); };
  let tree;
  try { tree = listTree(dir); } finally { fs.lstatSync = original; }

  assert.equal(tree.lines.length, MAX_LISTING_ENTRIES);
  assert.equal(tree.truncated, true);
  assert.ok(stats.length <= MAX_LISTING_ENTRIES, `${stats.length} files examined for a listing of ${MAX_LISTING_ENTRIES}`);
  if (linkMade) {
    assert.equal(tree.lines[0], 'aaa-link -> link', 'a link is named, not followed');
    assert.equal(tree.lines.some((line) => line.includes('inside-the-link')), false);
  } else {
    t.diagnostic('links could not be created here; the link case is not exercised');
  }

  const header = describeBuildFailure(new Error('x'), [{ label: 'scenario workspace', dir }]).split('\n').find((line) => line.startsWith('scenario workspace:'));
  assert.ok(header.includes(`(${MAX_LISTING_ENTRIES} entries listed; more exist, the listing stops at`), header);
});

test('build failure diagnostics: the walk goes no deeper than its depth budget', () => {
  const nested = Array.from({ length: MAX_DEPTH + 3 }, (_, i) => `d${i}`).join('/');
  const dir = workspaceWith({ [`${nested}/deep.txt`]: 'x' });
  const tree = listTree(dir);
  assert.equal(tree.truncated, true);
  assert.equal(tree.lines.length, MAX_DEPTH, 'one folder per level, and nothing below the last');
  assert.equal(tree.lines.some((line) => line.includes('deep.txt')), false);
});

test('build failure diagnostics: a credential quoted by a cause is masked, and a frozen or non-Error value is handled', () => {
  const secret = 'abcdefghijklmnop0123456789';
  const dir = workspaceWith({ 'a.json': '{}' });
  const error = new Error('request failed', { cause: new Error(`Authorization: Bearer ${secret} was refused`) });
  recordBuildFailure(error, [{ label: 'scenario workspace', dir }]);
  assert.equal(error.buildFailureDiagnostics.includes(secret), false, error.buildFailureDiagnostics);
  assert.ok(error.buildFailureDiagnostics.includes('Bearer ****'));

  const loop = new Error('outer');
  const inner = new Error('inner', { cause: loop });
  loop.cause = inner;
  assert.equal((describeBuildFailure(loop, []).match(/\[\d\] /g) || []).length, 2, 'each error of a cause loop is described once');

  const frozen = Object.freeze(new Error('frozen'));
  assert.equal(recordBuildFailure(frozen, []), frozen);
  assert.equal(frozen.message, 'frozen');
  assert.equal(recordBuildFailure('refused', []), 'refused');
  assert.equal(recordBuildFailure(undefined, []), undefined);
  discard();
});
