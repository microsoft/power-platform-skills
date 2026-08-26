'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  requirementClauses,
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

test('requires evidence-bound job coverage when App Requirements are present', () => {
  const plan = [
    '# Demo',
    '',
    '## App Requirements',
    '',
    'Track repairs and inspect equipment.',
    '',
    validPlan(),
  ].join('\n');
  assert.ok(validateScreenContracts(plan).some((issue) => issue.rule === 'missing-requirement-coverage'));
});

test('accepts complete requirement coverage and rejects unknown surfaces or invented evidence', () => {
  const coverage = [
    '',
    '### Requirement Coverage',
    '| Requirement | Brief evidence | Surface | Action | Data | States |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Track repairs | Track repairs | Home (`/(app)/home`) | Open repairs | Repair.list | populated, loading, empty, error, retry |',
    '| Inspect equipment | inspect equipment | Profile | Start inspection | Inspection.create | permission denied, retry |',
  ].join('\n');
  const plan = [
    '# Demo',
    '',
    '## App Requirements',
    '',
    'Track repairs and inspect equipment.',
    '',
    validPlan() + coverage,
  ].join('\n');
  assert.deepEqual(validateScreenContracts(plan), []);

  const invalid = plan
    .replace('inspect equipment | Profile', 'invented requirement | Missing screen')
    .replace('Track repairs | Track repairs', 'Track repairs | unsupported phrase');
  const rules = new Set(validateScreenContracts(invalid).map((issue) => issue.rule));
  assert.ok(rules.has('unverified-requirement-evidence'));
  assert.ok(rules.has('unknown-requirement-surface'));
});

test('rejects a coverage table that omits one explicit product job', () => {
  const coverage = [
    '',
    '### Requirement Coverage',
    '| Requirement | Brief evidence | Surface | Action | Data | States |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Track repairs | Track repairs | Home | Open repairs | Repair.list | populated, loading, empty, error, retry |',
  ].join('\n');
  const plan = [
    '# Demo',
    '',
    '## App Requirements',
    '',
    'Track repairs and inspect equipment.',
    '',
    validPlan() + coverage,
  ].join('\n');
  assert.ok(validateScreenContracts(plan).some((issue) => (
    issue.rule === 'uncovered-app-requirement' && /inspect equipment/.test(issue.message)
  )));
});

test('rejects one broad evidence row that collapses independent product jobs', () => {
  const coverage = [
    '',
    '### Requirement Coverage',
    '| Requirement | Brief evidence | Surface | Action | Data | States |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Manage work | Track repairs and inspect equipment | Home | Open repairs | Repair.list | populated, loading, empty, error, retry |',
  ].join('\n');
  const plan = [
    '# Demo',
    '',
    '## App Requirements',
    '',
    'Track repairs and inspect equipment.',
    '',
    validPlan() + coverage,
  ].join('\n');
  const rules = new Set(validateScreenContracts(plan).map((issue) => issue.rule));
  assert.ok(rules.has('ambiguous-requirement-evidence'));
  assert.ok(rules.has('uncovered-app-requirement'));
});

test('extracts action-led jobs from exact operational benchmark prose', () => {
  const gym = 'Create an app for maintining and auditing equipment at gym user should be able to get maintence records of equipment by scanning a qr code, the company owns multiple gyms, the app should support tracking issues, on going repairs, upcoming maintennce and warranty for equipments';
  assert.deepEqual(requirementClauses(gym), [
    'maintining',
    'auditing equipment at gym',
    'get maintence records of equipment by scanning a qr code',
    'tracking issues, on going repairs, upcoming maintennce and warranty for equipments',
  ]);

  const receiving = 'Design a mobile-first, offline field receiving solution. Enable field logisticians and inspectors to view expected shipments, scan barcodes or QR codes, record received and damaged quantities, capture inspection results, enter batch and expiry data, photograph damage, record GPS location, obtain recipient confirmation, and continue working with limited connectivity.';
  assert.deepEqual(requirementClauses(receiving), [
    'view expected shipments',
    'scan barcodes or QR codes',
    'record received and damaged quantities',
    'capture inspection results',
    'enter batch and expiry data',
    'photograph damage',
    'record GPS location',
    'obtain recipient confirmation',
    'continue working with limited connectivity',
  ]);
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
