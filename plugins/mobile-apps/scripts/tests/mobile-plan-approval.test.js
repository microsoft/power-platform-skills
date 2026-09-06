'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  approveGate,
  invalidateApprovalReceipt,
  validateIntegrity,
} = require('../lib/mobile-plan-approval');
const {
  validateApprovalReceipt,
} = require('../build-dataverse-operation-manifest');

const NOW = '2026-09-04T00:00:00.000Z';

function writeJson(root, relativePath, value) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function contract() {
  return {
    schemaVersion: 1,
    publisherPrefix: 'new',
    tables: [{
      logicalName: 'new_item',
      schemaName: 'new_item',
      displayName: 'Item',
      displayCollectionName: 'Items',
      plannedDecision: 'create',
      dependencyTier: 0,
      serviceRequired: true,
      ownershipType: 'UserOwned',
      columns: [{
        logicalName: 'new_name',
        schemaName: 'new_name',
        displayName: 'Name',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'ApplicationRequired',
        primaryName: true,
      }],
      relationships: [],
      alternateKeys: [],
    }],
  };
}

function plan() {
  return `# Test app

## Overview
Overview.

## App Requirements
Track items.

## Product Experience
Precise.

## Product Scope
One workflow.

## Native Capabilities
None.

## Connectors
None.

## Persistence
Dataverse.

## Data Model
One Item table.

## Design
Operational.

## Screens
Home.

## Approval Status
Pending.

## Plan Provenance
Generated from contracts.
`;
}

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-plan-approval-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), plan());
  writeJson(root, '.tmp/product-experience-contract.json', {
    schemaVersion: 1,
    contractType: 'product-experience',
    productName: 'Test app',
  });
  writeJson(root, '.tmp/product-scope-contract.json', {
    schemaVersion: 1,
    contractType: 'product-scope',
    screens: [{ id: 'home' }],
  });
  writeJson(root, '.tmp/navigation-manifest.json', {
    schemaVersion: 1,
    navigationRevision: 'navigation-revision',
  });
  writeJson(root, '.tmp/architecture-decisions.json', {
    schemaVersion: 1,
    nativeCapabilities: [{ id: 'camera', displayName: 'Camera', approved: true }],
    connectors: [],
    conceptOwners: [],
  });
  writeJson(root, '.tmp/persistence-contract.json', {
    schemaVersion: 1,
    mode: 'dataverse',
    persistenceRevision: 'persistence-revision',
  });
  writeJson(root, '.tmp/dataverse-schema-contract.json', contract());
  writeJson(root, '.tmp/workflow-journey-contract.json', {
    schemaVersion: 1,
    contractType: 'workflow-journey',
    journeys: [],
  });
  writeJson(root, '.tmp/compiled-screen-build-pack.json', {
    schemaVersion: 1,
    contractType: 'compiled-screen-build-pack',
    compiledRevision: 'build-pack-revision',
  });
  writeJson(root, '.tmp/scenario-facts.json', {
    schemaVersion: 1,
    scenarioRevision: 'scenario-revision',
  });
  writeJson(root, '.tmp/data-model-usage.json', {
    schemaVersion: 1,
    usageRevision: 'usage-revision',
    tables: [{
      tableLogicalName: 'new_item',
      consumers: [{ kind: 'screen', id: 'home' }],
    }],
  });
  fs.writeFileSync(path.join(root, '_plan_preview.html'), '<!doctype html><title>Preview</title>');
  return root;
}

test('four gates produce a manifest-compatible, integrity-bound receipt', (context) => {
  const root = project(context);
  for (let gate = 1; gate <= 4; gate += 1) approveGate(root, gate, { now: NOW });
  const receipt = JSON.parse(fs.readFileSync(
    path.join(root, '.tmp/mobile-plan-status.json'),
    'utf8',
  ));

  assert.deepEqual(validateIntegrity(receipt), { valid: true, errors: [] });
  assert.equal(receipt.receiptState, 'complete');
  assert.equal(receipt.approvals.dataModel.status, 'approved');
  assert.equal(receipt.approvals.screenPlan.status, 'approved');
  assert.equal(receipt.implementation.status, 'approved');
  assert.deepEqual(receipt.serviceRequiredTables, [{
    logicalName: 'new_item',
    consumers: ['screen:home'],
  }]);
  assert.deepEqual(validateApprovalReceipt(receipt, {
    contract: contract(),
    planBytes: fs.readFileSync(path.join(root, 'native-app-plan.md')),
  }), { valid: true, errors: [] });
});

test('Gate 2 invalidation preserves Gate 1 and removes execution authority', (context) => {
  const root = project(context);
  let receipt;
  for (let gate = 1; gate <= 4; gate += 1) receipt = approveGate(root, gate, { now: NOW });
  const invalidated = invalidateApprovalReceipt(receipt, {
    fromGate: 2,
    reason: 'data-model-edited',
    now: '2026-09-04T01:00:00.000Z',
  });

  assert.equal(invalidated.gates.gate1.status, 'approved');
  assert.equal(invalidated.gates.gate2.status, 'pending');
  assert.equal(invalidated.approvals.nativeCapabilities.status, 'approved');
  assert.equal(invalidated.approvals.dataModel.status, 'pending');
  assert.equal(invalidated.implementation.status, 'pending');
  assert.equal(invalidated.approvedContract, undefined);
  assert.equal(invalidated.serviceRequiredTables, undefined);
  assert.deepEqual(validateIntegrity(invalidated), { valid: true, errors: [] });
});

test('gate order and stale prior sections fail closed', (context) => {
  const root = project(context);
  assert.throws(() => approveGate(root, 2, { now: NOW }), /Gate 1 must be approved/);
  approveGate(root, 1, { now: NOW });
  const planPath = path.join(root, 'native-app-plan.md');
  fs.writeFileSync(
    planPath,
    fs.readFileSync(planPath, 'utf8').replace('Track items.', 'Track different items.'),
  );
  assert.throws(() => approveGate(root, 2, { now: NOW }), /Gate 1 plan sections changed/);
});

test('approval CLI validates the receipt written by the library', (context) => {
  const root = project(context);
  approveGate(root, 1, { now: NOW });
  const script = path.resolve(__dirname, '..', 'mobile-plan-approval.js');
  const result = spawnSync(process.execPath, [
    script,
    'validate',
    '--project-root',
    root,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('Gate 1 can bind architecture before the human plan is rendered', (context) => {
  const root = project(context);
  fs.rmSync(path.join(root, 'native-app-plan.md'));
  const receipt = approveGate(root, 1, { now: NOW });
  assert.equal(receipt.gates.gate1.status, 'approved');
  assert.deepEqual(Object.keys(receipt.gates.gate1.artifactRevisions).sort(), [
    'architecture',
    'experience',
    'navigation',
    'persistence',
    'scope',
  ]);
  assert.equal(receipt.gates.gate1.planSha256, undefined);
  assert.deepEqual(validateIntegrity(receipt), { valid: true, errors: [] });
});