'use strict';
// Does the SDK's workspace copy of an artifact hold edits the server has not seen?
//
// A push of a copy that equals its last-synced snapshot sends the server the document it already holds — a
// write that costs a few requests (version reads, the PATCH, a read-back) and changes nothing. The reconcile
// paths of the build (an existing view, an existing form) therefore push only when this says there is
// something to send.
//
// Why the SDK's own dirty tracking is the right proof, and a hand-rolled compare is not:
//   * The workspace copy is the SDK's ONE canonical projection of the artifact (no side-channel), and the
//     snapshot is the projection of what the server returned at the last fetch or push. Every edit made
//     through the generic surface (updateElement / addElement / moveElement / removeElement) changes the
//     copy, so "copy equals snapshot" means no edit has been made since the server last held that document.
//   * An edit an interrupted earlier run left in the workspace survives a plain `fetchArtifact` while the
//     server has not moved (the SDK keeps unpushed work rather than silently reverting it). It is in the
//     copy but not in the snapshot, so it is reported here and still gets pushed — a comparison of "what this
//     run computed" against "what was fetched" would miss it.
//   * A copy that was never synced (no snapshot) is a pending creation and reads as changed.
//
// What this does NOT prove: that the server's PUBLISHED layer matches. The snapshot is the unpublished
// layer's document (the SDK reads it with RetrieveUnpublished), so an earlier run that pushed and then
// stopped before publishing leaves a clean copy over an unpublished change. A caller must never skip a
// publish on the strength of this alone.
//
// `diffArtifact` is the SDK's structural diff between the copy and its snapshot — the same deepEqual that
// `isDirty` uses, but addressable for one artifact (`listArtifacts` flags every workspace artifact of a
// type, which a per-artifact decision should not pay for).
//
// FAILS OPEN: an SDK without the method, or a diff that throws (a workspace file that cannot be read), says
// "changed", so the caller writes exactly as it did before this check existed. A skipped write has to be
// proven unnecessary; a doubtful one is made.
async function hasUnsyncedEdits(sdk, type, id) {
  if (!sdk || typeof sdk.diffArtifact !== 'function') return true;
  try {
    const diff = await sdk.diffArtifact(type, id);
    return !(diff && Array.isArray(diff.changes) && diff.changes.length === 0);
  } catch {
    return true;
  }
}

module.exports = { hasUnsyncedEdits };
