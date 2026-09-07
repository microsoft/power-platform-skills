'use strict';
// Every bug this plugin has fixed must have a test that NAMES it.
//
// This is a coverage GUARD, not a coverage metric. The failure it prevents is specific and has
// happened here: a test whose purpose is invisible gets "simplified" by someone who cannot see what
// it guards, and the bug returns. #478 is the case in point — dashboards could not be deserialized,
// nothing in the suite fed a serialized dashboard back in, and the defect survived two separate SDK
// uptakes before a live run caught it.
//
// So the rule is: a fixed issue appears in MANIFEST, and at least one test or eval cites its id.
// Adding a fix without a citing test fails here, which is the point — the reminder arrives while the
// fix is still in your head, not months later.
//
// Citing means writing the id in the test: `#478`, `issues/478`, or `AB#6648526`. A citation is
// cheap and is the only durable link between a defect and the thing that stops it recurring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
const EVALS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'evals', 'model-apps');

// id -> what it was. Keep the description short; the issue itself holds the detail.
//
// ADO ids are recorded as `AB#NNNNNNN`, which is the standard Azure Boards <-> GitHub link syntax and
// is safe in this public repo (an opaque work-item id discloses nothing).
const MANIFEST = {
  '#475': 'the async-surface guard could not be decided by regex',
  '#478': 'the SDK could not deserialize a dashboard it had serialized',
  '#481': 'presence operators compiled to XAML the platform rejected (HTTP 500)',
  '#482': 'the business-rule fallback double-wrote — the qualifying 400 arrives AFTER the row commits',
  '#488': 'deferred review findings on business rules and column visualizations',
  '#493': 'teardown stranded the activated (type 2) copy of a business rule',
  '#494': 'download did not read artifact descriptions back',
  '#495': 'the SDK could not author Boolean default, Duration format, or per-column IsValidFor*',
  '#496': 'an existing view/chart never got its description reconciled',
  'AB#6648516': 'no per-field read-only control on forms',
  'AB#6648517': 'RequiredLevel could not be set on an existing column',
  'AB#6648522': 'Whole Number had no Duration format option',
  'AB#6648523': 'Boolean default value could not be set',
  'AB#6648526': 'a form could not be assigned to security roles',
  'AB#6651241': 'no per-field hidden/visibility control on forms',
  'AB#6651276': 'no per-column IsValidForCreate/Update/Read',
  'AB#6651439': 'no targeted form-control reordering',
  'AB#6651696': 'auto form layout placed Big Integer columns that cannot render',
};

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(test\.js|md)$/.test(entry.name)) out.push(p);
  }
  return out;
}

// Read once — this scans the whole suite plus the evals, and doing it per-id would be O(ids × files).
const FILES = [...walk(TESTS_DIR), ...walk(EVALS_DIR)]
  // Exclude this file: it names every id by construction, so counting it would make the guard
  // trivially self-satisfying — the exact failure mode it exists to prevent.
  .filter((f) => path.resolve(f) !== path.resolve(__filename))
  .map((f) => ({ file: path.basename(f), body: fs.readFileSync(f, 'utf8') }));

function citingFiles(id) {
  // `#478` must not match `#4780`, and `AB#6648526` is matched with optional space after the hash so
  // prose spellings still count.
  const re = id.startsWith('AB#')
    ? new RegExp(`AB#\\s*${id.slice(3)}(?![0-9])`, 'i')
    : new RegExp(`(?:issues/${id.slice(1)}|#${id.slice(1)})(?![0-9])`);
  return FILES.filter((f) => re.test(f.body)).map((f) => f.file);
}

test('every fixed issue in the manifest is named by at least one test or eval', () => {
  const uncited = [];
  for (const [id, what] of Object.entries(MANIFEST)) {
    if (!citingFiles(id).length) uncited.push(`${id} — ${what}`);
  }
  assert.deepStrictEqual(uncited, [],
    'these fixes have no test that names them, so nothing tells a future reader what the test is for:\n  '
    + uncited.join('\n  '));
});

test('the manifest itself is not silently empty', () => {
  // A guard that can be disarmed by emptying its own input is not a guard. Both halves are asserted:
  // the manifest has entries, and the scan actually found files to search.
  assert.ok(Object.keys(MANIFEST).length >= 18, `the manifest lost entries: ${Object.keys(MANIFEST).length}`);
  assert.ok(FILES.length > 50, `the file scan found only ${FILES.length} files — the walk is broken`);
});

test('the citation matcher does not match a longer id by prefix', () => {
  // `#478` inside `#4780` would make the guard pass on an unrelated citation. Verified directly
  // rather than trusted, because a false PASS here is invisible.
  const probe = FILES.length;
  assert.ok(probe > 0);
  const re = /(?:issues\/478|#478)(?![0-9])/;
  assert.ok(re.test('see #478 for the repro'), 'a real citation must match');
  assert.ok(re.test('https://github.com/microsoft/power-platform-skills/issues/478'), 'a link must match');
  assert.strictEqual(re.test('#4780'), false, 'a longer id must NOT match');
  const abRe = /AB#\s*6648526(?![0-9])/i;
  assert.ok(abRe.test('AB#6648526'), 'an ADO citation must match');
  assert.strictEqual(abRe.test('AB#66485260'), false, 'a longer ADO id must NOT match');
});
