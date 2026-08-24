'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  validateScreenContracts,
  validateScreenContractsWithExperience,
} = require('../validate-screen-contracts');
const { deriveExperienceFromBrief } = require('../experience-patterns');

function validPlan() {
  return [
    '# Demo',
    '',
    '## Screens',
    '',
    '### Screen Map',
    '| Screen | Route | File | Presentation |',
    '| --- | --- | --- | --- |',
    '| Home | /(app)/home | app/(app)/home.tsx | tab |',
    '| Profile | /(app)/profile | app/(app)/profile.tsx | tab |',
    '',
    '### Navigation Contracts',
    '| Route | Path params | Query params | Intent |',
    '| --- | --- | --- | --- |',
    '| /(app)/home | none | none | navigate |',
    '| /(app)/profile | none | none | navigate |',
  ].join('\n');
}

test('accepts a complete Screen Map and Navigation Contracts table', () => {
  assert.deepEqual(validateScreenContracts(validPlan()), []);
});

test('accepts routes and Expo Router files formatted as Markdown inline code', () => {
  const plan = validPlan()
    .replace(
      '| Home | /(app)/home | app/(app)/home.tsx |',
      '| Home | `/(app)/home` | `app/(app)/home.tsx` |',
    )
    .replace(
      '| Profile | /(app)/profile | app/(app)/profile.tsx |',
      '| Profile | `/(app)/profile` | `app/(app)/profile.tsx` |',
    )
    .replace('| /(app)/home | none |', '| `/(app)/home` | none |')
    .replace('| /(app)/profile | none |', '| `/(app)/profile` | none |');
  assert.deepEqual(validateScreenContracts(plan), []);
});

test('rejects duplicate routes and a missing canonical Home file', () => {
  const plan = validPlan()
    .replace('app/(app)/home.tsx', 'app/(app)/index.tsx')
    .replace('| Profile | /(app)/profile |', '| Profile | /(app)/home |');
  const rules = new Set(validateScreenContracts(plan).map((issue) => issue.rule));
  assert.ok(rules.has('duplicate-screen-route'));
  assert.ok(rules.has('missing-canonical-home'));
});

test('rejects a plan without navigation contracts', () => {
  const plan = validPlan().replace(/\n### Navigation Contracts[\s\S]*$/, '');
  const rules = new Set(validateScreenContracts(plan).map((issue) => issue.rule));
  assert.ok(rules.has('missing-navigation-contracts'));
});

test('composes the experience gate when the project has a contract sidecar', (context) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-contract-experience-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-contract.json'), JSON.stringify(
    deriveExperienceFromBrief('Help learners continue a course and finish the next lesson.'),
  ));
  fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), validPlan());

  const rules = new Set(validateScreenContractsWithExperience(validPlan(), projectRoot, 'plan')
    .map((issue) => issue.rule));
  assert.ok(rules.has('missing-plan-experience-summary'));
  assert.ok(rules.has('missing-artifact'));
});
