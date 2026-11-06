'use strict';
// The plugin's own code — what a user's run can execute — for source-scan tests that pin "no script does X".
//
// Read: every `.js`, `.cjs` and `.mjs` file under scripts/ (the scripts the skills tell an agent to run, and their libraries) and under hooks/ (what the host runs around its tools on every
// session). A scan that listed only scripts/*.js would not see a `pac` started from a hook, or from a CommonJS or ES module file of another extension.
//
// Skipped: vendor/ (the generated SDK bundle), _vendor-build/ (its dev-only bundler), node_modules/, and tests/
// (whose mock SDKs deliberately differ from the real one, and which name the very calls the scans look for).
const fs = require('node:fs');
const path = require('node:path');
const { commentRanges } = require('../../lib/source-literals.js');

const SCRIPTS_DIR = path.resolve(__dirname, '..', '..');
const HOOKS_DIR = path.resolve(SCRIPTS_DIR, '..', 'hooks');
const CODE_ROOTS = [SCRIPTS_DIR, HOOKS_DIR];
const CODE_FILE = /\.(?:js|cjs|mjs)$/;
const SKIPPED_DIRS = new Set(['vendor', '_vendor-build', 'node_modules', 'tests']);

// `roots` is a directory or a list of them (a root that does not exist holds nothing); by default, the plugin's scripts and hooks.
function productionScripts(roots = CODE_ROOTS) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (CODE_FILE.test(entry.name)) {
        files.push(full);
      }
    }
  };
  for (const root of [].concat(roots)) if (fs.existsSync(root)) walk(root);
  return files;
}

// A file as the tests name it: relative to scripts/ with forward slashes (`lib/pac-fallback.js`), and `hooks/…` for a hook.
function scriptLabel(file) {
  const inScripts = path.relative(SCRIPTS_DIR, file);
  const relative = inScripts.startsWith('..') ? path.join('hooks', path.relative(HOOKS_DIR, file)) : inScripts;
  return relative.split(path.sep).join('/');
}

// A sentence in a comment that names a call is not a call. The comments are the ones the plugin's literal-aware lexer finds
// (lib/source-literals.js commentRanges, the lexer the page checks use), so a `//` or `/*` inside a string, a template or a
// regular expression — `'https://host'`, `'a // b'` — is never taken for one, and the code after it is still scanned. A pattern
// matched with a line-start or line-end anchor would see each comment as blank space rather than as nothing: a comment is replaced
// by spaces, its line breaks kept, so an offset or a line number in the result is the source's own.
function withoutComments(source) {
  const text = String(source);
  let out = '';
  let at = 0;
  for (const { start, end } of commentRanges(text)) {
    out += text.slice(at, start) + text.slice(start, end).replace(/[^\r\n]/g, ' ');
    at = end;
  }
  return out + text.slice(at);
}

// The scripts (labelled as scriptLabel does) whose code — not comments — matches `pattern`.
// `search`, not `test`: it ignores a /g pattern's lastIndex, which would skip a file after a match.
function scriptsMatching(pattern) {
  return productionScripts()
    .filter((file) => withoutComments(fs.readFileSync(file, 'utf8')).search(pattern) !== -1)
    .map(scriptLabel)
    .sort();
}

module.exports = { SCRIPTS_DIR, HOOKS_DIR, productionScripts, scriptLabel, withoutComments, scriptsMatching };
