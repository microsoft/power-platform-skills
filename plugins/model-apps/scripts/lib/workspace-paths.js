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

  // 1. Never a UNC/network path. MEASURED: `\\server\share\proj\.maker-workspace` resolves with root
  //    `\\server\share\` and dirname `\\server\share\proj`, so the filesystem-root rules below do NOT
  //    reject it and it reaches `lstatSync` — which BLOCKS on an unreachable share until the SMB
  //    timeout. No try/catch helps a hang, and this cleanup runs immediately after a SUCCESSFUL
  //    teardown, so the operator is left staring at a command that appears wedged for no reason.
  //
  //    Checked FIRST so the refusal names the real problem. `\\server\share\.maker-workspace` would
  //    otherwise be caught by the root rule below and reported as "directly inside a filesystem root"
  //    — true of its UNC root, but it tells the operator nothing about the path they typed.
  //
  //    Refusing is also right on the merits: the workspace is a LOCAL metadata cache by design, and a
  //    recursive delete over SMB is slow and partially-fails in ways a local one does not. The cost is
  //    a stale cache directory the operator can remove by hand — the same trade the rest of this guard
  //    makes. A MAPPED DRIVE (`Z:\…`) is not a UNC path and is unaffected, so the ordinary way of
  //    working from a network location still clears.
  //
  //    `\\?\C:\…` is the extended-length form of a LOCAL path and is allowed; `\\?\UNC\…` is not.
  if (/^\\\\/.test(resolved) && !/^\\\\\?\\[A-Za-z]:\\/.test(resolved)) {
    return {
      ok: false,
      reason: `refusing to delete '${resolved}': it is a UNC/network path, not a local workspace cache `
        + '(a recursive delete there can block on an unreachable share)',
    };
  }

  // 2. Never a filesystem/drive root, and never directly inside one. `C:\\.maker-workspace` or
  //    `/.maker-workspace` is not a project layout; it is what an empty or truncated base path
  //    produces, so treat it as a mistake rather than an instruction.
  const parent = path.dirname(resolved);
  if (resolved === path.parse(resolved).root || parent === resolved) {
    return { ok: false, reason: `refusing to delete '${resolved}': that is a filesystem root` };
  }
  if (parent === path.parse(parent).root) {
    return { ok: false, reason: `refusing to delete '${resolved}': a workspace directly inside a filesystem root is not a project workspace` };
  }

  // 3. The final component must not be a symlink/junction. Deleting through one is how a directory
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

  // 4. Resolve the real path BEFORE the identity test, so a junction in the chain cannot land the
  //    delete somewhere that was never inspected.
  let real;
  try {
    real = realpathSync(resolved);
  } catch (e) {
    return { ok: false, reason: `cannot resolve '${resolved}' (${e.code || e.message})` };
  }

  // 4b. Re-apply the root rules to the CANONICAL target. Adversarial review found the lexical-only
  //     check bypassable: `D:\review-link\project\.maker-workspace` reached through an ancestor
  //     junction resolves to `D:\.maker-workspace`, which passing directly would be refused. The
  //     rules have to hold for the path actually deleted, not merely the one typed.
  const realParent = path.dirname(real);
  if (real === path.parse(real).root || realParent === real || realParent === path.parse(realParent).root) {
    return { ok: false, reason: `refusing to delete '${resolved}': it resolves to '${real}', at or directly inside a filesystem root` };
  }

  // 5. IDENTITY, proven by CONTENT. The directory must carry the SDK's own workspace manifest.
  //
  //    The default NAME is deliberately NOT accepted as an alternative. `--workspace` is
  //    caller-supplied, so `--workspace /some/important/.maker-workspace` would otherwise reach
  //    recursive deletion on nothing more than a matching basename — and a name is not identity.
  //    Refusing costs a stale cache directory the operator can delete by hand; accepting costs
  //    whatever was really in that directory.
  //
  //    This does not reject real workspaces: a live `--workspace <custom-name>` run cleared
  //    successfully through this very check, because a genuine workspace always carries the
  //    manifest. A directory named `.maker-workspace` WITHOUT one is either not a workspace or is
  //    empty enough that leaving it costs nothing.
  if (!looksLikeSdkWorkspace(real, readFileSync)) {
    return {
      ok: false,
      reason: `refusing to delete '${resolved}': it is not an SDK workspace `
        + `(no readable '${WORKSPACE_MANIFEST}' with instanceUrl + artifacts at its root)`,
    };
  }

  return { ok: true, target: real };
}

module.exports = { WORKSPACE_DIR_NAME, WORKSPACE_MANIFEST, looksLikeSdkWorkspace, checkWorkspaceClearable };
