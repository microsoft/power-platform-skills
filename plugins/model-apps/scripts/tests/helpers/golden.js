'use strict';
// Shared golden-snapshot helper. Compare mode by default; regenerate with UPDATE_GOLDENS=1.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const GOLDEN_DIR = path.join(__dirname, '..', 'golden');
const UPDATE = process.env.UPDATE_GOLDENS === '1';

// Golden files are text snapshots, so the comparison must not depend on how git checked them out.
// GitHub Actions' windows runner defaults to `core.autocrlf=true`, which rewrites the committed LF
// goldens to CRLF on checkout; the generated `actual` still uses \n, so a byte compare failed every
// golden test on Windows CI while passing on a developer clone with autocrlf off. Normalizing both
// sides compares the CONTENT these snapshots exist to pin. (`.gitattributes` keeps the committed
// bytes LF; this makes the test correct even where that is not honored.)
const normalizeEol = (s) => String(s).replace(/\r\n/g, '\n');

function assertGolden(name, actual) {
  const file = path.join(GOLDEN_DIR, name);
  if (UPDATE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  const expected = fs.readFileSync(file, 'utf8');
  assert.strictEqual(
    normalizeEol(actual),
    normalizeEol(expected),
    `golden mismatch: ${name} — re-run with UPDATE_GOLDENS=1 if the change is intended`
  );
}

module.exports = { assertGolden, GOLDEN_DIR, UPDATE };
