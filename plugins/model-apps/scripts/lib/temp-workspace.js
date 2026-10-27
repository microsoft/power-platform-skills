'use strict';
// The one place the plugin makes a throwaway workspace folder — and the sweep that removes the ones a killed run left behind.
//
// WHY. Every script that needs the SDK without keeping what it reads makes a folder in the OS temp directory (the SDK's storage has to be somewhere)
// and removes it in a `finally`. A run that is killed outright — SIGKILL, "End task", an agent's timeout — never reaches its `finally`, and nothing
// else would ever remove the folder: the page backend's holds the source of every page the run read, and every SDK workspace holds the address of
// the environment (manifest.json).
//
// WHAT THIS DOES
//   * The folders are made together in one folder of the plugin's own — `<temp>/power-platform-skills-model-apps` (with `-<uid>` after it where the temp
//     folder is shared between users) — never loose in the temp folder. A developer's temp folder can hold hundreds of thousands of entries, and
//     looking for the plugin's leftovers there would mean reading all of them; in its own folder the plugin reads only its own.
//   * Each folder holds an owner record, `.owner.json` (lib/process-owner.js): the process that made it, on which machine.
//   * The first workspace a process makes sweeps that folder first (sweepDeadWorkspaces): a workspace whose owner is PROVABLY gone is removed, and
//     the run says so on stderr. Everything else is left exactly as it is — a workspace of a run that may still be going, one with no readable record
//     (made by an earlier release, or damaged), one from another machine, anything that is not a folder.
//   * When the process ends — by itself, by `process.exit` or by an error nothing catches: the `exit` event — the workspaces it made and did not lend that are still there are removed, and then the plugin's folder, if nothing is
//     left in it, so a run leaves the temp folder as it found it. A run that is cut short never reached the `finally` that removes its workspace, and it held the source of every page the run read (THE END OF A RUN, below,
//     says why this cannot take what another run is using, and why a POSIX signal is not one of these ends).
//
// IT CHANGES NOTHING ELSE. A caller that gets the folder here does what it did with `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`: it passes the folder to
// the SDK and removes it, with `fs.rmSync`, when it is done — and the end of the process does it for a caller that never got there. The plugin's own folder is OPTIONAL: if it cannot be used — it is not ours alone, it is a link, the disk
// says no, or it exists and will not take a new folder (mode 0500, a Windows access list that denies it) — the folder is made in the temp directory exactly as before,
// unrecorded and never swept, and an error is reported only if that fails too. This is a courtesy to the next run, never a reason for one to fail.
// Folders made by an earlier release are loose in the temp folder with no record, and stay where they are.
//
// WHO IS TRUSTED TO HAVE MADE THE FOLDER. On POSIX the plugin's folder must be a plain folder this user owns and nobody else can write to (uid and mode). Windows gives Node
// no owner and no permissions, so an access list stands in (lib/windows-folder-acl.js): a folder this process MAKES is given an explicit, protected one before anything is put in it — only this
// user, the system and the administrators, full control, inherited by every workspace and record made inside — and read back, and a folder that cannot be made so is removed and not used;
// an EXISTING folder is used only if it is this user's (or the administrators') and NO entry of its list, an inherit-only one too, lets anyone else add to it, write to it, delete it
// or take it over. The answer is asked once per folder and process (but a "no" about a folder another run made moments ago, and has not yet given its own list, is asked again: checkParent). A folder that Windows is still removing — the last handle on it has not closed — refuses a new
// entry and cannot be read for a moment: the attempt is made again after short pauses, and one that is still refusing after the last is not used (WAITS_MS).
//
// A RUN HOLDS THE FOLDER WHILE IT JUDGES IT (Windows). Asking whether a folder that is there is private starts three programs (lib/windows-folder-acl.js) and takes about a second — more on a busy machine —
// and the answer is about the folder that was asked about (its file id). Every run that ends with nothing left in the plugin's folder removes it (THE END OF A RUN, below), so while one run was being told about the
// folder, another that ended took it away and a third made it again: the answer was about a folder that was no longer there, the run asked again about the new one, and that was replaced in its turn. With several
// runs starting and ending at once — an agent runs scripts side by side, a test suite runs dozens — the answers kept coming too late, and a run that had asked MAKE_ATTEMPTS times made its workspace in the plain
// temp folder, unrecorded and never swept (measured on one machine: about one run in twenty with three at a time, one in three with twelve; no folder refused an entry). So a run HOLDS the folder from the moment
// it has made or found it until its workspace is in it: an empty file of its own, `.hold-<machine>-<pid>-<6 hex>`, which the `rmdir` of a run that ends refuses to remove (ENOTEMPTY), as it refuses a workspace. The folder
// cannot go while it is judged, so the answer is about the folder the workspace is then made in. The hold is made after the access list of a folder this run made is set (nothing is put in a folder before that),
// and only in a plain folder (not through a link). It holds nothing, and is removed before makeTempWorkspace returns, whatever happened — on success only once the workspace is recorded, since its
// removal can wait on a scanner and a run killed in that wait must leave a workspace that a sweep can take; a hold that cannot be made leaves the run as it was without one (a full
// disk, a folder that takes no file), and one a run was killed while holding is removed by a later sweep once that run's pid is gone, so that the folder can go when it is empty. A pid means something only on
// the machine that gave it out, and a temp folder can be shared between machines (a network share, a profile that roams), so a hold names its machine — eight hex digits of a hash of the host name, the host
// an owner record names (lib/process-owner.js) — and a sweep takes only a hold of its own machine: one of another machine stays, and so does every hold when a sweep cannot read its own host name. On POSIX the question is one
// lstat, answered before anything could change: nothing is held, and a sweep there takes nothing for a hold (a file of that shape is an entry like any other, as it always was).
//
// A WORKSPACE LENT TO ANOTHER PROGRAM (`makeTempWorkspace(prefix, { lent: true })`). A path inside a workspace is sometimes given to a program of another make — pac, writing its settings file into the
// scratch folder of solution-settings.js. That program is not the run: on POSIX it outlives a run that is killed (SIGKILL, an agent's timeout), and a sweep that takes the folder because
// the run is gone would remove it from under a program that is still writing in it. Nothing here follows such a program — a record that is changed after the program has started can be
// unreadable at that moment, and a program that no record names is a folder that is taken — so the run says so ONCE, when it makes the folder, and the record is written ONCE, whole, with
// the word `lent` in it. A lent workspace is never taken because its maker is gone, however surely that is shown: it is taken only when it is OLD — neither the folder nor its record has
// been written to for LENT_KEEP_MS, seven days, far past any program of ours (pac gets an hour at most) — and its maker is gone as well. A workspace that nothing lends is exactly as before.
//
// WHY THE SWEEP CANNOT REMOVE A LIVE RUN'S WORKSPACE
//   * It lists the plugin's folder once, and judges each entry on its own record; a workspace made after the listing is not in it. A name is never
//     made twice (mkdtemp picks it at random), so an entry cannot be replaced by another run's between the judgement and the removal.
//   * A folder is named after the process that made it — `genpage-4242-AbC123`: the prefix, the pid, mkdtemp's six random characters (a prefix that does not end in a hyphen is given one, `work` is
//     `work-4242-AbC123`, so that the pid always follows the hyphen a sweep reads it from) — so that a sweep can
//     tell a run that is still going WITHOUT opening anything in its folder. That matters on Windows, where a file that is deleted while another process
//     has it open stays in its folder until that process lets go: a sweep that read the record of a live run at the moment the run removed its workspace
//     made the run's own removal fail (ENOTEMPTY — measured, on Node 20), and a run's removal is not retried by every caller. A folder whose name does not
//     name a pid, or names one that runs, is not opened; the one exception is Linux, where a file can always be deleted while it is open and the record's start
//     time can show that a pid was handed out again.
//   * Just before it removes an entry it reads the record again, and judges again, and takes the entry only if both are as they were.
//   * It removes what is inside first and the record last, and the record leaves the folder only for as long as the folder itself is being removed (it is moved back if that
//     fails — and if even that fails it stays beside the folder, whole, for the next sweep to finish the removal from; it is never WRITTEN into the folder again, because a write can be cut off), so a removal that fails — half way, or at the very end —
//     leaves a folder that is still recorded: still found, and still swept, by the next run, rather than
//     one that nothing can prove is dead. (Windows keeps a file that is deleted while another process holds it open, and lists it, until the holder lets go — Node 20 does; Node 22
//     deletes it at once — and the folder cannot be removed meanwhile. A removal that consumed the record with the rest left an empty folder that no later sweep could ever
//     tell from a stranger's. If the record itself is the file that is held open, it is renamed out of the folder, which Windows allows, rather than deleted.)
//   * The record is moved out of the folder to `<folder>.removing`, beside it, and the folder removed. A sweep that is killed between those two steps leaves an empty folder and that
//     file, and the next sweep FINISHES the removal — when the file is a record of the folder's own (its name, a record that names the pid in it, an owner that is gone) and the folder
//     is empty or already gone. Anything that does not agree is left exactly as it is.
//   * It never removes the plugin's folder itself: another run may be making a workspace in it that moment. (The end of a process takes the folder with `rmdir`, which takes it only when it is empty: THE END OF A RUN, below.)
//
// THE END OF A RUN. The `exit` event — it runs when the event loop empties, on `process.exit` and on an error nothing catches — removes, synchronously and in this order,
//   1. the workspaces this process made here and did not lend (makeTempWorkspace remembers them), by the steps a sweep takes a dead run's (removeWorkspace: what is inside first, the record last, so that a removal that fails —
//      Windows holds a file — leaves a folder that is still recorded, and that a later run's sweep takes). A LENT workspace is not one of them: the program it was lent to may still be writing in it, and a lent workspace is taken
//      only when it is old (LENT_KEEP_MS), by a sweep;
//   2. the plugin's folder, with `rmdir`.
// A caller that lends a workspace removes it itself, in a cleanup it registers for the end of the process (lib/exit-cleanup.js; solution-settings.js does), and that cleanup runs AFTER this listener, which found the lent workspace
// in the plugin's folder and so left the folder. The cleanup therefore calls `pruneWorkspaceParents()` once its workspace is gone: the same `rmdir` of the plugin's folder, which takes it only when it is empty, so nothing that is not
// the run's own is ever taken, and nothing is removed recursively. (A signal ends a POSIX process with no `exit` event at all; the cleanup that exit-cleanup.js runs for it, and this call, are then all that takes the folder.)
// Why neither takes what another run is using, or is about to use:
//   * A workspace of this process is named for its pid and six random characters, so no other run makes, opens or removes it. A sweep never opens a folder whose pid runs (on Linux it reads its record, and a run that is going
//     is "alive" there), and this process runs until the last listener of its `exit` event has returned.
//   * `rmdir` removes a folder only if it is empty, in one step. Another run's workspace in the plugin's folder — one that is there, or one `mkdtemp` is making that moment, which creates its entry in one step — makes it refuse
//     (ENOTEMPTY), and the folder stays; so does the hold of a run that is judging the folder (Windows: A RUN HOLDS THE FOLDER, above). A run that has made the folder and not yet its workspace in it has an empty folder for a moment, and CAN lose it: its `mkdtemp` then fails with ENOENT, which makeTempWorkspace answers by
//     making the folder again (MAKE_ATTEMPTS times), and on Windows a folder that is being removed refuses for a moment instead, which it answers by waiting (WAITS_MS). So no run fails for it; the cost is one more mkdir.
//   * The workspaces go first, so that the folder is looked at after this process has taken what is its own out of it.
// What is NOT covered is a POSIX signal. The default action of SIGINT, SIGTERM and SIGHUP ends the process at once, and the `exit` event never runs: what the run left stays for the next run's sweep, and the folder goes with the next
// run that ends with nothing in it. Covering it takes a listener in every script that makes a workspace, and a listener REPLACES the default action: a process that is blocked in a synchronous call (`az` or `pac` run to its end, a pause
// for a Windows lock) no longer ends when it is signalled, but when the call returns; the listener must end the process itself, by raising the signal again so that its status stays a signal's; and a script with a handler of its own
// must keep the decision. lib/exit-cleanup.js does all of that, and is used where the leftover holds values a person has not shared (solution-settings.js: the lent folder of pac, while pac runs). What a workspace leaves is a few
// kilobytes until the next run's sweep, which is not worth changing how every script of the plugin ends when it is signalled. SIGKILL and "End task" run nothing, whatever is listened for.
//
// A SWEEP IS BOUNDED, AND FAIR. It looks at no more than MAX_EXAMINED entries and removes no more than MAX_REMOVED, so a folder that has somehow collected thousands is worked off over several runs and not in the time of one. If the
// entries it looked at were always the first ones, a folder whose first MAX_EXAMINED must be kept — folders no record vouches for, a record that cannot be read for a moment — would hide every entry after them for good: a dead run's
// workspace, and a removal that a kill left half done, among them. So the entries are taken in name order, and a sweep that could not look at all of them writes down the name of the last it looked at (CURSOR_FILE: a small file in the plugin's
// folder, written whole, there only while the folder holds more than a sweep looks at); the next sweep — in this process or a later one — starts after that name and wraps round to the first. Every entry is looked at within
// ceil(entries / MAX_EXAMINED) sweeps, whatever the first of them are. The cursor says where to start and nothing else: it cannot make a sweep take what it would not have taken, one that is missing, unreadable or not what was written
// starts at the first entry, and the name in it is only ever compared with the names in the folder.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ownerStamp, ownerState, isOwnerStamp, probeProcess } = require('./process-owner.js');
const { windowsFolderIsPrivate, makeWindowsFolderPrivate } = require('./windows-folder-acl.js');

const PARENT_NAME = 'power-platform-skills-model-apps';
const OWNER_FILE = '.owner.json';
// What a removal in progress leaves beside the folder (see removeWorkspace): the folder's record, moved out of it.
const REMOVING_SUFFIX = '.removing';
// Where a sweep that could not look at every entry writes down the last it looked at (see the top of this file, and windowOf). Its name cannot be a workspace's (those end in `-<pid>-<six characters>`) or a removal's
// (`.removing`), so no sweep takes it for either. `isCursorName` is that name, and the shape of the temporary copy it is written through (writeWhole): `.sweep-cursor.json.<pid>.<random>.tmp` — what a sweep
// that was killed while it wrote the cursor leaves. Nothing else is the sweep's own: a file or a folder that only looks like these is an entry like any other, and is never removed.
const CURSOR_FILE = '.sweep-cursor.json';
const isCursorName = (name) => name === CURSOR_FILE || (name.startsWith(`${CURSOR_FILE}.`) && /^\.\d+\.[a-z0-9]*\.tmp$/.test(name.slice(CURSOR_FILE.length)));
// What a run puts in the plugin's folder while it judges it (Windows: A RUN HOLDS THE FOLDER, at the top of this file): an empty FILE named for the machine and the run — `.hold-1f2e3d4c-4242-a1b2c3`: the
// machine (machineOf), the pid and six hex digits — so a sweep can tell, from the name alone, whether the run that made it is gone. A workspace is a folder and a removal ends in `.removing`, so neither is
// ever taken for a hold.
const HOLD_PREFIX = '.hold-';
const HOLD_NAME = /^\.hold-([0-9a-f]{8})-\d{1,10}-[0-9a-f]{6}$/;
const isHoldName = (name) => HOLD_NAME.test(name);
// The machine a host name is, as a hold's name says it: eight hex digits of its SHA-256. A hash and not the name, since a host name is not a safe part of a file name everywhere; it is only ever
// compared, never read back. Null for a host name that could not be read: no machine can be told from it.
const machineOf = (host) => (typeof host === 'string' && host !== '' ? crypto.createHash('sha256').update(host).digest('hex').slice(0, 8) : null);
// What a prefix may be: a name, never a path. A prefix that is not one would put the folder outside the plugin's own.
const SAFE_PREFIX = /^[A-Za-z0-9._-]+$/;
// A record, or the cursor, is a few hundred bytes at most. One that is much larger is not one.
const OWNER_FILE_MAX_BYTES = 4096;
// How old a LENT workspace must be before a sweep takes it (and only then, and only if its maker is gone): seven days without anything written in the folder or to its record. pac is given an
// hour for an import (lib/pac-fallback.js PAC_IMPORT_TIMEOUT_MS) and three minutes for a read, so this is two orders of magnitude past the longest program of ours — the one place a time
// decides anything here, and it errs long on purpose: a folder that stays costs a few kilobytes, a folder taken from a program that still writes in it costs its work.
const LENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// The most one sweep looks at, and removes: a plugin's folder that has somehow collected thousands of entries is worked off over several runs, not in
// the time of one — and which entries a sweep looks at moves on from one sweep to the next, so that no entry is out of reach for good (see the top of this file).
const MAX_EXAMINED = 500;
const MAX_REMOVED = 100;
// How often a workspace is made again after the plugin's folder gave a reason to ask again (see makeTempWorkspace), and how long it waits between: ENOENT is asked again at once, a
// refusal that a folder being removed gives (below) after a pause, the pauses growing to the longest a measured run needed (Windows keeps such a folder for tens of milliseconds, a
// loaded machine for a few hundred).
const WAITS_MS = [25, 50, 100, 200, 400];
const MAKE_ATTEMPTS = WAITS_MS.length + 1;

const uidOf = (deps) => (deps.uid !== undefined ? deps.uid : (typeof process.getuid === 'function' ? process.getuid() : null));

// Windows removes a folder in two steps: the folder is marked for deletion, and it goes when the last handle on it is closed. In between it refuses a new entry — `mkdir` answers
// EPERM, measured with four runs starting and ending at once, each ending run removing the plugin's folder if it was the last to leave it — and cannot be opened to say who may change it.
// A run that meets a folder in that state would otherwise make its workspace in the temp folder, unrecorded, so that a kill would leave it for good. It asks again after a short pause, as
// lib/safe-fs.js does for a rename that a scanner holds (the same codes, the same kind of waits), and a folder that is
// still refusing then is not used. Only where there are no owners to compare (Windows): elsewhere EPERM and EACCES are the answers they sound like. The same three codes are what a scanner that is
// holding a file that was just made gives for its rename (writeWhole).
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pauseSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const windowsRefusesForAMoment = (e, deps) => uidOf(deps) === null && !!e && TRANSIENT_CODES.has(e.code);
// The code of the failure of a folder that this process made and could not make private (Windows): the folder is not used, and not tried again by this process (`refusing`, below).
const NOT_PRIVATE = 'ENOTPRIVATE';
// The code of a "no" about a folder that may yet be made private by the run that made it (Windows: checkParent): the attempt is made again after a pause, and a folder that is still saying it after the last is not used for
// this workspace — but it is not refused for the life of the process either, as a folder that is not private by anyone's choice is.
const NOT_YET_PRIVATE = 'ENOTYETPRIVATE';
// How long after it was made a folder whose access list is still all it took from the one above may be one that its maker has not yet given a list of its own: the maker's icacls is given 10 s
// (lib/windows-folder-acl.js), and a maker whose icacls did not answer in that time removes the folder. Measured: about 200 ms on average, and up to about a second on a busy machine.
const PROTECT_WINDOW_MS = 15000;

// The folder the plugin keeps its workspaces in, for the temp folder `deps.os` (the real one) names. Windows gives each user a temp folder of their
// own (GetTempPath reads TMP, TEMP, then the profile: https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-gettemppatha), and so does
// macOS; Linux's `/tmp` is shared by everyone on the machine, so the user id goes into the name — one user cannot make, or leave, the folder another
// user's runs would then work in.
function workspaceParent(deps = {}) {
  const uid = uidOf(deps);
  return path.join((deps.os || os).tmpdir(), uid === null ? PARENT_NAME : `${PARENT_NAME}-${uid}`);
}

// The plugin's folder is trusted only when it is a plain folder — not a link someone put there to point the plugin's removals elsewhere — and, where
// the system has owners, ours alone: nobody else can add or rename an entry in it. On Windows, which has none to compare, its access list says who can change it and who owns it
// (lib/windows-folder-acl.js). Throws when it is not.
//
// That is read once per folder and process, whatever the answer (the cache below): a run that makes a workspace for each of forty dashboards would otherwise start three programs
// forty times. The key names the folder itself — its place, device, file id and creation time — so a folder that is removed and made again by someone else is judged again.
// The one "no" that is not remembered is one that may be about to change: a folder that another run made moments ago takes the access list of the temp folder it is in until that run's icacls
// gives it one of its own (ensureParent), and where the temp folder lets others write — `TEMP` on a data drive gives Authenticated Users "modify" — a run that judges it in between is told
// "not private" about a folder that is private a moment later, with the same identity. Remembered, that "no" sent every later workspace of the run to the plain temp folder, unrecorded, for the
// rest of its life (measured: about one run in sixty, eight at a time, each making six). So a "no" about a list that is still only inherited (`inherited`, lib/windows-folder-acl.js), about a
// folder made within PROTECT_WINDOW_MS, is not remembered: it is asked again after a pause (makeTempWorkspace). A "no" about a list somebody set, or about an older folder, is final, as before.
// `created`: this call made the folder, gave it an access list of its own and read it back (ensureParent): it is not asked about again.
// `deps.folderPrivacy` is a test seam for the Windows reader.
const privacyVerdicts = new Map();
const identityOf = (parent, st) => `${parent}|${st.dev}|${st.ino}|${st.birthtimeMs}`;
function checkParent(parent, deps, { created = false } = {}) {
  const fsx = deps.fs || fs;
  const st = fsx.lstatSync(parent);
  if (!st.isDirectory()) throw new Error(`${parent} is not a folder`);
  const uid = uidOf(deps);
  if (uid !== null) {
    if (st.uid !== uid || (st.mode & 0o022) !== 0) throw new Error(`${parent} is not ours alone`);
    return;
  }
  const key = identityOf(parent, st);
  if (!privacyVerdicts.has(key)) {
    const answer = created ? { ok: true } : (deps.folderPrivacy || windowsFolderIsPrivate)(parent);
    if (!created) {
      // The answer is about the folder that was there when it was asked, and counts only if that is the folder that is there now. A folder that was removed while it was being judged — by
      // a run that ended with nothing left in it (prune) — has no answer (ENOENT, which the caller takes as "make it again"), and neither has one that was removed and made again by
      // another run meanwhile: "no" from either would send the run that asked to the plain temp folder, unrecorded, for the sake of a folder that is not there.
      const now = fsx.lstatSync(parent);
      if (identityOf(parent, now) !== key) throw Object.assign(new Error(`${parent} was replaced while it was being judged`), { code: 'ENOENT' });
    }
    // A list that could not be got at all (the folder is being removed, most likely) is no answer either, and is not remembered: it is a refusal of the kind a folder being removed
    // gives, and the caller asks again after a pause.
    if (answer.unreadable) throw Object.assign(new Error(`${parent} could not be judged: ${answer.reason}`), { code: 'EBUSY' });
    if (!answer.ok && answer.inherited === true && Math.abs(clockOf(deps)() - st.birthtimeMs) < PROTECT_WINDOW_MS) {
      throw Object.assign(new Error(`${parent} can be changed by others, for now: ${answer.reason}`), { code: NOT_YET_PRIVATE });
    }
    privacyVerdicts.set(key, answer);
  }
  const verdict = privacyVerdicts.get(key);
  if (!verdict.ok) throw new Error(`${parent} can be changed by others: ${verdict.reason}`);
}

// Makes the plugin's folder, or finds it, and judges it — holding it meanwhile where judging takes long (Windows: A RUN HOLDS THE FOLDER, at the top of this file). Answers the hold, which the caller releases
// once its workspace is in the folder (null when nothing is held); a folder that is refused throws, with the hold already released.
function ensureParent(parent, deps, stamp) {
  const fsx = deps.fs || fs;
  // Not `recursive`: a temp folder that is not there is the failure it always was (ENOENT, from the plain call this falls back to), not a folder this makes.
  let created = false;
  try {
    fsx.mkdirSync(parent, { mode: 0o700 });
    created = true;
  } catch (e) {
    if (!(e && e.code === 'EEXIST')) throw e;
  }
  // `mode` means nothing on Windows: a folder made there takes the access list of the temp folder it is in — in one that is shared (`TEMP=C:\Temp`) that can be a grant to everyone, and every
  // workspace and every owner record the sweep will believe is then made inside it and inherits that grant. So before anything is put in it the folder is given an access list of its own — only
  // this user, the system and the administrators, protected from the folder above — and the list is read back (lib/windows-folder-acl.js).
  if (created && uidOf(deps) === null) protectNewParent(parent, deps);
  const hold = holdParent(parent, deps, stamp);
  try {
    checkParent(parent, deps, { created });
  } catch (e) {
    releaseHold(hold, deps);
    throw e;
  }
  return hold;
}

// This run's hold on the plugin's folder (A RUN HOLDS THE FOLDER, at the top of this file), or null: nothing is held on POSIX, nor where the hold cannot be made — a full disk, a folder that takes no new
// file, a host name that cannot be read (the machine is part of the hold's name) — which leaves the run exactly as it was before holds. It is made only in a plain folder: a link is not followed (checkParent,
// which runs next, refuses the folder), and it is opened with `wx`, which makes a NEW file — nothing is ever written into it — so that what is removed later is this run's own. ENOENT is thrown — the folder
// went before the hold was in it — and the attempt is made again at once, as for any ENOENT; so is a refusal of the moment from the look at the folder (a folder Windows is removing cannot be opened), which
// is asked again after a pause. `stamp` is the run's owner stamp (lib/process-owner.js): its host and its pid name the hold.
function holdParent(parent, deps, stamp) {
  const machine = machineOf(stamp.host);
  if (uidOf(deps) !== null || machine === null) return null;
  const fsx = deps.fs || fs;
  if (!fsx.lstatSync(parent).isDirectory()) return null;
  const file = path.join(parent, `${HOLD_PREFIX}${machine}-${stamp.pid}-${crypto.randomBytes(3).toString('hex')}`);
  let fd;
  try {
    fd = fsx.openSync(file, 'wx', 0o600);
  } catch (e) {
    if (e && e.code === 'ENOENT') throw e;
    return null;
  }
  try { fsx.closeSync(fd); } catch { /* the file is made all the same, and is removed by its name */ }
  return file;
}

// Removes a hold. A scanner that has just seen the new file can refuse its removal for a moment (Windows: EPERM, EACCES or EBUSY), and a hold that stayed would keep the plugin's folder from going when the run
// ends, so the removal is asked again after the same short waits as a rename (writeWhole). It never throws: a hold that is gone already (a sweep that took this run for a dead one) is what was wanted, and one that
// cannot be removed is a dead run's hold to the next sweep once this run has ended.
function releaseHold(file, deps) {
  if (file === null) return;
  const fsx = deps.fs || fs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fsx.unlinkSync(file);
      return;
    } catch (e) {
      if (!windowsRefusesForAMoment(e, deps) || attempt >= WAITS_MS.length) return;
      (deps.pause || pauseSync)(WAITS_MS[attempt]);
    }
  }
}

// A folder this process made that cannot be made private is not used: it is removed — it is empty, and this process made it — and the workspace goes in the plain temp folder, where it always
// went. The answer is about the folder that is at the path now; a folder swapped for another between the mkdir and the icacls is not the one that was made, and nothing that was said about it counts.
function protectNewParent(parent, deps) {
  const fsx = deps.fs || fs;
  const before = identityOf(parent, fsx.lstatSync(parent));
  const answer = (deps.folderProtect || makeWindowsFolderPrivate)(parent);
  let same = false;
  try { same = identityOf(parent, fsx.lstatSync(parent)) === before; } catch { /* gone: another process that ended with nothing in it removed it */ }
  if (answer.ok && same) return;
  if (same) {
    try { fsx.rmdirSync(parent); } catch { /* something is in it already, and it is not this call's to remove */ }
  }
  // Gone, or replaced: ask again at once. A folder that icacls could not even open — Windows is removing it — asks again after a pause. Anything else is final for this process.
  if (!same) throw Object.assign(new Error(`${parent} was replaced while it was being made private`), { code: 'ENOENT' });
  throw Object.assign(new Error(`${parent} could not be made private: ${answer.reason}`), { code: answer.unreadable ? 'EBUSY' : NOT_PRIVATE });
}

// A file written WHOLE: to a file of its own name, then renamed over `file`, which is atomic — a reader (a sweep, which reads the record of a live run's folder on Linux) or a kill finds the file as it was or all of the
// new text, never half. Nothing in this module writes a file any other way, so there is no write that a full disk or a kill can cut off and leave a damaged file where a good one was needed. The temporary copy is
// created with `wx` — it is a name that did not exist — and removed if anything fails. True when `file` is written. A failure is never thrown: what is written here is a courtesy to the next run (the record of a folder,
// the cursor of a sweep), and a run does not fail for the lack of it.
function writeWhole(file, text, deps) {
  const fsx = deps.fs || fs;
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fsx.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
    // On Windows a scanner that has just seen the new file can hold it for a moment, and the rename is refused (EPERM, EACCES or EBUSY): the same short waits as for the folder.
    for (let attempt = 0; ; attempt += 1) {
      try {
        fsx.renameSync(temp, file);
        return true;
      } catch (e) {
        if (!windowsRefusesForAMoment(e, deps) || attempt >= WAITS_MS.length) throw e;
        (deps.pause || pauseSync)(WAITS_MS[attempt]);
      }
    }
  } catch {
    try { fsx.rmSync(temp, { force: true }); } catch { /* the temp file is not what was to be written */ }
    return false;
  }
}

// The owner record of a folder this process made: the same stamp whose pid is in the folder's name — with `lent: true` for a workspace that is to be handed to another program (see the top of
// this file). It is written ONCE, and whole (writeWhole): a sweep or a kill finds no record at all or all of it; and it is never written again, because a record that is changed later can be
// unreadable at that moment — a scanner, a backup, an editor holds it — and what the folder says then is not what the run decided. A record that cannot be written leaves the folder as it would have
// been before records existed — it works, and nothing ever sweeps it — so it is never a reason to fail.
const mark = (dir, stamp, deps) => { writeWhole(path.join(dir, OWNER_FILE), JSON.stringify(stamp), deps); };

// The pid a workspace's name names — `genpage-4242-AbC123` is 4242's — or null: a name this maker did not give. mkdtemp's six random characters are
// always the end of the name, and the pid is the number before them, so a prefix with numbers of its own cannot be mistaken for one.
function pidOfName(name) {
  const named = /-(\d{1,10})-[A-Za-z0-9]{6}$/.exec(name);
  return named ? Number(named[1]) : null;
}

// What the end of the process removes (THE END OF A RUN, at the top of this file): the workspaces this process made in the plugin's folder and did not lend, each with the file system it was made through, and then the plugin's folder when
// nothing is left in it. `rmdir` removes a folder only when it is empty — the check and the removal are one step — so a workspace another run is making, or has, is never lost to it; a run that was about to make one finds the
// folder gone and makes it again (makeTempWorkspace). One listener for everything this process used, so a process that uses many folders (a test) adds one. The listener never throws and never touches the exit status: the
// process is ending, there is nobody left to tell, and a failure here is what a later run's sweep is for.
const ownWorkspaces = new Map();
const pruneAtExit = new Map();
function removeOwnWorkspace(dir, fsx) {
  try {
    // Gone already (its run removed it) or not a folder at all — a link put there is not followed.
    if (!fsx.lstatSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  try { removeWorkspace(dir, { fs: fsx }); } catch { /* a removal that fails (Windows holds a file) leaves the folder recorded, for a later sweep */ }
  // A folder whose record could not be written has none to move aside, and removeWorkspace leaves it empty.
  try { fsx.rmdirSync(dir); } catch { /* gone, or not empty */ }
}
// The plugin's folder, taken when nothing is left in it: every folder this process used, with `rmdir`, which takes a folder only when it is empty (see above). The end of the process does it after the workspaces it removes, and a caller
// that removes a LENT workspace in a cleanup of its own — which runs after that listener, see THE END OF A RUN — does it again when the workspace is gone. It never throws, and asking again, or for a folder that is gone, costs nothing.
function pruneWorkspaceParents() {
  for (const [folder, fsx] of pruneAtExit) {
    try { fsx.rmdirSync(folder); } catch { /* not empty (another run's workspace, or one that could not be removed), or already gone */ }
  }
}
function prune(parent, deps) {
  if (pruneAtExit.size === 0) {
    process.once('exit', () => {
      for (const [dir, fsx] of ownWorkspaces) removeOwnWorkspace(dir, fsx);
      pruneWorkspaceParents();
    });
  }
  pruneAtExit.set(parent, deps.fs || fs);
}

// A small JSON file this module wrote, as its text and the value in it, and when it was last written — or null when there is none that can be believed: no file, one that is not a regular file (a link is not followed),
// a very large one, or text that is not JSON. Not being able to read it — another program holds it exclusively for a moment — is null as well.
function readSmallJson(file, deps) {
  const fsx = deps.fs || fs;
  try {
    const st = fsx.lstatSync(file);
    if (!st.isFile() || st.size > OWNER_FILE_MAX_BYTES) return null;
    const raw = fsx.readFileSync(file, 'utf8');
    return { raw, value: JSON.parse(raw), mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// A record file's text and the record it holds, and when it was last written — or null when there is none that can be believed: no file, one that is not a regular file, a very large one, text that
// is not JSON, JSON that is not a record, a `lent` that is anything but `true` (it is written as that and as nothing else). Not being able to read it — another program holds it exclusively for
// a moment — is null as well, and every caller takes "no record I can believe" as "not shown to be dead": the folder is kept.
function readRecord(file, deps) {
  const found = readSmallJson(file, deps);
  const stamp = found && found.value;
  return found && isOwnerStamp(stamp) && (stamp.lent === undefined || stamp.lent === true) ? { raw: found.raw, stamp, mtimeMs: found.mtimeMs } : null;
}
const readMarker = (dir, deps) => readRecord(path.join(dir, OWNER_FILE), deps);

// A workspace removed with its owner record LAST, and kept recorded until the folder is really gone.
//   1. What is inside, except the record, is removed. A removal that fails part way (Windows holds a file a scanner is reading) throws here, with the record still in place.
//   2. Windows lists a file that was deleted while another process had it open (Node 20: the deletion stays pending until the holder lets go) — and the folder cannot go meanwhile —
//      so anything but the record that is still listed ends the removal here, again with the record in place: the next sweep tries again.
//   3. The record is RENAMED out of the folder — to `<folder>.removing`, a file beside it in the plugin's folder, which a sweep never reads as a workspace — and the empty folder removed. A rename, not a
//      delete: a delete of a file another process has open leaves it pending in the folder (the very thing that keeps the folder from going, and a name that cannot be made again),
//      while Windows lets such a file be renamed away. If the folder will not go, the record is moved back, so that what is left is still known to be a dead run's — and if even that is refused it
//      stays where it is, beside the folder and whole: the folder is empty (the record was all that was left in it), which is exactly what the next sweep finishes the removal from (finishInterruptedRemoval),
//      as it does for a sweep that is KILLED between the move and the removal, which is why the file is named for the folder and holds its record whole. The record is never WRITTEN into the folder
//      instead: a write can be cut off (a full disk, a kill), and a damaged record in the folder beside the whole one would leave neither this path (which believes no damaged record) nor the next sweep's
//      (which needs the folder empty) able to finish the removal.
// False when there was nothing left to remove: another run's sweep, started at the same moment (two builds starting after a kill), took the folder first — that is neither this
// sweep's removal nor its failure, and it says nothing of it.
function removeWorkspace(dir, deps) {
  const fsx = deps.fs || fs;
  const missing = (e) => !!e && e.code === 'ENOENT';
  // Windows answers EBUSY or EPERM for a moment while a handle that was just released lets go of a file; rmSync retries those.
  const remove = (target) => fsx.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const entries = () => fsx.readdirSync(dir);
  let names;
  try {
    names = entries();
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
  for (const name of names) if (name !== OWNER_FILE) remove(path.join(dir, name));
  let listed;
  try {
    listed = entries().filter((name) => name !== OWNER_FILE);
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
  if (listed.length > 0) {
    throw Object.assign(new Error(`ENOTEMPTY: ${listed.length} deleted ${listed.length === 1 ? 'entry is' : 'entries are'} still listed in ${dir} (${listed.slice(0, 3).join(', ')}) — another process holds ${listed.length === 1 ? 'it' : 'them'} open`), { code: 'ENOTEMPTY' });
  }
  const file = path.join(dir, OWNER_FILE);
  const aside = path.join(path.dirname(dir), `${path.basename(dir)}${REMOVING_SUFFIX}`);
  try {
    fsx.renameSync(file, aside);
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
  try {
    fsx.rmdirSync(dir);
  } catch (e) {
    if (missing(e)) {
      try { fsx.rmSync(aside, { force: true }); } catch { /* a few hundred bytes beside the plugin's folder's entries, which no sweep reads as a workspace */ }
      return true;
    }
    try {
      fsx.renameSync(aside, file);
    } catch { /* the record stays beside the folder, whole: see above */ }
    throw e;
  }
  try { fsx.rmSync(aside, { force: true }); } catch { /* as above */ }
  return true;
}

const clockOf = (deps) => (deps.owner && deps.owner.now) || Date.now;

// Whether a LENT workspace is old enough to be taken: neither the folder nor its record has been written to for LENT_KEEP_MS. The folder's own time moves whenever an entry is added to it or
// removed from it, so a folder that something is still working in is never old, and the record is written once, when the folder is made, so its time is the folder's age. Both must be past the limit —
// and a time that cannot be compared (a clock set back, a file dated in the future, a time that is not a number) keeps the folder: `>` is false for all of those.
function lentIsOld(dir, found, deps) {
  const now = clockOf(deps)();
  try {
    const folder = (deps.fs || fs).lstatSync(dir).mtimeMs;
    return now - folder > LENT_KEEP_MS && now - found.mtimeMs > LENT_KEEP_MS;
  } catch {
    return false;
  }
}

// The entries a sweep looks at, in the order it looks at them (see "A SWEEP IS BOUNDED, AND FAIR" at the top of this file). `listing` is the plugin's folder as `readdirSync(…, { withFileTypes: true })` gives it.
//   * The cursor, and the temporary copies it is written through, are the sweep's own: they are not entries. (Only a regular file with one of those names is ever removed — by a sweep that has no use for a cursor.)
//   * A listing no longer than the window is looked at whole, in the order the system gives it, as it always was. There is no use for a cursor then: none is read, and one that an earlier sweep left — or the
//     copy of one that a killed sweep left — is removed, so that a plugin's folder that has been worked off down to nothing can be removed in its turn when a run ends, and a normal run leaves the temp folder as it found it.
//   * A longer one is put in name order — in UTF-16 code units, the order every process agrees on, where the file system's own is not the same on every system and moves as entries come and go — and the window is the
//     next `maxExamined` names after the cursor's, wrapping round to the first; no entry twice. The cursor is written BEFORE the entries are looked at: an entry that a sweep cannot get past (it throws, the
//     process is killed on it) must not be the one the next sweep starts at again.
// Never throws.
function windowOf(listing, parent, maxExamined, deps) {
  const own = listing.filter((entry) => isCursorName(entry.name));
  const entries = listing.filter((entry) => !isCursorName(entry.name));
  if (entries.length <= maxExamined) {
    // No more of the sweep's own files than a window's worth are removed by one sweep — the cursor first, then the copies sweeps killed while they wrote it left — so a pile of those copies costs
    // a bounded amount of work per run, as the entries do, and is worked off over runs rather than in one burst.
    let budget = Math.max(0, Math.trunc(maxExamined) || 0);
    for (const entry of [...own.filter((e) => e.name === CURSOR_FILE), ...own.filter((e) => e.name !== CURSOR_FILE)]) {
      if (budget === 0) break;
      if (!entry.isFile()) continue;
      budget -= 1;
      try { (deps.fs || fs).rmSync(path.join(parent, entry.name), { force: true }); } catch { /* a few dozen bytes: the next sweep that looks at everything tries again */ }
    }
    return entries;
  }
  // The limit as `slice(0, n)` reads it: nothing for what is not a number.
  const size = Math.min(entries.length, Math.max(0, Math.trunc(maxExamined) || 0));
  if (size === 0) return [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // The cursor: {"v":1,"after":"genpage-4242-AbC123"} — the name of the last entry the sweep before looked at. It is read as text and compared with names; it is never used as a path. Anything else in its place — no
  // file, a link, a folder, text that is not JSON, another version, a name that is not a string — is no cursor, and the sweep starts at the first entry.
  const found = readSmallJson(path.join(parent, CURSOR_FILE), deps);
  const after = found && found.value && found.value.v === 1 && typeof found.value.after === 'string' ? found.value.after : null;
  const next = after === null ? -1 : sorted.findIndex((entry) => entry.name > after);
  const start = next === -1 ? 0 : next;
  const window = Array.from({ length: size }, (_, i) => sorted[(start + i) % sorted.length]);
  writeWhole(path.join(parent, CURSOR_FILE), JSON.stringify({ v: 1, after: window[size - 1].name }), deps);
  return window;
}

/**
 * Removes the workspaces in the plugin's folder whose owner is provably gone — and, for one that was lent to another program, only when it is old as well (LENT_KEEP_MS) — and finishes the
 * removals that an earlier sweep began and was killed in, and removes the holds of runs that are gone (Windows: A RUN HOLDS THE FOLDER, at the top of this file). Looks at no more than `maxExamined` entries and removes no more than `maxRemoved` workspaces, and the entries it looks at move on from one sweep to the next
 * (windowOf), so that none is out of reach for good. Never throws; never touches anything it cannot prove dead.
 * @param {object} [deps] test seams: fs, os, uid, owner (the process-owner.js seams: hostname, platform, pid, probe, now, …), limits ({ maxExamined, maxRemoved })
 * @returns {{ parent: string, removed: Array<{ name: string, stamp: object }>, failed: Array<{ name: string, stamp: object, error: string }>, kept: number }}
 */
function sweepDeadWorkspaces(deps = {}) {
  const fsx = deps.fs || fs;
  const parent = workspaceParent(deps);
  const result = { parent, removed: [], failed: [], kept: 0 };
  const { maxExamined, maxRemoved } = { maxExamined: MAX_EXAMINED, maxRemoved: MAX_REMOVED, ...deps.limits };
  const platform = (deps.owner && deps.owner.platform) || process.platform;
  const probe = (deps.owner && deps.owner.probe) || probeProcess;
  // The real place of a path: a link, or a Windows junction that an older Node does not report as one, resolves to somewhere else.
  const realPath = (p) => (fsx.realpathSync.native || fsx.realpathSync)(p);
  let listing;
  let realParent;
  try {
    checkParent(parent, deps);
    realParent = realPath(parent);
    listing = fsx.readdirSync(parent, { withFileTypes: true });
  } catch {
    return result;
  }
  const full = () => result.removed.length + result.failed.length >= maxRemoved;
  // A folder is looked into only if its name names a pid that no process has — or, on Linux, one that runs (the record's start time can show that the pid
  // was handed out again). A run that is going is never opened (see the top of this file); neither is a name this maker did not give.
  const mayLookInto = (named) => {
    const probed = named === null ? null : probe(named);
    return probed === 'gone' || (probed === 'alive' && platform === 'linux');
  };
  // …and a folder that is not where its name says it is is somewhere else's: removing it would follow the link and remove what it points at.
  const isHere = (dir, name) => {
    try { return realPath(dir) === path.join(realParent, name); } catch { return false; /* gone meanwhile */ }
  };
  // The record must agree with the name, and say the owner is gone — and, for a workspace that was lent to another program, the workspace must be old (lentIsOld).
  const removable = (dir, named, found) => !!found && found.stamp.pid === named && ownerState(found.stamp, deps.owner).state === 'gone'
    && (found.stamp.lent !== true || lentIsOld(dir, found, deps));

  // A removal that a sweep began and was killed in leaves the empty folder and `<folder>.removing`, the folder's own record moved out of it (removeWorkspace). It is finished when everything about
  // it agrees: the name is a workspace's and may be looked into, the file is a record that is believed, names the pid the name does and has an owner that is gone, and the folder is where its name
  // says, with nothing in it — or no longer there. The folder goes with `rmdir`, which removes a folder that is empty and nothing else, and then the file. What a lent workspace's age protects is its
  // CONTENT, and none is left. Anything that does not agree is kept exactly as it is: false.
  const finishInterruptedRemoval = (sidecar) => {
    const name = sidecar.slice(0, -REMOVING_SUFFIX.length);
    const named = pidOfName(name);
    if (!mayLookInto(named)) return false;
    const file = path.join(parent, sidecar);
    const found = readRecord(file, deps);
    if (!found || found.stamp.pid !== named || ownerState(found.stamp, deps.owner).state !== 'gone') return false;
    const dir = path.join(parent, name);
    let present = true;
    try {
      if (!fsx.lstatSync(dir).isDirectory() || !isHere(dir, name) || fsx.readdirSync(dir).length > 0) return false;
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) return false;
      present = false;
    }
    if (present) {
      if (full()) return false;
      try {
        fsx.rmdirSync(dir);
        result.removed.push({ name, stamp: found.stamp });
      } catch (e) {
        if (!(e && e.code === 'ENOENT')) {
          // The folder will not go (Windows: a handle on it): the record stays beside it, and the next sweep tries again.
          result.failed.push({ name, stamp: found.stamp, error: String((e && e.code) || (e && e.message) || e) });
          return true;
        }
      }
    }
    try { fsx.rmSync(file, { force: true }); } catch { /* a few hundred bytes: the next sweep tries again */ }
    return true;
  };

  // A hold (Windows: A RUN HOLDS THE FOLDER, at the top of this file) that a run was killed while holding: an empty file, removed once its pid is gone, so that the plugin's folder can go when it is empty. Only a
  // hold of THIS machine — its name says which, and a pid says nothing on another — and only when this machine can be told at all (its host name is read as an owner record reads it, once a sweep meets a hold).
  // The hold of a run that is going — this one's own among them — is left, and so is a file of that name that is not empty: no run made it. Removing one says nothing (it held nothing) and costs no removal of the cap.
  let here;
  const thisMachine = () => {
    if (here === undefined) {
      try { here = machineOf(ownerStamp(deps.owner).host); } catch { here = null; }
    }
    return here;
  };
  const releaseDeadHold = (name) => {
    const machine = thisMachine();
    if (machine === null || HOLD_NAME.exec(name)[1] !== machine) return;
    if (probe(pidOfName(name)) !== 'gone') return;
    const file = path.join(parent, name);
    try {
      const st = fsx.lstatSync(file);
      if (st.isFile() && st.size === 0) fsx.unlinkSync(file);
    } catch { /* gone meanwhile, or held for a moment: the next sweep tries again */ }
  };

  for (const entry of windowOf(listing, parent, maxExamined, deps)) {
    if (entry.isFile() && entry.name.endsWith(REMOVING_SUFFIX)) {
      if (!finishInterruptedRemoval(entry.name)) result.kept += 1;
      continue;
    }
    // Only where holds are made (Windows: `uid` is null, as for holdParent): elsewhere a file of that shape is an entry like any other, and is left as it always was.
    if (uidOf(deps) === null && entry.isFile() && isHoldName(entry.name)) {
      releaseDeadHold(entry.name);
      continue;
    }
    // A link, a file, anything that is not a folder was not made by a workspace maker.
    if (!entry.isDirectory()) continue;
    const named = pidOfName(entry.name);
    if (!mayLookInto(named)) { result.kept += 1; continue; }
    const dir = path.join(parent, entry.name);
    if (!isHere(dir, entry.name)) { result.kept += 1; continue; }
    const marker = readMarker(dir, deps);
    if (!removable(dir, named, marker)) { result.kept += 1; continue; }
    if (full()) { result.kept += 1; continue; }
    // Read again, just before the removal: only an entry that is still what was judged is removed.
    const again = readMarker(dir, deps);
    if (!removable(dir, named, again) || again.raw !== marker.raw) { result.kept += 1; continue; }
    try {
      if (removeWorkspace(dir, deps)) result.removed.push({ name: entry.name, stamp: marker.stamp });
      else result.kept += 1;
    } catch (e) {
      result.failed.push({ name: entry.name, stamp: marker.stamp, error: String((e && e.code) || (e && e.message) || e) });
    }
  }
  return result;
}

// The words for what a sweep did: a name is shown only if it is a plain one (a name is what a record's maker chose, and this goes to a terminal).
// What removed workspaces held, by the maker their names say made them: the work folder of a pac fallback of solution-settings.js (`solution-settings-…`) holds pac's settings template, the
// package the SDK exported or a copy of the settings file pac imports with, any of which can hold the settings' values; every other workspace is an SDK's, and holds page source and the
// environment's address.
const SETTINGS_WORK_PREFIX = 'solution-settings-';
function heldBy(list) {
  const settings = list.filter((item) => String(item.name).startsWith(SETTINGS_WORK_PREFIX)).length;
  if (settings === 0) return "page source and the environment's address";
  if (settings === list.length) return "a settings template, an exported package or a copy of a settings file, which can hold its values";
  return "page source, the environment's address, or a settings file's values";
}

function sweepWarning(result) {
  const shown = (list, detail) => {
    const names = list.slice(0, 5).map((item) => `${/^[A-Za-z0-9._-]+$/.test(item.name) ? item.name : '?'} (${detail(item)})`);
    return names.join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '');
  };
  const parts = [];
  if (result.removed.length) {
    const n = result.removed.length;
    parts.push(`removed ${n} temporary workspace${n === 1 ? '' : 's'} left in ${result.parent} by ${n === 1 ? 'a run' : 'runs'} that ${n === 1 ? 'is' : 'are'} no longer running — ${n === 1 ? 'it' : 'they'} held ${heldBy(result.removed)}: ${shown(result.removed, (item) => `pid ${item.stamp.pid}`)}`);
  }
  if (result.failed.length) {
    const n = result.failed.length;
    parts.push(`could not remove ${n} such workspace${n === 1 ? '' : 's'} (${shown(result.failed, (item) => item.error)}) — delete ${n === 1 ? 'it' : 'them'} by hand`);
  }
  return parts.join('; ');
}

// The sweep once per process and folder: the first workspace a process makes is the moment the next run notices what a killed one left, and a script
// that makes several (verify makes one for every dashboard it reads) does not list the folder for each. It never throws.
const swept = new Set();
function sweepOnce(parent, deps) {
  if (swept.has(parent)) return;
  swept.add(parent);
  try {
    const message = sweepWarning(sweepDeadWorkspaces(deps));
    if (message) (deps.warn || ((text) => process.stderr.write(`⚠ ${text}\n`)))(message);
  } catch { /* a courtesy: it never stops the run that was about to make a workspace */ }
}

// A plugin's folder that would not take a new folder is not asked again by the process that was refused: the plain temp folder is where this process's workspaces go from then on.
// (Memory of a refusal, not of a verdict: the folder may take one tomorrow, and the next process asks for itself.)
const refusing = new Set();

/**
 * A new, empty, private workspace folder, to be used and removed as `fs.mkdtempSync(path.join(os.tmpdir(), prefix))` is — and removed when the process ends, if the caller never got to it (a workspace that is not lent: see THE END OF A RUN).
 *
 * `lent: true` is for a folder one of whose paths is to be GIVEN to another program — pac, writing its settings file in it: say so here, when the folder is made, and not later (see the top of
 * this file). The record is then written once with that word in it, and a sweep never takes the folder because this run is gone: only when it is old as well (LENT_KEEP_MS); and the end of this process does not take it either.
 * @param {string} prefix what the folder's name starts with (a name, not a path), so a folder left behind says whose it was: `<prefix><pid>-<random>`, with a hyphen put before the pid when the prefix does not end in one
 * @param {object} [deps] `lent` (see above), and test seams: fs, os, uid, mkdtempSync (what makes the folder, given the path to start its name with), warn, owner, pause (sleeps, given milliseconds), folderPrivacy (the Windows access-list reader), folderProtect (the Windows maker of an access list)
 * @returns {string} the folder
 */
function makeTempWorkspace(prefix, deps = {}) {
  const fsx = deps.fs || fs;
  const mkdtemp = deps.mkdtempSync || ((start) => fsx.mkdtempSync(start));
  if (typeof prefix === 'string' && SAFE_PREFIX.test(prefix)) {
    let parent = null;
    // What this process is, as it will be recorded — and named: the folder is `<prefix><pid>-<random>` (see the top of this file), and a sweep reads the pid from the hyphen before it (pidOfName). A prefix
    // that does not end in one is given it: `work` is `work-4242-AbC123`, and not `work4242-AbC123`, which no sweep could tell was a workspace's — it would be recorded, and never taken. A prefix that
    // ends in one (every caller's) is named exactly as it was. The plain call at the end is the caller's own prefix, as it always was.
    let stamp = null;
    const named = prefix.endsWith('-') ? prefix : `${prefix}-`;
    try { parent = workspaceParent(deps); stamp = ownerStamp(deps.owner); } catch { parent = null; /* no temp folder to name: the plain call below says so */ }
    if (stamp !== null && deps.lent === true) stamp = { ...stamp, lent: true };
    for (let attempt = 1; parent !== null && attempt <= MAKE_ATTEMPTS && !refusing.has(parent); attempt += 1) {
      // The plugin's folder is removed by a process that ends with nothing left in it (see prune), and that can land between the steps below: ENOENT anywhere is that, and the
      // attempt is made again at once. On Windows a folder that is being removed refuses for a moment instead (mkdir, mkdtemp and the reading of its access list, above), and the
      // attempt is made again after a pause; one that is still refusing after the last is not used, and not asked again by this process. Any other failure means the plugin's folder
      // cannot be used — it is not ours alone, it exists and will not take a new folder (permissions on it are not those of the temp folder it is in: mode 0500, an access list that
      // denies this user), the disk is full there, or (Windows) a folder this process made could not be made private — and the workspace is made in the plain temp folder, below, as it
      // always was. The plugin's folder is a courtesy to the next run, so a refusal of it is never this run's failure; an error is reported only if the plain call fails too, and then it
      // is that call's, with that call's path.
      let dir;
      let hold = null;
      try {
        hold = ensureParent(parent, deps, stamp);
        // From here on the folder may be one this process made, so it is this process's to take away when it ends with nothing in it — also when the workspace below is refused (a full disk) and goes in the temp folder.
        prune(parent, deps);
        sweepOnce(parent, deps);
        dir = mkdtemp(path.join(parent, `${named}${stamp.pid}-`));
      } catch (e) {
        releaseHold(hold, deps);
        if (e && e.code === 'ENOENT') continue;
        if (e && e.code === NOT_YET_PRIVATE) {
          // Its maker may not have given it its own list yet (checkParent): ask again after a pause. Still "no" after the last, it is not used for this workspace, and asked about again for the next.
          if (attempt < MAKE_ATTEMPTS) {
            (deps.pause || pauseSync)(WAITS_MS[attempt - 1]);
            continue;
          }
          break;
        }
        if (windowsRefusesForAMoment(e, deps)) {
          if (attempt < MAKE_ATTEMPTS) {
            (deps.pause || pauseSync)(WAITS_MS[attempt - 1]);
            continue;
          }
          refusing.add(parent);
        } else if (e && e.code === NOT_PRIVATE) {
          // Each try costs three programs and the answer will not change: this process does not make the folder again.
          refusing.add(parent);
        }
        break;
      }
      // The workspace is in the folder now, and keeps it from going as the hold did. It is recorded and registered BEFORE the hold is let go: letting go can wait on a scanner that holds the
      // new file (releaseHold), and a run that is killed in that wait must leave a workspace a sweep can prove dead, not an empty folder with no record, which no sweep ever takes.
      mark(dir, stamp, deps);
      // The end of the process removes what the run did not — unless it was lent: a program that was given a path in it may still be writing there (see THE END OF A RUN). A `mkdtempSync` seam that answers a
      // folder somewhere else is not the plugin's folder's, and is not touched.
      if (deps.lent !== true && path.dirname(dir) === parent) ownWorkspaces.set(dir, deps.fs || fs);
      releaseHold(hold, deps);
      return dir;
    }
  }
  return mkdtemp(path.join((deps.os || os).tmpdir(), prefix));
}

module.exports = { PARENT_NAME, OWNER_FILE, REMOVING_SUFFIX, CURSOR_FILE, HOLD_PREFIX, LENT_KEEP_MS, LIMITS: { MAX_EXAMINED, MAX_REMOVED }, workspaceParent, makeTempWorkspace, sweepDeadWorkspaces, sweepWarning, pruneWorkspaceParents };
