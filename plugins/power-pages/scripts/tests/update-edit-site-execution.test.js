const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publishApprovedPlan } = require('../promote-edit-site-plan');
const {
  updateExecution,
} = require('../update-edit-site-execution');

const fixturePath = path.join(
  __dirname,
  'fixtures',
  'edit-site-plan.json'
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

test('component operation identifiers execute without rewriting the approved plan', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-owner-execution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const metadataOwners = [
    ['author-content-snippet', 'content-snippets/brand/Brand.en-US.contentsnippet.yml'],
    ['author-web-template', 'web-templates/header/Header.webtemplate.yml'],
    ['author-page-template', 'page-templates/default/Default.pagetemplate.yml'],
    ['author-site-marker', 'sitemarker.yml'],
  ];
  for (const [owner, metadataPath] of metadataOwners) {
    plan.operations.push({
      id: `modify-${owner.slice('author-'.length)}`,
      skill: owner,
      action: 'modify',
      target: { metadataPath },
      locales: [],
      inputs: {},
      dependsOn: [],
      outputBindings: {},
      preserve: [],
      expectedOutputs: ['metadataPath'],
    });
    plan.capabilities.push({
      name: owner,
      status: 'ready',
      evidence: [metadataPath],
      ownerSkill: owner,
    });
  }
  plan.operations.push({
    id: 'style-speakers-page',
    skill: 'style-site',
    action: 'style',
    target: { page: 'Speakers' },
    locales: ['en-US'],
    inputs: {
      scope: 'page',
      properties: { padding: '1rem' },
      preservation: 'Keep native markup and unrelated declarations.',
    },
    dependsOn: plan.operations.map((operation) => operation.id),
    outputBindings: {
      pageId: { sourceOperation: 'create-speakers-page', output: 'websitePageId' },
    },
    preserve: ['Native component structure'],
    expectedOutputs: ['planHash', 'receiptPath'],
  });
  plan.capabilities.push({
    name: 'Guarded styling',
    status: 'ready',
    evidence: ['Existing localized page and stylesheet'],
    ownerSkill: 'style-site',
  });
  const dataPath = path.join(root, 'approved-plan.json');
  fs.writeFileSync(dataPath, JSON.stringify(plan), 'utf8');
  publishApprovedPlan({ projectRoot: root, dataPath });
  const currentPlanPath = path.join(root, 'docs', 'edit-site', 'current-plan.json');
  const approvedBytes = fs.readFileSync(currentPlanPath, 'utf8');
  const initial = updateExecution({ projectRoot: root, action: 'status' });
  const outputsPath = path.join(root, 'outputs.json');

  for (const operation of plan.operations) {
    const resolved = updateExecution({
      projectRoot: root, action: 'resolve', operationId: operation.id,
    });
    assert.deepEqual(resolved.operation, operation);
    assert.equal(resolved.planHash, initial.planHash);
    let outputs;
    if (operation.skill === 'author-web-file') {
      outputs = { metadataPath: 'web-files/speaker-1.webfile.yml', publicUrl: '/speaker-1.jpg' };
    } else if (operation.skill === 'author-webpage') {
      assert.equal(resolved.resolvedInputs.heroImageUrl, '/speaker-1.jpg');
      outputs = {
        websitePageId: '00000000-0000-0000-0000-000000000002',
        localizedTargetFile: 'web-pages/speakers/content-pages/Speakers.en-US.webpage.copy.html',
        route: '/speakers',
      };
    } else if (operation.skill === 'style-site') {
      assert.equal(resolved.resolvedInputs.pageId, '00000000-0000-0000-0000-000000000002');
      assert.deepEqual(resolved.resolvedInputs.properties, { padding: '1rem' });
      assert.equal(resolved.resolvedInputs.scope, 'page');
      assert.deepEqual(resolved.operation.locales, ['en-US']);
      outputs = {
        planHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        receiptPath: '.powerpages-style/receipt-1.json',
      };
    } else {
      outputs = { metadataPath: operation.target.metadataPath };
    }
    updateExecution({ projectRoot: root, action: 'start', operationId: operation.id });
    fs.writeFileSync(outputsPath, JSON.stringify(outputs), 'utf8');
    updateExecution({
      projectRoot: root, action: 'complete', operationId: operation.id, outputsPath,
    });
  }
  const finished = updateExecution({ projectRoot: root, action: 'finish' });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.planHash, initial.planHash);
  assert.equal(finished.runId, initial.runId);
  assert.equal(fs.readFileSync(currentPlanPath, 'utf8'), approvedBytes);
  assert.deepEqual(JSON.parse(approvedBytes), plan);
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
  const planPath = path.join(root, 'docs', 'edit-site', 'current-plan.json');
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
    'edit-site',
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
