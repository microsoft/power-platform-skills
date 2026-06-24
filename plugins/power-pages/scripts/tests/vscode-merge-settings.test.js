'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  MERGE_EDITOR_SETTINGS,
  ensureVsCodeExcludedFromGit,
  writeVsCodeMergeSettings,
} = require('../lib/vscode-merge-settings');

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

test('writeVsCodeMergeSettings writes merge editor settings', () => {
  const repoDir = 'C:\\repo';
  const fsImpl = fakeFs();
  const result = writeVsCodeMergeSettings({ repoDir, fsImpl });
  const settings = JSON.parse(fsImpl.files.get(normalize(path.join(repoDir, '.vscode', 'settings.json'))));

  assert.equal(result.wroteSettings, true);
  assert.deepEqual(settings, MERGE_EDITOR_SETTINGS);
});

test('writeVsCodeMergeSettings merges with existing settings without clobbering unrelated keys', () => {
  const repoDir = 'C:\\repo';
  const settingsPath = path.join(repoDir, '.vscode', 'settings.json');
  const fsImpl = fakeFs({
    [settingsPath]: JSON.stringify({ 'editor.tabSize': 2, 'git.mergeEditor': false }),
  });

  writeVsCodeMergeSettings({ repoDir, fsImpl });
  const settings = JSON.parse(fsImpl.files.get(normalize(settingsPath)));

  assert.equal(settings['editor.tabSize'], 2);
  assert.equal(settings['git.mergeEditor'], true);
  assert.equal(settings['mergeEditor.showBase'], true);
  assert.equal(settings['mergeEditor.showBaseAtTop'], false);
});

test('writeVsCodeMergeSettings handles invalid existing JSON without throwing and preserves a backup', () => {
  const repoDir = 'C:\\repo';
  const settingsPath = path.join(repoDir, '.vscode', 'settings.json');
  const fsImpl = fakeFs({ [settingsPath]: '{ invalid json' });

  assert.doesNotThrow(() => writeVsCodeMergeSettings({ repoDir, fsImpl }));
  assert.equal(fsImpl.files.get(normalize(`${settingsPath}.bak`)), '{ invalid json');
  assert.deepEqual(JSON.parse(fsImpl.files.get(normalize(settingsPath))), MERGE_EDITOR_SETTINGS);
});

test('ensureVsCodeExcludedFromGit appends /.vscode/ exactly once', () => {
  const repoDir = 'C:\\repo';
  const excludePath = path.join(repoDir, '.git', 'info', 'exclude');
  const fsImpl = fakeFs({ [excludePath]: '# local excludes\n' });

  ensureVsCodeExcludedFromGit({ repoDir, fsImpl });
  ensureVsCodeExcludedFromGit({ repoDir, fsImpl });

  const exclude = fsImpl.files.get(normalize(excludePath));
  assert.equal((exclude.match(/^\/\.vscode\/$/gm) || []).length, 1);
  assert.match(exclude, /^# local excludes\n\/\.vscode\/\n$/);
});
