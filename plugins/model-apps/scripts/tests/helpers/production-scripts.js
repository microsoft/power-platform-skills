'use strict';
// The plugin's own scripts — what a user's run can execute — for source-scan tests that pin "no script does X".
//
// Skipped: vendor/ (the generated SDK bundle), _vendor-build/ (its dev-only bundler), node_modules/, and tests/
// (whose mock SDKs deliberately differ from the real one, and which name the very calls the scans look for).
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS_DIR = path.resolve(__dirname, '..', '..');
const SKIPPED_DIRS = new Set(['vendor', '_vendor-build', 'node_modules', 'tests']);

function productionScripts(dir = SCRIPTS_DIR) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...productionScripts(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

// A sentence in a comment that names a call is not a call. A `//` only starts a comment at the start of a line
// or after whitespace, so the one in `'https://host'` survives and the code after a URL is still scanned.
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

// The scripts (paths relative to scripts/, forward slashes) whose code — not comments — matches `pattern`.
// `search`, not `test`: it ignores a /g pattern's lastIndex, which would skip a file after a match.
function scriptsMatching(pattern) {
  return productionScripts()
    .filter((file) => withoutComments(fs.readFileSync(file, 'utf8')).search(pattern) !== -1)
    .map((file) => path.relative(SCRIPTS_DIR, file).split(path.sep).join('/'))
    .sort();
}

module.exports = { SCRIPTS_DIR, productionScripts, withoutComments, scriptsMatching };
