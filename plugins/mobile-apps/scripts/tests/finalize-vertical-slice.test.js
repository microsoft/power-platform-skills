'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(
  __dirname,
  '..',
  '..',
  'skills',
  'create-mobile-prototype',
  'scripts',
  'finalize-vertical-slice.js',
);

function write(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function run(root, action) {
  return spawnSync(process.execPath, [script, root, action], { encoding: 'utf8' });
}

function validFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vertical-slice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const plan = `# Equipment care

## Delivery Scope

## Screens
| Screen | Route | File |
|---|---|---|
| Overview | /(app)/home | app/(app)/home.tsx |
| Equipment | /(app)/equipment | app/(app)/equipment.tsx |
| Report issue | /(app)/issues/new | app/(app)/issues/new.tsx |
| Profile | /(app)/profile | app/(app)/profile.tsx |
`;
  write(root, 'native-app-plan.md', plan);
  write(root, '.tmp/dataverse-schema-contract.json', {
    schemaVersion: 1,
    planningMode: 'prototype',
    executionEligible: false,
    tables: [
      { logicalName: 'cr_equipment', plannedDecision: 'create', serviceRequired: true },
      { logicalName: 'cr_issue', plannedDecision: 'create', serviceRequired: true },
    ],
  });
  write(root, '.tmp/vertical-slice-contract.json', {
    schemaVersion: 1,
    deliveryMode: 'vertical-slice',
    sliceGoal: 'Scan or select equipment and report a visible issue.',
    acceptanceJourney: [
      'Open overview',
      'Select equipment',
      'Review equipment',
      'Report issue',
      'See the issue in the equipment summary',
    ],
    included: {
      screens: [
        { name: 'Overview', route: '/(app)/home', file: 'app/(app)/home.tsx' },
        { name: 'Equipment', route: '/(app)/equipment', file: 'app/(app)/equipment.tsx' },
        { name: 'Report issue', route: '/(app)/issues/new', file: 'app/(app)/issues/new.tsx' },
      ],
      baselineScreens: [
        { name: 'Profile', route: '/(app)/profile', file: 'app/(app)/profile.tsx' },
      ],
      entityLogicalNames: ['cr_equipment', 'cr_issue'],
      nativeCapabilities: ['camera'],
      connectors: [],
    },
    deferred: {
      requirements: ['Complete preventive maintenance'],
      screens: ['Maintenance queue'],
      entities: ['Maintenance task'],
      nativeCapabilities: [],
      connectors: [],
    },
  });
  write(root, '.tmp/mobile-plan-status.json', {
    schemaVersion: 1,
    approvedPlanSha256: hash(plan),
  });
  write(root, '.tmp/final-validation.md', `Overall: PASS
Plan: ${hash(plan)}
PASS check-routes.js
PASS validate-screen-contracts.js
PASS validate-screen-quality.js --report
PASS validate-color-contrast.js --report
PASS npm run type-check
PASS validate-mobile-files.js
`);
  return { root, plan };
}

test('checks, finalizes, and expands a hash-bound vertical slice', (t) => {
  const { root } = validFixture(t);

  const checked = run(root, 'check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /valid \(3 business screens/);

  const finalized = run(root, 'finalize');
  assert.equal(finalized.status, 0, finalized.stderr);
  const receiptPath = path.join(root, '.mobile-app', 'vertical-slice.json');
  const finalizedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(finalizedReceipt.status, 'validated');
  assert.equal(finalizedReceipt.included.screens.length, 3);
  assert.equal(finalizedReceipt.deferred.requirements.length, 1);

  const expandedPlan = `${fs.readFileSync(path.join(root, 'native-app-plan.md'), 'utf8')}\nExpanded maintenance scope.\n`;
  write(root, 'native-app-plan.md', expandedPlan);
  write(root, '.tmp/mobile-plan-status.json', {
    schemaVersion: 1,
    approvedPlanSha256: hash(expandedPlan),
  });
  write(root, '.mobile-app/state.json', {
    schemaVersion: 1,
    dataMode: 'prototype',
    environment: null,
    transition: null,
    lastSyncedPlanHash: hash(expandedPlan),
    lastDataverseManifestHash: null,
    lastSyncAt: new Date().toISOString(),
  });
  write(root, '.tmp/final-validation.md', `Overall: PASS
Plan: ${hash(expandedPlan)}
PASS check-routes.js
PASS validate-screen-contracts.js
PASS validate-screen-quality.js --report
PASS validate-color-contrast.js --report
PASS npm run type-check
PASS validate-mobile-files.js
`);

  const expanded = run(root, 'expand');
  assert.equal(expanded.status, 0, expanded.stderr);
  const expandedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(expandedReceipt.status, 'expanded');
  assert.equal(expandedReceipt.expandedScope.requirements.length, 1);
  assert.deepEqual(expandedReceipt.deferred, {
    requirements: [],
    screens: [],
    entities: [],
    nativeCapabilities: [],
    connectors: [],
  });
});

test('rejects slices outside the screen cap and schema boundary', (t) => {
  const { root } = validFixture(t);
  const contractPath = path.join(root, '.tmp', 'vertical-slice-contract.json');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

  contract.included.screens = contract.included.screens.slice(0, 2);
  write(root, '.tmp/vertical-slice-contract.json', contract);
  const tooSmall = run(root, 'check');
  assert.equal(tooSmall.status, 1);
  assert.match(tooSmall.stderr, /3-6 user-visible business screens/);

  contract.included.screens.push({
    name: 'Equipment detail',
    route: '/(app)/equipment/1',
    file: 'app/(app)/equipment/[id].tsx',
  });
  contract.deferred.nativeCapabilities = ['camera'];
  write(root, '.tmp/vertical-slice-contract.json', contract);
  const overlap = run(root, 'check');
  assert.equal(overlap.status, 1);
  assert.match(overlap.stderr, /native capability appears in both included and deferred scope/);

  contract.deferred.nativeCapabilities = [];
  contract.included.entityLogicalNames = ['cr_equipment'];
  write(root, 'native-app-plan.md', `${fs.readFileSync(path.join(root, 'native-app-plan.md'), 'utf8')}\n/(app)/equipment/1 app/(app)/equipment/[id].tsx\n`);
  write(root, '.tmp/vertical-slice-contract.json', contract);
  const schemaMismatch = run(root, 'check');
  assert.equal(schemaMismatch.status, 1);
  assert.match(schemaMismatch.stderr, /must exactly match service-required tables/);
});
