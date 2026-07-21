'use strict';

/**
 * Regression tests guarding the plan-alm Q2 "Strategy Selection" UX.
 *
 * Context: a prior run picked Manual export/import because
 * (a) no option in Q2 was labeled "(Recommended)", and
 * (b) the comparison/recommendation text was hidden behind option 4 ("Help me decide").
 * The reader had nothing to anchor on, so it guessed wrong.
 *
 * Fix: option 1 carries an explicit "(Recommended ...)" label, option 2 is qualified
 * as one-off, and the recommendation is surfaced inline in the prompt body. These tests
 * fail loudly if any of those guardrails regress.
 *
 * (Note: an earlier draft also added an "autopilot defaults" policy + a manual-confirm
 * gate. Those were reverted — a skill can't reliably detect it is running unattended,
 * and the "(Recommended)" label already anchors the choice in attended and unattended
 * runs alike. plan-alm is also plan-only, so a wrong Q2 pick produces a reviewable plan,
 * not an action.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SKILL_MD = path.resolve(
  __dirname,
  '..',
  '..',
  'skills',
  'plan-alm',
  'SKILL.md'
);

function readSkill() {
  return fs.readFileSync(SKILL_MD, 'utf8');
}

function extractQ2Section(skill) {
  const q2Heading = skill.indexOf('### Q2 — Strategy Selection');
  assert.notEqual(q2Heading, -1, 'Q2 section heading must exist');
  // Q2 section ends at the next "### " heading (e.g. the PP Pipelines Path section)
  const nextHeading = skill.indexOf('\n### ', q2Heading + 5);
  assert.notEqual(nextHeading, -1, 'A section after Q2 must exist');
  return skill.slice(q2Heading, nextHeading);
}

test('plan-alm Q2: PP Pipelines option is labeled "(Recommended ...)"', () => {
  const q2 = extractQ2Section(readSkill());
  assert.match(
    q2,
    /Power Platform Pipelines\s*\(Recommended[^)]*\)/i,
    'Q2 option 1 must carry an explicit "(Recommended ...)" marker so the recommendation is in the option label itself, not hidden behind another option.'
  );
});

test('plan-alm Q2: Manual option is qualified as "one-off"', () => {
  const q2 = extractQ2Section(readSkill());
  assert.match(
    q2,
    /Manual export\/import\s*\(one-off[^)]*\)/i,
    'Q2 option 2 must include a "(one-off ...)" qualifier so Manual is not treated as equivalent to PP Pipelines for ongoing CI/CD.'
  );
});

test('plan-alm Q2: recommendation comparison is shown inline (not only behind option 4)', () => {
  const q2 = extractQ2Section(readSkill());
  assert.match(
    q2,
    /Recommendation:\s*Power Platform Pipelines/i,
    'Q2 must surface the recommendation paragraph inline in the prompt body. Hiding it behind option 4 ("Help me decide") leaves the reader guessing.'
  );
});
