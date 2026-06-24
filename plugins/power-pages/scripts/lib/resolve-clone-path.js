#!/usr/bin/env node

// Single source of truth for the clone working-tree layout.
//
// The clone lives under a user-chosen, flat cloneDir:
//   <cloneDir>/
//     repo/        full git clone working tree
//     .pp-merge/   local-only run-state and merge artifacts
//
// This module is intentionally pure path logic: no git, no network, no filesystem.

'use strict';

const path = require('path');

/**
 * Returns the canonical sub-directory layout for a clone rooted at cloneDir.
 *
 * @param {string} cloneDir  Absolute path to the flat, user-chosen clone root.
 * @returns {{ cloneDir: string, repoDir: string, ppMergeDir: string }}
 */
function cloneDirLayout(cloneDir) {
  if (!cloneDir) throw new Error('cloneDirLayout: cloneDir is required');
  if (!path.isAbsolute(cloneDir)) throw new Error('cloneDirLayout: cloneDir must be an absolute path');
  return {
    cloneDir,
    repoDir: path.join(cloneDir, 'repo'),
    ppMergeDir: path.join(cloneDir, '.pp-merge'),
  };
}

module.exports = { cloneDirLayout };
