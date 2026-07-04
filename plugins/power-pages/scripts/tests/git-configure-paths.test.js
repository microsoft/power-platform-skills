'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  GIT_CONFIGURE_DIR,
  FILE_NAMES,
  gitConfigureDir,
  gitConfigurePath,
  ensureGitConfigureDir,
} = require('../lib/git-configure-paths');

function makeTmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-configure-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('GIT_CONFIGURE_DIR co-locates git-configure artifacts under docs/inner-loop', () => {
  // git-configure IS an inner-loop skill; it just owns its own subset of files.
  // Sharing the directory means existing tooling that points at docs/inner-loop
  // git-configure IS an inner-loop skill; it just owns its own subset of files.
  // Sharing the directory means all inner-loop tooling that points at
  // docs/inner-loop (git-configure + git-sync markers and reports) keeps
  // working without changes.
  assert.equal(GIT_CONFIGURE_DIR, 'docs/inner-loop');
});

test('FILE_NAMES exposes the git-configure keys and uses kebab-case file names', () => {
  const expected = [
    'lastGitConfigure',
    'gitConfigurePlanData',
  ];
  assert.deepEqual(Object.keys(FILE_NAMES).sort(), expected.slice().sort());
  for (const name of Object.values(FILE_NAMES)) {
    assert.ok(!name.startsWith('.'),
      `file name ${name} should not start with a dot — it lives in docs/inner-loop/`);
    assert.ok(/^[a-z0-9.-]+\.(json|html)$/.test(name),
      `file name ${name} should be kebab-case .json or .html`);
  }
});

test('FILE_NAMES is frozen (cannot be mutated at runtime)', () => {
  assert.throws(() => { FILE_NAMES.lastGitConfigure = 'last-git-configure-v2.json'; },
    /read.?only|assign|cannot/i);
});

test('FILE_NAMES key names follow the same camelCase scheme as inner-loop-paths.js', () => {
  // Sanity: callers shouldn't have to memorise both camelCase and snake_case
  // — git-configure-paths matches inner-loop-paths' convention.
  for (const key of Object.keys(FILE_NAMES)) {
    assert.ok(/^[a-z][a-zA-Z0-9]*$/.test(key),
      `key ${key} must be camelCase to match inner-loop-paths.js convention`);
  }
});

test('gitConfigureDir(projectRoot) joins GIT_CONFIGURE_DIR onto the project root', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  assert.equal(gitConfigureDir(root), path.join(root, 'docs', 'inner-loop'));
});

test('gitConfigureDir throws when projectRoot is missing', () => {
  assert.throws(() => gitConfigureDir(undefined), /projectRoot is required/);
  assert.throws(() => gitConfigureDir(''), /projectRoot is required/);
});

test('gitConfigurePath returns a stable absolute path for known keys', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  assert.equal(
    gitConfigurePath(root, 'lastGitConfigure'),
    path.join(root, 'docs', 'inner-loop', 'last-git-configure.json'),
  );
  assert.equal(
    gitConfigurePath(root, 'gitConfigurePlanData'),
    path.join(root, 'docs', 'inner-loop', 'git-configure-plan-data.json'),
  );
});

test('gitConfigurePath throws for unknown keys (catches typos at call-site)', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  assert.throws(() => gitConfigurePath(root, 'lstGitConfg'), /unknown key/);
  assert.throws(() => gitConfigurePath(root, 'somethingMadeUp'), /unknown key/);
});

test('ensureGitConfigureDir creates docs/inner-loop/ if it does not exist', (t) => {
  const root = makeTmp(t);
  assert.equal(fs.existsSync(path.join(root, 'docs', 'inner-loop')), false,
    'precondition: docs/inner-loop/ should not exist yet');
  const created = ensureGitConfigureDir(root);
  assert.equal(created, path.join(root, 'docs', 'inner-loop'));
  assert.ok(fs.statSync(created).isDirectory());
});

test('ensureGitConfigureDir is idempotent when docs/inner-loop/ already exists', (t) => {
  const root = makeTmp(t);
  fs.mkdirSync(path.join(root, 'docs', 'inner-loop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'inner-loop', 'sentinel.txt'), 'pre-existing');
  ensureGitConfigureDir(root);
  assert.equal(
    fs.readFileSync(path.join(root, 'docs', 'inner-loop', 'sentinel.txt'), 'utf8'),
    'pre-existing',
  );
});

test('every FILE_NAMES entry resolves via gitConfigurePath without error', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  for (const key of Object.keys(FILE_NAMES)) {
    const p = gitConfigurePath(root, key);
    assert.ok(p.includes(FILE_NAMES[key]),
      `${key} → ${p} should contain ${FILE_NAMES[key]}`);
    assert.ok(p.startsWith(path.join(root, 'docs', 'inner-loop')),
      `${key} should live under docs/inner-loop/`);
  }
});
