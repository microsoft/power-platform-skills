'use strict';

const fs = require('fs');
const path = require('path');

const MERGE_EDITOR_SETTINGS = Object.freeze({
  'git.mergeEditor': true,
  'mergeEditor.showBase': true,
  'mergeEditor.showBaseAtTop': false,
});

const VSCODE_EXCLUDE_LINE = '/.vscode/';

function readJsonOrBackup({ settingsPath, fsImpl }) {
  if (!fsImpl.existsSync(settingsPath)) return {};

  const raw = fsImpl.readFileSync(settingsPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    fsImpl.writeFileSync(`${settingsPath}.bak`, raw, 'utf8');
    return {};
  }
}

function writeVsCodeMergeSettings({ repoDir, fsImpl = fs } = {}) {
  const vscodeDir = path.join(repoDir, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');

  fsImpl.mkdirSync(vscodeDir, { recursive: true });
  const existing = readJsonOrBackup({ settingsPath, fsImpl });
  const merged = { ...existing, ...MERGE_EDITOR_SETTINGS };
  fsImpl.writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  return { wroteSettings: true, settingsPath, settings: merged };
}

function ensureVsCodeExcludedFromGit({ repoDir, fsImpl = fs } = {}) {
  const excludePath = path.join(repoDir, '.git', 'info', 'exclude');
  const excludeDir = path.dirname(excludePath);

  fsImpl.mkdirSync(excludeDir, { recursive: true });
  const existing = fsImpl.existsSync(excludePath) ? fsImpl.readFileSync(excludePath, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  if (lines.includes(VSCODE_EXCLUDE_LINE)) {
    return { excludedFromGit: true, excludePath };
  }

  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fsImpl.writeFileSync(excludePath, `${existing}${prefix}${VSCODE_EXCLUDE_LINE}\n`, 'utf8');
  return { excludedFromGit: true, excludePath };
}

module.exports = {
  MERGE_EDITOR_SETTINGS,
  VSCODE_EXCLUDE_LINE,
  writeVsCodeMergeSettings,
  ensureVsCodeExcludedFromGit,
};
