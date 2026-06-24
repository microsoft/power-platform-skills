'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openMergeFolder, quoteArg, PANEL_LABELS } = require('../lib/open-merge-folder');

function fakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles).map(([key, value]) => [normalize(key), value]));
  const dirs = new Set();
  return {
    files,
    dirs,
    existsSync(filePath) {
      return files.has(normalize(filePath)) || dirs.has(normalize(filePath));
    },
    readFileSync(filePath) {
      const key = normalize(filePath);
      if (!files.has(key)) throw new Error(`missing ${filePath}`);
      return files.get(key);
    },
    writeFileSync(filePath, content) {
      files.set(normalize(filePath), String(content));
    },
    mkdirSync(dirPath) {
      dirs.add(normalize(dirPath));
    },
  };
}

function normalize(filePath) {
  return String(filePath).replace(/\//g, '\\');
}

test('success: opens the folder with quoted path and shell:true', () => {
  const calls = [];
  const repoDir = 'C:\\Users\\Test User\\cloned repo';
  const fsImpl = fakeFs();
  const result = openMergeFolder({
    repoDir,
    fsImpl,
    spawnImpl: (command, options) => {
      calls.push({ command, options });
      return { status: 0 };
    },
  });

  assert.equal(result.opened, true);
  assert.equal(result.launched, true);
  assert.equal(result.path, repoDir);
  assert.equal(result.openedFile, null);
  assert.equal(result.wroteSettings, true);
  assert.equal(result.excludedFromGit, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /^code(\.cmd)? "C:\\Users\\Test User\\cloned repo"$/);
  assert.equal(calls[0].options.shell, true);
});

test('success: opens the folder and first conflicted file when provided', () => {
  const calls = [];
  const repoDir = 'C:\\Users\\Test User\\cloned repo';
  const expectedFile = path.join(repoDir, 'site', 'page.html');
  const result = openMergeFolder({
    repoDir,
    conflictedPaths: ['site\\page.html', 'site\\other.html'],
    fsImpl: fakeFs(),
    spawnImpl: (command, options) => {
      calls.push({ command, options });
      return { status: 0 };
    },
  });

  assert.equal(result.openedFile, expectedFile);
  assert.match(calls[0].command, /^code(\.cmd)? "C:\\Users\\Test User\\cloned repo" "C:\\Users\\Test User\\cloned repo\\site\\page.html"$/);
});

test('success: firstConflictedFile overrides conflictedPaths', () => {
  const calls = [];
  const repoDir = 'C:\\repo';
  const result = openMergeFolder({
    repoDir,
    firstConflictedFile: 'chosen.html',
    conflictedPaths: ['other.html'],
    fsImpl: fakeFs(),
    spawnImpl: (command) => {
      calls.push(command);
      return { status: 0 };
    },
  });

  assert.equal(result.openedFile, path.join(repoDir, 'chosen.html'));
  assert.match(calls[0], /"C:\\repo\\chosen\.html"$/);
});

test('returns panelLabels with Dataverse current and Azure DevOps incoming wording', () => {
  const result = openMergeFolder({
    repoDir: 'C:\\repo',
    fsImpl: fakeFs(),
    spawnImpl: () => ({ status: 0 }),
  });

  assert.deepEqual(result.panelLabels, PANEL_LABELS);
  assert.match(result.panelLabels.current, /Dataverse/);
  assert.match(result.panelLabels.incoming, /Azure DevOps/);
  assert.match(result.panelLabels.base, /Common ancestor/);
});

test('ENOENT throw: returns fallback and does not throw', () => {
  const repoDir = 'C:\\missing-code\\repo';
  const result = openMergeFolder({
    repoDir,
    fsImpl: fakeFs(),
    spawnImpl: () => {
      const err = new Error('spawn code ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });

  assert.equal(result.opened, false);
  assert.equal(result.launched, false);
  assert.equal(result.fallback, true);
  assert.equal(result.path, repoDir);
  assert.equal(result.wroteSettings, true);
  assert.equal(result.excludedFromGit, true);
  assert.match(result.command, /^code(\.cmd)? "C:\\missing-code\\repo"$/);
  assert.match(result.instructions, /Open this folder in VS Code/);
  assert.match(result.instructions, /Source Control view/);
});

test('ENOENT result: returns fallback and does not throw', () => {
  const repoDir = 'C:\\missing-code\\repo';
  const result = openMergeFolder({
    repoDir,
    fsImpl: fakeFs(),
    spawnImpl: () => ({ status: null, error: { code: 'ENOENT' } }),
  });

  assert.equal(result.opened, false);
  assert.equal(result.fallback, true);
  assert.equal(result.path, repoDir);
});

test('nonzero exit: returns fallback', () => {
  const repoDir = 'C:\\repo';
  const result = openMergeFolder({
    repoDir,
    fsImpl: fakeFs(),
    spawnImpl: () => ({ status: 1, stderr: 'not found' }),
  });

  assert.equal(result.opened, false);
  assert.equal(result.fallback, true);
  assert.equal(result.path, repoDir);
});

test('quoteArg quotes a path containing spaces', () => {
  assert.equal(quoteArg('C:\\Users\\Test User\\repo folder'), '"C:\\Users\\Test User\\repo folder"');
});

// ---- Task 1/3: code --merge launcher (Env LEFT / ADO RIGHT) ----
test('Task 1/3: mergeEditor → `code --merge <env> <ado> <base> <result>` (Env left, ADO right) + opens folder', () => {
  const calls = [];
  const repoDir = 'C:\\clone\\repo';
  const mergeEditor = { left: 'C:\\stages\\x\\Dataverse.html', right: 'C:\\stages\\x\\ADO.html', base: 'C:\\stages\\x\\Base.html', result: 'C:\\clone\\repo\\site\\f.html' };
  const result = openMergeFolder({
    repoDir,
    conflictedPaths: ['site\\f.html', 'site\\g.html'],
    mergeEditor,
    fsImpl: fakeFs(),
    spawnImpl: (command, options) => { calls.push(command); return { status: 0 }; },
  });
  assert.equal(result.launched, true);
  assert.equal(result.openedFolder, true);
  // two spawns: open folder, then the merge editor
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^code(\.cmd)? "C:\\clone\\repo"$/); // folder first
  // merge editor: left=env, right=ado, base, result — IN THAT ORDER (Env left, ADO right)
  assert.match(calls[1], /--merge "C:\\stages\\x\\Dataverse\.html" "C:\\stages\\x\\ADO\.html" "C:\\stages\\x\\Base\.html" "C:\\clone\\repo\\site\\f\.html"/);
  assert.match(calls[1], /--reuse-window/);
  assert.equal(result.mergeCommand, calls[1]);
  // panel labels + SCM pointer surfaced
  assert.equal(result.panelLabels.current, PANEL_LABELS.current);
  assert.match(result.scmPointer, /Source Control/);
  assert.match(result.scmPointer, /Dataverse on the LEFT, Azure DevOps on the RIGHT/);
});

test('Task 1: incomplete mergeEditor → falls back to folder + first file (no --merge)', () => {
  const calls = [];
  const repoDir = 'C:\\clone\\repo';
  const result = openMergeFolder({
    repoDir,
    conflictedPaths: ['site\\f.html'],
    mergeEditor: { left: 'x' }, // missing right/base/result
    fsImpl: fakeFs(),
    spawnImpl: (command) => { calls.push(command); return { status: 0 }; },
  });
  assert.equal(result.mergeCommand, null);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /--merge/);
});

test('Task 1: code unavailable with mergeEditor → fallback carries the SCM pointer', () => {
  const repoDir = 'C:\\clone\\repo';
  const result = openMergeFolder({
    repoDir,
    conflictedPaths: ['site\\f.html'],
    mergeEditor: { left: 'a', right: 'b', base: 'c', result: 'd' },
    fsImpl: fakeFs(),
    spawnImpl: () => ({ status: 1, error: { code: 'ENOENT' } }),
  });
  assert.equal(result.fallback, true);
  assert.match(result.scmPointer, /Source Control/);
});
