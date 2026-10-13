#!/usr/bin/env node
'use strict';
// Pre-transpile gate for /genpage: does a generated page write a CSS shorthand that Griffel drops at runtime?
//
// `pac model genpage transpile` does not run `makeStyles` and TypeScript does not know Griffel's list, so a page with `borderWidth: '1px'` in a style object
// compiles, uploads and then renders without the border (the browser console logs `@griffel/react: You are using unsupported shorthand CSS property`). The rule itself
// — which ten properties, and where in the page they count — lives in lib/griffel-styles.js. This wrapper exists so the orchestrator, an AI following SKILL.md,
// gets a yes/no answer it cannot talk itself past, instead of a grep it has to read the result of.
//
// Usage:
//   node check-griffel-styles.js --file <page.tsx>
//
// Output (one JSON line) and exit code:
//   0  {"ok":true,"filePath":…,"calls":1,"problems":[]}
//   3  {"ok":false,…,"problems":[{"code","property","line","column","longhands","within","value","message"}]}   — rewrite those keys with the longhands, then check again
//   1  {"ok":false,"error":…}   — usage error, or the file cannot be read
// `calls` is how many makeStyles calls were read. A problem's `code` is `unsupported-shorthand`; or `unread-style-object`, a style object the checker cannot see — one
// passed to the call (`makeStyles(styles)`), a slot or a selector given a variable, a spread of anything but an inline object — whose keys may be any of the ten, or a
// computed key it cannot read as a name (`[key]: …`), so it is never reported as clean (write it inline); or — where the checker cannot read the code for certain —
// `unverifiable-style-call` and `unbalanced-style-call`. `within` is
// the slot, selectors and at-rules a key sits under (`["root", ":hover"]`): where it is apart from its line, and `value` is what the key is set to, as written (a quoted
// string as its text in double quotes, anything else as its source text): together they let genpage-upload.js tell a key a page already had, set the same, from a new or
// a changed one.

const fs = require('node:fs');
const path = require('node:path');
const { griffelStyleProblems } = require('./lib/griffel-styles.js');

function checkGriffelStyles({ filePath }) {
  if (!filePath) return { exit: 1, result: { ok: false, error: '--file is required' } };
  const abs = path.resolve(filePath);
  let source;
  try {
    source = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { exit: 1, result: { ok: false, filePath: abs, error: `--file could not be read: ${(e && e.code) || e}` } };
  }
  const { calls, problems } = griffelStyleProblems(source);
  return { exit: problems.length ? 3 : 0, result: { ok: problems.length === 0, filePath: abs, calls, problems } };
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') { out.filePath = argv[i + 1]; i += 1; }
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
