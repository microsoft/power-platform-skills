'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  EXPECTED_FILES,
  scaffold,
} = require('../scaffold-apple-fastlane');

const ROOT = path.join(__dirname, '.scaffold-apple-fastlane-work');
const OUTSIDE_ROOT = path.join(__dirname, '.scaffold-apple-fastlane-outside');

test.afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
});

test('creates only the expected fastlane scaffold files', () => {
  fs.mkdirSync(ROOT, { recursive: true });

  const result = scaffold({ projectRoot: ROOT });

  assert.deepEqual(result.created, EXPECTED_FILES);
  const actual = fs.readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)))
    .sort();
  assert.deepEqual(actual, [...EXPECTED_FILES].sort());
});

test('reuses an identical scaffold idempotently', () => {
  fs.mkdirSync(ROOT, { recursive: true });
  scaffold({ projectRoot: ROOT });

  const result = scaffold({ projectRoot: ROOT });

  assert.deepEqual(result, {
    created: [],
    replaced: [],
    reused: EXPECTED_FILES,
  });
});

test('reports customized files without partially modifying the project', () => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'Gemfile'), '# project-owned\n');

  assert.throws(
    () => scaffold({ projectRoot: ROOT }),
    /explicit --replace selection: Gemfile/,
  );
  assert.equal(fs.readFileSync(path.join(ROOT, 'Gemfile'), 'utf8'), '# project-owned\n');
  assert.equal(fs.existsSync(path.join(ROOT, 'Gemfile.lock')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'fastlane')), false);
});

test('replaces only explicitly selected customized files', () => {
  fs.mkdirSync(ROOT, { recursive: true });
  scaffold({ projectRoot: ROOT });
  fs.writeFileSync(path.join(ROOT, 'Gemfile'), '# replace me\n');
  fs.writeFileSync(path.join(ROOT, 'fastlane', 'README.md'), '# keep me\n');

  assert.throws(
    () => scaffold({ projectRoot: ROOT, replace: ['Gemfile'] }),
    /fastlane[/\\]README\.md/,
  );
  assert.equal(fs.readFileSync(path.join(ROOT, 'Gemfile'), 'utf8'), '# replace me\n');

  const result = scaffold({
    projectRoot: ROOT,
    replace: ['Gemfile', path.join('fastlane', 'README.md')],
  });
  assert.deepEqual(result.replaced, ['Gemfile', path.join('fastlane', 'README.md')]);
  assert.match(fs.readFileSync(path.join(ROOT, 'Gemfile'), 'utf8'), /fastlane/);
  assert.match(fs.readFileSync(path.join(ROOT, 'fastlane', 'README.md'), 'utf8'), /scaffold/);
});

test('rejects symlink escapes without writing through them', () => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(OUTSIDE_ROOT, { recursive: true });
  fs.symlinkSync(OUTSIDE_ROOT, path.join(ROOT, 'fastlane'), 'dir');

  assert.throws(
    () => scaffold({ projectRoot: ROOT }),
    /symbolic links/,
  );
  assert.deepEqual(fs.readdirSync(OUTSIDE_ROOT), []);
  assert.equal(fs.existsSync(path.join(ROOT, 'Gemfile')), false);
});

test('rejects path-like replacement escapes and a symlinked project root', () => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(OUTSIDE_ROOT, { recursive: true });

  assert.throws(
    () => scaffold({ projectRoot: ROOT, replace: ['../Gemfile'] }),
    /Unexpected replacement path/,
  );

  const linkedRoot = path.join(OUTSIDE_ROOT, 'linked-project');
  fs.symlinkSync(ROOT, linkedRoot, 'dir');
  assert.throws(
    () => scaffold({ projectRoot: linkedRoot }),
    /not a symbolic link/,
  );
  assert.deepEqual(fs.readdirSync(ROOT), []);
});
