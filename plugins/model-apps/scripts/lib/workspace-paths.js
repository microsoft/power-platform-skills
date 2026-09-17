'use strict';
// Workspace path identity + the safety guard for destructive workspace cleanup.
//
// The SDK workspace is a LOCAL cache directory (`.maker-workspace`) holding artifact metadata. It
// is safe to delete, and teardown's `--clear-workspace` deletes it after a clean apply because
// stale metadata would make a later rebuild skip tables that no longer exist.
//
// The hazard (#587 item 8): `--workspace <dir>` lets the caller name that directory, and cleanup
// then ran `fs.rmSync(dir, { recursive: true, force: true })` on whatever was passed — no check
// that it was a workspace at all. A mistyped or shell-expanded path (a repo root, a home
// directory, `.`) was therefore recursively deleted on a SUCCESSFUL teardown, which is the moment
// an operator is least expecting data loss.
const path = require('node:path');
const fs = require('node:fs');

// The one place this name is defined. Everything that deletes a workspace must agree with
// everything that creates one, or the guard below rejects a directory the build legitimately made.
const WORKSPACE_DIR_NAME = '.maker-workspace';

// May `--clear-workspace` recursively delete `dir`?
//
// Returns { ok: true, target } with the REAL path to delete, or { ok: false, reason }. Refusing is
// always safe here: the cost is a stale cache directory the operator can remove by hand, against
// the cost of deleting a directory that was never a workspace.
//
// `deps` exists so the rules can be tested without creating symlinks/junctions, which need
// elevation on Windows.
function checkWorkspaceClearable(dir, deps = {}) {
  const lstatSync = deps.lstatSync || fs.lstatSync;
  const realpathSync = deps.realpathSync || fs.realpathSync;

  if (typeof dir !== 'string' || !dir.trim()) return { ok: false, reason: 'no workspace path was given' };
  const resolved = path.resolve(dir);

  // 1. It must LOOK like a workspace. This is the single strongest guard, because a path an
  //    operator typed by mistake — or a shell that expanded a variable to empty — essentially never
  //    ends in `.maker-workspace`.
  if (path.basename(resolved) !== WORKSPACE_DIR_NAME) {
    return { ok: false, reason: `refusing to delete '${resolved}': only a directory named '${WORKSPACE_DIR_NAME}' may be cleared` };
  }

  // 2. Never a filesystem/drive root, and never directly inside one. `C:\.maker-workspace` or
  //    `/.maker-workspace` is not a project layout; it is what an empty or truncated base path
  //    produces, so treat it as a mistake rather than an instruction.
  const parent = path.dirname(resolved);
  if (resolved === path.parse(resolved).root || parent === resolved) {
    return { ok: false, reason: `refusing to delete '${resolved}': that is a filesystem root` };
  }
  if (parent === path.parse(parent).root) {
    return { ok: false, reason: `refusing to delete '${resolved}': a workspace directly inside a filesystem root is not a project workspace` };
  }

  // 3. The final component must not be a symlink/junction. Deleting through one is how a
  //    `.maker-workspace` that merely POINTS at something else (a source tree, a home directory)
  //    turns a cache cleanup into arbitrary data loss. Only the last component is checked, because
  //    a symlinked ANCESTOR is ordinary and legitimate (/tmp is a symlink on macOS), and refusing
  //    those would reject real workspaces.
  let st;
  try {
    st = lstatSync(resolved);
  } catch (e) {
    // Nothing there is not an error for a cleanup step — there is simply nothing to remove.
    return { ok: false, reason: `nothing to clear at '${resolved}' (${e.code || e.message})` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, reason: `refusing to delete '${resolved}': it is a symlink/junction, not a real workspace directory` };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: `refusing to delete '${resolved}': not a directory` };
  }

  // 4. Re-check identity AFTER resolving the real path. A junction in the chain can land the
  //    delete somewhere whose basename is no longer a workspace name; rule 1 would have passed on
  //    the lexical path alone.
  let real;
  try {
    real = realpathSync(resolved);
  } catch (e) {
    return { ok: false, reason: `cannot resolve '${resolved}' (${e.code || e.message})` };
  }
  if (path.basename(real) !== WORKSPACE_DIR_NAME) {
    return { ok: false, reason: `refusing to delete '${resolved}': it resolves to '${real}', which is not a '${WORKSPACE_DIR_NAME}' directory` };
  }

  return { ok: true, target: real };
}

module.exports = { WORKSPACE_DIR_NAME, checkWorkspaceClearable };
