'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  recordState,
  verifyState,
} = require('../mobile-pipeline-state');

function project(testContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-pipeline-state-'));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  return root;
}

test('records a completed step and verifies unchanged artifacts', (testContext) => {
  const root = project(testContext);
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), '# Plan\n');
  const stateFile = path.join(root, '.tmp', 'pipeline-state.json');

  recordState({
    projectRoot: root,
    stateFile,
    step: '6.75',
    artifacts: ['plan=native-app-plan.md'],
    now: () => '2026-08-28T00:00:00.000Z',
  });

  assert.deepEqual(verifyState({ projectRoot: root, stateFile }), {
    valid: true,
    reason: 'current',
    resumeAfterStep: '6.75',
    mismatches: [],
  });
});

test('invalidates resume when an artifact changes or disappears', (testContext) => {
  const root = project(testContext);
  const artifact = path.join(root, 'native-app-plan.md');
  fs.writeFileSync(artifact, '# Plan\n');
  const stateFile = path.join(root, '.tmp', 'pipeline-state.json');
  recordState({
    projectRoot: root,
    stateFile,
    step: '3.9',
    artifacts: ['plan=native-app-plan.md'],
  });

  fs.writeFileSync(artifact, '# Changed\n');
  assert.equal(verifyState({ projectRoot: root, stateFile }).reason, 'artifact-mismatch');
  fs.rmSync(artifact);
  assert.equal(verifyState({ projectRoot: root, stateFile }).mismatches[0].reason, 'missing');
});

test('later checkpoints retain earlier artifact authorities', (testContext) => {
  const root = project(testContext);
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(root, 'approval.json'), '{}\n');
  const stateFile = path.join(root, '.tmp', 'pipeline-state.json');

  recordState({
    projectRoot: root,
    stateFile,
    step: '3.9',
    artifacts: ['plan=native-app-plan.md', 'approval=approval.json'],
  });
  recordState({
    projectRoot: root,
    stateFile,
    step: '6.75',
    artifacts: ['plan=native-app-plan.md'],
  });

  fs.writeFileSync(path.join(root, 'approval.json'), '{"changed":true}\n');
  const result = verifyState({ projectRoot: root, stateFile });
  assert.equal(result.valid, false);
  assert.deepEqual(result.mismatches, [{ name: 'approval', reason: 'hash-mismatch' }]);
});

test('later checkpoints cannot restamp an approved file artifact', (testContext) => {
  const root = project(testContext);
  const plan = path.join(root, 'native-app-plan.md');
  fs.writeFileSync(plan, '# Approved plan\n');
  const stateFile = path.join(root, '.tmp', 'pipeline-state.json');
  recordState({
    projectRoot: root,
    stateFile,
    step: '6.75',
    artifacts: ['plan=native-app-plan.md'],
  });

  fs.writeFileSync(plan, '# Changed after approval\n');
  assert.throws(() => recordState({
    projectRoot: root,
    stateFile,
    step: '10.8',
    artifacts: ['plan=native-app-plan.md'],
  }), /immutable artifact changed/);
});

test('later checkpoints validate retained immutable artifacts even when omitted', (testContext) => {
  const root = project(testContext);
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), '# Approved plan\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  const stateFile = path.join(root, '.tmp', 'pipeline-state.json');
  recordState({
    projectRoot: root,
    stateFile,
    step: '6.75',
    artifacts: ['plan=native-app-plan.md'],
  });

  fs.writeFileSync(path.join(root, 'native-app-plan.md'), '# Changed after approval\n');
  assert.throws(() => recordState({
    projectRoot: root,
    stateFile,
    step: '10.8',
    artifacts: ['package=package.json'],
  }), /immutable artifact changed/);
});

test('artifact trees invalidate resume when generated source changes', (testContext) => {
  const root = project(testContext);
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default null;\n');
  const stateFile = path.join(root, '.tmp', 'pipeline-state.json');

  recordState({
    projectRoot: root,
    stateFile,
    step: '11.4',
    artifactTrees: ['routes=app'],
  });
  assert.equal(verifyState({ projectRoot: root, stateFile }).valid, true);

  fs.writeFileSync(path.join(root, 'app', 'home.tsx'), 'export default function Home() {}\n');
  assert.deepEqual(verifyState({ projectRoot: root, stateFile }).mismatches, [
    { name: 'routes', reason: 'hash-mismatch' },
  ]);
});

test('rejects artifacts outside the project root', (testContext) => {
  const root = project(testContext);
  assert.throws(() => recordState({
    projectRoot: root,
    stateFile: path.join(root, '.tmp', 'pipeline-state.json'),
    step: '1',
    artifacts: ['outside=../secret.txt'],
  }), /outside project root/);
});
