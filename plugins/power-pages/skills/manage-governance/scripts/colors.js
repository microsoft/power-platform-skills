#!/usr/bin/env node

// colors.js — Tiny ANSI color helper modeled on PowerShell's
// `Write-Host -ForegroundColor <Color>`. It lets scripts emit red / green /
// yellow / cyan text WHEN — and only when — the output is a real interactive
// terminal.
//
// Why opt-in / TTY-gated: this skill's tables are usually produced as JSON and
// re-rendered by the agent into chat Markdown, which supports NO ANSI. If we
// always wrapped text in escape codes, captured strings would show garbage like
// `←[32mEnabled←[0m`. So coloring is OFF by default and only turns on when:
//   * `enabled: true` is passed explicitly (e.g. from a `--color` flag), OR
//   * stdout is a TTY, `NO_COLOR` is unset, and the caller didn't force it off.
// `FORCE_COLOR` (any truthy value) forces it on; `NO_COLOR` forces it off.

// ForegroundColor name -> SGR code. Names match PowerShell's ConsoleColor so a
// caller can pass 'Green' / 'Red' / 'Yellow' / 'Cyan' just like -ForegroundColor.
const FOREGROUND = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
};

const RESET = '\u001b[0m';

/**
 * Decide whether ANSI coloring should be applied.
 *
 * @param {object} [opts]
 * @param {boolean|null} [opts.enabled] - Tri-state override. `true` forces on,
 *   `false` forces off, `null`/`undefined` falls back to auto-detection.
 * @param {NodeJS.WriteStream} [opts.stream] - Stream whose `.isTTY` is checked
 *   during auto-detection (defaults to `process.stdout`).
 * @param {object} [opts.env] - Environment map (defaults to `process.env`).
 * @returns {boolean}
 */
function shouldColor(opts = {}) {
  if (opts.enabled === true) return true;
  if (opts.enabled === false) return false;
  const env = opts.env || process.env;
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') {
    return true;
  }
  const stream = opts.stream || process.stdout;
  return Boolean(stream && stream.isTTY);
}

/**
 * Wrap `text` in the ANSI escape for a ConsoleColor-style foreground color —
 * the programmatic equivalent of `Write-Host $text -ForegroundColor <color>`.
 * When coloring is disabled the text is returned unchanged, so JSON/chat output
 * stays clean.
 *
 * @param {string} text
 * @param {string} color - A ForegroundColor name ('Green', 'Red', ...).
 * @param {object} [opts] - Passed through to `shouldColor` (e.g. `{ enabled }`).
 * @returns {string}
 */
function foregroundColor(text, color, opts = {}) {
  const s = String(text == null ? '' : text);
  if (!shouldColor(opts)) return s;
  const code = FOREGROUND[String(color || '').toLowerCase()];
  if (code == null) return s;
  return `\u001b[${code}m${s}${RESET}`;
}

// Convenience helpers named after the four colors this skill actually uses for
// status output (green = enabled/success, red = disabled/error, yellow =
// warning, cyan = info) — mirroring the PowerShell snippet.
const green = (text, opts) => foregroundColor(text, 'Green', opts);
const red = (text, opts) => foregroundColor(text, 'Red', opts);
const yellow = (text, opts) => foregroundColor(text, 'Yellow', opts);
const cyan = (text, opts) => foregroundColor(text, 'Cyan', opts);

module.exports = {
  FOREGROUND,
  RESET,
  shouldColor,
  foregroundColor,
  green,
  red,
  yellow,
  cyan,
};

// Tiny CLI so you can eyeball the colors in a terminal:
//   node colors.js            -> auto-detects TTY
//   node colors.js --color    -> force on
//   node colors.js --no-color -> force off
if (require.main === module) {
  const argv = process.argv.slice(2);
  let enabled = null;
  if (argv.includes('--color')) enabled = true;
  if (argv.includes('--no-color')) enabled = false;
  const opts = { enabled };
  process.stdout.write(green('Success', opts) + '\n');
  process.stdout.write(yellow('Warning', opts) + '\n');
  process.stdout.write(red('Error', opts) + '\n');
  process.stdout.write(cyan('Info', opts) + '\n');
}
