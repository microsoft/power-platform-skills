'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  materializeEnvelopeSet,
  partitionEnvelopeSet,
  parseAgentEnvelope,
  sealWorkOrder,
  validateEnvelopeSet,
} = require('../lib/agent-return-envelope');
const { recordMaterializationState, run } = require('../agent-return-envelope');

function fixture(context) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-envelope-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const workOrder = sealWorkOrder({
    schemaVersion: 1,
    agent: 'screen-builder',
    workOrderId: 'screen:home',
    attempt: 1,
    context: { screen: 'home', revision: 1 },
    artifacts: [{
      artifactId: 'screen:home',
      targetPath: path.join(projectRoot, 'app', 'home.tsx'),
    }],
  });
  return { projectRoot, workOrder };
}

function response(workOrder, overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    agent: workOrder.agent,
    inputFingerprint: workOrder.inputFingerprint,
    artifacts: workOrder.artifacts.map((artifact) => ({
      ...artifact,
      content: 'export default function Home() { return null; }\n',
    })),
    concerns: [],
    clarification: null,
    ...overrides,
  });
}

test('parses an exact ready envelope and preserves supplied identities', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const parsed = parseAgentEnvelope(response(workOrder), workOrder, { projectRoot });
  assert.equal(parsed.status, 'ready');
  assert.equal(parsed.inputFingerprint, workOrder.inputFingerprint);
  assert.deepEqual(parsed.artifacts.map((artifact) => artifact.artifactId), ['screen:home']);
});

test('accepts ready_with_concerns and structured clarification statuses', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const concerned = parseAgentEnvelope(response(workOrder, {
    status: 'ready_with_concerns',
    concerns: ['The empty state needs final product copy.'],
  }), workOrder, { projectRoot });
  assert.equal(concerned.status, 'ready_with_concerns');

  const clarification = parseAgentEnvelope(response(workOrder, {
    status: 'needs_clarification',
    artifacts: [],
    clarification: {
      question: 'Should archived assets remain searchable?',
      reason: 'This changes the primary search scope.',
      affectedDecisions: ['search-scope'],
    },
  }), workOrder, { projectRoot });
  assert.equal(clarification.clarification.affectedDecisions[0], 'search-scope');
});

test('accepts exact needs_context and substantive blocked results', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  for (const [status, concern] of [
    ['needs_context', 'Exact metadata is required for new_asset.'],
    ['blocked', 'The required offline conflict policy is irreconcilable.'],
  ]) {
    const parsed = parseAgentEnvelope(response(workOrder, {
      status,
      artifacts: [],
      concerns: [concern],
    }), workOrder, { projectRoot });
    assert.equal(parsed.status, status);
  }
});

test('rejects malformed, wrapped, truncated, and unknown-version responses', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const options = { projectRoot };
  assert.throws(() => parseAgentEnvelope('{', workOrder, options), /invalid JSON/);
  assert.throws(
    () => parseAgentEnvelope(`\`\`\`json\n${response(workOrder)}\n\`\`\``, workOrder, options),
    /exactly one JSON object/,
  );
  assert.throws(() => parseAgentEnvelope(response(workOrder, {
    artifacts: [{
      ...workOrder.artifacts[0],
      content: '[truncated]',
    }],
  }), workOrder, options), /truncation marker/);
  assert.throws(() => parseAgentEnvelope(response(workOrder, {
    schemaVersion: 2,
  }), workOrder, options), /schemaVersion must equal 1/);
});

test('rejects wrong roles, fingerprints, missing content, and unknown fields', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const options = { projectRoot };
  assert.throws(() => parseAgentEnvelope(response(workOrder, {
    agent: 'screen-planner',
  }), workOrder, options), /response agent/);
  assert.throws(() => parseAgentEnvelope(response(workOrder, {
    inputFingerprint: 'wrong',
  }), workOrder, options), /inputFingerprint/);
  assert.throws(() => parseAgentEnvelope(response(workOrder, {
    artifacts: [],
  }), workOrder, options), /missing one or more requested artifacts/);
  assert.throws(() => parseAgentEnvelope(response(workOrder, {
    unexpected: true,
  }), workOrder, options), /unexpected is not supported/);
});

test('rejects unapproved and outside-project target paths', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const unapproved = path.join(projectRoot, 'app', 'other.tsx');
  assert.throws(() => parseAgentEnvelope(response(workOrder, {
    artifacts: [{
      artifactId: 'screen:home',
      targetPath: unapproved,
      content: 'export default null;\n',
    }],
  }), workOrder, { projectRoot }), /not allowlisted/);
  const outsideWorkOrder = sealWorkOrder({
    ...workOrder,
    artifacts: [{
      artifactId: 'screen:home',
      targetPath: path.join(projectRoot, '..', 'outside.tsx'),
    }],
  });
  assert.throws(
    () => parseAgentEnvelope(response(outsideWorkOrder), outsideWorkOrder, { projectRoot }),
    /outside the project root/,
  );
});

test('rejects duplicate target paths across concurrent responses', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const second = sealWorkOrder({
    ...workOrder,
    agent: 'screen-builder-secondary',
    workOrderId: 'screen:details',
    context: { screen: 'details' },
    artifacts: [{
      artifactId: 'screen:details',
      targetPath: workOrder.artifacts[0].targetPath,
    }],
  });
  assert.throws(() => validateEnvelopeSet([
    { workOrder, responseText: response(workOrder) },
    { workOrder: second, responseText: response(second) },
  ], { projectRoot }), /duplicate targetPath across agent responses/);
});

test('rejects tool-surface absence as a child blocked condition', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  for (const concern of [
    'Task tool is unavailable in this host.',
    'Missing Plan Mode in this host.',
    'The structured question UI is not exposed.',
    'Filesystem access is unavailable.',
  ]) {
    assert.throws(() => parseAgentEnvelope(response(workOrder, {
      status: 'blocked',
      artifacts: [],
      concerns: [concern],
    }), workOrder, { projectRoot }), /not a substantive blocked condition/);
  }
});

test('validates the complete response set before writing any final file', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const secondPath = path.join(projectRoot, 'app', 'details.tsx');
  const second = sealWorkOrder({
    ...workOrder,
    workOrderId: 'screen:details',
    context: { screen: 'details' },
    artifacts: [{ artifactId: 'screen:details', targetPath: secondPath }],
  });
  assert.throws(() => materializeEnvelopeSet([
    { workOrder, responseText: response(workOrder) },
    { workOrder: second, responseText: response(second, { inputFingerprint: 'wrong' }) },
  ], { projectRoot }), /inputFingerprint/);
  assert.equal(fs.existsSync(workOrder.artifacts[0].targetPath), false);
  assert.equal(fs.existsSync(secondPath), false);
});

test('retains valid sibling envelopes while identifying one targeted repair', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const secondPath = path.join(projectRoot, 'app', 'details.tsx');
  const second = sealWorkOrder({
    ...workOrder,
    workOrderId: 'screen:details',
    context: { screen: 'details' },
    artifacts: [{ artifactId: 'screen:details', targetPath: secondPath }],
  });
  const result = partitionEnvelopeSet([
    { workOrder, responseText: response(workOrder) },
    { workOrder: second, responseText: '{' },
  ], { projectRoot });
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].envelope.artifacts[0].artifactId, 'screen:home');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].inputFingerprint, second.inputFingerprint);
  assert.match(result.failures[0].error, /invalid JSON/);
});

test('returns repair findings when every response in a wave is invalid', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const result = partitionEnvelopeSet([
    { workOrder, responseText: '{' },
  ], { projectRoot });
  assert.equal(result.valid.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /invalid JSON/);
});

test('materializes validated artifacts atomically in deterministic target order', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const firstPath = path.join(projectRoot, 'app', 'a-details.tsx');
  const second = sealWorkOrder({
    ...workOrder,
    context: { screen: 'details' },
    artifacts: [{ artifactId: 'screen:details', targetPath: firstPath }],
  });
  const validated = [];
  let stagedValidated = false;
  const result = materializeEnvelopeSet([
    { workOrder, responseText: response(workOrder) },
    { workOrder: second, responseText: response(second) },
  ], {
    projectRoot,
    validateArtifactContent(artifact) {
      validated.push(artifact.targetPath);
      return [];
    },
    validateStagedArtifacts(artifacts) {
      stagedValidated = true;
      assert.equal(artifacts.every((artifact) => fs.existsSync(artifact.stagedPath)), true);
      assert.equal(artifacts.every((artifact) => !fs.existsSync(artifact.targetPath)), true);
      assert.equal(artifacts.every((artifact) => path.extname(artifact.stagedPath) === '.tsx'), true);
      return [];
    },
  });
  assert.deepEqual(validated, [firstPath, workOrder.artifacts[0].targetPath]);
  assert.deepEqual(result.map((item) => item.targetPath), validated);
  assert.equal(stagedValidated, true);
  assert.equal(fs.readFileSync(firstPath, 'utf8').includes('Home'), true);
  assert.equal(fs.readFileSync(workOrder.artifacts[0].targetPath, 'utf8').includes('Home'), true);
});

test('targeted repair preserves unrelated existing artifacts', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const sibling = path.join(projectRoot, 'app', 'sibling.tsx');
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  fs.writeFileSync(sibling, 'preserved\n');
  materializeEnvelopeSet([
    { workOrder, responseText: response(workOrder) },
  ], { projectRoot });
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'preserved\n');
});

test('content validation failure leaves the final target untouched', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  fs.mkdirSync(path.dirname(workOrder.artifacts[0].targetPath), { recursive: true });
  fs.writeFileSync(workOrder.artifacts[0].targetPath, 'previous\n');
  assert.throws(() => materializeEnvelopeSet([
    { workOrder, responseText: response(workOrder) },
  ], {
    projectRoot,
    validateArtifactContent: () => ['TypeScript failed'],
  }), /TypeScript failed/);
  assert.equal(fs.readFileSync(workOrder.artifacts[0].targetPath, 'utf8'), 'previous\n');
});

test('staged validation failure leaves existing final content untouched', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  fs.mkdirSync(path.dirname(workOrder.artifacts[0].targetPath), { recursive: true });
  fs.writeFileSync(workOrder.artifacts[0].targetPath, 'previous\n');
  assert.throws(() => materializeEnvelopeSet([
    { workOrder, responseText: response(workOrder) },
  ], {
    projectRoot,
    validateStagedArtifacts: () => ['screen validator failed'],
  }), /screen validator failed/);
  assert.equal(fs.readFileSync(workOrder.artifacts[0].targetPath, 'utf8'), 'previous\n');
});

test('rename failure rolls back every target in the materialization set', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const secondPath = path.join(projectRoot, 'app', 'details.tsx');
  const second = sealWorkOrder({
    ...workOrder,
    context: { screen: 'details' },
    artifacts: [{ artifactId: 'screen:details', targetPath: secondPath }],
  });
  fs.mkdirSync(path.dirname(secondPath), { recursive: true });
  fs.writeFileSync(workOrder.artifacts[0].targetPath, 'previous-home\n');
  fs.writeFileSync(secondPath, 'previous-details\n');
  const fileSystem = Object.create(fs);
  const renameSync = fs.renameSync.bind(fs);
  let failed = false;
  fileSystem.renameSync = (from, to) => {
    if (!failed && to === workOrder.artifacts[0].targetPath && from.includes('.agent-')) {
      failed = true;
      throw new Error('simulated rename failure');
    }
    renameSync(from, to);
  };
  assert.throws(() => materializeEnvelopeSet([
    { workOrder, responseText: response(workOrder) },
    { workOrder: second, responseText: response(second) },
  ], { projectRoot, fileSystem }), /simulated rename failure/);
  assert.equal(fs.readFileSync(workOrder.artifacts[0].targetPath, 'utf8'), 'previous-home\n');
  assert.equal(fs.readFileSync(secondPath, 'utf8'), 'previous-details\n');
});

test('rejects an existing symbolic-link target', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const outside = path.join(projectRoot, 'outside.tsx');
  fs.mkdirSync(path.dirname(workOrder.artifacts[0].targetPath), { recursive: true });
  fs.writeFileSync(outside, 'outside\n');
  fs.symlinkSync(outside, workOrder.artifacts[0].targetPath);
  assert.throws(
    () => parseAgentEnvelope(response(workOrder), workOrder, { projectRoot }),
    /must not be a symbolic link/,
  );
});

test('seals and verifies the complete work-order content', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  assert.match(workOrder.inputFingerprint, /^[a-f0-9]{64}$/);
  const changed = structuredClone(workOrder);
  changed.context.revision = 2;
  assert.throws(
    () => parseAgentEnvelope(response(workOrder), changed, { projectRoot }),
    /work order inputFingerprint does not match its complete content/,
  );
  assert.notEqual(sealWorkOrder(changed).inputFingerprint, workOrder.inputFingerprint);
});

test('foreground CLI validates and materializes response files', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.tmp', 'work-order.json'),
    JSON.stringify(workOrder),
  );
  fs.writeFileSync(
    path.join(projectRoot, '.tmp', 'response.json'),
    response(workOrder),
  );
  fs.writeFileSync(
    path.join(projectRoot, '.tmp', 'validation-plan.json'),
    JSON.stringify({
      schemaVersion: 1,
      commands: [{
        id: 'tsx-content',
        command: process.execPath,
        args: [
          '-e',
          'const fs=require("fs"); if(!fs.readFileSync(process.argv[1],"utf8").includes("Home")) process.exit(1)',
          '{{artifact:screen:home}}',
        ],
      }],
    }),
  );
  const result = run({
    projectRoot,
    workOrders: ['.tmp/work-order.json'],
    responses: ['.tmp/response.json'],
    materialize: true,
    validationPlan: '.tmp/validation-plan.json',
    materializationState: '.tmp/materialization-state.json',
    phase: 'screen-wave-1',
    output: '.tmp/result.json',
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.agentToolCallCount, 0);
  assert.equal(result.materialized.length, 1);
  assert.equal(fs.existsSync(workOrder.artifacts[0].targetPath), true);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(projectRoot, '.tmp', 'result.json'),
  )).status, 'ready');
  const state = JSON.parse(fs.readFileSync(
    path.join(projectRoot, '.tmp', 'materialization-state.json'),
  ));
  assert.equal(state.phase, 'screen-wave-1');
  assert.equal(state.revision, 1);
  assert.match(state.artifacts['screen:home'].sha256, /^[a-f0-9]{64}$/);
});

test('targeted materialization state revision preserves successful sibling hashes', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  const statePath = path.join(projectRoot, '.tmp', 'materialization-state.json');
  fs.mkdirSync(path.dirname(workOrder.artifacts[0].targetPath), { recursive: true });
  fs.writeFileSync(workOrder.artifacts[0].targetPath, 'home-v1\n');
  const siblingPath = path.join(projectRoot, 'app', 'sibling.tsx');
  fs.writeFileSync(siblingPath, 'sibling-v1\n');
  const first = recordMaterializationState(statePath, projectRoot, 'screen-wave-1', [{
    agent: 'screen-builder',
    artifactId: 'screen:home',
    targetPath: workOrder.artifacts[0].targetPath,
  }, {
    agent: 'screen-builder',
    artifactId: 'screen:sibling',
    targetPath: siblingPath,
  }], { nowIso: () => '2026-08-29T12:00:00.000Z' });
  fs.writeFileSync(workOrder.artifacts[0].targetPath, 'home-v2\n');
  const second = recordMaterializationState(statePath, projectRoot, 'screen-wave-1-repair', [{
    agent: 'screen-builder',
    artifactId: 'screen:home',
    targetPath: workOrder.artifacts[0].targetPath,
  }], { nowIso: () => '2026-08-29T12:01:00.000Z' });
  assert.equal(second.revision, 2);
  assert.notEqual(second.artifacts['screen:home'].sha256, first.artifacts['screen:home'].sha256);
  assert.equal(
    second.artifacts['screen:sibling'].sha256,
    first.artifacts['screen:sibling'].sha256,
  );
});

test('parallel and sequential response order materialize identical screen content', (context) => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-parallel-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sequential-'));
  context.after(() => fs.rmSync(firstRoot, { recursive: true, force: true }));
  context.after(() => fs.rmSync(secondRoot, { recursive: true, force: true }));

  function entries(root) {
    return ['home', 'details'].map((screen) => {
      const workOrder = sealWorkOrder({
        schemaVersion: 1,
        agent: 'screen-builder',
        workOrderId: `screen:${screen}`,
        attempt: 1,
        context: { screen, spec: `complete-${screen}-spec` },
        artifacts: [{
          artifactId: `screen:${screen}`,
          targetPath: path.join(root, 'app', `${screen}.tsx`),
        }],
      });
      return {
        workOrder,
        responseText: response(workOrder, {
          artifacts: [{
            ...workOrder.artifacts[0],
            content: `export default function Screen() { return '${screen}'; }\n`,
          }],
        }),
      };
    });
  }

  const parallel = entries(firstRoot);
  const sequential = entries(secondRoot);
  materializeEnvelopeSet([...parallel].reverse(), { projectRoot: firstRoot });
  for (const entry of sequential) {
    materializeEnvelopeSet([entry], { projectRoot: secondRoot });
  }
  for (const screen of ['home', 'details']) {
    assert.equal(
      fs.readFileSync(path.join(firstRoot, 'app', `${screen}.tsx`), 'utf8'),
      fs.readFileSync(path.join(secondRoot, 'app', `${screen}.tsx`), 'utf8'),
    );
  }
});

test('correction changes only the affected work-order fingerprint', (context) => {
  const { projectRoot } = fixture(context);
  const workOrders = ['home', 'details'].map((screen) => sealWorkOrder({
    schemaVersion: 1,
    agent: 'screen-builder',
    workOrderId: `screen:${screen}`,
    attempt: 1,
    context: { screen, entityRevision: 1 },
    artifacts: [{
      artifactId: `screen:${screen}`,
      targetPath: path.join(projectRoot, 'app', `${screen}.tsx`),
    }],
  }));
  const repairedHome = sealWorkOrder({
    ...workOrders[0],
    attempt: 2,
    context: { screen: 'home', entityRevision: 2 },
    validatorFindings: ['Entity field changed from assetTag to inventoryTag.'],
  });
  assert.notEqual(repairedHome.inputFingerprint, workOrders[0].inputFingerprint);
  assert.equal(workOrders[1].inputFingerprint, sealWorkOrder(workOrders[1]).inputFingerprint);
  assert.equal(repairedHome.artifacts[0].artifactId, workOrders[0].artifacts[0].artifactId);
  assert.equal(repairedHome.artifacts[0].targetPath, workOrders[0].artifacts[0].targetPath);
});

test('foreground CLI validates non-ready status without materializing', (context) => {
  const { projectRoot, workOrder } = fixture(context);
  fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'work-order.json'), JSON.stringify(workOrder));
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'response.json'), response(workOrder, {
    status: 'needs_context',
    artifacts: [],
    concerns: ['Exact metadata is required for new_asset.'],
  }));
  const result = run({
    projectRoot,
    workOrders: ['.tmp/work-order.json'],
    responses: ['.tmp/response.json'],
    validateOnly: true,
  });
  assert.equal(result.status, 'needs_context');
  assert.equal(result.materialized.length, 0);
  assert.equal(fs.existsSync(workOrder.artifacts[0].targetPath), false);
});