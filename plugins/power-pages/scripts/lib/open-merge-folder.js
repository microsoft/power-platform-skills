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

// Bug 6: plain-language guidance the skill relays so a maker can always reach the
// one-click Accept controls — and recover when a hunk drops into "Manual Resolution".
const MERGE_EDITOR_TIPS = Object.freeze([
  'Accept a whole side: click the "✓✓ Accept all" icon in a pane header (Incoming = Azure DevOps, Current = Dataverse).',
  'Accept one hunk: hover the conflict block in an input pane to reveal its checkbox, then tick the side you want.',
  'If a hunk went to "Manual Resolution" (one-click options vanished): use the hunk\'s "Reset to base" (or Undo) to restore Accept Current / Accept Incoming / Accept Both.',
  'Last resort: edit the bottom "Result" pane directly — type the exact final text and save.',
  'A file is resolved when no <<<<<<< / ======= / >>>>>>> markers remain and it is saved.',
]);

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
  spawnImpl = spawnSync,
  fsImpl = fs,
} = {}) {
  const codeBin = process.platform === 'win32' ? 'code.cmd' : 'code';
  const openedFile = resolveConflictedFile(repoDir, firstConflict({ firstConflictedFile, conflictedPaths }));
  const excludeResult = ensureVsCodeExcludedFromGit({ repoDir, fsImpl });
  const settingsResult = writeVsCodeMergeSettings({ repoDir, fsImpl });

  // Open the FOLDER (so the Source Control "Merge Changes" list is one click away) AND
  // the first conflicted file. With `git.mergeEditor: true` (written above), opening a
  // conflicted file drops the user straight into VS Code's NATIVE 3-way merge editor —
  // avoiding a blank Explorer/Welcome — and EVERY conflict then uses that same native
  // editor (consistent Incoming/Current labels), not a per-file custom `code --merge`.
  const folderCommand = `${codeBin} ${quoteArg(repoDir)}`;
  const command = `${folderCommand}${openedFile ? ` ${quoteArg(openedFile)}` : ''}`;

  // The native merge editor labels the sides Incoming/Current (VS Code's fixed order:
  // Incoming on the LEFT, Current on the RIGHT). Relay what those map to so the generic
  // labels are never ambiguous — makers resolve by LABEL, not by screen position.
  const scmPointer = `Open Source Control (Ctrl/Cmd+Shift+G) — ${(conflictedPaths || []).length || 'the'} conflicted file(s) are listed under "Merge Changes"; the first is already open. In the 3-way merge editor, "Current" = Dataverse (your environment) and "Incoming" = Azure DevOps — resolve by label, not by which side of the screen it is on.`;

  const launchDetails = {
    command,
    folderCommand,
    openedFile,
    scmPointer,
    wroteSettings: settingsResult.wroteSettings,
    settingsPath: settingsResult.settingsPath,
    excludedFromGit: excludeResult.excludedFromGit,
    excludePath: excludeResult.excludePath,
    // What VS Code's native "Current"/"Incoming" labels map to (resolve by label, not side).
    panelLabels: PANEL_LABELS,
    // Bug 6: relay these so the maker can always reach the Accept controls.
    mergeEditorTips: MERGE_EDITOR_TIPS,
  };

  let result;
  try {
    result = spawnImpl(command, { encoding: 'utf8', shell: true });
  } catch {
    return fallback(repoDir, launchDetails);
  }

  if (!result || result.status !== 0 || (result.error && result.error.code === 'ENOENT')) {
    return fallback(repoDir, launchDetails);
  }

  return { opened: true, launched: true, path: repoDir, ...launchDetails };
}

module.exports = { openMergeFolder, quoteArg, PANEL_LABELS, MERGE_EDITOR_TIPS };
