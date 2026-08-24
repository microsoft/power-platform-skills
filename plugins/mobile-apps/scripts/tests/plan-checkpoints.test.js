'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { contractHash } = require('../experience-patterns');
const { sha256: executionSha256 } = require('../lib/mobile-plan-execution-contract');
const { validateApprovalReceipt } = require('../build-dataverse-operation-manifest');
const { currentRevision } = require('../plan-approval');

const script = path.resolve(__dirname, '..', 'plan-checkpoints.js');

function makeProject(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-plan-checkpoints-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), '# Draft plan\n');
  fs.writeFileSync(path.join(root, 'brief.md'), 'Approve this app plan.');
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{},"devDependencies":{}}\n');
  fs.writeFileSync(path.join(root, '.tmp', 'dataverse-schema-contract.json'), JSON.stringify({
    schemaVersion: 1,
    publisherPrefix: 'cr1',
    tables: [{
      logicalName: 'cr1_item',
      schemaName: 'cr1_item',
      displayName: 'Item',
      displayCollectionName: 'Items',
      plannedDecision: 'create',
      dependencyTier: 0,
      serviceRequired: true,
      ownershipType: 'UserOwned',
      columns: [{
        logicalName: 'cr1_name',
        schemaName: 'cr1_name',
        displayName: 'Name',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'ApplicationRequired',
        primaryName: true,
      }],
      relationships: [],
      alternateKeys: [],
    }],
  }, null, 2));
  const experience = { schemaVersion: 1 };
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), `${JSON.stringify(experience)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-screen-contract.json'), '{"schemaVersion":3,"screens":[]}\n');
  fs.writeFileSync(path.join(root, '.tmp', 'experience-foundation-contract.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-execution-contract.json'), `${JSON.stringify({
    schemaVersion: 1,
    experienceContractSha256: contractHash(experience),
    briefSha256: executionSha256('Approve this app plan.'),
    requirements: [{ id: 'req-approve-plan', source: 'Approve this app plan.', priority: 'required', kind: 'job', satisfiedBy: ['screen-plan'], status: 'planned' }],
    nativeCapabilities: [], javascriptDependencies: [], connectorOperations: [],
  })}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-execution-preflight.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'mobile-plan-execution-preflight',
    experienceContractSha256: contractHash(experience),
    briefSha256: executionSha256('Approve this app plan.'),
    templateCatalogRevision: 'a'.repeat(64),
    requirements: [{ id: 'req-approve-plan', source: 'Approve this app plan.', priority: 'required', kind: 'job', ordinal: 0 }],
    nativeCapabilities: [], javascriptDependencies: [], connectorHints: [], blockers: [],
  })}\n`);
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [script, '--project-root', root, ...args], { encoding: 'utf8' });
}

function output(result) {
  return JSON.parse(result.stdout);
}

test('prototype uses four textual checkpoints without external mutation authorization', (context) => {
  const root = makeProject(context);
  const draft = run(root, '--action', 'draft', '--workflow', 'create-mobile-prototype');
  assert.equal(draft.status, 0, draft.stderr);
  const pending = output(draft);
  assert.equal(pending.status, 'needs-user-approval');
  assert.equal(pending.mayAuthorizeExternalMutations, false);
  assert.deepEqual(pending.sections, ['data-model', 'native-capabilities', 'connectors', 'screen-plan']);
  assert.match(pending.approvalId, /^[a-f0-9]{64}$/);

  for (const section of ['data-model', 'native-capabilities', 'connectors']) {
    const checkpoint = run(root, '--action', 'approve', '--workflow', 'create-mobile-prototype', '--section', section, '--response', 'approve', '--now', '2026-08-24T00:00:00.000Z');
    assert.equal(checkpoint.status, 0, checkpoint.stderr);
    assert.equal(output(checkpoint).status, 'needs-user-approval');
  }
  const last = run(root, '--action', 'approve', '--workflow', 'create-mobile-prototype', '--section', 'screen-plan', '--response', 'approve', '--now', '2026-08-24T00:00:00.000Z');
  assert.equal(last.status, 0, last.stderr);
  assert.equal(output(last).status, 'approved');
  assert.equal(output(last).mayAuthorizeExternalMutations, false);
  assert.equal(run(root, '--action', 'status', '--workflow', 'create-mobile-prototype').status, 0);

  fs.appendFileSync(path.join(root, '.tmp', 'experience-screen-contract.json'), '\n');
  const stale = run(root, '--action', 'status', '--workflow', 'create-mobile-prototype');
  assert.equal(stale.status, 2);
  const refreshed = output(stale);
  assert.equal(refreshed.reason, 'plan-revision-changed');
  assert.deepEqual(refreshed.approvedSections, []);
});

test('prototype approval requires one explicitly named section and cannot bulk-approve checkpoints', (context) => {
  const root = makeProject(context);
  assert.equal(run(root, '--action', 'draft', '--workflow', 'create-mobile-prototype').status, 0);

  for (const args of [
    ['--action', 'approve', '--workflow', 'create-mobile-prototype', '--response', 'approve'],
    ['--action', 'approve', '--workflow', 'create-mobile-prototype', '--section', 'all', '--response', 'approve'],
  ]) {
    const result = run(root, ...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires exactly one named --section/);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'mobile-plan-status.json'), 'utf8'));
    assert.deepEqual(state.approvals, {
      dataModel: { status: 'pending' },
      nativeCapabilities: { status: 'pending' },
      connectors: { status: 'pending' },
      screenPlan: { status: 'pending' },
    });
  }
});

test('real app all-section textual approval persists a Dataverse-valid receipt', (context) => {
  const root = makeProject(context);
  const draft = run(root, '--action', 'draft', '--workflow', 'create-mobile-app');
  assert.equal(draft.status, 0, draft.stderr);
  assert.equal(output(draft).mayAuthorizeExternalMutations, false);
  const approve = run(root, '--action', 'approve', '--workflow', 'create-mobile-app', '--section', 'all', '--response', 'approve', '--now', '2026-08-24T00:00:00.000Z');
  assert.equal(approve.status, 0, approve.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'mobile-plan-status.json'), 'utf8'));
  const revision = currentRevision(root);
  const validation = validateApprovalReceipt(receipt, {
    contract: revision.contract,
    planBytes: revision.planBytes,
  });
  assert.equal(validation.valid, true, validation.errors.join('; '));
  assert.equal(receipt.approvalProtocol, 'textual-checkpoints');
  assert.equal(receipt.mayAuthorizeExternalMutations, true);
});

test('connector-only real plans can complete textual approval without a Dataverse schema', (context) => {
  const root = makeProject(context);
  fs.writeFileSync(path.join(root, '.tmp', 'dataverse-schema-contract.json'), 'null\n');
  assert.equal(run(root, '--action', 'draft', '--workflow', 'create-mobile-app').status, 0);
  const approve = run(root, '--action', 'approve', '--workflow', 'create-mobile-app', '--section', 'all', '--response', 'approve', '--now', '2026-08-24T00:00:00.000Z');
  assert.equal(approve.status, 0, approve.stderr);
  const status = run(root, '--action', 'status', '--workflow', 'create-mobile-app');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(output(status).mayAuthorizeExternalMutations, true);
});

test('checkpoint draft rejects incomplete foreground artifact bundles', (context) => {
  const root = makeProject(context);
  fs.rmSync(path.join(root, '.tmp', 'experience-foundation-contract.json'));
  const draft = run(root, '--action', 'draft', '--workflow', 'create-mobile-prototype');
  assert.equal(draft.status, 2);
  assert.match(draft.stderr, /Planning artifacts are missing: experienceFoundationContractSha256/);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'mobile-plan-status.json')), false);
});
