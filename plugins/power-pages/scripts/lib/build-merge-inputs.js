#!/usr/bin/env node

// A3: DETERMINISTICALLY compose the clone-merge resolver's inputs from helper
// output — never hand-built. Hand-built inputs caused two live failures:
//   1. the synced commit IDs were omitted → pickBaseCommit fell back to a base
//      that lacked the files → add/add → the merge editor showed whole-file
//      conflicts with no base (see A2);
//   2. string component types ("webtemplate") slipped in → buildPathFromComponentPath
//      returned supported:false → every unit fell to binary → empty merge that
//      DROPPED the environment's edits (see A1).
//
// This module composes inputs from:
//   - detect-git-binding.js  (org/project/repo, branch, rootFolder/gitFolder, and
//                              BOTH synced commit IDs — branch + upstream)
//   - enriched list-conflicts.js rows  (numeric ppcType, eligibility — see A4)
//   - the clone record  (the flat cloneDir, via readCloneRecord / --cloneDir)
// and writes the result to the clone's local-only `.pp-merge/` directory (OUTSIDE
// the git worktree, so the resolver's own `git rm -rf .` can never wipe it — that
// ENOENT'd a prior `--resume`).
//
// Output object shape (consumed by clone-merge-resolver.js):
//   { cloneDir, envUrl, solutionUniqueName, solutionId, user,
//     binding: { organization, project, repository, repositoryId?, branch,
//                rootFolder, gitFolder, baseCommit,
//                branchSyncedCommitId, upstreamBranchSyncedCommitId },
//     conflicts: [ { conflictId, componentId, name, type:<NUMBER>, field, componentPath } ] }
//
// Usage (CLI):
//   node build-merge-inputs.js --binding <binding.json> --conflicts <conflicts.json>
//        [--cloneDir <path>] [--projectRoot <path>] --envUrl <url>
//        --solutionUniqueName <name> [--solutionId <guid>] [--user <name>]
//        [--out <path>]      // default: stdout

'use strict';

const fs = require('fs');
const path = require('path');
const {
  normalizeComponentType, primaryFieldForType, isEligibleForSelectiveMerge,
  stripSerializedSuffix,
} = require('./component-type-map');
const { stamp } = require('./artifact-timestamps');

/**
 * Normalize ONE conflict row (from enriched list-conflicts or a raw roster) into
 * the resolver's conflict shape, guaranteeing a NUMERIC type and a resolved field.
 * Returns null when the type cannot be resolved (caller decides how to surface).
 */
function normalizeConflict(c) {
  // Prefer the already-enriched numeric ppcType; else normalize from type or name.
  const type =
    (c.ppcType != null ? normalizeComponentType(c.ppcType) : null) != null ? normalizeComponentType(c.ppcType)
    : normalizeComponentType(c.type) != null ? normalizeComponentType(c.type)
    : normalizeComponentType(c.componentName || c.name);
  if (type == null) return null;
  const field = c.field || primaryFieldForType(type) || null;
  const name = stripSerializedSuffix(c.name || c.componentName || '');
  return {
    conflictId: c.conflictId || null,
    componentId: c.componentId || null,
    name,
    type,
    field,
    componentPath: c.componentPath || null,
    eligibleForSelectiveMerge: isEligibleForSelectiveMerge(type),
  };
}

/**
 * Compose the full resolver inputs object. Pure (no IO).
 * @param {object} args
 * @param {object} args.binding   detect-git-binding output (or equivalent)
 * @param {object[]} args.conflicts  enriched list-conflicts items (or raw roster)
 * @param {string} args.cloneDir  absolute path to the flat, user-chosen clone directory
 * @param {string} args.envUrl
 * @param {string} args.solutionUniqueName
 * @param {string} [args.solutionId]
 * @param {string} [args.user]
 * @param {string} [args.repositoryId]  optional ADO repo GUID (branch-policy precheck)
 * @returns {{ inputs: object, warnings: string[] }}
 */
function buildMergeInputs({
  binding, conflicts, cloneDir, envUrl,
  solutionUniqueName, solutionId = null, user = 'user', repositoryId = null,
} = {}) {
  if (!binding) throw new Error('buildMergeInputs: binding is required');
  if (!Array.isArray(conflicts)) throw new Error('buildMergeInputs: conflicts must be an array');
  if (!cloneDir) throw new Error('buildMergeInputs: cloneDir is required');

  const warnings = [];
  const normConflicts = [];
  for (const c of conflicts) {
    const n = normalizeConflict(c);
    if (!n) { warnings.push(`Skipped conflict with unresolvable type: ${c.componentName || c.name || JSON.stringify(c)}`); continue; }
    normConflicts.push(n);
  }

  // A3/A2: ALWAYS include BOTH synced commit IDs as base candidates. baseCommit is
  // left null so the resolver's pickBaseCommit chooses (and can auto-discover).
  const branchSyncedCommitId = binding.branchSyncedCommitId || null;
  const upstreamBranchSyncedCommitId = binding.upstreamBranchSyncedCommitId || null;
  if (!branchSyncedCommitId && !upstreamBranchSyncedCommitId) {
    warnings.push('Binding has neither branchSyncedCommitId nor upstreamBranchSyncedCommitId — base auto-discovery from the branch history will be relied upon.');
  }

  const inputs = {
    cloneDir,
    envUrl: envUrl || null,
    solutionUniqueName: solutionUniqueName || binding.solutionUniqueName || null,
    solutionId: solutionId || null,
    user,
    binding: {
      organization: binding.organization || null,
      project: binding.project || null,
      repository: binding.repository || null,
      repositoryId: repositoryId || binding.repositoryId || null,
      branch: binding.branch || null,
      rootFolder: binding.rootFolder || null,
      gitFolder: binding.gitFolder || null,
      baseCommit: binding.baseCommit || null,
      branchSyncedCommitId,
      upstreamBranchSyncedCommitId,
    },
    conflicts: normConflicts,
  };

  return { inputs, warnings };
}

/**
 * Write inputs to the clone's local-only `.pp-merge/` dir (outside the worktree),
 * timestamped (E1). Returns the absolute path written.
 * @param {object} args
 * @param {string} args.ppMergeDir  the clone's sibling .pp-merge directory
 * @param {object} args.inputs      from buildMergeInputs().inputs
 * @param {string} [args.fileName='merge-inputs.json']
 * @param {object} [args.fsImpl=fs]
 * @returns {string} absolute path written
 */
function writeMergeInputs({ ppMergeDir, inputs, fileName = 'merge-inputs.json', fsImpl = fs } = {}) {
  if (!ppMergeDir) throw new Error('writeMergeInputs: ppMergeDir is required');
  if (!inputs) throw new Error('writeMergeInputs: inputs is required');
  fsImpl.mkdirSync(ppMergeDir, { recursive: true });
  const out = path.join(ppMergeDir, fileName);
  fsImpl.writeFileSync(out, JSON.stringify(stamp({ ...inputs }), null, 2), 'utf8');
  return out;
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { binding: null, conflicts: null, cloneDir: null, projectRoot: null, envUrl: null, solutionUniqueName: null, solutionId: null, user: 'user', repositoryId: null, out: null };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (Object.prototype.hasOwnProperty.call(o, k) && a[i + 1]) o[k] = a[++i];
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  try {
    const binding = JSON.parse(fs.readFileSync(args.binding, 'utf8'));
    const conflicts = JSON.parse(fs.readFileSync(args.conflicts, 'utf8'));
    const conflictArr = Array.isArray(conflicts) ? conflicts : (conflicts.items || conflicts.conflicts || []);
    let cloneDir = args.cloneDir;
    if (!cloneDir && args.projectRoot) {
      const { readCloneRecord } = require('./clone-record');
      const rec = readCloneRecord({ projectRoot: args.projectRoot });
      if (rec && rec.path) cloneDir = rec.path;
    }
    const { inputs, warnings } = buildMergeInputs({
      binding, conflicts: conflictArr, cloneDir, envUrl: args.envUrl,
      solutionUniqueName: args.solutionUniqueName, solutionId: args.solutionId, user: args.user, repositoryId: args.repositoryId,
    });
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, JSON.stringify(stamp({ ...inputs }), null, 2), 'utf8');
      process.stdout.write(JSON.stringify({ wrote: args.out, conflicts: inputs.conflicts.length, warnings }, null, 2) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ inputs, warnings }, null, 2) + '\n');
    }
  } catch (e) {
    process.stderr.write('build-merge-inputs: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = { buildMergeInputs, writeMergeInputs, normalizeConflict };
