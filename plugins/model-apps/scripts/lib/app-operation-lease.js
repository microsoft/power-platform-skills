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
//   app-pages.<sha256 of the lower-cased app unique name>.lock    the pages phase, keyed without regard to case
//   pages-<the app unique name, unsafe characters as _>.lock     the pages phase, as every earlier release spells it
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
function takeLockFile(dir, file, { owner = {}, now = Date.now, stamp }) {
  const lockPath = path.join(dir, file);
  assertPlainFileTarget(lockPath);
  assertPlainFileTarget(`${lockPath}.reclaim`);
  return acquireLease(dir, {
    file,
    now,
    stamp: stamp || ownerStamp({ ...owner, now }),
    // Stale only when the process that took the lock is PROVEN gone (process-owner.js): a lock whose owner runs, or cannot be judged — another
    // machine, another pid namespace, a record that is missing or damaged, a lock of a release that recorded only { pid, at } — is never stale,
    // however old it is.
    isStale: (held) => ownerState(held, owner).state === 'gone',
  });
}

// Releases a lock this process holds, and says so when it cannot confirm that it did. Owner-checked: the file is removed only while it still holds
// this holder's exact token, and a lock that holds another token now — a build that took it over after this one was judged gone — is that build's,
// and is left without a word. A removal that cannot be confirmed (the file still holds the token when read back, or cannot be read at all: an
// unreadable lock is not a removed one) is a warning, never an error: the work the lock guarded has already finished, so this must not turn a
// finished build into a failure. A later build takes the lock over once this process is gone.
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
  if (!confirmed && typeof warn === 'function') {
    warn(`could not confirm removal of the ${kind} lock for '${appUnique}': ${handle.path}. This run has finished; keep the workspace and its recovery records. If a later run still stops here, confirm no build is running before removing only this lock.`);
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
// two files are one owner), and also when the second file then refuses and the first is let go again: the take-over did happen. Cross-machine or
// cross-worktree concurrency for the SAME app is UNSUPPORTED. `deps` = seams: now, warn, and owner (the process-owner.js seams).
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
    sayTakenOver(lease);
  }
  return { release: letGo };
}

module.exports = {
  acquireAppPagesLease,
  canonicalPagesLockName,
  legacyPagesLockName,
  // For the build lease (below the pages one in every build) and for tests.
  canonicalAppOf,
  takeLockFile,
  releaseLockFile,
};
