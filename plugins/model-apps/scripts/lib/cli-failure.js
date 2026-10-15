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

// One argument of a command that a message tells the user — or the agent driving the skill — to paste, written so that pasting the command hands the
// program it runs (`node`) exactly this value, as ONE argument, in the shells the skill's own commands are written for: PowerShell (Windows PowerShell 5.1
// and PowerShell 7) and the POSIX shells (sh, bash, zsh). The skill's instructions quote arguments in single quotes ('<working-dir>/<file>.tsx'); cmd.exe,
// which reads no single quotes, is not one of them.
//   letters and digits of any script, and `_ . / : -`      written bare: no shell reads anything in them
//   (not a leading `-`)
//   anything else                                        single-quoted: inside '…' neither PowerShell nor a POSIX shell expands, substitutes or splits
//                                                        anything, so `;`, `$(…)`, backticks, `|`, `&`, globs, `\` and white space stay literal
//   null — no spelling, so the caller writes a placeholder and names the value outside the command (commandArgOrPlaceholder) — for:
//     a single quote, or one PowerShell reads as one     PowerShell doubles a quote, a POSIX shell closes and reopens one: no spelling is literal in both
//     (‘ ’ ‚ ‛), a line break or another control
//     character (a tab is fine)
//     a double quote; white space with a `\` at the      Windows PowerShell does not hand a native program its arguments as they are: it joins them into one
//     end; the empty value                               command line, wrapping a value that holds white space in double quotes and escaping nothing, so the
//                                                        program drops a `"` ('x"y.tsx' arrives as xy.tsx) and reads the closing quote after a final `\` as
//                                                        an escaped one ('C:\Dev User\' arrives as C:\Dev User"); an empty value is not passed at all.
//                                                        PowerShell 7.3 and later pass all three as they are; Windows PowerShell 5.1 is still the one
//                                                        Windows ships.
//     exactly `--%`                                      PowerShell's stop-parsing token: both PowerShells take it for the token even quoted, and drop it
// Measured on Windows PowerShell 5.1 and PowerShell 7.6 (tests/cli-failure.test.js runs every spelling through each shell it finds and reads node's argv).
// See https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_parsing#passing-arguments-that-contain-quote-characters and
// https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_parsing#the-stop-parsing-token.
// A path can come from an untrusted checkout, so a value is written bare only when it is plain: a file named `x;rm -rf ~;.tsx`, written bare or in double
// quotes, would run its second half when the advice is pasted.
const BARE_ARG = /^(?!-)[\p{L}\p{N}_./:-]+$/u;
const UNQUOTABLE = /['"\u2018\u2019\u201A\u201B\p{Zl}\p{Zp}]|[^\P{Cc}\t]/u;
function commandArg(value) {
  const text = String(value);
  if (BARE_ARG.test(text)) return text;
  if (UNQUOTABLE.test(text) || text === '' || text === '--%' || (/\s/u.test(text) && text.endsWith('\\'))) return null;
  return `'${text}'`;
}

// commandArg's spelling of `value`, or — when it has none — `placeholder` (`<file>`), with the sentence a message adds to name the value as data, never as part of
// a command.
function commandArgOrPlaceholder(value, placeholder) {
  const arg = commandArg(value);
  if (arg !== null) return { arg, note: '' };
  return {
    arg: placeholder,
    note: `${placeholder} is ${JSON.stringify(String(value))}; it is not written into the command because no way of writing it reaches the command unchanged in both PowerShell and a POSIX shell.`,
  };
}

module.exports = { AZ_TIMEOUT_ENV, DEFAULT_AZ_TIMEOUT_MS, MIN_AZ_TIMEOUT_MS, MAX_AZ_TIMEOUT_MS, azTimeoutMs, cliFailureKind, azTimeoutAdvice,
  PAC_TIMEOUT_ENV, DEFAULT_PAC_READ_TIMEOUT_MS, DEFAULT_PAC_UPLOAD_TIMEOUT_MS, MIN_PAC_TIMEOUT_MS, MAX_PAC_TIMEOUT_MS, pacTimeoutMs, pacLongerTimeoutMs, pacTimeoutAdvice, commandArg,
  commandArgOrPlaceholder };
