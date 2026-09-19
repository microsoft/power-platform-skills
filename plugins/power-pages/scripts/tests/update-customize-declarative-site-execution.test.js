const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publishApprovedPlan } = require('../promote-customize-declarative-site-plan');
const {
  updateExecution,
} = require('../update-customize-declarative-site-execution');

const fixturePath = path.join(
  __dirname,
  'fixtures',
  'customize-declarative-site-plan.json'
);

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-execution-'));
  const dataPath = path.join(root, 'approved-plan.json');
  fs.copyFileSync(fixturePath, dataPath);
  publishApprovedPlan({ projectRoot: root, dataPath });
  return root;
}

test('resolves dependency outputs and persists operation progress', () => {
  const root = setup();
  updateExecution({ projectRoot: root, action: 'start', operationId: 'add-speaker-images' });
  const outputsPath = path.join(root, 'outputs.json');
  fs.writeFileSync(
    outputsPath,
    JSON.stringify({
      publicUrl: '/speaker-1.jpg',
      metadataPath: 'web-files/speaker-1.webfile.yml',
    }),
    'utf8'
  );
  updateExecution({
    projectRoot: root,
    action: 'complete',
    operationId: 'add-speaker-images',
    outputsPath,
  });

  const resolved = updateExecution({
    projectRoot: root,
    action: 'resolve',
    operationId: 'create-speakers-page',
  });
  assert.deepEqual(resolved.resolvedInputs, {
    navigation: 'Primary Navigation',
    heroImageUrl: '/speaker-1.jpg',
  });

  updateExecution({ projectRoot: root, action: 'start', operationId: 'create-speakers-page' });
  const pageOutputsPath = path.join(root, 'page-outputs.json');
  fs.writeFileSync(
    pageOutputsPath,
    JSON.stringify({
      websitePageId: '22222222-2222-2222-2222-222222222222',
      localizedTargetFile:
        'web-pages/speakers/content-pages/Speakers.en-US.webpage.copy.html',
      route: '/speakers',
    }),
    'utf8'
  );
  updateExecution({
    projectRoot: root,
    action: 'complete',
    operationId: 'create-speakers-page',
    outputsPath: pageOutputsPath,
  });
  const finished = updateExecution({ projectRoot: root, action: 'finish' });
  assert.equal(finished.status, 'completed');
  assert.ok(finished.completedAt);
});

test('blocks an operation until every declared dependency is complete', () => {
  const root = setup();
  assert.throws(
    () =>
      updateExecution({
        projectRoot: root,
        action: 'start',
        operationId: 'create-speakers-page',
      }),
    /incomplete dependencies: add-speaker-images/
  );
});

test('requires every output key declared by the approved operation', () => {
  const root = setup();
  updateExecution({ projectRoot: root, action: 'start', operationId: 'add-speaker-images' });
  const outputsPath = path.join(root, 'incomplete-outputs.json');
  fs.writeFileSync(outputsPath, JSON.stringify({ publicUrl: '/speaker-1.jpg' }), 'utf8');

  assert.throws(
    () =>
      updateExecution({
        projectRoot: root,
        action: 'complete',
        operationId: 'add-speaker-images',
        outputsPath,
      }),
    /outputs are missing: metadataPath/
  );
});

test('allows a failed operation to restart after the cause is resolved', () => {
  const root = setup();
  updateExecution({ projectRoot: root, action: 'start', operationId: 'add-speaker-images' });
  updateExecution({
    projectRoot: root,
    action: 'fail',
    operationId: 'add-speaker-images',
    errorMessage: 'Source file was missing',
  });
  const restarted = updateExecution({
    projectRoot: root,
    action: 'start',
    operationId: 'add-speaker-images',
  });
  const state = restarted.operations.find((entry) => entry.id === 'add-speaker-images');
  assert.equal(state.status, 'running');
  assert.equal(state.attempt, 2);
  assert.equal(state.error, null);
});

test('detects a stale execution receipt after the current plan changes', () => {
  const root = setup();
  const planPath = path.join(root, 'docs', 'customize-declarative-site', 'current-plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.summary = 'Changed without publication';
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

  assert.throws(
    () => updateExecution({ projectRoot: root, action: 'status' }),
    /does not match current-plan.json/
  );
});

test('rejects malformed durable operation state', () => {
  const root = setup();
  const executionPath = path.join(
    root,
    'docs',
    'customize-declarative-site',
    'current-execution.json'
  );
  const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
  execution.operations[0].attempt = -1;
  fs.writeFileSync(executionPath, JSON.stringify(execution), 'utf8');

  assert.throws(
    () => updateExecution({ projectRoot: root, action: 'status' }),
    /attempt must be a non-negative integer/
  );
});

test('rejects a canonical plan copied from another site or project-relative root', () => {
  const root = setup();
  assert.throws(
    () =>
      updateExecution({
        projectRoot: root,
        action: 'status',
        expectedWebsiteRecordId: '11111111-1111-1111-1111-111111111111',
      }),
    /websiteRecordId does not match/
  );
  assert.throws(
    () =>
      updateExecution({
        projectRoot: root,
        action: 'status',
        expectedSiteRoot: 'another-site',
      }),
    /siteRoot does not match/
  );
});
