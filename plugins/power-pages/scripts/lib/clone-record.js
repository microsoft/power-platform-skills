#!/usr/bin/env node

// D3/D4: the clone LOCATION record. The clone-based conflict flow needs to know
// WHERE the whole repo was cloned (at git-configure time, to a user-chosen path)
// so git-sync can REUSE it instead of re-deriving a 200+ char cache path or
// re-cloning mid-conflict. The authoritative copy lives in the single local-only
// git-integration manifest (under docs/inner-loop/), as a `clone` block — NOT a
// duplicate top-level file (AGENTS.md rule). The manifest `clone` block is the
// single source of truth for the clone location — no registry or index mirrors it.
//
// `clone` block shape (stamped via artifact-timestamps E1):
//   { path, coordinates: { env, organization, project, repository, rootFolder,
//                          gitFolder, branch, solutionUniqueName },
//     createdAt, updatedAt, lastVerifiedAt }
//
// This module is pure manifest IO + a coordinate-match predicate; no git/network.

'use strict';

const fs = require('fs');
const { gitIntegrationManifestPath } = require('./inner-loop-paths');
const { stamp } = require('./artifact-timestamps');

// The binding fields that identify WHICH clone a solution needs. A change in any
// of these means the stored clone no longer matches (→ git-sync re-prompts D4).
const COORD_FIELDS = Object.freeze([
  'env', 'organization', 'project', 'repository', 'rootFolder', 'gitFolder', 'branch', 'solutionUniqueName',
]);

function readManifest(projectRoot, fsImpl = fs) {
  const p = gitIntegrationManifestPath(projectRoot);
  let raw;
  try { raw = fsImpl.readFileSync(p, 'utf8'); } catch { return {}; }
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

/**
 * Read the `clone` block from the git-integration manifest, or null.
 * @param {object} args { projectRoot, fsImpl? }
 * @returns {object|null}
 */
function readCloneRecord({ projectRoot, fsImpl = fs } = {}) {
  if (!projectRoot) throw new Error('readCloneRecord: projectRoot is required');
  const manifest = readManifest(projectRoot, fsImpl);
  return manifest && manifest.clone ? manifest.clone : null;
}

/**
 * Normalize a binding-ish object into the coordinate subset we match on.
 * Accepts detect-git-binding output (uses `organization`/`project`/`repository`)
 * and tolerates an `env`/`envName` alias.
 */
function toCoordinates(b = {}) {
  const out = {};
  out.env = b.env || b.envName || null;
  out.organization = b.organization || null;
  out.project = b.project || null;
  out.repository = b.repository || null;
  out.rootFolder = b.rootFolder || null;
  out.gitFolder = b.gitFolder || null;
  out.branch = b.branch || null;
  out.solutionUniqueName = b.solutionUniqueName || null;
  return out;
}

/**
 * Write/merge the `clone` block into the manifest, preserving every other key and
 * the block's own createdAt (E1). Sets lastVerifiedAt = now.
 * @param {object} args { projectRoot, clonePath, coordinates, fsImpl?, now? }
 * @returns {object} the written clone block
 */
function writeCloneRecord({ projectRoot, clonePath, coordinates, fsImpl = fs, now } = {}) {
  if (!projectRoot) throw new Error('writeCloneRecord: projectRoot is required');
  if (!clonePath) throw new Error('writeCloneRecord: clonePath is required');
  const p = gitIntegrationManifestPath(projectRoot);
  const manifest = readManifest(projectRoot, fsImpl);
  const prior = manifest.clone || {};
  const nowIso = new Date(now != null ? now : Date.now()).toISOString();
  const block = stamp({
    path: clonePath,
    coordinates: toCoordinates(coordinates || {}),
    lastVerifiedAt: nowIso,
    ...(prior.createdAt ? { createdAt: prior.createdAt } : {}),
  }, { now });
  manifest.clone = block;
  // Ensure the manifest dir exists (it normally does; be defensive).
  try { fsImpl.mkdirSync(require('path').dirname(p), { recursive: true }); } catch (_) { /* best-effort */ }
  fsImpl.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return block;
}

/**
 * Does a stored clone record match the requested binding coordinates? A mismatch
 * (different repo/folder/branch/solution) means git-sync must ask for a path and
 * clone the new repo there (D4).
 * @param {object} record   the stored `clone` block (or its `.coordinates`)
 * @param {object} coordinates  binding-ish object (toCoordinates-able)
 * @returns {boolean}
 */
function cloneMatches(record, coordinates) {
  if (!record) return false;
  const have = record.coordinates || record;
  const want = toCoordinates(coordinates || {});
  return COORD_FIELDS.every((f) => (have[f] || null) === (want[f] || null));
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { projectRoot: null, read: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--projectRoot' && a[i + 1]) o.projectRoot = a[++i];
    else if (a[i] === '--read') o.read = true;
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (!args.projectRoot) { process.stderr.write('clone-record: --projectRoot is required\n'); process.exit(1); }
  const rec = readCloneRecord({ projectRoot: args.projectRoot });
  process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
}

module.exports = { readCloneRecord, writeCloneRecord, cloneMatches, toCoordinates, COORD_FIELDS };
