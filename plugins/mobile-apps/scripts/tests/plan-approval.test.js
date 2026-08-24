'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { contractHash } = require('../experience-patterns');
const { sha256: executionSha256 } = require('../lib/mobile-plan-execution-contract');
const {
  approvalStatus,
  approvedReceipt,
  currentRevision,
  pendingApprovalState,
  textApprovalResponse,
} = require('../plan-approval');
const { validateApprovalReceipt } = require('../build-dataverse-operation-manifest');
const approvalScript = path.resolve(__dirname, '..', 'plan-approval.js');

function makeProject(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-plan-approval-'));
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
  writeExperienceArtifacts(root);
  return root;
}

function writeExperienceArtifacts(root) {
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
}

test('textual approval produces a receipt accepted by the existing Dataverse mutation gate', (context) => {
  const root = makeProject(context);
  const draft = spawnSync(process.execPath, [
    approvalScript,
    '--project-root', root,
    '--action', 'draft',
    '--workflow', 'create-mobile-app',
  ], { encoding: 'utf8' });
  assert.equal(draft.status, 0, draft.stderr);
  assert.match(draft.stdout, /"status": "needs-user-approval"/);
  const approve = spawnSync(process.execPath, [
    approvalScript,
    '--project-root', root,
    '--action', 'approve',
    '--workflow', 'create-mobile-app',
    '--response', 'approve',
    '--now', '2026-08-24T00:00:00.000Z',
  ], { encoding: 'utf8' });
  assert.equal(approve.status, 0, approve.stderr);
  assert.match(approve.stdout, /"status": "approved"/);
  const revision = currentRevision(root);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'mobile-plan-status.json'), 'utf8'));
  const validation = validateApprovalReceipt(receipt, {
    contract: revision.contract,
    planBytes: revision.planBytes,
  });
  assert.equal(validation.valid, true, validation.errors.join('; '));
  assert.equal(receipt.approvals.dataModel.method, 'textual');
  assert.equal(textApprovalResponse('approve'), true);
  assert.equal(textApprovalResponse('approved'), true);
  assert.equal(textApprovalResponse('looks good'), false);
});

test('a changed plan revision invalidates an earlier textual approval', (context) => {
  const root = makeProject(context);
  const revision = currentRevision(root);
  const receipt = approvedReceipt(revision, 'create-mobile-app', '2026-08-24T00:00:00.000Z');
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-status.json'), JSON.stringify(receipt, null, 2));
  assert.equal(approvalStatus(root).status, 'approved');

  fs.appendFileSync(path.join(root, 'native-app-plan.md'), '\nChanged after approval.\n');
  const stale = approvalStatus(root);
  assert.equal(stale.status, 'needs-user-approval');
  assert.equal(stale.reason, 'plan-revision-changed');
});

test('schema and experience sidecars invalidate an earlier textual approval', (context) => {
  for (const relativePath of [
    '.tmp/dataverse-schema-contract.json',
    '.tmp/experience-contract.json',
    '.tmp/experience-screen-contract.json',
    '.tmp/experience-foundation-contract.json',
    '.tmp/mobile-plan-execution-contract.json',
    '.tmp/mobile-plan-execution-preflight.json',
  ]) {
    const root = makeProject(context);
    writeExperienceArtifacts(root);
    const revision = currentRevision(root);
    const receipt = approvedReceipt(revision, 'create-mobile-app', '2026-08-24T00:00:00.000Z');
    fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-status.json'), JSON.stringify(receipt, null, 2));
    assert.equal(approvalStatus(root).status, 'approved', relativePath);

    fs.appendFileSync(path.join(root, relativePath), '\n');
    const stale = approvalStatus(root);
    assert.equal(stale.status, 'needs-user-approval', relativePath);
    assert.equal(stale.reason, 'plan-revision-changed', relativePath);
  }
});

test('an unchanged approved revision remains approved when the outer workflow rechecks its draft', (context) => {
  const root = makeProject(context);
  const revision = currentRevision(root);
  const receipt = approvedReceipt(revision, 'create-mobile-app', '2026-08-24T00:00:00.000Z');
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-status.json'), JSON.stringify(receipt, null, 2));
  assert.equal(approvalStatus(root).status, 'approved');
  const result = spawnSync(process.execPath, [
    approvalScript,
    '--project-root', root,
    '--action', 'draft',
    '--workflow', 'create-mobile-app',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status": "approved"/);
  assert.equal(approvalStatus(root).status, 'approved');
});

test('pending draft state is never mistaken for approval', (context) => {
  const root = makeProject(context);
  const revision = currentRevision(root);
  const pending = pendingApprovalState(revision, 'create-mobile-app');
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-status.json'), JSON.stringify(pending, null, 2));
  const status = approvalStatus(root);
  assert.equal(status.status, 'needs-user-approval');
});