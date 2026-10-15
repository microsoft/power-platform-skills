'use strict';
// Who made a lock or a temporary workspace, and whether that process is gone.
//
// WHY. A run that is killed outright — SIGKILL, "End task", an agent's timeout, a power cut — cannot clean up after itself, so it leaves what it
// held: the pages lock a build takes on an app's workspace (lib/sdk-build.js), and the throwaway workspaces it made in the temp folder
// (lib/temp-workspace.js), which hold the page source it read and the environment's address. A later run may take such a thing over ONLY when it can
// prove that its maker is gone; everything else is left exactly as it was. That proof is made here, once, for both. It is deliberately one-sided:
// every doubt answers "keep" — a lock that stays costs a person one delete, and a lock or a workspace taken from a run that is still going costs it
// its work.
//
// WHAT IS RECORDED. A "stamp", written as JSON into the lock, or into the workspace's own folder, by the process that makes it:
//   { "v": 1, "pid": 4242, "at": 1760483934512, "host": "build-box", "platform": "linux",
//     "ns": "pid:[4026531836]", "start": "11111111-2222-3333-4444-555555555555:5382613" }
//   pid       the process that made it
//   at        when (ms since the epoch). For a message only: an age never decides anything here, because a live process can be paused for as
//             long as a laptop sleeps
//   host      os.hostname(). A workspace folder on a network share, or a temp folder on a shared drive, can hold another machine's stamp, and
//             a pid means nothing on a machine that did not make it
//   platform  process.platform. Windows and WSL show one folder under one host name and have two pid spaces
//   ns        Linux only: the pid namespace (`readlink /proc/self/ns/pid`). Two containers given one host name and one volume have two pid spaces
//   start     Linux only: the boot id and the process's start time in clock ticks since boot (`/proc/<pid>/stat`, field 22). A pid that is
//             running now with another start is not the process that made the stamp
//
// WHEN THE MAKER IS "GONE" (ownerState → 'gone'): the stamp is well formed, it was made on this machine, by this kind of system, in this pid
// namespace, and then either no process has the pid (ESRCH), or — on Linux, where the start time is cheap to read — a process has it that is a
// zombie or started at another time (the pid was handed out again). Everything else is 'alive' (a process runs under the pid and nothing says it is
// another one) or 'unknown' (not this machine's, not readable, not understood): both mean keep.
//
// WHAT THIS CANNOT PROVE, and why it errs toward keeping instead. Where there is no cheap start time (Windows, macOS) a dead maker's pid that has
// been given to another process looks alive, so its lock or folder stays until that process ends or someone deletes it — the state of things before
// this module existed. Reading a start time there costs a process of its own (`ps`, PowerShell) per check. A changed host name (a laptop that
// the network renames, as macOS does) makes a stamp look foreign, with the same result.
const fs = require('node:fs');
const os = require('node:os');

const STAMP_VERSION = 1;

// process.kill(pid, 0) sends no signal: it only reports whether `pid` can be signalled. ESRCH is "no such process"; EPERM is "it exists, and it is
// not ours to signal" — alive, for a process that belongs to another user, or one Windows will not let this one open. On Windows Node maps the
// same two answers: an exited process whose handle is still held somewhere reads as ESRCH, since it is no longer running.
// https://nodejs.org/api/process.html#processkillpid-signal
function killCode(pid) {
  try { process.kill(pid, 0); return null; } catch (e) { return (e && e.code) || 'UNKNOWN'; }
}

// Is `pid` a live process? Best-effort, and a boolean for a caller that only needs "may this still be running": true for a process that runs, or that
// belongs to another user (EPERM); false for anything else — including an answer that says nothing, such as a pid that is not a number. Used by
// the snapshot lease (lib/apply-snapshot-store.js) exactly as it was before it moved here. pid reuse can FALSELY report a dead holder alive.
function processAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  const code = killCode(pid);
  return code === null || code === 'EPERM';
}

// The same check, in three answers, for a caller that must tell "gone" from "I cannot tell": 'alive', 'gone' (ESRCH, the only code that means no
// such process) or 'unknown' (a pid that cannot name a process, or an error that is neither).
function probeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  const code = killCode(pid);
  if (code === null || code === 'EPERM') return 'alive';
  return code === 'ESRCH' ? 'gone' : 'unknown';
}

// ---------------------------------------------------------------------------------------------------------------------
// Linux: the process's start time and pid namespace, which tell a pid that was handed out again from the process that made a stamp
// ---------------------------------------------------------------------------------------------------------------------

const readText = (deps, file) => (deps.readFile ? deps.readFile(file) : fs.readFileSync(file, 'utf8'));

// `/proc/<pid>/stat` is one line:
//   4242 (node) S 4000 4242 4000 34816 4242 4194560 20961 0 0 0 51 9 0 0 20 0 11 0 5382613 1207963648 38437 ...
// Field 2 is the command name in parentheses, and it can hold spaces and ")" itself (a thread named "a) b" is "(a) b)"), so the line is split after
// its LAST ")". What follows begins at field 3, the state, which puts field 22, the start time in clock ticks since boot, at index 19.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
// → { state: 'S', start: '5382613' }, or null when the line is not in this shape.
function parseProcStat(text) {
  const line = String(text);
  const close = line.lastIndexOf(')');
  if (close < 0) return null;
  const fields = line.slice(close + 1).trim().split(/\s+/);
  const [state] = fields;
  const start = fields[19];
  return /^[A-Za-z]$/.test(state || '') && /^\d+$/.test(start || '') ? { state, start } : null;
}

// The boot id is a random UUID made at each boot: `cat /proc/sys/kernel/random/boot_id` → 11111111-2222-3333-4444-555555555555 (a placeholder; random(4)).
// It is what keeps a start time in ticks since boot from meaning the same on two boots.
const BOOT_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// A process's start as a token that is the same whenever it is read for that process and different for the process that has the pid next:
// `<boot id>:<start ticks>`, with the state letter alongside. null whenever it cannot be read — a process that is gone, a /proc that hides other
// users' processes (hidepid), a platform with no /proc: "cannot tell" is never an answer of "gone".
function readStart(pid, deps = {}) {
  try {
    const stat = parseProcStat(readText(deps, `/proc/${pid}/stat`));
    const boot = String(readText(deps, '/proc/sys/kernel/random/boot_id')).trim();
    return stat && BOOT_ID.test(boot) ? { token: `${boot}:${stat.start}`, state: stat.state } : null;
  } catch {
    return null;
  }
}

// The pid namespace this process is in, as the kernel names it: `readlink /proc/self/ns/pid` → pid:[4026531836] (namespaces(7)); null when it
// cannot be read. https://man7.org/linux/man-pages/man7/namespaces.7.html
function readNamespace(deps = {}) {
  try {
    const link = String((deps.readlink || fs.readlinkSync)('/proc/self/ns/pid'));
    return /^pid:\[\d+\]$/.test(link) ? link : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The stamp, and the verdict on it
// ---------------------------------------------------------------------------------------------------------------------

// `deps` are test seams, all optional: pid, hostname (a function), platform, now (a function), readFile, readlink (the Linux reads), ns and startOf
// (what those reads would answer), probe (the pid check).
function hostNameOf(deps) {
  try { return String((deps.hostname || os.hostname)()); } catch { return ''; }
}

// What the process making a lock or a workspace records about itself: see the top of this file.
function ownerStamp(deps = {}) {
  const platform = deps.platform || process.platform;
  const pid = deps.pid != null ? deps.pid : process.pid;
  const stamp = { v: STAMP_VERSION, pid, at: (deps.now || Date.now)(), host: hostNameOf(deps), platform };
  if (platform === 'linux') {
    const ns = deps.ns !== undefined ? deps.ns : readNamespace(deps);
    if (ns) stamp.ns = ns;
    const start = (deps.startOf || ((p) => readStart(p, deps)))(pid);
    if (start && start.token) stamp.start = start.token;
  }
  return stamp;
}

// Is `value` a stamp this module wrote? Anything else — a lock a release of the plugin before this one took ({ pid, at } alone), a file that is not
// JSON, an object of another shape, a stamp of a later version — is not one, and is never treated as proof of anything.
function isOwnerStamp(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && value.v === STAMP_VERSION
    && Number.isInteger(value.pid) && value.pid > 0
    && typeof value.at === 'number' && Number.isFinite(value.at)
    && typeof value.host === 'string' && value.host !== ''
    && typeof value.platform === 'string' && value.platform !== ''
    && (value.ns === undefined || typeof value.ns === 'string')
    && (value.start === undefined || typeof value.start === 'string');
}

// A zombie has exited and only waits to be reaped (a container whose first process does not reap leaves them); X and x are the kernel's "dead".
const NOT_RUNNING = new Set(['Z', 'X', 'x']);

/**
 * Whether the process that made `stamp` is gone, judged on this machine and by this process.
 * @returns {{ state: 'gone' | 'alive' | 'unknown', reason: string }}
 *   gone     provably not running: the pid is free, or Linux shows another process (or a zombie) in it
 *   alive    a process runs under the pid and nothing says it is not the maker — including this process itself
 *   unknown  not decidable here (another machine, platform or pid namespace; a stamp that is missing, damaged or not understood)
 */
function ownerState(stamp, deps = {}) {
  if (!isOwnerStamp(stamp)) return { state: 'unknown', reason: 'no readable owner record' };
  const platform = deps.platform || process.platform;
  if (stamp.host !== hostNameOf(deps) || stamp.platform !== platform) {
    return { state: 'unknown', reason: `made on ${stamp.host} (${stamp.platform}), not here` };
  }
  // A stamp that names a namespace and a reader that cannot name its own, or the reverse, are not shown to share a pid space.
  const ns = platform === 'linux' ? (deps.ns !== undefined ? deps.ns : readNamespace(deps)) : null;
  if ((stamp.ns || null) !== (ns || null)) return { state: 'unknown', reason: 'made in another pid namespace' };
  const startOf = deps.startOf || ((p) => readStart(p, deps));
  const here = deps.pid != null ? deps.pid : process.pid;
  if (stamp.pid === here) {
    // This process — or an earlier one that had the same pid, which only a start time can tell (Linux). Without one it is this process.
    const mine = platform === 'linux' && typeof stamp.start === 'string' ? startOf(here) : null;
    return mine && mine.token !== stamp.start
      ? { state: 'gone', reason: `pid ${stamp.pid} is this process now; it was another one when the record was made` }
      : { state: 'alive', reason: 'this process' };
  }
  const probed = (deps.probe || probeProcess)(stamp.pid);
  if (probed === 'gone') return { state: 'gone', reason: `no process has pid ${stamp.pid}` };
  if (probed !== 'alive') return { state: 'unknown', reason: `pid ${stamp.pid} could not be checked` };
  if (platform === 'linux' && typeof stamp.start === 'string') {
    // A process runs under the pid: is it the one that made the record? Only a start time that was READ and differs says no.
    const now = startOf(stamp.pid);
    if (now && NOT_RUNNING.has(now.state)) return { state: 'gone', reason: `process ${stamp.pid} has exited and is waiting to be reaped` };
    if (now && now.token !== stamp.start) return { state: 'gone', reason: `pid ${stamp.pid} was given to another process after the record was made` };
  }
  return { state: 'alive', reason: `process ${stamp.pid} is running` };
}

// "pid 4242 on build-box, since 2026-10-14T23:38:54.512Z" — for a message about a stamp that has passed ownerState (its host is this machine's).
function describeOwner(stamp) {
  let since = '';
  try { since = `, since ${new Date(stamp.at).toISOString()}`; } catch { /* an out-of-range time stamps nothing */ }
  return `pid ${stamp.pid} on ${stamp.host}${since}`;
}

module.exports = { STAMP_VERSION, processAlive, probeProcess, parseProcStat, ownerStamp, isOwnerStamp, ownerState, describeOwner };
