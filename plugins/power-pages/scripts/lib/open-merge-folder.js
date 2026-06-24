#!/usr/bin/env node

// Opens a cloned repository folder in VS Code for Dataverse Git conflict resolution.
//
// Rationale: makers should resolve conflicts with VS Code's native Git Source
// Control view and built-in 3-way merge editor, instead of a custom launcher.
//
// Usage:
//   const { openMergeFolder } = require('./open-merge-folder');
//   openMergeFolder({ repoDir: 'C:\\path\\to\\repo' });

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const {
  writeVsCodeMergeSettings,
  ensureVsCodeExcludedFromGit,
} = require('./vscode-merge-settings');

const PANEL_LABELS = Object.freeze({
  current: 'Dataverse (your environment)',
  incoming: 'Azure DevOps (incoming)',
  base: 'Common ancestor',
});

function quoteArg(p) {
  return `"${String(p).replace(/"/g, '""')}"`;
}

function fallback(repoDir, extras = {}) {
  return {
    opened: false,
    launched: false,
    fallback: true,
    path: repoDir,
    instructions: `Open this folder in VS Code: ${repoDir}  (then use the Source Control view to resolve the conflicts)`,
    ...extras,
  };
}

function firstConflict({ firstConflictedFile, conflictedPaths }) {
  return firstConflictedFile || (Array.isArray(conflictedPaths) && conflictedPaths.length ? conflictedPaths[0] : null);
}

function resolveConflictedFile(repoDir, conflictedFile) {
  if (!conflictedFile) return null;
  const normalized = String(conflictedFile).replace(/^[/\\]+/, '');
  return path.isAbsolute(normalized) ? normalized : path.join(repoDir, normalized);
}

function openMergeFolder({
  repoDir,
  conflictedPaths,
  firstConflictedFile,
  mergeEditor,        // Task 1/3: { left, right, base, result } → `code --merge` with Env-left/ADO-right
  spawnImpl = spawnSync,
  fsImpl = fs,
} = {}) {
  const codeBin = process.platform === 'win32' ? 'code.cmd' : 'code';
  const openedFile = resolveConflictedFile(repoDir, firstConflict({ firstConflictedFile, conflictedPaths }));
  const excludeResult = ensureVsCodeExcludedFromGit({ repoDir, fsImpl });
  const settingsResult = writeVsCodeMergeSettings({ repoDir, fsImpl });

  // Task 1: open the FOLDER (so the Source Control "Merge Changes" list is one click
  // away) AND, when stage files are provided, launch straight into the 3-way MERGE
  // EDITOR for the first conflict via `code --merge`. `code` has no flag to focus the
  // SCM viewlet, so dropping the user directly into the merge editor is the most
  // reliable way to avoid landing on a blank Explorer/Welcome.
  const folderCommand = `${codeBin} ${quoteArg(repoDir)}`;
  const me = mergeEditor && mergeEditor.left && mergeEditor.right && mergeEditor.base && mergeEditor.result ? mergeEditor : null;
  // Task 3: `--merge <left> <right> <base> <result>` → left=Env(Dataverse), right=ADO.
  const mergeCommand = me
    ? `${codeBin} --merge ${quoteArg(me.left)} ${quoteArg(me.right)} ${quoteArg(me.base)} ${quoteArg(me.result)} --reuse-window`
    : null;
  // Without stage files, fall back to opening the first conflicted file in the folder.
  const command = mergeCommand || `${folderCommand}${openedFile ? ` ${quoteArg(openedFile)}` : ''}`;

  const scmPointer = `Open Source Control (Ctrl/Cmd+Shift+G) — ${(conflictedPaths || []).length || 'the'} conflicted file(s) are listed under "Merge Changes". The first conflict opens directly in the 3-way merge editor (Dataverse on the LEFT, Azure DevOps on the RIGHT).`;

  const launchDetails = {
    command,
    folderCommand,
    mergeCommand,
    openedFile,
    mergeEditor: me ? { left: me.left, right: me.right, base: me.base, result: me.result } : null,
    scmPointer,
    wroteSettings: settingsResult.wroteSettings,
    settingsPath: settingsResult.settingsPath,
    excludedFromGit: excludeResult.excludedFromGit,
    excludePath: excludeResult.excludePath,
    // Task 3: Env (Dataverse) LEFT, Azure DevOps RIGHT, base at the bottom — driven by
    // the `--merge <left=env> <right=ado>` argument order, not a git-staging swap.
    panelLabels: PANEL_LABELS,
  };

  // Open the folder first (best-effort), then the merge editor (reuse window).
  let folderResult = null;
  let result;
  try {
    if (me) folderResult = spawnImpl(folderCommand, { encoding: 'utf8', shell: true });
    result = spawnImpl(command, { encoding: 'utf8', shell: true });
  } catch {
    return fallback(repoDir, launchDetails);
  }

  if (!result || result.status !== 0 || (result.error && result.error.code === 'ENOENT')) {
    return fallback(repoDir, launchDetails);
  }

  return { opened: true, launched: true, path: repoDir, openedFolder: !!folderResult, ...launchDetails };
}

module.exports = { openMergeFolder, quoteArg, PANEL_LABELS };
