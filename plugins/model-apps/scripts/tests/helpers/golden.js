'use strict';
// Shared golden-snapshot helper. Compare mode by default; regenerate with UPDATE_GOLDENS=1.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const GOLDEN_DIR = path.join(__dirname, '..', 'golden');
const UPDATE = process.env.UPDATE_GOLDENS === '1';

function assertGolden(name, actual) {
  const file = path.join(GOLDEN_DIR, name);
  if (UPDATE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    // Normalize CRLF -> LF on write too, so regenerating a golden on Windows (with
    // core.autocrlf=true) doesn't persist CRLF into the checked-in file and produce
    // whole-file diffs on the next reader. Read path also normalizes for defense in depth.
    fs.writeFileSync(file, actual.replace(/\r\n/g, '\n'));
    return;
  }
  // Normalize CRLF -> LF on both sides. Golden files are stored LF in git, but with
  // core.autocrlf=true (Windows default) they check out as CRLF, and buildPlan/journal
  // output is always LF. Stripping CR here keeps the comparison content-based and
  // avoids per-developer .gitattributes drift breaking the suite. Applies to every
  // golden (plan, sitemap, journal) — root-cause pattern fix, not per-file.
  const expected = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const actualNormalized = actual.replace(/\r\n/g, '\n');
  assert.strictEqual(actualNormalized, expected, `golden mismatch: ${name} — re-run with UPDATE_GOLDENS=1 if the change is intended`);
}

module.exports = { assertGolden, GOLDEN_DIR, UPDATE };
