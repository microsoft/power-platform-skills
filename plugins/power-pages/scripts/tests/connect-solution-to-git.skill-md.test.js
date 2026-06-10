'use strict';

// Source-grep regression tests for skills/connect-solution-to-git/SKILL.md.
// Each assertion pins a contract that was added in response to a specific
// live-test finding — if a future edit removes one of these, the test will
// fail loudly so the regression doesn't silently re-ship.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_MD = path.resolve(
  __dirname,
  '..', '..', 'skills', 'connect-solution-to-git', 'SKILL.md',
);

let prose;
test('connect-solution-to-git SKILL.md exists and is readable', () => {
  prose = fs.readFileSync(SKILL_MD, 'utf8');
  assert.ok(prose.length > 1000, 'SKILL.md should be non-trivial in size');
});

// ===== E1 — envUrl ↔ pac env who mismatch hard-fail =====

test('E1: Phase 1 declares `<envUrl>` as a required parameter (no implicit-current-env fallback)', () => {
  assert.match(prose, /Required parameter:\*?\*?\s*`<envUrl>`/i);
  assert.match(prose, /does NOT have an implicit/i);
});

test('E1: Phase 1 step 1 has a verbatim PowerShell snippet calling `pac env who --json`', () => {
  // The snippet MUST contain the literal command, the comparison branch,
  // and the recovery hint pointing at `pac org select --environment`.
  assert.match(prose, /pac env who --json \| ConvertFrom-Json/);
  assert.match(prose, /TrimEnd\('\/'\)\.ToLowerInvariant\(\)/);
  assert.match(prose, /\[envUrl-mismatch\] expected=\$expected actual=\$actual/);
});

test('E1: mismatch recovery prompt offers `pac org select --environment <expected>`', () => {
  assert.match(prose, /pac org select --environment ["{]<?[\w{]/i);
  // The Switch-PAC branch and Cancel branch are both present
  assert.match(prose, /Switch PAC: `pac org select --environment/);
  assert.match(prose, /Cancel — re-run with the correct --envUrl/);
});

test('E1: Key Decision Points table records the envUrl-mismatch recovery prompt at Phase 1', () => {
  // It MUST appear ahead of the prereq-fail gate so the user sees it first.
  const kdpStart = prose.indexOf('## Key Decision Points');
  assert.ok(kdpStart >= 0, 'Key Decision Points section must exist');
  const kdp = prose.slice(kdpStart, kdpStart + 2500);
  assert.match(kdp, /Phase 1\*\*: envUrl mismatch with `pac env who`/);
  // It should be listed at position 1, before the prereq-fail entry.
  const mismatchIdx = kdp.indexOf('envUrl mismatch');
  const prereqIdx = kdp.indexOf('prereq-fail');
  assert.ok(
    mismatchIdx > 0 && prereqIdx > mismatchIdx,
    'envUrl-mismatch entry must precede prereq-fail in Key Decision Points',
  );
});
