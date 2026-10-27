'use strict';
// The local leases that keep two builds of ONE app in ONE workspace from writing at the same time.
//
// WHY. A build discovers what an environment has and then creates what is missing: the app's generated icon is looked up by name and created
// when the lookup finds nothing, and so are the app, the authored web resources, the views, the forms and the pages. Two builds of the same app
// that overlap both see "missing" and both create — measured over the real bundle: two lookups, two icon creates, two icons added to the
// solution. Only a lock held around the whole read-then-create stops that; the platform's own uniqueness answers are not a lock.
//
// WHAT IS LOCKED, AND BY WHICH FILE. Every lock is a file in the workspace folder, taken through the snapshot lease's protocol
// (lib/apply-snapshot-store.js acquireLease: an exclusive create picks one holder, a `.reclaim` claim lets exactly one of several reclaimers win,
// a release removes only a file that still holds its own token) and stamped and judged by lib/process-owner.js: a lock is taken over ONLY from a
// process that is PROVEN gone, never because it is old — a live build can be paused for as long as a laptop sleeps.
//
//   app-build.<sha256 of the lower-cased app unique name>.lock    one whole apply of the app (withAppBuildLease)
//   app-pages.<sha256 of the lower-cased app unique name>.lock    the pages phase, keyed without regard to case
//   pages-<the app unique name, unsafe characters as _>.lock     the pages phase, as every earlier release spells it
//
// The build lock is held for one complete apply: from before the CLI's auth check, through every phase, the automatic re-runs of a transient
// halt and their waits, the settlement of what a halted run owes, the inline verify, the journal and the SDK's cleanup, to the baseline and the
// snapshot the run persists — and let go only when all of that has settled. A second apply of the same app in the same workspace is refused at
// once (`build-locked`), before it opens the SDK's workspace, the journal or the snapshot, or sends any request. The pages files are taken inside
// it, by the pages phase, as before: a build of an earlier release takes no build lock, so the legacy pages file is the only thing that still keeps
// it and a build of this one apart.
//
// The page-publish record already compares app names without regard to case (lib/page-publish-records.js), so `Contoso_App` and `contoso_app`
// share one record; the pages lock did not, and on a case-sensitive file system the two spellings took two locks. The hashed name fixes that. It
// is a different name from the legacy one on every file system: a lower-cased `pages-contoso_app.lock` would be the SAME file as
// `pages-Contoso_App.lock` on Windows and on a default macOS volume, and a build would then refuse its own lock. The legacy name is still taken,
// byte for byte, because a build of an earlier release takes only that one: holding it keeps the two releases out of each other's pages phase when
// they spell the app the same way. A different spelling across releases on a case-sensitive file system is not covered (the earlier release cannot
// see the hashed file), and no scan of other spellings can cover it: an old build can start under an unseen spelling right after the scan.
//
// Nothing here talks to Dataverse, stores a token, an environment, a spec or a name in a lock, or waits: a held lock is refused at once.
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./hash.js');
const { assertSafeOutputDir, assertPlainFileTarget } = require('./safe-fs.js');
const { acquireLease } = require('./apply-snapshot-store.js');
const { ownerStamp, ownerState, describeOwner } = require('./process-owner.js');
const { BuildHalt } = require('./entity-provision.js');
const { RETRY } = require('./retry-policy.js');

// The one lower-casing the page-publish record uses for an app's name (page-publish-records.js: `String(name || '').toLowerCase()`), nothing more
// — no trimming, no Unicode normalization — so the lock and the record agree on which spellings are one app. Hashed so that any name, whatever its
// characters, makes a file name that is safe and of one length.
const canonicalAppOf = (rawApp) => String(rawApp || '').toLowerCase();
const appHashOf = (rawApp) => sha256(canonicalAppOf(rawApp));

// The file names, all inside the workspace folder. The legacy one is the earlier releases' exactly (`String(appUnique).replace(...)`): a build
// of one of them and a build of this one must name the same file when they spell the app the same way.
const buildLockName = (rawApp) => `app-build.${appHashOf(rawApp)}.lock`;
const canonicalPagesLockName = (rawApp) => `app-pages.${appHashOf(rawApp)}.lock`;
const legacyPagesLockName = (rawApp) => `pages-${String(rawApp).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`;

// What a refused take-over adds to a refusal: the lock's owner is gone, but the lock could not be taken (another build was taking it over at the
// same moment, or died doing so).
const unreleasedNote = (lease) => (lease.stale ? ` The build that held it is no longer running, but its lock could not be released: ${lease.reason}.` : '');

// Takes ONE lock file `file` in the folder `dir`. Answers acquireLease's result: { ok: true, path, token, reclaimed?, previous? }, or
// { ok: false, reason, stale?, error? }.
//
// The lock and its claim file are looked at first, with the plugin's one check for a planted link (lib/safe-fs.js): a symbolic link, a junction,
// a hard link or a folder at either name is refused, not followed — a reclaim writes the lock and a release deletes it, and either would then land
// on whatever the link points at. A missing name is what a free lock is. These checks are of names, between operations; they are no defense
// against a hostile process that swaps a name for a link in between.
//
// A name that is being deleted is a lock in use, and is refused as one (Windows only; see beingDeleted below): another build is releasing the lock or
// finishing a take-over at this very moment, which is a build that holds it or has just held it. A create that fails with EPERM is that refusal only
// while the name is still there being deleted; one whose name is not there is tried once more — the deletion may have finished in between — and a
// second such failure is the error it is (a folder that cannot be written), as it always was.
function takeLockFile(dir, file, { owner = {}, now = Date.now, stamp }) {
  const lockPath = path.join(dir, file);
  const beingRemoved = { ok: false, reason: 'the lock is being removed by another build at this moment' };
  for (let attempt = 1; ; attempt += 1) {
    if (inspectLockName(lockPath) || inspectLockName(`${lockPath}.reclaim`)) return beingRemoved;
    const lease = acquireLease(dir, {
      file,
      now,
      stamp: stamp || ownerStamp({ ...owner, now }),
      // Stale only when the process that took the lock is PROVEN gone (process-owner.js): a lock whose owner runs, or cannot be judged — another
      // machine, another pid namespace, a record that is missing or damaged, a lock of a release that recorded only { pid, at } — is never stale,
      // however old it is.
      isStale: (held) => ownerState(held, owner).state === 'gone',
    });
    if (process.platform !== 'win32' || lease.ok || !lease.error || lease.error.code !== 'EPERM') return lease;
    if (beingDeleted(lockPath)) return beingRemoved;
    if (attempt >= 2) return lease;
  }
}

// On Windows a file deleted while another process has it open — a build reading the lock to judge its owner, a scanner — keeps its name until that
// handle closes ("delete pending"), unless the delete asks for POSIX semantics, which libuv does only from 1.48 (Node 22): https://github.com/libuv/libuv/issues/3839,
// https://github.com/libuv/libuv/pull/4318. Under an older libuv (Node 20) every lstat and every create of that name meanwhile fails with EPERM
// (STATUS_DELETE_PENDING reaches Node as ERROR_ACCESS_DENIED), and a build that lost a race for the lock used to stop with a file-safety error or a raw
// EPERM instead of the refusal it is. EPERM cannot say WHY the name is refused: a file this user may not even look at answers it too. Either way the
// name exists and cannot be used, so refusing changes nothing but the words; nothing is written or followed. Never true on Linux or macOS, where a
// delete removes the name at once and these paths are as they were.
function beingDeleted(name) {
  if (process.platform !== 'win32') return false;
  try {
    fs.lstatSync(name);
    return false;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

// The planted-link check of one lock name (assertPlainFileTarget), which answers true when the name could not be inspected because it is being
// deleted (above), and throws what the check throws otherwise: a link, a junction, a hard link or a folder at the name is refused exactly as before.
// The answer is read from the lstat the check itself made — through its `fs` seam — and not from a second look, which could find the deletion
// finished and then let the check's error through after all.
function inspectLockName(name) {
  if (process.platform !== 'win32') {
    assertPlainFileTarget(name);
    return false;
  }
  let firstLook = null;
  const watched = Object.create(fs);
  watched.lstatSync = (...args) => {
    try {
      return fs.lstatSync(...args);
    } catch (e) {
      if (!firstLook) firstLook = e;
      throw e;
    }
  };
  try {
    assertPlainFileTarget(name, { fs: watched });
    return false;
  } catch (e) {
    if (e && e.code === 'UNSAFE_OUTPUT' && e.reason === 'uninspectable' && firstLook && firstLook.code === 'EPERM') return true;
    throw e;
  }
}

// Releases a lock this process holds, and says so when it cannot confirm that it did. Owner-checked: the file is removed only while it still holds
// this holder's exact token, and a lock that holds another token now — a build that took it over after this one was judged gone — is that build's,
// and is left without a word. A removal that cannot be confirmed (the file still holds the token when read back, or cannot be read at all: an
// unreadable lock is not a removed one) is a warning, never an error: the work the lock guarded has already finished, so this must not turn a
// finished build into a failure. A later build takes the lock over once this process is gone. Never throws (sayAfterRelease).
function releaseLockFile(handle, { warn, kind, appUnique }) {
  if (!handle || !handle.path || !handle.token) return;
  let confirmed = false;
  try {
    const held = fs.readFileSync(handle.path, 'utf8');
    if (held !== handle.token) return;
    fs.rmSync(handle.path, { force: true });
    try {
      confirmed = fs.readFileSync(handle.path, 'utf8') !== handle.token;
    } catch (e) {
      confirmed = !!e && e.code === 'ENOENT';
    }
  } catch (e) {
    confirmed = !!e && e.code === 'ENOENT';
  }
  if (!confirmed) {
    sayAfterRelease(warn, `could not confirm removal of the ${kind} lock for '${appUnique}': ${handle.path}. This run has finished; keep the workspace and its recovery records. If a later run still stops here, confirm no build is running before removing only this lock.`);
  }
}

// A warning given while locks are let go, through the caller's `warn`. The release is done by then, and by the rule above it must not change what
// the build answers — so a callback that throws (a logger that is gone, a pipe that closed) is not let out of here either: it would replace the
// build's own result or error, and stop the release of the files still held after this one. The warning is lost; no lock is.
function sayAfterRelease(warn, message) {
  if (typeof warn !== 'function') return;
  try {
    warn(message);
  } catch {
    // Deliberately nothing: see above.
  }
}

// Whose lock a take-over replaced, as one key: the process (pid, machine, kind of system, pid namespace, start), not the moment or the random part
// of its token. The two pages files of one build carry one owner, and a take-over of both is said once.
const ownerKeyOf = (held) => JSON.stringify([held && held.pid, held && held.host, held && held.platform, held && held.ns, held && held.start]);

// The pages refusal, in the words it has always had (a person and the skills read them). `blocking` is the file that refused: the hashed one for two
// builds of this release, the legacy one for a build of an earlier release that spells the app the same way. "Stale" in the sentence means what the
// take-over means by it — the owner is proven gone — and never that the lock is old.
function pagesLocked(appUnique, blocking, lease) {
  // `retry: NEVER`: the lock belongs to a build that is still running, or to one that is gone but whose lock could not be released — running the
  // earlier phases again releases neither — and the message quotes the lock's path, which holds the maker's folder.
  return new BuildHalt(`another build is deploying pages for '${appUnique}' — refusing a second concurrent pages deploy (would risk duplicate page creation). Retry after it finishes, or delete ${blocking} if it is stale.${unreleasedNote(lease)}`, { phase: 'pages', code: 'pages-locked', recoverable: true, retry: RETRY.NEVER });
}

// SINGLE-MACHINE advisory lock over the pages phase (design §9: a courtesy, not a cross-machine guarantee): it stops two LOCAL builds of the same app
// racing to CREATE duplicate pages, while correctness rests on the convergence spine (fail-closed enumeration, create-absent-first, persist after
// each create) that makes any re-run idempotent. Takes, in this order, the hashed pages lock and then the legacy one, and answers { release() },
// which lets go of the legacy one and then the hashed one.
//
// A lock that is held refuses at once (`pages-locked`, the file that refused named), and so does one whose owner is gone but that could not be
// taken over. Nothing is waited for, so taking the two files in a fixed order cannot deadlock a build of this release against an earlier one,
// which takes only the second. When the second file refuses, the first is let go again before the refusal is thrown: a phase never runs on half
// of its locks, and no lock is kept while waiting for another. A create that failed for another reason than the lock being there (a workspace
// that cannot be written) is that error, as it always was.
//
// A build killed outright (SIGKILL, "End task", an agent's timeout, a power cut) cannot release its locks, and used to leave every later build
// stopped on them until a person deleted the file. A later build now takes such a lock over itself when the process that took it is PROVABLY gone
// (lib/process-owner.js), and every doubt keeps it: a pid that still runs, a lock made on another machine, platform or pid namespace, one with no
// readable record — none is ever taken by age. The take-over is said through `deps.warn` — once for each build the locks belonged to (one build's
// two files are one owner), and also when the second file then refuses and the first is let go again: the take-over did happen. A `warn` that throws
// while it says so rolls the acquire back like a refusal and its error is thrown; one that throws while the files are let go is not let out
// (sayAfterRelease). Cross-machine or cross-worktree concurrency for the SAME app is UNSUPPORTED. `deps` = seams: now, warn, and owner (the
// process-owner.js seams).
function acquireAppPagesLease(wsDir, appUnique, deps = {}) {
  const now = deps.now || (() => Date.now());
  const owner = deps.owner || {};
  // The folder itself is checked as every place the plugin writes into a folder it was named: a link or a file at its name is refused, a missing
  // one is made. A linked ANCESTOR is the maker's own choice and is followed (lib/safe-fs.js).
  assertSafeOutputDir(wsDir, { create: true });
  const stamp = ownerStamp({ ...owner, now });
  const held = [];
  const said = new Set();
  const sayTakenOver = (lease) => {
    if (!lease.reclaimed || typeof deps.warn !== 'function') return;
    const key = ownerKeyOf(lease.previous);
    if (said.has(key)) return;
    said.add(key);
    deps.warn(`released the pages lock for '${appUnique}': the build that held it (${describeOwner(lease.previous)}) is no longer running`);
  };
  const letGo = () => {
    for (const lease of held.splice(0).reverse()) releaseLockFile(lease, { warn: deps.warn, kind: 'pages', appUnique });
  };
  for (const file of [canonicalPagesLockName(appUnique), legacyPagesLockName(appUnique)]) {
    let lease;
    try {
      lease = takeLockFile(wsDir, file, { owner, now, stamp });
    } catch (e) {
      letGo();
      throw e;
    }
    if (!lease.ok) {
      letGo();
      if (lease.error) throw lease.error;
      throw pagesLocked(appUnique, path.join(wsDir, file), lease);
    }
    held.push(lease);
    // The caller's `warn` runs only once the file is in `held`, inside the same rollback as a refusal: a callback that throws lets go of every file
    // this call took — rather than leave them stamped with this process, which is alive, so no later build could take them over — and its error is
    // what the caller gets, as for any acquire that failed.
    try {
      sayTakenOver(lease);
    } catch (e) {
      letGo();
      throw e;
    }
  }
  return { release: letGo };
}

// ---------------------------------------------------------------------------------------------------------------------
// The build lease: one whole apply of one app in one workspace
// ---------------------------------------------------------------------------------------------------------------------

// The workspace an apply leases when its caller named none: the app folder's `.maker-workspace`, as the CLI makes it beside app-spec.json and as
// the pages phase has always found it. Every applying entry resolves it through this one function, so the lease a caller holds and the lease its
// callee looks for name the same folder.
const applyWorkspaceOf = (opts = {}) => opts.workspaceDir || path.join(path.resolve(opts.appDir || '.'), '.maker-workspace');

// The capabilities this process has handed out, each the proof that a lease is held: an empty frozen object that only withAppBuildLease makes,
// recognised by identity here. Not JSON, not a flag, not an environment variable, not a pid — a callee borrows a lease only when its caller hands it
// the very object, so two independent applies in one process still compete like two processes do (sharing a pid is not owning a lease).
const capabilities = new WeakMap();

// `retry: NEVER` for both refusals below: running the build's phases again cannot release another build's lease or make a capability valid, and a
// refusal quotes the lock's path, which holds the maker's folder — the retry rule must never read its words. `recoverable` is the operator's: a
// later run of the same command can proceed once the other build has finished. It never authorizes the build's own automatic re-run.
function buildLocked(appUnique, lockPath, lease) {
  return new BuildHalt(`another build may be applying '${appUnique}' in this workspace — refusing a second concurrent apply (would risk duplicate creation). Re-run the same command after it finishes. If no build using this workspace is running, inspect ${lockPath} and remove it only if it is abandoned; keep the workspace and its recovery records.${unreleasedNote(lease)}`, { phase: 'preflight', code: 'build-locked', recoverable: true, retry: RETRY.NEVER });
}
function buildLeaseInvalid() {
  return new BuildHalt('the supplied build lease is not active for this app and workspace — refusing to apply without its own lease', { phase: 'preflight', code: 'build-lease-invalid', recoverable: false, retry: RETRY.NEVER });
}

// Runs `operation(buildLease)` while this process holds the build lease of the app `appUniqueName` (the raw name sdk-build.js appUniqueName gives)
// in the workspace `workspaceDir`, and answers what it answered, or throws what it threw — after the lease is let go.
//
// `buildLease` is how a nested apply BORROWS its caller's lease instead of taking one of its own (the CLI hands it to buildModelApp, which hands it to
// every attempt of runSdkBuild; the changed-only flow hands it to its builds): it must be a capability this function made, still active, for the same
// workspace folder (compared as the real path safe-fs resolves it, so two spellings of one folder are one) and the same app (without regard to case). A
// borrower runs the operation and releases nothing. Anything else — a string, a capability already released, one for another app or folder — is
// refused (`build-lease-invalid`): an apply never runs without a lease of its own or a valid borrowed one.
//
// Without a `buildLease` the lease is TAKEN: a held lock refuses at once (`build-locked`); there is no wait, no age limit and no flag that skips it.
// A lock whose owner is PROVEN gone is taken over, and `warn` says so; one whose owner is gone but that could not be taken over adds why. A create
// that failed for another reason than the lock being there (a folder that cannot be written) is that error. The lease is let go only when
// `operation` has settled — every request it awaited has answered — never by a timer, a signal handler or an exit hook that could fire while a
// write is still in flight; a release that cannot confirm the lock is gone says so through `warn` and does not change the result. The release is
// guarded from the moment the lock is ours: a `warn` that throws while it says the take-over lets the lock go, and its error is thrown (the
// operation does not run); one that throws while the lock is let go is not let out (sayAfterRelease).
// `owner` and `now` are the process-owner.js seams, for tests.
async function withAppBuildLease({ workspaceDir, appUniqueName, buildLease, warn, owner, now }, operation) {
  // A link or a file at the workspace's name is refused, a missing one is made (lib/safe-fs.js), and the answer is the folder's real path: what a
  // borrower's folder is compared with.
  const root = assertSafeOutputDir(workspaceDir, { create: true });
  const app = canonicalAppOf(appUniqueName);
  if (buildLease !== undefined && buildLease !== null) {
    const held = typeof buildLease === 'object' ? capabilities.get(buildLease) : undefined;
    if (!held || !held.active || held.root !== root || held.app !== app) throw buildLeaseInvalid();
    return operation(buildLease);
  }
  const file = buildLockName(appUniqueName);
  const lease = takeLockFile(workspaceDir, file, { owner, now: now || Date.now });
  if (!lease.ok) {
    if (lease.error) throw lease.error;
    throw buildLocked(appUniqueName, path.join(workspaceDir, file), lease);
  }
  const capability = Object.freeze({});
  const record = { root, app, active: true };
  capabilities.set(capability, record);
  try {
    // Inside the guard: the caller's `warn` is the first thing outside this module that runs once the lock is ours, and a callback that throws must
    // not leave the lock stamped with this process, which is alive — no later build could take it over.
    if (lease.reclaimed && typeof warn === 'function') {
      warn(`released the build lock for '${appUniqueName}': the build that held it (${describeOwner(lease.previous)}) is no longer running`);
    }
    return await operation(capability);
  } finally {
    record.active = false;
    releaseLockFile(lease, { warn, kind: 'build', appUnique: appUniqueName });
  }
}

module.exports = {
  withAppBuildLease,
  applyWorkspaceOf,
  acquireAppPagesLease,
  buildLockName,
  canonicalPagesLockName,
  legacyPagesLockName,
  // For tests.
  canonicalAppOf,
  takeLockFile,
  releaseLockFile,
};
