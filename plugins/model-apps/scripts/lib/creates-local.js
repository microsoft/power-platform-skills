'use strict';
// The local half of a stable create: what the SDK's workspace already holds at a derived id, and whether a build may continue
// from it. Read-only: nothing here fetches, overwrites, deletes, reapplies or pushes.
//
// The state is read only through the SDK's public surface — `listArtifacts(type)` (a summary per local artifact, with `isDirty`)
// and `diffArtifact(type, id)`, both local reads that send no request:
//   { artifactType: 'chart', artifactId: '<id>', changes: [] }                                          synced, clean (or nothing local)
//   { …, changes: [{ pointer: '', type: 'added', newValue: { id: '<id>', … } }] }                        a pending create (no baseline)
//   { …, changes: [{ pointer: '', type: 'removed', oldValue: { … } }] }                                  a baseline without its artifact
//   { …, changes: [{ pointer: '/name', type: 'changed', oldValue: 'A', newValue: 'B' }, …] }             synced, with edits not pushed
// No summary and an empty diff is a fresh workspace for this id. Anything else (a summary whose diff is a root removal, a root change
// next to others, a malformed answer) is inconsistent and stops — the build never guesses at a workspace it cannot read.
//
// WHY A STOP AND NOT A REPAIR. A diff says that the local copy differs from the server's, never who made the difference: an
// earlier run's edit that was never sent, or a maker's own. An earlier design fetched the server's copy over a dirty one, wrote the
// declaration back and then compared — and by then an authored edit outside the declaration was already gone, so the identical
// re-run had nothing left to protect. Here every state but a clean one stops before anything touches the copy, so the bytes stay
// exactly as the maker left them and the same run, run again, stops again. The maker keeps what should stay by putting it in the
// spec, then refreshes the local copy on purpose. There is no overwrite approval that skips this check.

const { createStop } = require('./creates-identity.js');

// The refusal category the build already uses for a local copy that differs from the server's (sdk-build.js refuseUnsentCopy).
const UNSENT_EDITS = 'workspace-copy-unsent-edits';

const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/^\{|\}$/g, '').toLowerCase() === b.replace(/^\{|\}$/g, '').toLowerCase();

/**
 * What the workspace holds at `id`: { state: 'fresh' } | { state: 'synced', dirty, changes } | { state: 'pending', draft } |
 * { state: 'orphaned', why }. A workspace it cannot read consistently throws create-completion-required.
 */
async function readLocalCreateState(sdk, type, id) {
  const stop = (why) => createStop('create-completion-required', `${type} ${id}: the local workspace is in a state the build cannot continue from (${why}); nothing was changed`, { create: { kind: type, id } });
  const summaries = await sdk.listArtifacts(type);
  if (!Array.isArray(summaries)) throw stop('the local list is not a list');
  const listed = summaries.filter((s) => s && sameId(s.id, id));
  if (listed.length > 1) throw stop('the id is listed twice');
  const diff = await sdk.diffArtifact(type, id);
  if (!diff || !Array.isArray(diff.changes)) throw stop('the local difference could not be read');
  const roots = diff.changes.filter((c) => c && c.pointer === '');
  if (roots.length && (roots.length !== 1 || diff.changes.length !== 1)) throw stop('the local difference mixes a whole-artifact change with others');
  const root = roots[0];
  if (!listed.length) {
    if (!diff.changes.length) return { state: 'fresh' };
    if (root && root.type === 'removed') return { state: 'orphaned', why: 'a synced baseline remains without its artifact' };
    throw stop('there are changes for an artifact the workspace does not list');
  }
  if (root) {
    if (root.type === 'added' && root.newValue && typeof root.newValue === 'object' && sameId(root.newValue.id, id)) {
      return { state: 'pending', draft: root.newValue };
    }
    throw stop(`the artifact's whole-artifact change is '${root.type}'`);
  }
  return { state: 'synced', dirty: diff.changes.length > 0 || listed[0].isDirty === true, changes: diff.changes };
}

/**
 * Whether a stable create may continue from the workspace at `id`. Answers { state: 'fresh' | 'synced' } for a copy the build may
 * fetch into and plan over: nothing local, or a synced copy with no edit. Every other state throws create-completion-required
 * (category workspace-copy-unsent-edits) and leaves the copy untouched:
 *   synced with any edit — inside or outside what the spec declares — or `isDirty` with an empty diff;
 *   a pending local create (a draft at this id the server never acknowledged);
 *   an orphaned baseline, a malformed or unreadable workspace.
 */
async function assertCleanContinuation(sdk, type, id) {
  const stop = (found) => {
    const err = createStop('create-completion-required', `the local copy of the ${type} ${id} in the workspace ${found}, so the build stopped before it fetched over, reapplied or pushed it; the local copy was kept exactly as it is and nothing was written. Put any change you want to keep into the spec, then refresh the local copy of this ${type}. Running the build again without that stops here again`, { create: { kind: type, id } });
    err.category = UNSENT_EDITS;
    return err;
  };
  if (!sdk || typeof sdk.listArtifacts !== 'function' || typeof sdk.diffArtifact !== 'function') throw stop('could not be compared with the server\'s (the SDK cannot list or compare local copies)');
  let local;
  try {
    local = await readLocalCreateState(sdk, type, id);
  } catch (err) {
    throw stop(`could not be read consistently (${(err && err.message) || err})`);
  }
  if (local.state === 'fresh') return { state: 'fresh' };
  if (local.state === 'synced' && !local.dirty) return { state: 'synced' };
  if (local.state === 'synced') {
    const at = (local.changes || []).map((c) => c && c.pointer).filter((p) => typeof p === 'string' && p).slice(0, 4);
    throw stop(at.length ? `holds edits the server has not seen (${at.join(', ')})` : 'is marked as edited and the server has not seen the edit');
  }
  if (local.state === 'pending') throw stop('holds a local create the server never acknowledged');
  throw stop(`cannot be continued from (${local.why || local.state})`);
}

module.exports = { readLocalCreateState, assertCleanContinuation, UNSENT_EDITS };
