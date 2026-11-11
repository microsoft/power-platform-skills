#!/usr/bin/env node
'use strict';
// Pre-transpile gate for /genpage: does a generated page write a CSS shorthand that Griffel drops at runtime?
//
// Compiling a page does not run `makeStyles` and TypeScript does not know Griffel's list, so a page with `borderWidth: '1px'` in a style object
// compiles, uploads and then renders without the border (the browser console logs `@griffel/react: You are using unsupported shorthand CSS property`). The rule itself
// — which ten properties, and where in the page they count — lives in lib/griffel-styles.js. This wrapper exists so the orchestrator, an AI following SKILL.md,
// gets a yes/no answer it cannot talk itself past, instead of a grep it has to read the result of.
//
// It runs a second check on a file that is a page (one with a default export): does the page establish its own scroll context? The host shows a page in a
// container of fixed height and never scrolls it, so a page in which nothing both has a bounded height and scrolls is cut off below the fold, silently. That
// rule lives in lib/page-scroll.js (AB#6793599). One command runs both, so no flow that checks a page can skip one of them.
//
// Usage:
//   node check-griffel-styles.js --file <page.tsx> [--existing]
//
// `--existing`: the page was not generated in this run (a downloaded page an edit changes, a maker's hand edit). Its scroll-context problems are reported
// in `notes` and do not change `ok` or the exit code: refusing a maker's small edit over a layout they chose would be a regression. Griffel problems are
// judged the same in both modes.
//
// Output (one JSON line) and exit code:
//   0  {"ok":true,"filePath":…,"calls":1,"problems":[]}
//   3  {"ok":false,…,"problems":[{"code","property","line","column","longhands","within","value","owner","branch","arms","message"}]}   — rewrite those keys with the longhands, then check again
//   1  {"ok":false,"error":…}   — usage error, or the file cannot be read
// A scroll-context problem is `{"code","line","column","element","message"}` (plus `reason` for `scroll-context-unproven`), appended to `problems` after the
// Griffel ones: `no-scroll-context` (nothing from the page's top element down both has a bounded height and scrolls), `scroll-context-unproven` (the check
// cannot read what decides it: `reason` says what), or `scroll-context-padding` (the page scrolls, but a box that fills its container has vertical padding
// without `boxSizing: "border-box"`, so its end stays cut off). The message gives the edit that fixes it; apply it and check again. With `--existing` the
// same objects go to `"notes":[…]` instead. `notes` is present only when it is not empty, so the output of a fragment, a page that passes and every page
// before this check existed is unchanged; it can also hold `scroll-check-failed` when the scroll check itself fails, which never changes the exit code.
//
// `calls` is how many makeStyles calls were read. A problem's `code` is `unsupported-shorthand`; or `unread-style-object`, a style object the checker cannot see — one
// passed to the call (`makeStyles(styles)`), a slot or a selector given a variable, a spread of anything but an inline object — whose keys may be any of the ten, or a
// computed key it cannot read as a name (`[key]: …`), so it is never reported as clean (write it inline); or — where the checker cannot read the code for certain —
// `unverifiable-style-call` and `unbalanced-style-call`. `within` is
// the slot, selectors and at-rules a key sits under (`["root", ":hover"]`): where it is apart from its line, and `value` is what the key is set to, as written (a quoted
// string as its text in double quotes, anything else as its source text); `owner` is the hook the key is in (the name it is bound to at the top of the page, or null when the page does not prove one),
// and `branch` and `arms` the arm of each condition above it: together they let genpage-upload.js tell a key a page already had, set the same, from a new or
// a changed one.

const fs = require('node:fs');
const path = require('node:path');
const { griffelStyleProblems } = require('./lib/griffel-styles.js');
const { pageScrollProblems } = require('./lib/page-scroll.js');

// `existing`: the page was not generated in this run (a downloaded page an edit touches, a maker's hand edit), so a missing scroll context
// is the maker's to decide on: it is reported in `notes` and does not change `ok` or the exit code. Griffel problems are judged the same in
// both modes.
function checkGriffelStyles({ filePath, existing = false }) {
  if (!filePath) return { exit: 1, result: { ok: false, error: '--file is required' } };
  const abs = path.resolve(filePath);
  let source;
  try {
    source = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { exit: 1, result: { ok: false, filePath: abs, error: `--file could not be read: ${(e && e.code) || e}` } };
  }
  const { calls, problems } = griffelStyleProblems(source);
  let scroll;
  let notes = [];
  try {
    scroll = pageScrollProblems(source).map(({ fix, ...p }) => p);
  } catch (e) {
    // A defect in the scroll check must not take the Griffel check down with it, nor refuse a page over the checker's own failure: it is
    // reported as a note, and the Griffel result stands as it would without the scroll check.
    scroll = [];
    notes = [{ code: 'scroll-check-failed', message: `the scroll-context check could not read the page (${(e && e.message) || e}); open the page and scroll to its end to check it by hand` }];
  }
  if (existing) notes = [...notes, ...scroll];
  const all = existing ? problems : [...problems, ...scroll];
  const result = { ok: all.length === 0, filePath: abs, calls, problems: all };
  if (notes.length) result.notes = notes;
  return { exit: all.length ? 3 : 0, result };
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') { out.filePath = argv[i + 1]; i += 1; }
    else if (argv[i] === '--existing') out.existing = true;
  }
  return out;
}

if (require.main === module) {
  const { exit, result } = checkGriffelStyles(parseArgv(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(result) + '\n');
  // Not process.exit(): a pipe's writes are queued on POSIX (synchronous on Windows), and a page with many findings makes a line longer than the pipe holds, so exiting
  // right after the write would cut it off. https://nodejs.org/api/process.html#a-note-on-process-io
  process.exitCode = exit;
}

module.exports = { checkGriffelStyles };
