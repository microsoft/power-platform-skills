'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { cloneDirLayout } = require('../lib/resolve-clone-path');

test('cloneDirLayout: returns cloneDir, repoDir, and ppMergeDir for an absolute path', () => {
  const cloneDir = path.resolve('C:\\clones\\my-site');
  const layout = cloneDirLayout(cloneDir);

  assert.equal(layout.cloneDir, cloneDir);
  assert.equal(layout.repoDir, path.join(cloneDir, 'repo'));
  assert.equal(layout.ppMergeDir, path.join(cloneDir, '.pp-merge'));
});

test('cloneDirLayout: repoDir is exactly <cloneDir>/repo', () => {
  const cloneDir = path.resolve('C:\\Users\\user\\clones\\contoso-retail');
  const { repoDir } = cloneDirLayout(cloneDir);
  assert.equal(repoDir, path.join(cloneDir, 'repo'));
});

test('cloneDirLayout: ppMergeDir is exactly <cloneDir>/.pp-merge', () => {
  const cloneDir = path.resolve('C:\\Users\\user\\clones\\contoso-retail');
  const { ppMergeDir } = cloneDirLayout(cloneDir);
  assert.equal(ppMergeDir, path.join(cloneDir, '.pp-merge'));
});

test('cloneDirLayout: is deterministic for identical inputs', () => {
  const cloneDir = path.resolve('C:\\clones\\site-a');
  assert.deepEqual(cloneDirLayout(cloneDir), cloneDirLayout(cloneDir));
});

test('cloneDirLayout: throws on a relative path', () => {
  assert.throws(
    () => cloneDirLayout('relative/path/to/clone'),
    /cloneDir must be an absolute path/
  );
});

test('cloneDirLayout: throws on a null/undefined cloneDir', () => {
  assert.throws(() => cloneDirLayout(null), /cloneDir is required/);
  assert.throws(() => cloneDirLayout(undefined), /cloneDir is required/);
  assert.throws(() => cloneDirLayout(), /cloneDir is required/);
});

test('cloneDirLayout: returned object has exactly the 3 expected keys', () => {
  const cloneDir = path.resolve('C:\\clones\\my-site');
  const layout = cloneDirLayout(cloneDir);
  assert.deepEqual(Object.keys(layout).sort(), ['cloneDir', 'ppMergeDir', 'repoDir'].sort());
});
