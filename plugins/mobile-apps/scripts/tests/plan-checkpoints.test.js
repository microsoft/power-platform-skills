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
const { contextEnrichmentRevision } = require('../resolve-context-enrichment');
const { domainModelRevision } = require('../lib/prototype-domain-model');

const script = path.resolve(__dirname, '..', 'plan-checkpoints.js');

function domainModel(experience, contextContract) {
  return {
    schemaVersion: 1, mode: 'prototype-domain', experienceContractSha256: contractHash(experience), contextEnrichmentSha256: contextEnrichmentRevision(contextContract),
    entities: [{ key: 'Item', displayName: 'Item', displayPluralName: 'Items', description: 'An item in the planned app.', primaryNameField: 'name', estimatedPrototypeRows: 1, fields: [
      { key: 'id', displayName: 'ID', type: 'id', required: true },
      { key: 'name', displayName: 'Name', type: 'text', required: true },
    ] }],
    relationships: [], choices: [],
    operations: [{ key: 'listItems', entity: 'Item', kind: 'list', repository: 'ItemRepository', method: 'listItems', hook: 'useItems', selectFields: ['id', 'name'], filterFields: [], sortFields: ['name'], pagination: { mode: 'bounded', boundedReason: 'One planned fixture item.', maximumExpectedCount: 1 } }],
    actors: [{ key: 'User', displayName: 'User' }],
    uxPermissions: [{ actor: 'User', operation: 'listItems', allowed: true }],
    offlineUxIntent: { connectivity: 'network-optional', requiredOperations: ['listItems'] },
    fixtureRequirements: [
      { key: 'items-populated', state: 'populated', description: 'One item is visible.', entity: 'Item', minimumRecords: 1 },
      { key: 'items-loading', state: 'loading', description: 'Items are loading.' },
      { key: 'items-empty', state: 'empty', description: 'No items are visible.' },
      { key: 'items-error', state: 'error', description: 'Items failed to load.' },
      { key: 'items-offline', state: 'offline', description: 'Local items remain visible.' },
    ],
    mediaPolicy: { mode: 'not-applicable', requiredFields: [], requiresFallback: false },
    fixtures: { Item: [{ id: 'item-cabin-kit', name: 'Cabin comfort kit' }] },
    fixtureScenarios: [
      { key: 'items-populated', state: 'populated', description: 'One item is visible.', entity: 'Item', recordIds: ['item-cabin-kit'] },
      { key: 'items-loading', state: 'loading', description: 'Items are loading.' },
      { key: 'items-empty', state: 'empty', description: 'No items are visible.' },
      { key: 'items-error', state: 'error', description: 'Items failed to load.' },
      { key: 'items-offline', state: 'offline', description: 'Local items remain visible.' },
    ],
  };
}

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
  const contextContract = {
    schemaVersion: 1,
    experienceContractSha256: contractHash(experience),
    contextMode: 'none', displayContext: [], ephemeralModel: null, assumptions: [],
    forbiddenInferences: ['Do not invent functionality, integrations, permissions, or persistent entities from illustrative context.'],
  };
  const domain = domainModel(experience, contextContract);
  fs.writeFileSync(path.join(root, '.tmp', 'context-enrichment-contract.json'), `${JSON.stringify(contextContract, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-domain-model.json'), `${JSON.stringify(domain, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), `${JSON.stringify(experience)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-screen-contract.json'), '{"schemaVersion":3,"screens":[]}\n');
  fs.writeFileSync(path.join(root, '.tmp', 'experience-foundation-contract.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(root, '.tmp', 'workflow-journey-contract.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(root, '.tmp', 'navigation-contract.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-execution-contract.json'), `${JSON.stringify({
    schemaVersion: 1,
    experienceContractSha256: contractHash(experience),
    contextEnrichmentSha256: contextEnrichmentRevision(contextContract),
    domainModelSha256: domainModelRevision(domain),
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

test('prototype uses one consolidated review without external mutation authorization', (context) => {
  const root = makeProject(context);
  const draft = run(root, '--action', 'draft', '--workflow', 'create-mobile-prototype');
  assert.equal(draft.status, 0, draft.stderr);
  const pending = output(draft);
  assert.equal(pending.status, 'needs-user-approval');
  assert.equal(pending.mayAuthorizeExternalMutations, false);
  assert.deepEqual(pending.sections, ['prototype-review']);
  assert.match(pending.approvalId, /^[a-f0-9]{64}$/);

  const last = run(root, '--action', 'approve', '--workflow', 'create-mobile-prototype', '--section', 'prototype-review', '--response', 'approve', '--now', '2026-08-24T00:00:00.000Z');
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

test('prototype full review requires four local sections and never authorizes mutation', (context) => {
  const root = makeProject(context);
  const mode = ['--workflow', 'create-mobile-prototype', '--review-mode', 'full'];
  const draft = run(root, '--action', 'draft', ...mode);
  assert.equal(draft.status, 0, draft.stderr);
  assert.deepEqual(output(draft).sections, ['domain-context', 'native-capabilities', 'connectors', 'screen-composition']);

  for (const section of ['domain-context', 'native-capabilities', 'connectors']) {
    const partial = run(root, '--action', 'approve', ...mode, '--section', section, '--response', 'approve');
    assert.equal(partial.status, 0, partial.stderr);
    assert.equal(output(partial).status, 'needs-user-approval');
    assert.equal(output(partial).mayAuthorizeExternalMutations, false);
  }
  const complete = run(root, '--action', 'approve', ...mode, '--section', 'screen-composition', '--response', 'approve');
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(output(complete).status, 'approved');
  assert.equal(output(complete).mayAuthorizeExternalMutations, false);

  const consolidated = run(root, '--action', 'status', '--workflow', 'create-mobile-prototype');
  assert.equal(consolidated.status, 2);
  assert.equal(output(consolidated).reason, 'plan-revision-changed');
});

test('prototype approval requires the explicitly named consolidated review', (context) => {
  const root = makeProject(context);
  assert.equal(run(root, '--action', 'draft', '--workflow', 'create-mobile-prototype').status, 0);

  for (const args of [
    ['--action', 'approve', '--workflow', 'create-mobile-prototype', '--response', 'approve'],
    ['--action', 'approve', '--workflow', 'create-mobile-prototype', '--section', 'all', '--response', 'approve'],
  ]) {
    const result = run(root, ...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires --section prototype-review/);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'mobile-plan-status.json'), 'utf8'));
    assert.deepEqual(state.approvals, {
      prototypeReview: { status: 'pending' },
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
  fs.rmSync(path.join(root, '.tmp', 'prototype-domain-model.json'));
  const executionPath = path.join(root, '.tmp', 'mobile-plan-execution-contract.json');
  const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
  delete execution.domainModelSha256;
  fs.writeFileSync(executionPath, `${JSON.stringify(execution)}\n`);
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
