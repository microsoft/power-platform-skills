#!/usr/bin/env node

// Computes the execution direction for the merged `git-sync` skill.
//
// `git-sync` is one SKILL.md that dispatches the per-cycle inner loop based on
// the current Dataverse Git state (the three counts) AND the user's args:
//
//   • commit          — local Changes pending (Dirty); push env → ADO.
//   • pull            — incoming Updates pending (Stale); pull ADO → env.
//   • both            — Changes AND Updates (Mixed); ordered pull-then-commit
//                       by default (override to commit-then-pull).
//   • conflicts-first — Conflicts present; they GATE both directions and must be
//                       resolved before commit/pull. After resolution each item
//                       re-routes back into Changes or Updates.
//   • clean           — nothing pending; up to date.
//
// Mixed-state ordering default is pull-then-commit (git muscle memory: pull
// before push surfaces conflicts before you push and keeps you current). Never
// auto-execute a mutating direction — the SKILL.md gates plan + consent.
//
// Output:
//   {
//     mode:        "commit" | "pull" | "both" | "conflicts-first" | "clean",
//     ordering:    "pull-then-commit" | "commit-then-pull" | null,
//     requiresConflictFirst: boolean,   // true when conflicts gate the run
//     state:       "Clean" | "Dirty" | "Stale" | "Mixed" | "Conflicted",
//     reason:      "<short prose>",
//     explicitOverride: boolean,        // true when --commit/--pull forced it
//   }
//
// Errors are signalled by throwing — callers wrap in try/catch.

'use strict';

const VALID_MODES = Object.freeze(['commit', 'pull', 'both', 'conflicts-first', 'clean']);

/**
 * Parse a $ARGUMENTS-like array into a small options bag.
 *
 * Accepted forms:
 *   --commit                force the commit direction
 *   --pull                  force the pull direction
 *   --commit-then-pull      override the Mixed ordering
 *   --pull-then-commit      explicit (already the default)
 *   --hard-delete           pull-side DeleteDeletedComponents (passed through)
 *   --dry-run               commit-side pre-flight only (passed through)
 *
 * Unknown flags are ignored (forward-compat).
 *
 * @param {string[]} args
 * @returns {{ forceCommit?: boolean, forcePull?: boolean,
 *             ordering?: 'pull-then-commit'|'commit-then-pull',
 *             hardDelete?: boolean, dryRun?: boolean }}
 */
function parseDirectionArgs(args = []) {
  const out = {};
  if (!Array.isArray(args)) return out;
  for (const a of args) {
    if (typeof a !== 'string') continue;
    if (a === '--commit') out.forceCommit = true;
    else if (a === '--pull') out.forcePull = true;
    else if (a === '--commit-then-pull') out.ordering = 'commit-then-pull';
    else if (a === '--pull-then-commit') out.ordering = 'pull-then-commit';
    else if (a === '--hard-delete') out.hardDelete = true;
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

function classifyState({ changes, updates, conflicts }) {
  if (conflicts > 0) return 'Conflicted';
  if (changes > 0 && updates > 0) return 'Mixed';
  if (changes > 0) return 'Dirty';
  if (updates > 0) return 'Stale';
  return 'Clean';
}

/**
 * @param {object} input
 * @param {{ changes:number, updates:number, conflicts:number }} input.counts
 * @param {string[]} [input.args=[]]
 * @returns {object}
 */
function detectSyncDirection({ counts, args = [] } = {}) {
  if (!counts || typeof counts !== 'object') {
    throw new Error('detectSyncDirection: counts {changes, updates, conflicts} is required.');
  }
  const changes = Number(counts.changes) || 0;
  const updates = Number(counts.updates) || 0;
  const conflicts = Number(counts.conflicts) || 0;
  if (changes < 0 || updates < 0 || conflicts < 0) {
    throw new Error('detectSyncDirection: counts must be non-negative.');
  }

  const opts = parseDirectionArgs(args);
  const state = classifyState({ changes, updates, conflicts });

  // Conflicts gate everything — regardless of explicit direction, they must be
  // resolved first. The SKILL.md re-detects after resolution.
  if (state === 'Conflicted') {
    return {
      mode: 'conflicts-first',
      ordering: null,
      requiresConflictFirst: true,
      state,
      reason: `${conflicts} conflict(s) gate this run — resolve them before commit/pull. Resolved items re-route to Changes/Updates.`,
      explicitOverride: Boolean(opts.forceCommit || opts.forcePull),
    };
  }

  // Explicit direction override (only honoured when not conflicted).
  if (opts.forceCommit && !opts.forcePull) {
    return {
      mode: 'commit', ordering: null, requiresConflictFirst: false, state,
      reason: changes > 0
        ? 'Forced --commit; local Changes will be pushed.'
        : 'Forced --commit but no local Changes pending — nothing to commit.',
      explicitOverride: true,
    };
  }
  if (opts.forcePull && !opts.forceCommit) {
    return {
      mode: 'pull', ordering: null, requiresConflictFirst: false, state,
      reason: updates > 0
        ? 'Forced --pull; incoming Updates will be pulled.'
        : 'Forced --pull but no incoming Updates pending — nothing to pull.',
      explicitOverride: true,
    };
  }

  // Auto-detect from state.
  if (state === 'Clean') {
    return {
      mode: 'clean', ordering: null, requiresConflictFirst: false, state,
      reason: 'No Changes, Updates, or Conflicts — you are up to date.',
      explicitOverride: false,
    };
  }
  if (state === 'Dirty') {
    return {
      mode: 'commit', ordering: null, requiresConflictFirst: false, state,
      reason: `${changes} local change(s) pending — commit to the bound branch.`,
      explicitOverride: false,
    };
  }
  if (state === 'Stale') {
    return {
      mode: 'pull', ordering: null, requiresConflictFirst: false, state,
      reason: `${updates} incoming update(s) pending — pull into the environment.`,
      explicitOverride: false,
    };
  }
  // Mixed.
  const ordering = opts.ordering || 'pull-then-commit';
  return {
    mode: 'both', ordering, requiresConflictFirst: false, state,
    reason: `${changes} local change(s) AND ${updates} incoming update(s) — default ${ordering} (gate the order before proceeding).`,
    explicitOverride: false,
  };
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const out = { counts: { changes: 0, updates: 0, conflicts: 0 }, passthrough: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--changes' && args[i + 1] !== undefined) out.counts.changes = parseInt(args[++i], 10);
    else if (args[i] === '--updates' && args[i + 1] !== undefined) out.counts.updates = parseInt(args[++i], 10);
    else if (args[i] === '--conflicts' && args[i + 1] !== undefined) out.counts.conflicts = parseInt(args[++i], 10);
    else out.passthrough.push(args[i]);
  }
  return out;
}

if (require.main === module) {
  const cli = parseCliArgs(process.argv);
  try {
    const result = detectSyncDirection({ counts: cli.counts, args: cli.passthrough });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (e) {
    process.stderr.write('detect-sync-direction: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = { detectSyncDirection, parseDirectionArgs, classifyState, VALID_MODES };
