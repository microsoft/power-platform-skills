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
//   * When the process ends, the plugin's folder is removed if nothing is left in it, so a normal run leaves the temp folder as it found it.
//
// IT CHANGES NOTHING ELSE. A caller that gets the folder here does what it did with `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`: it passes the folder to
// the SDK and removes it, with `fs.rmSync`, when it is done. If the plugin's own folder cannot be used — it is not ours alone, it is a link, the disk says
// no — the folder is made in the temp directory as before, unrecorded and never swept: this is a courtesy to the next run, never a reason for one to fail.
// Folders made by an earlier release are loose in the temp folder with no record, and stay where they are.
//
// WHY THE SWEEP CANNOT REMOVE A LIVE RUN'S WORKSPACE
//   * It lists the plugin's folder once, and judges each entry on its own record; a workspace made after the listing is not in it. A name is never
//     made twice (mkdtemp picks it at random), so an entry cannot be replaced by another run's between the judgement and the removal.
//   * A folder is named after the process that made it — `genpage-4242-AbC123`: the prefix, the pid, mkdtemp's six random characters — so that a sweep can
//     tell a run that is still going WITHOUT opening anything in its folder. That matters on Windows, where a file that is deleted while another process
//     has it open stays in its folder until that process lets go: a sweep that read the record of a live run at the moment the run removed its workspace
//     made the run's own removal fail (ENOTEMPTY — measured, on Node 20), and a run's removal is not retried by every caller. A folder whose name does not
//     name a pid, or names one that runs, is not opened; the one exception is Linux, where a file can always be deleted while it is open and the record's start
//     time can show that a pid was handed out again.
//   * Just before it removes an entry it reads the record again, and judges again, and takes the entry only if both are as they were.
//   * It removes what is inside first and the record last, so a removal that fails half way leaves a folder that is still recorded — still found, and
//     still swept, by the next run — rather than one that nothing can prove is dead.
//   * It never removes the plugin's folder itself: another run may be making a workspace in it that moment.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ownerStamp, ownerState, isOwnerStamp, probeProcess } = require('./process-owner.js');

const PARENT_NAME = 'power-platform-skills-model-apps';
const OWNER_FILE = '.owner.json';
// What a prefix may be: a name, never a path. A prefix that is not one would put the folder outside the plugin's own.
const SAFE_PREFIX = /^[A-Za-z0-9._-]+$/;
// A record is a few hundred bytes. One that is much larger is not a record.
const OWNER_FILE_MAX_BYTES = 4096;
// The most one sweep looks at, and removes: a plugin's folder that has somehow collected thousands of entries is worked off over several runs, not in
// the time of one.
const MAX_EXAMINED = 500;
const MAX_REMOVED = 100;
// How often a workspace is made again after the folder it belongs in was removed under it (see makeTempWorkspace).
const MAKE_ATTEMPTS = 3;

const uidOf = (deps) => (deps.uid !== undefined ? deps.uid : (typeof process.getuid === 'function' ? process.getuid() : null));

// The folder the plugin keeps its workspaces in, for the temp folder `deps.os` (the real one) names. Windows gives each user a temp folder of their
// own (GetTempPath reads TMP, TEMP, then the profile: https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-gettemppatha), and so does
// macOS; Linux's `/tmp` is shared by everyone on the machine, so the user id goes into the name — one user cannot make, or leave, the folder another
// user's runs would then work in.
function workspaceParent(deps = {}) {
  const uid = uidOf(deps);
  return path.join((deps.os || os).tmpdir(), uid === null ? PARENT_NAME : `${PARENT_NAME}-${uid}`);
}

// The plugin's folder is trusted only when it is a plain folder — not a link someone put there to point the plugin's removals elsewhere — and, where
// the system has owners, ours alone: nobody else can add or rename an entry in it. Throws when it is not.
function checkParent(parent, deps) {
  const fsx = deps.fs || fs;
  const st = fsx.lstatSync(parent);
  if (!st.isDirectory()) throw new Error(`${parent} is not a folder`);
  const uid = uidOf(deps);
  if (uid !== null && (st.uid !== uid || (st.mode & 0o022) !== 0)) throw new Error(`${parent} is not ours alone`);
}

function ensureParent(parent, deps) {
  // Not `recursive`: a temp folder that is not there is the failure it always was (ENOENT, from the plain call this falls back to), not a folder this makes.
  try {
    (deps.fs || fs).mkdirSync(parent, { mode: 0o700 });
  } catch (e) {
    if (!(e && e.code === 'EEXIST')) throw e;
  }
  checkParent(parent, deps);
}

// The owner record of a folder this process made: the same stamp whose pid is in the folder's name. A record that cannot be written leaves the folder as
// it would have been before records existed — it works, and nothing ever sweeps it — so it is never a reason to fail.
function mark(dir, stamp, deps) {
  try {
    (deps.fs || fs).writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify(stamp), { flag: 'wx', mode: 0o600 });
  } catch { /* an unrecorded folder is a plain one */ }
}

// The pid a workspace's name names — `genpage-4242-AbC123` is 4242's — or null: a name this maker did not give. mkdtemp's six random characters are
// always the end of the name, and the pid is the number before them, so a prefix with numbers of its own cannot be mistaken for one.
function pidOfName(name) {
  const named = /-(\d{1,10})-[A-Za-z0-9]{6}$/.exec(name);
  return named ? Number(named[1]) : null;
}

// The plugin's folder is removed when the process ends and nothing is left in it. `rmdir` removes a folder only when it is empty — the check and the
// removal are one step — so a workspace another run is making, or has, is never lost to it; a run that was about to make one finds the folder gone
// and makes it again (makeTempWorkspace). One listener for every folder this process used, so a process that uses many (a test) adds one.
const pruneAtExit = new Map();
function prune(parent, deps) {
  if (pruneAtExit.size === 0) {
    process.once('exit', () => {
      for (const [folder, fsx] of pruneAtExit) {
        try { fsx.rmdirSync(folder); } catch { /* not empty (a workspace that was left, another run's), or already gone */ }
      }
    });
  }
  pruneAtExit.set(parent, deps.fs || fs);
}

// A folder's owner record, as text and as the record it holds — or null when there is none that can be believed: no record, a file that is not a
// regular file, a very large one, text that is not JSON, JSON that is not a record.
function readMarker(dir, deps) {
  const fsx = deps.fs || fs;
  try {
    const file = path.join(dir, OWNER_FILE);
    const st = fsx.lstatSync(file);
    if (!st.isFile() || st.size > OWNER_FILE_MAX_BYTES) return null;
    const raw = fsx.readFileSync(file, 'utf8');
    const stamp = JSON.parse(raw);
    return isOwnerStamp(stamp) ? { raw, stamp } : null;
  } catch {
    return null;
  }
}

// A workspace removed with its owner record LAST. A removal that fails part way (Windows holds a file a scanner is reading) throws before the record
// goes: the folder is still recorded, and the next sweep tries again. False when there was nothing left to remove: another run's sweep, started at the same
// moment (two builds starting after a kill), took the folder first — that is neither this sweep's removal nor its failure, and it says nothing of it.
function removeWorkspace(dir, deps) {
  const fsx = deps.fs || fs;
  // Windows answers EBUSY or EPERM for a moment while a handle that was just released lets go of a file; rmSync retries those.
  const remove = (target) => fsx.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  let names;
  try {
    names = fsx.readdirSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    throw e;
  }
  for (const name of names) if (name !== OWNER_FILE) remove(path.join(dir, name));
  remove(dir);
  return true;
}

/**
 * Removes the workspaces in the plugin's folder whose owner is provably gone. Never throws; never touches anything it cannot prove dead.
 * @param {object} [deps] test seams: fs, os, uid, owner (the process-owner.js seams: hostname, platform, pid, probe, …), limits ({ maxExamined, maxRemoved })
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
  let entries;
  let realParent;
  try {
    checkParent(parent, deps);
    realParent = realPath(parent);
    entries = fsx.readdirSync(parent, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries.slice(0, maxExamined)) {
    // A link, a file, anything that is not a folder was not made by a workspace maker.
    if (!entry.isDirectory()) continue;
    // A folder is looked into only if its name names a pid that no process has — or, on Linux, one that runs (the record's start time can show that the pid
    // was handed out again). A run that is going is never opened (see the top of this file); neither is a name this maker did not give.
    const named = pidOfName(entry.name);
    const probed = named === null ? null : probe(named);
    if (probed !== 'gone' && !(probed === 'alive' && platform === 'linux')) { result.kept += 1; continue; }
    const dir = path.join(parent, entry.name);
    // …and a folder that is not where it says it is is somewhere else's: removing it would follow the link and remove what it points at.
    let place = null;
    try { place = realPath(dir); } catch { /* gone meanwhile */ }
    if (place !== path.join(realParent, entry.name)) { result.kept += 1; continue; }
    // The record must agree with the name, and say the owner is gone.
    const gone = (found) => !!found && found.stamp.pid === named && ownerState(found.stamp, deps.owner).state === 'gone';
    const marker = readMarker(dir, deps);
    if (!gone(marker)) { result.kept += 1; continue; }
    if (result.removed.length + result.failed.length >= maxRemoved) { result.kept += 1; continue; }
    // Read again, just before the removal: only an entry that is still what was judged is removed.
    const again = readMarker(dir, deps);
    if (!gone(again) || again.raw !== marker.raw) { result.kept += 1; continue; }
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
function sweepWarning(result) {
  const shown = (list, detail) => {
    const names = list.slice(0, 5).map((item) => `${/^[A-Za-z0-9._-]+$/.test(item.name) ? item.name : '?'} (${detail(item)})`);
    return names.join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '');
  };
  const parts = [];
  if (result.removed.length) {
    const n = result.removed.length;
    parts.push(`removed ${n} temporary workspace${n === 1 ? '' : 's'} left in ${result.parent} by ${n === 1 ? 'a run' : 'runs'} that ${n === 1 ? 'is' : 'are'} no longer running — ${n === 1 ? 'it' : 'they'} held page source and the environment's address: ${shown(result.removed, (item) => `pid ${item.stamp.pid}`)}`);
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

/**
 * A new, empty, private workspace folder, to be used and removed as `fs.mkdtempSync(path.join(os.tmpdir(), prefix))` is.
 * @param {string} prefix what the folder's name starts with (a name, not a path), so a folder left behind says whose it was
 * @param {object} [deps] test seams: fs, os, uid, mkdtempSync (what makes the folder, given the path to start its name with), warn, owner
 * @returns {string} the folder
 */
function makeTempWorkspace(prefix, deps = {}) {
  const fsx = deps.fs || fs;
  const mkdtemp = deps.mkdtempSync || ((start) => fsx.mkdtempSync(start));
  if (typeof prefix === 'string' && SAFE_PREFIX.test(prefix)) {
    let parent = null;
    // What this process is, as it will be recorded — and named: the folder is `<prefix><pid>-<random>` (see the top of this file).
    let stamp = null;
    try { parent = workspaceParent(deps); stamp = ownerStamp(deps.owner); } catch { parent = null; /* no temp folder to name: the plain call below says so */ }
    for (let attempt = 1; parent !== null && attempt <= MAKE_ATTEMPTS; attempt += 1) {
      // The plugin's folder is removed by a process that ends with nothing left in it (see prune), and that can land between the two steps below. ENOENT at either
      // is that, and the step is made again. Any other failure of the first step means the folder cannot be used (the plain temp folder, below); any other failure of the
      // second (no space, no permission) is the one the plain temp folder would give, and is the caller's, as it always was.
      try {
        ensureParent(parent, deps);
      } catch (e) {
        if (e && e.code === 'ENOENT') continue;
        break;
      }
      sweepOnce(parent, deps);
      let dir;
      try {
        dir = mkdtemp(path.join(parent, `${prefix}${stamp.pid}-`));
      } catch (e) {
        if (e && e.code === 'ENOENT') continue;
        throw e;
      }
      mark(dir, stamp, deps);
      prune(parent, deps);
      return dir;
    }
  }
  return mkdtemp(path.join((deps.os || os).tmpdir(), prefix));
}

module.exports = { PARENT_NAME, OWNER_FILE, LIMITS: { MAX_EXAMINED, MAX_REMOVED }, workspaceParent, makeTempWorkspace, sweepDeadWorkspaces, sweepWarning };
