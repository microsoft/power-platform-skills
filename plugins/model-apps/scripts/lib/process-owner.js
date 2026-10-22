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
// another one) or 'unknown' (not this machine's, not readable, not understood): both mean keep. This is a fact about the MAKER, and only that: a maker that
// handed what it made to another program (a workspace given to pac — lib/temp-workspace.js `lent`) is not the program, and its death proves nothing about it.
//
// WHAT "IN THIS PID NAMESPACE" NEEDS. On Linux a pid means something only inside the pid namespace it was given in: two containers can share a host
// name and a volume and have two pid spaces, so a pid that is "not found" here may be running in the other. The proof therefore needs the namespace
// of the stamp AND the namespace of the process judging it, each readable and well formed (`pid:[4026531836]`), and equal. A side that cannot name its
// own — a /proc that is hidden (a container, hidepid, a sandbox), or a stamp made by one — shows nothing about which pid space it is in, and two sides
// that cannot is not "the same pid space as far as anything shows": it is unknown, and the answer is keep.
//
// WHAT A START IS. The `start` of a stamp is `<boot id>:<start ticks>` and nothing else. A value that is not that — empty, cut short, damaged inside a
// record that is still valid JSON — is not a start, so the record is not believed at all (isOwnerStamp), and a start that is read from /proc but is not
// well formed is not compared. Only two well-formed starts that differ show that a pid was handed out again.
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
// It is what keeps a start time in ticks since boot from meaning the same on two boots. A start TOKEN is the boot id and the start time, `<boot id>:<ticks>`.
const UUID = '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const BOOT_ID = new RegExp(`^${UUID}$`, 'i');
const START_TOKEN = new RegExp(`^${UUID}:\\d+$`, 'i');
// A pid namespace as the kernel names it: `pid:[4026531836]` (namespaces(7)).
const NAMESPACE = /^pid:\[\d+\]$/;
const isStartToken = (value) => typeof value === 'string' && START_TOKEN.test(value);
const isNamespace = (value) => typeof value === 'string' && NAMESPACE.test(value);

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
    return isNamespace(link) ? link : null;
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

// What the process making a lock or a workspace records about itself: see the top of this file. A namespace or a start that is not well formed is not recorded:
// a record names what it can show, and nothing that cannot be compared later.
function ownerStamp(deps = {}) {
  const platform = deps.platform || process.platform;
  const pid = deps.pid != null ? deps.pid : process.pid;
  const stamp = { v: STAMP_VERSION, pid, at: (deps.now || Date.now)(), host: hostNameOf(deps), platform };
  if (platform === 'linux') {
    const ns = deps.ns !== undefined ? deps.ns : readNamespace(deps);
    if (isNamespace(ns)) stamp.ns = ns;
    const start = (deps.startOf || ((p) => readStart(p, deps)))(pid);
    if (start && isStartToken(start.token)) stamp.start = start.token;
  }
  return stamp;
}

// Is `value` a stamp this module wrote? Anything else — a lock a release of the plugin before this one took ({ pid, at } alone), a file that is not
// JSON, an object of another shape, a stamp of a later version, a stamp one of whose fields is damaged (a start that is not a start, a namespace
// that is not one) — is not one, and is never treated as proof of anything. A field the module does not define is not read: the pages lock's token adds a random part, and
// a workspace's record may say it was lent (lib/temp-workspace.js, which reads that field itself and as strictly).
function isOwnerStamp(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && value.v === STAMP_VERSION
    && Number.isInteger(value.pid) && value.pid > 0
    && typeof value.at === 'number' && Number.isFinite(value.at)
    && typeof value.host === 'string' && value.host !== ''
    && typeof value.platform === 'string' && value.platform !== ''
    && (value.ns === undefined || isNamespace(value.ns))
    && (value.start === undefined || isStartToken(value.start));
}

// A zombie has exited and only waits to be reaped (a container whose first process does not reap leaves them); X and x are the kernel's "dead".
const NOT_RUNNING = new Set(['Z', 'X', 'x']);

// Whether a start that was READ for a pid shows it is not the process whose start was recorded: both must be real starts, and they must differ. A reading that is not a start
// (a damaged /proc, a seam) shows nothing, and neither does a recorded one that is not (isOwnerStamp does not let one through, and this does not rely on that alone).
const startsDiffer = (read, recorded) => !!read && isStartToken(read.token) && isStartToken(recorded) && read.token !== recorded;

/**
 * Whether the process that made `stamp` is gone, judged on this machine and by this process.
 * @returns {{ state: 'gone' | 'alive' | 'unknown', reason: string }}
 *   gone     provably not running: the pid is free, or Linux shows another process (or a zombie) in it
 *   alive    a process runs under the pid and nothing says it is not the maker — including this process itself
 *   unknown  not decidable here (another machine or platform, a pid namespace that is not the same or that either side cannot name; a stamp that is missing, damaged or
 *            not understood)
 */
function ownerState(stamp, deps = {}) {
  if (!isOwnerStamp(stamp)) return { state: 'unknown', reason: 'no readable owner record' };
  const platform = deps.platform || process.platform;
  if (stamp.host !== hostNameOf(deps) || stamp.platform !== platform) {
    return { state: 'unknown', reason: `made on ${stamp.host} (${stamp.platform}), not here` };
  }
  if (platform === 'linux') {
    // A pid is only a name inside its pid namespace (see the top of this file): a stamp and a reader that do not BOTH name theirs — readable, well formed — are not
    // shown to share one, and neither are two that name different ones.
    const ns = deps.ns !== undefined ? deps.ns : readNamespace(deps);
    if (!isNamespace(stamp.ns) || !isNamespace(ns)) return { state: 'unknown', reason: 'the pid namespace of the record, or of this process, cannot be told' };
    if (stamp.ns !== ns) return { state: 'unknown', reason: 'made in another pid namespace' };
  } else if (stamp.ns !== undefined) {
    return { state: 'unknown', reason: 'made in another pid namespace' };
  }
  const startOf = deps.startOf || ((p) => readStart(p, deps));
  const here = deps.pid != null ? deps.pid : process.pid;
  if (stamp.pid === here) {
    // This process — or an earlier one that had the same pid, which only a start time can tell (Linux). Without one it is this process.
    const mine = platform === 'linux' && stamp.start !== undefined ? startOf(here) : null;
    return startsDiffer(mine, stamp.start)
      ? { state: 'gone', reason: `pid ${stamp.pid} is this process now; it was another one when the record was made` }
      : { state: 'alive', reason: 'this process' };
  }
  const probed = (deps.probe || probeProcess)(stamp.pid);
  if (probed === 'gone') return { state: 'gone', reason: `no process has pid ${stamp.pid}` };
  if (probed !== 'alive') return { state: 'unknown', reason: `pid ${stamp.pid} could not be checked` };
  if (platform === 'linux' && stamp.start !== undefined) {
    // A process runs under the pid: is it the one that made the record? Only a start time that was READ, well formed, and differs says no.
    const now = startOf(stamp.pid);
    if (now && NOT_RUNNING.has(now.state)) return { state: 'gone', reason: `process ${stamp.pid} has exited and is waiting to be reaped` };
    if (startsDiffer(now, stamp.start)) return { state: 'gone', reason: `pid ${stamp.pid} was given to another process after the record was made` };
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
