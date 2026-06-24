'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  hasConflictMarkers,
  detectMergeState,
  matchesRoster,
} = require('../lib/detect-merge-state');

function fakeGit({ statusStdout = '', mergeHeadOk = false } = {}) {
  return {
    status(opts) {
      assert.equal(opts.cwd, 'C:\\repo');
      return { ok: true, code: 0, stdout: statusStdout, stderr: '' };
    },
    runGit(opts) {
      assert.equal(opts.cwd, 'C:\\repo');
      assert.deepEqual(opts.args, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
      return { ok: mergeHeadOk, code: mergeHeadOk ? 0 : 1, stdout: '', stderr: '' };
    },
  };
}

function fakeFs({ mergeHeadExists = false, files = {} } = {}) {
  return {
    existsSync(filePath) {
      return filePath === path.join('C:\\repo', '.git', 'MERGE_HEAD') && mergeHeadExists;
    },
    readFileSync(filePath) {
      if (!Object.prototype.hasOwnProperty.call(files, filePath)) {
        throw new Error(`missing ${filePath}`);
      }
      return files[filePath];
    },
  };
}

test('detectMergeState reports a clean worktree without MERGE_HEAD or porcelain entries', () => {
  const state = detectMergeState({
    repoDir: 'C:\\repo',
    gitImpl: fakeGit(),
    fsImpl: fakeFs(),
  });

  assert.equal(state.inProgressMerge, false);
  assert.deepEqual(state.unmergedPaths, []);
  assert.deepEqual(state.markerFiles, []);
  assert.equal(state.clean, true);
});

test('detectMergeState reports in-progress merge and unmerged porcelain paths', () => {
  const state = detectMergeState({
    repoDir: 'C:\\repo',
    gitImpl: fakeGit({ statusStdout: 'UU path/a\nAA path/b\n M path/c\n' }),
    fsImpl: fakeFs({ mergeHeadExists: true }),
  });

  assert.equal(state.inProgressMerge, true);
  assert.deepEqual(state.unmergedPaths, ['path/a', 'path/b']);
  assert.equal(state.clean, false);
});

test('detectMergeState scans marker candidates and ignores clean or unreadable files', () => {
  const state = detectMergeState({
    repoDir: 'C:\\repo',
    gitImpl: fakeGit({ statusStdout: 'UU path/conflicted\nUU path/clean\nUU path/missing\n' }),
    fsImpl: fakeFs({
      files: {
        [path.join('C:\\repo', 'path/conflicted')]: 'first\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n',
        [path.join('C:\\repo', 'path/clean')]: 'resolved text\n',
      },
    }),
  });

  assert.deepEqual(state.markerFiles, ['path/conflicted']);
  assert.equal(state.clean, false);
});

test('detectMergeState scans optional candidatePaths instead of unmerged paths', () => {
  const state = detectMergeState({
    repoDir: 'C:\\repo',
    gitImpl: fakeGit({ statusStdout: 'UU path/unmerged\n' }),
    fsImpl: fakeFs({
      files: {
        [path.join('C:\\repo', 'path/candidate')]: '<<<<<<< ours\n',
      },
    }),
    candidatePaths: ['/path/candidate'],
  });

  assert.deepEqual(state.markerFiles, ['path/candidate']);
});

test('hasConflictMarkers detects only git conflict-start lines', () => {
  assert.equal(hasConflictMarkers('ok\n<<<<<<< HEAD\nconflict\n'), true);
  assert.equal(hasConflictMarkers('prefix <<<<<<< HEAD\n'), false);
  assert.equal(hasConflictMarkers('<<<<<<<\n'), false);
  assert.equal(hasConflictMarkers('resolved\n'), false);
});

test('matchesRoster matches equal sets after normalizing leading slashes', () => {
  assert.deepEqual(
    matchesRoster({ unmergedPaths: ['a/b', '/c/d'], expectedPaths: ['/a/b', 'c/d'] }),
    { matches: true, missing: [], extra: [] },
  );
});

test('matchesRoster reports missing and extra paths', () => {
  assert.deepEqual(
    matchesRoster({ unmergedPaths: ['a/b', 'extra/file'], expectedPaths: ['a/b', '/missing/file'] }),
    { matches: false, missing: ['missing/file'], extra: ['extra/file'] },
  );
});
