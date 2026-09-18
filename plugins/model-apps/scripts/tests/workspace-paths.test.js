'use strict';
// #587 item 8 — `--clear-workspace` ran a recursive delete on whatever `--workspace` named.
//
// The danger is the timing: cleanup happens after a SUCCESSFUL teardown, which is the moment an
// operator is least expecting data loss. A mistyped path, or a shell variable that expanded to a
// repo root or home directory, was recursively removed with `force: true`.
//
// The first fix keyed on the directory NAME, and a live run caught that being wrong: every CLI here
// accepts `--workspace <any-dir>`, so `--workspace lvws` — a genuine workspace the build had just
// written 20 files into — was refused. Identity is therefore established by CONTENT: the SDK's own
// workspace manifest. These tests pin BOTH directions, because a guard that refuses everything is
// as broken as one that permits everything.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { WORKSPACE_DIR_NAME, WORKSPACE_MANIFEST, checkWorkspaceClearable } = require('../lib/workspace-paths.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Real directories on disk, so the accept path is never proved with a stub alone.
function makeDir(name, manifest) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wsclear-'));
  dirs.push(base);
  const d = path.join(base, 'app', name);
  fs.mkdirSync(d, { recursive: true });
  if (manifest !== undefined) fs.writeFileSync(path.join(d, WORKSPACE_MANIFEST), manifest, 'utf8');
  return d;
}
const SDK_MANIFEST = JSON.stringify({ instanceUrl: 'https://contoso.crm.dynamics.com/', artifacts: [] });

// A directory named `.maker-workspace` is clearable only when it PROVES it is one. The name alone
// is not identity: `--workspace` is caller-supplied, so accepting the basename let
// `--workspace /some/important/.maker-workspace` reach recursive deletion with no manifest at all.
test('the conventionally-named workspace is clearable WHEN it carries the manifest', () => {
  const r = checkWorkspaceClearable(makeDir(WORKSPACE_DIR_NAME, SDK_MANIFEST));
  assert.strictEqual(r.ok, true, `a genuine workspace must be clearable, got ${JSON.stringify(r)}`);
  assert.strictEqual(path.basename(r.target), WORKSPACE_DIR_NAME);
});

test('a directory with the conventional NAME but no manifest is refused', () => {
  const r = checkWorkspaceClearable(makeDir(WORKSPACE_DIR_NAME));
  assert.strictEqual(r.ok, false, 'the default name is not proof of identity');
  assert.match(r.reason, /not an SDK workspace/);
});

// The regression a LIVE run caught: `--workspace lvws` is supported by every CLI here, and the
// first version of this guard refused it — breaking cleanup for anyone using a custom name.
test('a CUSTOM-named directory carrying the SDK workspace manifest is clearable', () => {
  const d = makeDir('lvws', SDK_MANIFEST);
  const r = checkWorkspaceClearable(d);
  assert.strictEqual(r.ok, true,
    `--workspace <custom-dir> is supported, so a real workspace must clear: ${JSON.stringify(r)}`);
});

test('a custom-named directory with no manifest is refused', () => {
  const r = checkWorkspaceClearable(makeDir('src'));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /neither named|not an SDK workspace/);
});

// Identity is the manifest's CONTENT, not its filename — otherwise any npm package or bundler
// output directory would qualify, and the original bug returns wearing a different hat.
test('a manifest.json belonging to something else does not make a directory clearable', () => {
  for (const foreign of [
    JSON.stringify({ name: 'my-pkg', version: '1.0.0' }),        // npm
    JSON.stringify({ artifacts: [] }),                            // no instanceUrl
    JSON.stringify({ instanceUrl: 'https://x/' }),                // no artifacts
    JSON.stringify([{ instanceUrl: 'https://x/', artifacts: [] }]), // array, not an object
    'not json at all',
  ]) {
    const r = checkWorkspaceClearable(makeDir('build', foreign));
    assert.strictEqual(r.ok, false, `${foreign.slice(0, 40)} must not qualify`);
  }
});

test('a BOM-prefixed manifest is still recognised', () => {
  // pac and some editors write UTF-8 with a BOM; JSON.parse throws on it, so it is stripped.
  const r = checkWorkspaceClearable(makeDir('ws2', '\uFEFF' + SDK_MANIFEST));
  assert.strictEqual(r.ok, true, `a BOM must not make a real workspace unrecognisable: ${JSON.stringify(r)}`);
});

test('empty, blank and non-string paths are refused rather than resolved to the cwd', () => {
  // `path.resolve('')` is the CWD — so an unset shell variable used to mean "delete the directory
  // the command happens to be running in".
  for (const bad of ['', '   ', undefined, null, 42]) {
    assert.strictEqual(checkWorkspaceClearable(bad).ok, false, `${JSON.stringify(bad)} must not be clearable`);
  }
});

test('a filesystem root, and a workspace directly inside one, are refused', () => {
  const root = path.parse(process.cwd()).root;
  assert.strictEqual(checkWorkspaceClearable(root).ok, false);
  const wsAtRoot = checkWorkspaceClearable(path.join(root, WORKSPACE_DIR_NAME));
  assert.strictEqual(wsAtRoot.ok, false, 'a workspace directly inside a root is a truncated path, not a project');
  assert.match(wsAtRoot.reason, /filesystem root/);
});

// Junctions need elevation on Windows, so the filesystem answers are injected. The RULES are what
// is under test, not node's fs.
test('a symlinked or junctioned workspace is refused', () => {
  const ws = path.join(os.tmpdir(), 'proj', WORKSPACE_DIR_NAME);
  const r = checkWorkspaceClearable(ws, {
    lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => true }),
    realpathSync: () => ws,
    readFileSync: () => SDK_MANIFEST,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /symlink\/junction/);
});

// The escape a name check alone cannot catch: the lexical name is right, but it resolves elsewhere.
test('a workspace name that resolves to a non-workspace is refused', () => {
  const ws = path.join(os.tmpdir(), 'proj', WORKSPACE_DIR_NAME);
  const r = checkWorkspaceClearable(ws, {
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    realpathSync: () => path.join(os.homedir(), 'Documents'),
    readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.strictEqual(r.ok, false, 'identity must be tested on the RESOLVED path');
  assert.match(r.reason, /neither named|not an SDK workspace/);
});

test('a file wearing the workspace name is refused', () => {
  const ws = path.join(os.tmpdir(), 'proj', WORKSPACE_DIR_NAME);
  const r = checkWorkspaceClearable(ws, {
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => false }),
    realpathSync: () => ws,
    readFileSync: () => SDK_MANIFEST,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not a directory/);
});

test('a missing workspace is reported as nothing to clear, not as an error to fix', () => {
  const r = checkWorkspaceClearable(path.join(os.tmpdir(), 'no-such-proj-xyz', WORKSPACE_DIR_NAME));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /nothing to clear/);
});

// Adversarial review: the root rules were applied to the LEXICAL path only, so an ancestor junction
// could land the delete at a root-level directory that passing directly would have refused.
// Measured: `D:\review-link\project\.maker-workspace` resolving to `D:\.maker-workspace` was
// accepted. The rules must hold for the path actually deleted, not merely the one typed.
test('an ancestor junction cannot land the delete at a filesystem root', () => {
  const root = path.parse(process.cwd()).root;
  const typed = path.join(root, 'review-link', 'project', WORKSPACE_DIR_NAME);
  const r = checkWorkspaceClearable(typed, {
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    realpathSync: () => path.join(root, WORKSPACE_DIR_NAME),
    readFileSync: () => JSON.stringify({ instanceUrl: 'https://x/', artifacts: [] }),
  });
  assert.strictEqual(r.ok, false, 'the canonical target is root-level and must be refused');
  assert.match(r.reason, /filesystem root/);

  // CONTROL: the same junction landing somewhere ordinary is still allowed, so this is a root rule
  // and not a blanket ban on resolving elsewhere.
  const ok = checkWorkspaceClearable(typed, {
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    realpathSync: () => path.join(root, 'real', 'project', WORKSPACE_DIR_NAME),
    readFileSync: () => JSON.stringify({ instanceUrl: 'https://x/', artifacts: [] }),
  });
  assert.strictEqual(ok.ok, true, `an ordinary canonical target must still clear: ${JSON.stringify(ok)}`);
});
