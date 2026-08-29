'use strict';

/**
 * Reads the per-screen spec for a file out of `native-app-plan.md`.
 *
 * `native-app-plan.md` is the approved source of truth written by the planner.
 * The plan is Markdown, so this is a genuinely lexical contract and stays
 * regex-based even after the behavioral rules moved to the AST analyzer: the
 * only thing parsed here is the plan's own heading/field shape, e.g.
 *
 *   ### Inspections list
 *   - File: app/(app)/inspections/index.tsx
 *   - Pagination: cursor
 *
 * Shared by the semantic cursor-list rule and the legacy regex validator so the
 * plan-lookup semantics cannot drift between them.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Walks up from a file to the nearest directory containing `native-app-plan.md`. */
function findProjectRoot(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  for (let depth = 0; depth < 14; depth += 1) {
    if (fs.existsSync(path.join(dir, 'native-app-plan.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

/** Returns the plan section that mentions `filePath`, or null. */
function findScreenSpec(planText, filePath, projectRoot) {
  const relPath = normalizePath(path.relative(projectRoot, filePath));
  const absPath = normalizePath(path.resolve(filePath));
  const candidates = [absPath, relPath, `./${relPath}`];

  let matchIndex = -1;
  for (const candidate of candidates) {
    matchIndex = normalizePath(planText).indexOf(candidate);
    if (matchIndex >= 0) break;
  }
  if (matchIndex < 0) return null;

  const startMarkers = ['\n### ', '\n#### '];
  let start = -1;
  for (const marker of startMarkers) {
    const idx = planText.lastIndexOf(marker, matchIndex);
    if (idx > start) start = idx;
  }
  if (start < 0) start = 0;

  const nextMajor = planText.indexOf('\n### ', matchIndex + 1);
  const nextMinor = planText.indexOf('\n#### ', matchIndex + 1);
  const ends = [nextMajor, nextMinor].filter((idx) => idx > matchIndex);
  const end = ends.length > 0 ? Math.min(...ends) : planText.length;

  return planText.slice(start, end);
}

function isCursorSpec(spec) {
  if (!spec) return false;
  return /\bPagination\b[\s\S]{0,140}\bcursor\b/i.test(spec);
}

/** Convenience wrapper: resolves the plan and returns the spec for one file. */
function readScreenSpec(filePath) {
  const projectRoot = findProjectRoot(filePath);
  if (!projectRoot) return { projectRoot: null, spec: null };
  let planText = '';
  try {
    planText = fs.readFileSync(path.join(projectRoot, 'native-app-plan.md'), 'utf8');
  } catch {
    return { projectRoot, spec: null };
  }
  return { projectRoot, spec: findScreenSpec(planText, filePath, projectRoot) };
}

module.exports = { findProjectRoot, findScreenSpec, isCursorSpec, readScreenSpec };
