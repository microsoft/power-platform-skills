'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  ARTIFACT_PATHS,
  DESIGN_ARTIFACT_PATHS,
  PROTOTYPE_ARTIFACT_PATHS,
  approveGate,
  invalidateApprovalReceipt,
  validateIntegrity,
  validatePrototypeApprovals,
  validatePresentationApprovals,
} = require('../lib/mobile-plan-approval');
const { sha256Hex } = require('../lib/product-experience-contracts');
const {
  validateApprovalReceipt,
} = require('../build-dataverse-operation-manifest');
const { recordState, verifyState } = require('../mobile-pipeline-state');

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-plan-approval-')));
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
  for (const gate of Object.values(receipt.gates)) assert.equal(gate.prototypeRevisions, undefined);
  assert.equal(Object.keys(ARTIFACT_PATHS).some((name) => name.startsWith('prototype')), false);
  assert.deepEqual(receipt.serviceRequiredTables, [{
    logicalName: 'new_item',
    consumers: ['screen:home'],
  }]);
  assert.deepEqual(validateApprovalReceipt(receipt, {
    contract: contract(),
    planBytes: fs.readFileSync(path.join(root, 'native-app-plan.md')),
  }), { valid: true, errors: [] });
});

test('HTML-off approvals bind materialized design and reject mode or design drift', (context) => {
  const root = project(context);
  fs.rmSync(path.join(root, '_plan_preview.html'));
  for (const [name, relative] of Object.entries(DESIGN_ARTIFACT_PATHS)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `Materialized ${name}\n`);
  }
  const options = { now: NOW, htmlCompanions: '0' };
  let receipt;
  for (let gate = 1; gate <= 4; gate += 1) receipt = approveGate(root, gate, options);
  assert.equal(receipt.gates.gate3.htmlCompanions, false);
  assert.equal(receipt.gates.gate3.previewSha256, undefined);
  assert.deepEqual(Object.keys(receipt.gates.gate3.designRevisions).sort(), Object.keys(DESIGN_ARTIFACT_PATHS).sort());
  assert.equal(validatePresentationApprovals(root, receipt, options).valid, true);
  assert.equal(validatePresentationApprovals(root, receipt, { htmlCompanions: '1' }).valid, false);
  assert.throws(() => approveGate(root, 4, { htmlCompanions: '1' }), /companion mode changed/);
  const stateFile = path.join(root, '.tmp/pipeline-state.json');
  assert.throws(() => recordState({ projectRoot: root, stateFile, step: '6.75' }), /companion mode changed/);
  const script = path.join(__dirname, '../mobile-pipeline-state.js');
  const recorded = spawnSync(process.execPath, [script, '--project-root', root, '--record', '--step', '6.75'], {
    encoding: 'utf8', env: { ...process.env, MOBILE_APP_HTML_COMPANIONS: '0' },
  });
  assert.equal(recorded.status, 0, recorded.stderr);
  const resumed = spawnSync(process.execPath, [script, '--project-root', root, '--verify'], {
    encoding: 'utf8', env: { ...process.env, MOBILE_APP_HTML_COMPANIONS: '1' },
  });
  assert.notEqual(resumed.status, 0);
  const tokens = path.join(root, DESIGN_ARTIFACT_PATHS.designTokens);
  fs.appendFileSync(tokens, 'Changed palette\n');
  assert.equal(validatePresentationApprovals(root, receipt, options).valid, false);
  assert.throws(() => approveGate(root, 4, options), /materialized design changed/);
  const refreshed = approveGate(root, 3, options);
  assert.equal(refreshed.gates.gate4.status, 'pending');
  assert.equal(refreshed.implementation.status, 'pending');
  fs.rmSync(path.join(root, DESIGN_ARTIFACT_PATHS.signatureComponents));
  assert.throws(() => approveGate(root, 3, options));
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

test('architecture revisions reopen Gate 1 and replace superseded resume checkpoints', (context) => {
  for (const kind of ['nativeCapabilities', 'connectors']) {
    const root = project(context);
    const planPath = path.join(root, 'native-app-plan.md');
    fs.rmSync(planPath);
    approveGate(root, 1, { now: NOW });
    const stateFile = path.join(root, '.tmp', 'pipeline-state.json');
    const stateOptions = {
      projectRoot: root,
      stateFile,
      artifacts: ['architecture=.tmp/architecture-decisions.json'],
      mutableArtifacts: ['approval=.tmp/mobile-plan-status.json'],
    };
    recordState({ ...stateOptions, step: '3.2' });
    fs.writeFileSync(planPath, plan());
    for (let gate = 2; gate <= 4; gate += 1) approveGate(root, gate, { now: NOW });
    recordState({
      ...stateOptions,
      step: '6.75',
      mutableArtifacts: [...stateOptions.mutableArtifacts, 'plan=native-app-plan.md'],
    });

    const architecturePath = path.join(root, '.tmp/architecture-decisions.json');
    const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'));
    architecture[kind] = kind === 'nativeCapabilities'
      ? [{ id: 'location', displayName: 'Location', approved: true }]
      : [{ apiName: 'contoso-api', displayName: 'Contoso API', approved: true }];
    writeJson(root, '.tmp/architecture-decisions.json', architecture);
    assert.throws(
      () => approveGate(root, 2, { now: NOW }),
      /Gate 1 artifact architecture changed and requires reapproval/,
    );

    const evidencePath = path.join(root, '.tmp/dataverse-metadata-execution-journal.json');
    const evidence = '{"completed":{}}\n';
    fs.writeFileSync(evidencePath, evidence);
    const canonicalPath = path.join(root, '.tmp/dataverse-schema-contract.json');
    const canonicalBytes = fs.readFileSync(canonicalPath);
    const invalidated = spawnSync(process.execPath, [
      path.resolve(__dirname, '..', 'mobile-plan-approval.js'),
      'invalidate',
      '--project-root', root,
      '--from-gate', '1',
      '--reason', 'architecture-changed',
    ], { encoding: 'utf8' });
    assert.equal(invalidated.status, 0, invalidated.stderr);
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(fs.readFileSync(evidencePath, 'utf8'), evidence);
    assert.deepEqual(fs.readFileSync(canonicalPath), canonicalBytes);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.tmp/mobile-plan-status.json')));
    assert.ok(Object.values(receipt.gates).every((gate) => gate.status === 'pending'));
    assert.equal(receipt.implementation.status, 'pending');
    assert.equal(receipt.approvedPlanSha256, undefined);

    approveGate(root, 1, { now: NOW });
    recordState({ ...stateOptions, step: '3.2' });
    for (let gate = 2; gate <= 4; gate += 1) approveGate(root, gate, { now: NOW });
    recordState({
      ...stateOptions,
      step: '6.75',
      mutableArtifacts: [...stateOptions.mutableArtifacts, 'plan=native-app-plan.md'],
    });
    assert.equal(verifyState({ projectRoot: root, stateFile }).valid, true);
  }
});

function localContracts(root) {
  writeJson(root, '.tmp/prototype-domain.json', { schemaVersion: 1, entities: [], actions: [] });
  writeJson(root, '.tmp/prototype-bindings.json', { schemaVersion: 1, entities: [] });
  writeJson(root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [] });
}

test('standalone gates bind the complete optional local domain without changing legacy requirements', (context) => {
  const root = project(context);
  localContracts(root);
  approveGate(root, 1, { now: NOW });
  const second = approveGate(root, 2, { now: NOW });
  assert.deepEqual(Object.keys(second.gates.gate2.prototypeRevisions).sort(), [
    'prototypeBindings', 'prototypeDomain', 'prototypeRules',
  ]);
  writeJson(root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [{ id: 'changed' }] });
  assert.throws(() => approveGate(root, 3, { now: NOW }), /Gate 2 prototype.*reapproval/);
  approveGate(root, 2, { now: NOW });
  approveGate(root, 3, { now: NOW });
  const final = approveGate(root, 4, { now: NOW });
  assert.equal(validatePrototypeApprovals(root, final).valid, true);
  assert.deepEqual(final.gates.gate2.prototypeRevisions, final.gates.gate4.prototypeRevisions);
});

test('partial, newly added, and removed local domain reviews cannot reuse an existing approval', (context) => {
  const partial = project(context);
  approveGate(partial, 1, { now: NOW });
  writeJson(partial, '.tmp/prototype-domain.json', { schemaVersion: 1 });
  assert.throws(() => approveGate(partial, 2, { now: NOW }), /complete domain, bindings, and rules/);

  const added = project(context);
  approveGate(added, 1, { now: NOW });
  approveGate(added, 2, { now: NOW });
  localContracts(added);
  assert.throws(() => approveGate(added, 3, { now: NOW }), /Gate 2 prototype.*reapproval/);

  const removed = project(context);
  localContracts(removed);
  for (let gate = 1; gate <= 4; gate += 1) approveGate(removed, gate, { now: NOW });
  for (const file of ['prototype-domain.json', 'prototype-bindings.json', 'prototype-rules.json']) {
    fs.unlinkSync(path.join(removed, '.tmp', file));
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(removed, '.tmp/mobile-plan-status.json')));
  assert.equal(validatePrototypeApprovals(removed, receipt).valid, false);
});

test('completed prototype approvals reject stale CLI validation and resume checkpoints', (context) => {
  const root = project(context);
  localContracts(root);
  for (let gate = 1; gate <= 4; gate += 1) approveGate(root, gate, { now: NOW });
  const stateFile = path.join(root, '.tmp/pipeline-state.json');
  const options = { projectRoot: root, stateFile, step: '11', mutableArtifacts: ['approval=.tmp/mobile-plan-status.json'] };
  recordState(options);
  assert.equal(verifyState({ projectRoot: root, stateFile }).valid, true);
  writeJson(root, '.tmp/prototype-bindings.json', { schemaVersion: 1, entities: [{ entityId: 'Changed' }] });
  assert.equal(verifyState({ projectRoot: root, stateFile }).valid, false);
  assert.throws(() => recordState(options), /prototype.*reapproval/);
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'mobile-plan-approval.js'), 'validate', '--project-root', root,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prototype.*reapproval/);
});

test('prototype gates bind exact sidecar bytes and keep optional paths separate and unique', (context) => {
  const root = project(context);
  localContracts(root);
  for (let gate = 1; gate <= 4; gate += 1) approveGate(root, gate, { now: NOW });
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.tmp/mobile-plan-status.json')));
  const paths = [...Object.values(ARTIFACT_PATHS), ...Object.values(PROTOTYPE_ARTIFACT_PATHS)];
  assert.equal(new Set(paths).size, paths.length);
  for (const [name, file] of Object.entries(PROTOTYPE_ARTIFACT_PATHS)) {
    const expected = sha256Hex(fs.readFileSync(path.join(root, file)));
    for (const gate of [2, 3, 4]) assert.equal(receipt.gates[`gate${gate}`].prototypeRevisions[name], expected);
    assert.equal(receipt.artifactRevisions[name], expected);
  }
  fs.appendFileSync(path.join(root, PROTOTYPE_ARTIFACT_PATHS.prototypeRules), '\n');
  assert.equal(validatePrototypeApprovals(root, receipt).valid, false);
  assert.throws(() => approveGate(root, 4, { now: NOW }), /Gate 2 prototype.*reapproval/);
});

test('Gate 1 leaves the optional domain review to Gate 2 without accepting partial later approvals', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, '.tmp/prototype-domain.json'), '{unfinished');
  assert.equal(approveGate(root, 1, { now: NOW }).gates.gate1.status, 'approved');
  assert.throws(() => approveGate(root, 2, { now: NOW }), /complete domain, bindings, and rules/);
});

test('null, non-object, linked and directory sidecars cannot masquerade as absent or approved local contracts', (context) => {
  for (const kind of ['null', 'array', 'symlink', 'hardlink', 'directory']) {
    const root = project(context);
    localContracts(root);
    approveGate(root, 1, { now: NOW });
    const rules = path.join(root, '.tmp/prototype-rules.json');
    if (kind === 'null' || kind === 'array') fs.writeFileSync(rules, kind === 'null' ? 'null\n' : '[]\n');
    else {
      const source = path.join(root, '.tmp/source-rules.json');
      fs.renameSync(rules, source);
      if (kind === 'symlink') fs.symlinkSync(source, rules);
      else if (kind === 'hardlink') fs.linkSync(source, rules);
      else fs.mkdirSync(rules);
    }
    assert.throws(() => approveGate(root, 2, { now: NOW }), /regular sidecar|schemaVersion 1 object/, kind);
  }
});