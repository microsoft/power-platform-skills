#!/usr/bin/env node

// Detects Git merge/conflict state in a cloned worktree for the Power Pages
// clone-based conflict resolver.

'use strict';

const fs = require('fs');
const path = require('path');
const defaultGit = require('./git-exec');

const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function hasConflictMarkers(text) {
  return /^<<<<<<< /m.test(String(text || ''));
}

function normalizeRosterPath(filePath) {
  return String(filePath || '').replace(/^[\\/]+/, '');
}

function parsePorcelainPath(line) {
  const raw = line.slice(3);
  const renameSeparator = ' -> ';
  const renameIndex = raw.indexOf(renameSeparator);
  return normalizeRosterPath(renameIndex >= 0 ? raw.slice(renameIndex + renameSeparator.length) : raw);
}

function parseUnmergedPaths(stdout) {
  const paths = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const code = line.slice(0, 2);
    if (UNMERGED_CODES.has(code)) paths.push(parsePorcelainPath(line));
  }
  return paths;
}

function hasMergeHeadFile(repoDir, fsImpl) {
  try {
    return fsImpl.existsSync(path.join(repoDir, '.git', 'MERGE_HEAD'));
  } catch (_e) {
    return false;
  }
}

function hasMergeHeadViaGit(repoDir, gitImpl, opts) {
  if (!gitImpl || typeof gitImpl.runGit !== 'function') return false;
  const result = gitImpl.runGit({
    ...opts,
    cwd: repoDir,
    args: ['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
  });
  return Boolean(result && result.ok);
}

function readMarkerFiles({ repoDir, paths, fsImpl }) {
  const markerFiles = [];
  for (const filePath of paths) {
    const normalized = normalizeRosterPath(filePath);
    try {
      const content = fsImpl.readFileSync(path.join(repoDir, normalized), 'utf8');
      if (hasConflictMarkers(content)) markerFiles.push(normalized);
    } catch (_e) {
      // Missing/unreadable files are not marker-positive; Git status remains authoritative.
    }
  }
  return markerFiles;
}

function detectMergeState({
  repoDir,
  gitImpl = defaultGit,
  fsImpl = fs,
  candidatePaths = null,
  ...gitOpts
} = {}) {
  if (!repoDir) throw new Error('detectMergeState: repoDir is required.');

  const statusResult = gitImpl.status({ ...gitOpts, cwd: repoDir });
  const unmergedPaths = parseUnmergedPaths(statusResult && statusResult.stdout);
  const inProgressMerge = hasMergeHeadFile(repoDir, fsImpl) || hasMergeHeadViaGit(repoDir, gitImpl, gitOpts);
  const markerCandidates = Array.isArray(candidatePaths) ? candidatePaths : unmergedPaths;
  const markerFiles = readMarkerFiles({ repoDir, paths: markerCandidates, fsImpl });

  return {
    inProgressMerge,
    unmergedPaths,
    markerFiles,
    clean: !inProgressMerge && unmergedPaths.length === 0 && markerFiles.length === 0,
  };
}

function matchesRoster({ unmergedPaths, expectedPaths } = {}) {
  const current = new Set((unmergedPaths || []).map(normalizeRosterPath));
  const expected = new Set((expectedPaths || []).map(normalizeRosterPath));
  const missing = [...expected].filter((filePath) => !current.has(filePath)).sort();
  const extra = [...current].filter((filePath) => !expected.has(filePath)).sort();
  return {
    matches: missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
}

module.exports = {
  hasConflictMarkers,
  detectMergeState,
  matchesRoster,
};
