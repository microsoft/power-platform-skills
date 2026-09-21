'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), 'utf8');
}

function frontmatterTools(relativePath) {
  const content = read(relativePath);
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  const toolsBlock = frontmatter.match(/^tools:\n((?:  - .+\n?)+)/m)?.[1] || '';
  return toolsBlock
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

test('Firebase cloud work stays serial in setup-fcm owner context', () => {
  const setupFcm = read('skills/setup-fcm/SKILL.md');

  assert.match(setupFcm, /Execute each selected platform serially in this owner context/);
  assert.match(setupFcm, /Android\s+first and then iOS/);
  assert.match(setupFcm, /never delegate Firebase MCP\s+calls to a background `Task`/);
  assert.match(setupFcm, /every Firebase cloud call and every\s+platform config write remains in `\/setup-fcm`/);
  assert.match(setupFcm, /If Android succeeds and iOS blocks, preserve and report Android as configured/);
  assert.doesNotMatch(setupFcm, /firebase-platform-worker/);
  assert.doesNotMatch(setupFcm, /\bTask\b.*Firebase MCP|Firebase MCP.*\bTask\b/);
});

test('WIF cloud work stays serial in setup-push-wif owner context', () => {
  const owner = read('skills/setup-push-wif/SKILL.md');
  const reference = read('shared/references/push-wif-provisioning.md');

  for (const content of [owner, reference]) {
    assert.match(content, /reuse-app-registration/);
    assert.match(content, /use-existing-registration/);
    assert.match(content, /create-dedicated-registration/);
    assert.match(content, /cloudmessaging\.messages\.create/);
    assert.doesNotMatch(content, /push-wif-worker/);
    assert.doesNotMatch(content, /WORKER_RESULT/);
  }
  assert.match(owner, /first approval never authorizes the second stage/i);
  assert.match(reference, /fresh complete plan for the remaining Google\/API\/RBAC work/);
  assert.match(reference, /four stages must succeed in this run/i);
});

test('only MCP-free push workers remain', () => {
  const workerFiles = [
    'agents/push-runtime-worker.md',
    'agents/push-ios-prerequisites-worker.md',
  ];

  assert.ok(!fs.existsSync(path.join(PLUGIN_ROOT, 'agents/firebase-platform-worker.md')));
  assert.ok(!fs.existsSync(path.join(PLUGIN_ROOT, 'agents/push-wif-worker.md')));

  for (const workerFile of workerFiles) {
    const tools = frontmatterTools(workerFile);
    assert.ok(!tools.some((tool) => tool.startsWith('mcp__')), `${workerFile} is MCP-free`);
    assert.ok(!tools.includes('Task'), `${workerFile} cannot fan out`);
    assert.ok(!tools.includes('Skill'), `${workerFile} cannot invoke owners`);
    assert.match(read(workerFile), /operation: preflight/);
    assert.match(read(workerFile), /preflightCloudCalls/);
  }
});

test('guided orchestration runs cloud owners before a maximum-two worker wave', () => {
  const addPush = read('skills/add-push-notifications/SKILL.md');

  assert.match(addPush, /Connected MCP servers are owned by the main skill context/);
  assert.match(addPush, /invoke `\/setup-push-wif --working-dir <root>` synchronously/);
  assert.match(addPush, /Evaluate only these two independent tracks/);
  assert.match(addPush, /mobile-app:push-runtime-worker/);
  assert.match(addPush, /mobile-app:push-ios-prerequisites-worker/);
  assert.match(addPush, /Neither worker may declare an MCP tool/);
  assert.match(addPush, /dispatch exactly two tasks in one bounded batch/);
  assert.doesNotMatch(addPush, /mobile-app:push-wif-worker/);
  assert.doesNotMatch(addPush, /max-three|at most three/i);
});

test('Task preflight never claims MCP inheritance', () => {
  const readiness = read('shared/references/push-tool-readiness.md');
  const shared = read('shared/shared-instructions.md');
  const lifecycle = read('shared/references/push-lifecycle.md');

  for (const content of [readiness, shared, lifecycle]) {
    assert.match(content, /(?:may not|cannot be assumed to)\s+inherit/i);
  }
  assert.match(readiness, /does not test or prove MCP inheritance/);
  assert.match(shared, /Background push workers must be MCP-free/);
  assert.match(lifecycle, /at most two MCP-free tracks/);
});

test('cold WIF retains two separate approvals without worker delegation', () => {
  const owner = read('skills/setup-push-wif/SKILL.md');
  const parent = read('skills/add-push-notifications/SKILL.md');
  const reference = read('shared/references/push-wif-provisioning.md');

  for (const content of [owner, parent, reference]) {
    assert.match(content, /create-dedicated-registration/);
    assert.match(content, /(?:server-)?generated\s+client ID/i);
    assert.match(content, /fresh (?:claim|token)/i);
  }
  assert.match(parent, /two-stage approval boundary/);
  assert.match(parent, /Bootstrap never mutates Google or writes `sender-auth\.json`/);
  assert.match(reference, /first present\s+only the narrow identity\/credential and secret-safe Key Vault bootstrap plan/);
  assert.match(reference, /fresh complete plan for the remaining Google\/API\/RBAC work/);
});

test('serial cloud owner evals cover MCP-inaccessible workers and safe resume', () => {
  const setupFcm = JSON.parse(read('skills/setup-fcm/evals/evals.json'));
  const addPush = JSON.parse(read('skills/add-push-notifications/evals/evals.json'));
  const firebaseCoverage = new Set(setupFcm.evals.map(({ coverage }) => coverage));
  const orchestrationCoverage = new Set(addPush.evals.map(({ coverage }) => coverage));

  for (const coverage of [
    'serial-both-platform-success',
    'serial-single-platform',
    'background-worker-mcp-unavailable',
    'serial-second-platform-blocked',
    'serial-platform-resume',
    'firebase-owner-mcp-isolation',
  ]) {
    assert.ok(firebaseCoverage.has(coverage), coverage);
  }
  for (const coverage of [
    'serial-cloud-owners-noncloud-wave',
    'worker-mcp-inheritance-forbidden',
    'mcp-free-worker-contract-and-ios-fallback',
    'cold-wif-identity-bootstrap-reapproval',
  ]) {
    assert.ok(orchestrationCoverage.has(coverage), coverage);
  }
});
