'use strict';

// How a CLI child process failed, and how long one Azure CLI call may take.
//
// The auth preflight and every Dataverse token read shell out to `az` (check-auth also to `pac`), and
// each failure used to come back as the same thing: null. A slow Azure CLI therefore read as a missing
// or signed-out one — a cached-token read was measured at 44.6 s on a busy machine, past the 30 s
// budget, and check-auth reported `az_missing` ("not installed") while every script said "run az login".
// Neither was the problem. A failure now has one of three kinds, and a timeout is reported as one.

const AZ_TIMEOUT_ENV = 'POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS';
const DEFAULT_AZ_TIMEOUT_MS = 60000;
// The range an override may take: 1 s to 15 min. Shared by the parser and the advice below, so the
// advice can never suggest a value the parser would reject — and so fall back to the 60 s default.
const MIN_AZ_TIMEOUT_MS = 1000;
const MAX_AZ_TIMEOUT_MS = 900000;

// The budget for one Azure CLI call: 60 s, or POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS milliseconds (1 s to
// 15 min). An unusable value keeps the default rather than failing the run — this is a tuning knob for
// a slow machine, not an input a mistake in which should stop the work.
function azTimeoutMs(env = process.env) {
  const n = Number(env && env[AZ_TIMEOUT_ENV]);
  return Number.isInteger(n) && n >= MIN_AZ_TIMEOUT_MS && n <= MAX_AZ_TIMEOUT_MS ? n : DEFAULT_AZ_TIMEOUT_MS;
}

// 'timeout' | 'missing' | 'failed' for an error from the process runner, or null for none. The shapes
// Node gives each case (https://nodejs.org/api/child_process.html):
//   execFileSync / spawnSync past `timeout`   code 'ETIMEDOUT'
//   execFile past `timeout`                   killed: true, signal: the kill signal, code: null
//   not on PATH                               code 'ENOENT' — the runner resolves the executable before
//                                             it spawns anything ("spawn az ENOENT: not found on PATH")
// Any other code (a non-zero exit, output past maxBuffer — which also kills the child) is 'failed'.
function cliFailureKind(error) {
  if (!error) return null;
  if (error.code === 'ETIMEDOUT') return 'timeout';
  if (error.code === 'ENOENT') return 'missing';
  if (typeof error.code === 'string') return 'failed';
  if (error.killed === true && error.signal) return 'timeout';
  if (/\bENOENT\b/.test(String(error.message || ''))) return 'missing';
  return 'failed';
}

// What to tell the user when `command` ran out of time: that it was slow, and how to allow it longer. The
// suggested budget is double the one that ran out (at least 2 min), CAPPED at the maximum the parser
// accepts — a suggestion above it would be rejected and quietly put the budget back to 60 s. Once the
// budget is already the maximum, more time is not the remedy, and the advice says so.
function azTimeoutAdvice(command, ms = azTimeoutMs()) {
  const ranOut = `\`${command}\` did not answer within ${Math.round(ms / 1000)} s.`;
  if (ms >= MAX_AZ_TIMEOUT_MS) {
    return `${ranOut} That is already the longest ${AZ_TIMEOUT_ENV} allows (${MAX_AZ_TIMEOUT_MS / 60000} min), so `
      + `waiting longer will not help: run \`${command}\` yourself to see whether Azure CLI answers at all, then retry.`;
  }
  const longer = Math.min(Math.max(ms * 2, 120000), MAX_AZ_TIMEOUT_MS);
  return `${ranOut} Azure CLI can take that long to start on a busy machine — retry, or allow it longer with `
    + `${AZ_TIMEOUT_ENV}=${longer}.`;
}

// ── The time one `pac model genpage` call may take ─────────────────────────────────────────────────────────────
// A page upload once stalled — no CPU, no network — for 17 minutes, until the process was killed by hand; the build then finished. A pac call
// therefore waits a bounded time (lib/genpage-cli.js runPac ends the whole process tree when it runs out and reports `timedOut`). The bound is
// generous, because a real upload of a large page is slow and a slow call is not a stalled one:
//   list, download   3 min   (a listing takes ~5 s; a download is a few files)
//   upload           10 min  (it transpiles the page and writes it through the service)
// POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS sets the budget of ONE call, for every kind, for a machine or an environment slower than that: 1 s to
// 60 min. Like the Azure CLI budget it is a tuning knob, so an unusable value keeps the default instead of stopping the work.
const PAC_TIMEOUT_ENV = 'POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS';
const DEFAULT_PAC_READ_TIMEOUT_MS = 180000;
const DEFAULT_PAC_UPLOAD_TIMEOUT_MS = 600000;
const MIN_PAC_TIMEOUT_MS = 1000;
const MAX_PAC_TIMEOUT_MS = 3600000;

// The budget for one pac call of `kind` ('upload'; anything else is a read: list, download).
function pacTimeoutMs(kind, env = process.env) {
  const n = Number(env && env[PAC_TIMEOUT_ENV]);
  if (Number.isInteger(n) && n >= MIN_PAC_TIMEOUT_MS && n <= MAX_PAC_TIMEOUT_MS) return n;
  return kind === 'upload' ? DEFAULT_PAC_UPLOAD_TIMEOUT_MS : DEFAULT_PAC_READ_TIMEOUT_MS;
}

// The budget to suggest in place of `ms`: one pacTimeoutMs accepts — double, at least 5 min, capped at the maximum — or null once `ms` is the
// maximum, because nothing larger would be read and the default would quietly come back.
function pacLongerTimeoutMs(ms) {
  return ms >= MAX_PAC_TIMEOUT_MS ? null : Math.min(Math.max(ms * 2, 300000), MAX_PAC_TIMEOUT_MS);
}

// What to tell the user when `command` ran out of time: that it was stopped, and how to allow it longer. As for azTimeoutAdvice, the suggested
// budget is one pacTimeoutMs accepts, and once the budget is the maximum, more time is not the remedy. For a READ — a listing or a download, which
// can be made again at no cost; an upload that stalls says what to do about itself (lib/genpage-cli.js), because running it again is not always safe.
function pacTimeoutAdvice(command, ms) {
  const ranOut = `\`${command}\` did not finish within ${Math.round(ms / 1000)} s and was stopped.`;
  const longer = pacLongerTimeoutMs(ms);
  if (longer === null) {
    return `${ranOut} That is already the longest ${PAC_TIMEOUT_ENV} allows (${MAX_PAC_TIMEOUT_MS / 60000} min), so waiting longer will not help: `
      + 'check that the PAC CLI can reach the environment (`pac org who`), then retry.';
  }
  return `${ranOut} A stalled call is usually transient — retry, or allow it longer with ${PAC_TIMEOUT_ENV}=${longer}.`;
}

// One argument of a command that a message tells the user to paste: bare, or in double quotes when it holds white space — a path under a Windows profile folder is often
// "C:\Users\Dev User\…" — so that it stays ONE argument.
function commandArg(value) {
  return /\s/.test(String(value)) ? `"${value}"` : String(value);
}

module.exports = { AZ_TIMEOUT_ENV, DEFAULT_AZ_TIMEOUT_MS, MIN_AZ_TIMEOUT_MS, MAX_AZ_TIMEOUT_MS, azTimeoutMs, cliFailureKind, azTimeoutAdvice,
  PAC_TIMEOUT_ENV, DEFAULT_PAC_READ_TIMEOUT_MS, DEFAULT_PAC_UPLOAD_TIMEOUT_MS, MIN_PAC_TIMEOUT_MS, MAX_PAC_TIMEOUT_MS, pacTimeoutMs, pacLongerTimeoutMs, pacTimeoutAdvice, commandArg };
