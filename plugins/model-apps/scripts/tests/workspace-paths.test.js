'use strict';
// #587 item 8 — `--clear-workspace` ran a recursive delete on whatever `--workspace` named.
//
// The danger is the timing: cleanup happens after a SUCCESSFUL teardown, which is the moment an
// operator is least expecting data loss. A mistyped path, or a shell variable that expanded to a
// repo root or home directory, was recursively removed with `force: true`.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { WORKSPACE_DIR_NAME, checkWorkspaceClearable } = require('../lib/workspace-paths.js');

// A real directory on disk, so the ordinary accept path is not proved with a stub.
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function realWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wsclear-'));
  dirs.push(base);
  const ws = path.join(base, 'app', WORKSPACE_DIR_NAME);
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

test('a real .maker-workspace under a spec folder is clearable', () => {
  const ws = realWorkspace();
  const r = checkWorkspaceClearable(ws);
  assert.strictEqual(r.ok, true, `expected a genuine workspace to be clearable, got ${JSON.stringify(r)}`);
  assert.strictEqual(path.basename(r.target), WORKSPACE_DIR_NAME);
});

// The core of the bug: any other path was deleted just as readily.
test('a path that is not a workspace directory is refused', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wsclear-src-'));
  dirs.push(base);
  for (const candidate of [base, path.join(base, 'src'), path.join(base, 'node_modules'), os.homedir()]) {
    const r = checkWorkspaceClearable(candidate);
    assert.strictEqual(r.ok, false, `${candidate} must not be clearable`);
    assert.match(r.reason, new RegExp(`only a directory named '\\${WORKSPACE_DIR_NAME}'`));
  }
});

test('empty, blank and missing paths are refused rather than resolved to the cwd', () => {
  // `path.resolve('')` is the CWD — so an unset shell variable used to mean "delete the directory
  // the command happens to be running in".
  for (const bad of ['', '   ', undefined, null, 42]) {
    const r = checkWorkspaceClearable(bad);
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} must not be clearable`);
  }
});

test('a filesystem root, and a workspace directly inside one, are refused', () => {
  const root = path.parse(process.cwd()).root;
  const atRoot = checkWorkspaceClearable(root);
  assert.strictEqual(atRoot.ok, false);

  const wsAtRoot = checkWorkspaceClearable(path.join(root, WORKSPACE_DIR_NAME));
  assert.strictEqual(wsAtRoot.ok, false, 'a workspace directly inside a root is a truncated path, not a project');
  assert.match(wsAtRoot.reason, /filesystem root/);
});

// Junctions need elevation on Windows, so the filesystem answers are injected. The RULES are what
// is under test here, not node's fs.
test('a symlinked or junctioned workspace is refused', () => {
  const ws = path.join(os.tmpdir(), 'proj', WORKSPACE_DIR_NAME);
  const r = checkWorkspaceClearable(ws, {
    lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => true }),
    realpathSync: () => ws,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /symlink\/junction/);
});

// The escape rule 1 alone cannot catch: the LEXICAL name is right, but it resolves elsewhere.
test('a workspace name that resolves somewhere else is refused', () => {
  const ws = path.join(os.tmpdir(), 'proj', WORKSPACE_DIR_NAME);
  const r = checkWorkspaceClearable(ws, {
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    realpathSync: () => path.join(os.homedir(), 'Documents'),
  });
  assert.strictEqual(r.ok, false, 'resolving outside a workspace must be refused');
  assert.match(r.reason, /which is not a/);
});

test('a file wearing the workspace name is refused', () => {
  const ws = path.join(os.tmpdir(), 'proj', WORKSPACE_DIR_NAME);
  const r = checkWorkspaceClearable(ws, {
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => false }),
    realpathSync: () => ws,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not a directory/);
});

test('a missing workspace is reported as nothing to clear, not as an error to fix', () => {
  const r = checkWorkspaceClearable(path.join(os.tmpdir(), 'no-such-proj-xyz', WORKSPACE_DIR_NAME));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /nothing to clear/);
});
