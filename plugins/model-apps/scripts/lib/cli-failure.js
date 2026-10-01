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

// The budget for one Azure CLI call: 60 s, or POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS milliseconds (1 s to
// 15 min). An unusable value keeps the default rather than failing the run — this is a tuning knob for
// a slow machine, not an input a mistake in which should stop the work.
function azTimeoutMs(env = process.env) {
  const n = Number(env && env[AZ_TIMEOUT_ENV]);
  return Number.isInteger(n) && n >= 1000 && n <= 900000 ? n : DEFAULT_AZ_TIMEOUT_MS;
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

// What to tell the user when `command` ran out of time: that it was slow, and how to allow it longer.
function azTimeoutAdvice(command, ms = azTimeoutMs()) {
  return `\`${command}\` did not answer within ${Math.round(ms / 1000)} s. Azure CLI can take that long to start `
    + `on a busy machine — retry, or allow it longer with ${AZ_TIMEOUT_ENV}=${Math.max(ms * 2, 120000)}.`;
}

module.exports = { AZ_TIMEOUT_ENV, DEFAULT_AZ_TIMEOUT_MS, azTimeoutMs, cliFailureKind, azTimeoutAdvice };
