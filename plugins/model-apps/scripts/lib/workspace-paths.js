'use strict';
// Workspace path identity + the safety guard for destructive workspace cleanup.
//
// The SDK workspace is a LOCAL cache directory holding artifact metadata. It is safe to delete, and
// teardown's `--clear-workspace` deletes it after a clean apply because stale metadata would make a
// later rebuild skip tables that no longer exist.
//
// The hazard (#587 item 8): `--workspace <dir>` lets the caller name that directory, and cleanup
// then ran `fs.rmSync(dir, { recursive: true, force: true })` on whatever was passed — no check that
// it was a workspace at all. A mistyped or shell-expanded path (a repo root, a home directory,
// `.`) was therefore recursively deleted on a SUCCESSFUL teardown, which is the moment an operator
// is least expecting data loss.
const path = require('node:path');
const fs = require('node:fs');

// The DEFAULT name, used when `--workspace` is not given. It is NOT an identity test: every CLI here
// accepts `--workspace <any-dir>`, and a live run with `--workspace lvws` proved a name-only guard
// refuses a perfectly real workspace. Identity is established by CONTENT below.
const WORKSPACE_DIR_NAME = '.maker-workspace';

// The SDK writes this at the workspace root. Its shape is the durable marker: `instanceUrl` plus an
// `artifacts` array. Checking the CONTENT rather than just the filename matters — plenty of
// directories contain some `manifest.json`, and deleting one of those would be the original bug
// wearing a different hat.
const WORKSPACE_MANIFEST = 'manifest.json';

function looksLikeSdkWorkspace(dir, readFileSync) {
  let raw;
  try {
    raw = readFileSync(path.join(dir, WORKSPACE_MANIFEST), 'utf8');
  } catch {
    return false; // no manifest => not an SDK workspace
  }
  try {
    const m = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    return !!m && typeof m === 'object' && !Array.isArray(m)
      && typeof m.instanceUrl === 'string' && Array.isArray(m.artifacts);
  } catch {
    return false; // a manifest.json belonging to something else (npm, a bundler, …)
  }
}

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
  const readFileSync = deps.readFileSync || fs.readFileSync;

  if (typeof dir !== 'string' || !dir.trim()) return { ok: false, reason: 'no workspace path was given' };
  const resolved = path.resolve(dir);

  // 1. Never a filesystem/drive root, and never directly inside one. `C:\\.maker-workspace` or
  //    `/.maker-workspace` is not a project layout; it is what an empty or truncated base path
  //    produces, so treat it as a mistake rather than an instruction.
  const parent = path.dirname(resolved);
  if (resolved === path.parse(resolved).root || parent === resolved) {
    return { ok: false, reason: `refusing to delete '${resolved}': that is a filesystem root` };
  }
  if (parent === path.parse(parent).root) {
    return { ok: false, reason: `refusing to delete '${resolved}': a workspace directly inside a filesystem root is not a project workspace` };
  }

  // 2. The final component must not be a symlink/junction. Deleting through one is how a directory
  //    that merely POINTS at something else (a source tree, a home directory) turns a cache cleanup
  //    into arbitrary data loss. Only the last component is checked, because a symlinked ANCESTOR is
  //    ordinary and legitimate (/tmp is a symlink on macOS) and refusing those would reject real
  //    workspaces.
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

  // 3. Resolve the real path BEFORE the identity test, so a junction in the chain cannot land the
  //    delete somewhere that was never inspected.
  let real;
  try {
    real = realpathSync(resolved);
  } catch (e) {
    return { ok: false, reason: `cannot resolve '${resolved}' (${e.code || e.message})` };
  }

  // 3b. Re-apply the root rules to the CANONICAL target. Adversarial review found the lexical-only
  //     check bypassable: `D:\review-link\project\.maker-workspace` reached through an ancestor
  //     junction resolves to `D:\.maker-workspace`, which passing directly would be refused. The
  //     rules have to hold for the path actually deleted, not merely the one typed.
  const realParent = path.dirname(real);
  if (real === path.parse(real).root || realParent === real || realParent === path.parse(realParent).root) {
    return { ok: false, reason: `refusing to delete '${resolved}': it resolves to '${real}', at or directly inside a filesystem root` };
  }

  // 4. IDENTITY. Either the conventional default name, or — for the `--workspace <custom-dir>` case
  //    the CLIs explicitly support — a directory carrying the SDK's own workspace manifest. A
  //    live run with `--workspace lvws` is what proved a name-only rule wrongly refuses a real
  //    workspace; an arbitrary path (repo root, home directory, `.`) still has neither.
  if (path.basename(real) !== WORKSPACE_DIR_NAME && !looksLikeSdkWorkspace(real, readFileSync)) {
    return {
      ok: false,
      reason: `refusing to delete '${resolved}': it is neither named '${WORKSPACE_DIR_NAME}' nor an SDK workspace `
        + `(no readable '${WORKSPACE_MANIFEST}' with instanceUrl + artifacts at its root)`,
    };
  }

  return { ok: true, target: real };
}

module.exports = { WORKSPACE_DIR_NAME, WORKSPACE_MANIFEST, looksLikeSdkWorkspace, checkWorkspaceClearable };
