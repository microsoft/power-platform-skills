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

// The `--authorize <approval>` flag a message tells the maker to paste, as ONE argument. An approval is built from a name the maker wrote (a view, a form, a rule,
// a dashboard key), so it can hold white space — `adopt:view:contoso_item/Declared Items` — and an unquoted paste reaches the CLI as two arguments
// (`adopt:view:contoso_item/Declared`, `Items`), which it rejects as an approval nothing declares.
//   plain (letters, digits, `_ . / : -`)   written bare, exactly as before: `--authorize adopt:view:contoso_item/Items`
//   nothing a double-quoted string reads   double-quoted, the spelling the printed approvals already used for a form, a rule and a process flow:
//                                          `--authorize "adopt:view:contoso_item/Declared Items"`
//   a `$`, a backtick, `\`, `!` or a curly double quote (which PowerShell reads as a double quote) makes a double-quoted spelling unsafe, but when the key
//                                          has no quote of any kind commandArg's single-quoted spelling is literal in Windows PowerShell 5.1, PowerShell 7 and the
//                                          POSIX shells alike: `--authorize 'adopt:view:contoso_item/cost $5'`
//   a double quote, or an apostrophe together with one of the characters above
//                                          no ONE spelling is literal everywhere, so the flag is written once per shell (shellSpellings below).
//   a line break or another control character
//                                          cannot be pasted as one line; the message gives the value as data and says to rename the item.
// Double quotes rather than commandArg's single quotes keep the spelling already printed (and pinned) for forms, rules and process flows.
const DOUBLE_QUOTE_UNSAFE = /["$`\\!\u201C\u201D\u201E\u201F\p{Zl}\p{Zp}]|[^\P{Cc}\t]/u;
const CANNOT_BE_ONE_LINE = /[\p{Zl}\p{Zp}]|[^\P{Cc}\t]/u;

// The value as one single-quoted argument in each family of shells, for a value no common spelling carries:
//   posix        sh, bash, zsh: nothing is read inside '…', and a quote is written by closing the string, adding an escaped quote and reopening: 'it'\''s $5'
//   powershell   PowerShell on any system, and PowerShell 7.3 and later on Windows: inside '…' a quote is doubled, and PowerShell reads the curly single quotes
//                (‘ ’ ‚ ‛) as quotes too, so those are doubled as well: 'it''s $5'. From 7.3 it hands a native program each argument exactly, a `"` included.
//   windowsPowerShell   Windows PowerShell 5.1 and PowerShell 7.0–7.2 on Windows do not: they join the arguments into one command line, wrapping one that holds
//                white space in double quotes and escaping nothing, so a `"` is dropped by the program and a final `\` before the closing quote swallows it. The
//                value is written the way the program's own command-line reader (CommandLineToArgvW) reads it back: each `"` as `\"` with the backslashes before it
//                doubled, and, when the value holds white space and so gets wrapped, the final backslashes doubled. See
//                https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_parsing#passing-arguments-that-contain-quote-characters
//                and https://learn.microsoft.com/cpp/c-language/parsing-c-command-line-arguments.
function shellSpellings(value) {
  const text = String(value);
  const powershell = (s) => `'${s.replace(/['\u2018\u2019\u201A\u201B]/gu, (q) => q + q)}'`;
  let commandLine = text.replace(/(\\*)"/g, '$1$1\\"');
  if (/\s/u.test(text)) commandLine = commandLine.replace(/(\\+)$/, '$1$1');
  return {
    posix: `'${text.replace(/'/g, "'\\''")}'`,
    powershell: powershell(text),
    windowsPowerShell: powershell(commandLine),
  };
}

function authorizeFlag(approval) {
  const text = String(approval);
  if (BARE_ARG.test(text)) return `--authorize ${text}`;
  if (text !== '' && !DOUBLE_QUOTE_UNSAFE.test(text)) return `--authorize "${text}"`;
  const single = text !== '' && !CANNOT_BE_ONE_LINE.test(text) ? commandArg(text) : null;
  if (single !== null) return `--authorize ${single}`;
  if (text === '' || CANNOT_BE_ONE_LINE.test(text)) {
    return `--authorize <approval> — <approval> is ${JSON.stringify(text)}; it holds a line break or another control character, so it cannot be pasted as one line: rename the item so its name has none`;
  }
  // The approval is written once per shell because it holds a quote that the shells spell differently. Each spelling is the whole flag, to be pasted as it is.
  const s = shellSpellings(text);
  return `the --authorize flag, which this approval's quote or special character makes depend on your shell: in a POSIX shell (sh, bash, zsh) --authorize ${s.posix}; in PowerShell 7.3 or later --authorize ${s.powershell}; in Windows PowerShell 5.1 or PowerShell 7.0–7.2 on Windows --authorize ${s.windowsPowerShell}`;
}

module.exports = { AZ_TIMEOUT_ENV, DEFAULT_AZ_TIMEOUT_MS, MIN_AZ_TIMEOUT_MS, MAX_AZ_TIMEOUT_MS, azTimeoutMs, cliFailureKind, azTimeoutAdvice, commandArg,
  commandArgOrPlaceholder, authorizeFlag, shellSpellings };
