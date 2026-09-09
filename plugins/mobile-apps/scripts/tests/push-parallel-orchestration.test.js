'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), 'utf8');
}

function evalByCoverage(relativePath, coverage) {
  const document = JSON.parse(read(relativePath));
  const evaluation = document.evals.find((item) => item.coverage === coverage);
  assert.ok(evaluation, `${relativePath} covers ${coverage}`);
  return evaluation;
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

function frontmatter(relativePath) {
  return read(relativePath).match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
}

function workerResults(relativePath) {
  return [...read(relativePath).matchAll(/^WORKER_RESULT: (\{.+\})$/gm)]
    .map((match) => JSON.parse(match[1]));
}

function preflightResult(relativePath) {
  const result = workerResults(relativePath).find(({ operation }) => operation === 'preflight');
  assert.ok(result, `${relativePath} defines a parseable preflight result`);
  return result;
}

test('Firebase foundation is serial with a bounded two-platform wave', () => {
  const setupFcm = read('skills/setup-fcm/SKILL.md');

  assert.match(
    setupFcm,
    /authentication, project selection\/creation, project activation, and both\s+activation read-backs in the parent and strictly serial/,
  );
  assert.match(setupFcm, /collect every selected platform's app decision before\s+dispatching platform work/);
  assert.match(setupFcm, /launch exactly two\s+`mobile-app:firebase-platform-worker` execution tasks/);
  assert.match(setupFcm, /If only one platform needs work, use one synchronous worker/);
  assert.match(setupFcm, /batch maximum is two|at most two|exactly two/i);
  assert.match(setupFcm, /After every dispatched platform has joined successfully/);
});

test('APNs upload questions wait for the exact Firebase iOS app', () => {
  const addPush = read('skills/add-push-notifications/SKILL.md');
  const stepThree = addPush.indexOf('### 3. Serially resume or establish and join Firebase client setup');
  const postFirebaseQuestions = addPush.indexOf('At this point, after Firebase login when needed');
  const stepFour = addPush.indexOf('### 4. Run the bounded prerequisite/runtime/sender-auth wave');

  assert.ok(stepThree >= 0, 'Step 3 exists');
  assert.ok(postFirebaseQuestions > stepThree, 'APNs questions follow Firebase setup');
  assert.ok(stepFour > postFirebaseQuestions, 'APNs questions are collected before worker dispatch');
  assert.match(
    addPush.slice(0, stepThree),
    /Do not ask whether an APNs\s+credential is uploaded/,
  );
  assert.match(
    addPush.slice(postFirebaseQuestions, stepFour),
    /immutable iOS Firebase app has been created or reused and\s+validated/,
  );
  assert.match(
    addPush.slice(postFirebaseQuestions, stepFour),
    /Firebase\s+Console upload attestation/,
  );
});

test('Task capability checks carry prompt-level preflight operations', () => {
  const setupFcm = read('skills/setup-fcm/SKILL.md');
  const addPush = read('skills/add-push-notifications/SKILL.md');

  assert.match(setupFcm, /silently invoke a normal `Task`[\s\S]*operation: preflight/);
  assert.match(setupFcm, /`operation` is a\s+prompt field, not a `Task` API mode/);
  assert.match(addPush, /preflight all three fully-qualified agents with ordinary\s+`Task` requests/);
  assert.match(addPush, /Put `operation: preflight` in each task prompt/);
  assert.match(addPush, /do not use or\s+invent a `Task` API mode/);

  for (const worker of [
    'mobile-app:push-runtime-worker',
    'mobile-app:push-wif-worker',
    'mobile-app:push-ios-prerequisites-worker',
  ]) {
    assert.match(
      addPush,
      new RegExp(`${worker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*operation: preflight`),
      `${worker} is covered by prompt-level preflight`,
    );
  }
});

test('every bounded worker publishes a mutation-free preflight result', () => {
  const workerFiles = [
    'agents/firebase-platform-worker.md',
    'agents/push-runtime-worker.md',
    'agents/push-wif-worker.md',
    'agents/push-ios-prerequisites-worker.md',
  ];

  for (const workerFile of workerFiles) {
    const content = read(workerFile);
    const result = preflightResult(workerFile);
    assert.strictEqual(result.operation, 'preflight', workerFile);
    assert.strictEqual(result.stage, 'preflight', workerFile);
    assert.strictEqual(result.status, 'done', workerFile);
    assert.deepStrictEqual(result.identities, {}, workerFile);
    assert.deepStrictEqual(result.decisions, {}, workerFile);
    assert.deepStrictEqual(result.changedFiles, [], workerFile);
    assert.deepStrictEqual(result.validatedFiles, [], workerFile);
    assert.deepStrictEqual(result.memoryPatch, { sections: [] }, workerFile);
    assert.deepStrictEqual(result.contextRequests, [], workerFile);
    assert.deepStrictEqual(result.concerns, [], workerFile);
    assert.deepStrictEqual(result.blockers, [], workerFile);
    assert.strictEqual(result.capabilities.preflightRequiresExecutionEnvelope, false, workerFile);
    assert.strictEqual(result.capabilities.preflightCloudCalls, false, workerFile);
    assert.strictEqual(result.capabilities.preflightFileReads, false, workerFile);
    assert.strictEqual(result.capabilities.preflightFileWrites, false, workerFile);
    assert.strictEqual(result.capabilities.mayPrompt, false, workerFile);
    assert.strictEqual(result.capabilities.mayDelegate, false, workerFile);
    assert.strictEqual(result.capabilities.memoryWrites, false, workerFile);
    assert.match(
      content,
      /Make no [^\n]*network call;[\s\S]{0,160}read,\s+create, edit, hash, or\s+delete no file/,
      `${workerFile} makes preflight inert`,
    );
  }
});

test('bounded workers inherit the host default available model', () => {
  for (const workerFile of [
    'agents/firebase-platform-worker.md',
    'agents/push-runtime-worker.md',
    'agents/push-wif-worker.md',
    'agents/push-ios-prerequisites-worker.md',
  ]) {
    assert.doesNotMatch(
      frontmatter(workerFile),
      /^model:/m,
      `${workerFile} must not pin a model unavailable to the host`,
    );
  }
});

test('iOS prerequisites omit the separate Apple membership attestation', () => {
  const setupApple = read('skills/setup-apple-ios/SKILL.md');
  const appleReference = read('shared/references/apple-ios-signing-provisioning.md');
  const iosWorker = read('agents/push-ios-prerequisites-worker.md');
  const setupAppleEvals = JSON.parse(read('skills/setup-apple-ios/evals/evals.json'));
  const evaluation = setupAppleEvals.evals
    .find(({ coverage }) => coverage === 'skip-membership-access-question');

  for (const content of [appleReference, iosWorker]) {
    assert.doesNotMatch(content, /membership_access_agreements/);
    assert.doesNotMatch(content, /membershipAccessAgreements/);
  }
  assert.doesNotMatch(appleReference, /^## \d+\. Membership, access, and agreements$/m);
  assert.match(setupApple, /Do not perform or ask for a separate Apple Developer Program membership/);
  assert.ok(evaluation, 'membership-question regression eval exists');
  assert.match(evaluation.expected_output, /does not ask this membership, role, access, or agreement question/);
});

test('cold WIF stages absent Entra identity before the remaining approval', () => {
  const workerPath = 'agents/push-wif-worker.md';
  const worker = read(workerPath);
  const parent = read('skills/add-push-notifications/SKILL.md');
  const owner = read('skills/setup-push-wif/SKILL.md');
  const reference = read('shared/references/push-wif-provisioning.md');
  const results = workerResults(workerPath);
  const preflight = results.find(({ operation }) => operation === 'preflight');
  const bootstrapPlan = results.find(({ stage }) => stage === 'identity-bootstrap-plan');
  const bootstrap = results.find(({ operation }) => operation === 'identity-bootstrap');
  const remainingPlan = results.find(({ stage, proposedPlan }) => (
    stage === 'sender-auth-plan' && proposedPlan?.decisions?.planPhase === 'post-identity-bootstrap'
  ));

  assert.deepStrictEqual(
    preflight.capabilities.supportedOperations,
    ['preflight', 'plan', 'identity-bootstrap', 'execute'],
  );
  assert.strictEqual(preflight.capabilities.identityBootstrapSupported, true);
  assert.strictEqual(preflight.capabilities.identityBootstrapCloudMutations, true);
  assert.strictEqual(preflight.capabilities.identityBootstrapFileWrites, false);

  assert.ok(bootstrapPlan, 'worker publishes an absent-identity bootstrap plan');
  assert.strictEqual(bootstrapPlan.identities.entraSenderClientId, null);
  assert.strictEqual(bootstrapPlan.identityBootstrapPlan.route, 'identity-bootstrap');
  assert.deepStrictEqual(bootstrapPlan.identityBootstrapPlan.googleMutations, []);
  assert.deepStrictEqual(bootstrapPlan.identityBootstrapPlan.apiEnablement, []);
  assert.ok(!Object.hasOwn(bootstrapPlan, 'proposedPlan'));

  assert.ok(bootstrap, 'worker publishes an identity-bootstrap result');
  assert.deepStrictEqual(bootstrap.changedFiles, []);
  assert.deepStrictEqual(bootstrap.validatedFiles, []);
  assert.deepStrictEqual(bootstrap.memoryPatch, { sections: [] });
  assert.deepStrictEqual(bootstrap.decisions.googleMutations, []);
  assert.deepStrictEqual(bootstrap.decisions.apiEnablement, []);
  assert.ok(bootstrap.identityBootstrapReceipt.entraSenderClientId);
  assert.ok(!Object.hasOwn(bootstrap, 'senderAuthPath'));
  assert.ok(!Object.hasOwn(bootstrap, 'proofComplete'));

  assert.ok(remainingPlan, 'worker publishes a fresh post-bootstrap remaining plan');
  assert.strictEqual(remainingPlan.decisions.planPhase, 'post-identity-bootstrap');
  assert.ok(remainingPlan.validations.some(({ name, ok }) => name === 'fresh-entra-claims' && ok));
  assert.deepStrictEqual(
    Object.keys(remainingPlan.proposedPlan.claimContract),
    ['iss', 'aud', 'appid', 'azp', 'selectedAppClaim', 'applicationId', 'googleProviderIssuer'],
  );

  for (const content of [worker, owner, reference]) {
    assert.match(content, /server-generated\s+client ID/i);
    assert.match(content, /fresh (?:app-only token|read-only plan)/i);
    assert.match(
      content,
      /no Google[\s\S]{0,50}(?:mutation|cloud call|call that mutates)|must not mutate Google|does not[\s\S]{0,80}Google cloud call/i,
    );
    assert.match(content, /no local file|writes no local file|write no local file/i);
  }
  assert.match(parent, /approval #2/);
  assert.match(parent, /only accepted\s+transitions are `preflight -> sender-auth-plan -> sender-auth`/i);
  assert.match(parent, /identity-bootstrap-plan -> identity-bootstrap ->\s+sender-auth-plan -> sender-auth/i);
  assert.match(parent, /never retry or replay that\s+mutation stage/i);
});

test('post-Firebase wave uses only the three qualified bounded workers', () => {
  const addPush = read('skills/add-push-notifications/SKILL.md');
  const expectedWorkers = [
    'mobile-app:push-runtime-worker',
    'mobile-app:push-wif-worker',
    'mobile-app:push-ios-prerequisites-worker',
  ];

  assert.match(addPush, /`\/setup-fcm` is the serial foundation/);
  assert.match(addPush, /Do not\s+start any later worker from one platform's early `\/setup-fcm` result/);
  assert.match(addPush, /Dispatch at most three tracks/);
  assert.match(addPush, /batch maximum\s+is three/);
  for (const worker of expectedWorkers) {
    assert.ok(addPush.includes(worker), `${worker} is in the qualified inventory`);
  }
  assert.doesNotMatch(addPush, /(?:^|[\s`])push-runtime-worker(?:[\s`,]|$)(?![\s\S]*mobile-app:push-runtime-worker)/);

  for (const workerFile of [
    'agents/firebase-platform-worker.md',
    'agents/push-runtime-worker.md',
    'agents/push-wif-worker.md',
    'agents/push-ios-prerequisites-worker.md',
  ]) {
    const tools = frontmatterTools(workerFile);
    assert.ok(!tools.includes('Task'), `${workerFile} cannot fan out`);
    assert.ok(!tools.includes('Skill'), `${workerFile} cannot invoke owners`);
    assert.match(read(workerFile), /No nested work/);
  }
});

test('parent owns decisions, exclusive files, return parsing, retries, and memory', () => {
  const addPush = read('skills/add-push-notifications/SKILL.md');
  const setupFcm = read('skills/setup-fcm/SKILL.md');
  const combined = `${setupFcm}\n${addPush}`;

  assert.match(addPush, /The parent owns all questions, dispatch, joins, validation, memory merge/);
  assert.match(addPush, /memory_bank_sha256: <pre-wave SHA-256>/);
  assert.match(addPush, /exclusive_files: \[<exact absolute paths>\]/);
  assert.match(combined, /literal first line/);
  assert.match(combined, /exactly\s+one (?:parseable )?`WORKER_RESULT`/);
  assert.match(addPush, /Collect all valid `NEEDS_CONTEXT` results from the joined wave before asking/);
  assert.match(addPush, /one parent `AskUserQuestion` call/);
  assert.match(addPush, /Allow at most two retries per worker/);
  assert.match(setupFcm, /Cap at 2 retries per platform/);
  assert.match(addPush, /Immediately before memory mutation, recompute `memory-bank\.md` SHA-256/);
  assert.match(addPush, /apply them in\s+one parent edit to `memory-bank\.md`/);
  assert.match(addPush, /Workers and fallback\s+owner modes must never write it themselves/);
});

test('fallback and partial dispatch never overlap file ownership', () => {
  const addPush = read('skills/add-push-notifications/SKILL.md');
  const setupFcm = read('skills/setup-fcm/SKILL.md');

  assert.match(addPush, /start \*\*no execution worker\*\*/);
  assert.match(addPush, /deterministic serial fallback/);
  assert.match(addPush, /if dispatch\/start state is uncertain or partial, return\s+`BLOCKED: push-worker-partial-dispatch-uncertain`/);
  assert.match(addPush, /Join every definitely started\s+task/);
  assert.match(setupFcm, /Join and validate the started track first/);
  assert.match(setupFcm, /run only the undispatched track synchronously/);
  assert.match(setupFcm, /never allow a worker and fallback path to own the same\s+platform concurrently/);
});

test('project-relative worker results are resolved before absolute allowlist checks', () => {
  const files = [
    'agents/firebase-platform-worker.md',
    'agents/push-runtime-worker.md',
    'agents/push-wif-worker.md',
    'agents/push-ios-prerequisites-worker.md',
    'skills/setup-fcm/SKILL.md',
    'skills/add-push-notifications/SKILL.md',
  ];

  for (const relativePath of files) {
    const content = read(relativePath);
    assert.match(
      content,
      /project-relative\s+(?:result\s+)?paths?/i,
      `${relativePath} requires relative result paths`,
    );
    assert.match(content, /resolv(?:e|es|ing)[\s\S]{0,180}(?:against|with) `?working_dir`?/i,
      `${relativePath} resolves paths against working_dir`);
    if (relativePath.includes('push-ios-prerequisites-worker')) {
      assert.match(content, /corresponding absolute prompt path/i,
        `${relativePath} compares its read-only result with the absolute prompt path`);
      assert.match(content, /`changedFiles` must remain empty/,
        `${relativePath} keeps its empty exclusive write set`);
    } else if (relativePath === 'skills/add-push-notifications/SKILL.md') {
      assert.match(content, /exclusive list\s+is exactly `<working_dir>\/sender-auth\.json`/);
      assert.match(content, /resolve each against `working_dir`\s+before comparing it with the absolute exclusive path/);
    } else {
      assert.match(content, /absolute[\s\S]{0,180}`?exclusive_files`|`?exclusive_files`[\s\S]{0,180}absolute/i,
        `${relativePath} compares resolved paths with absolute ownership`);
    }
    assert.match(content, /must not\s+compare raw relative and\s+absolute strings|Never compare a\s+raw project-relative result string directly with an\s+absolute prompt string|Never compare an absolute prompt path directly with a\s+project-relative result path/i,
      `${relativePath} forbids raw relative/absolute comparison`);
  }
});

test('FlowAgent, builds, and verification remain sequential boundaries', () => {
  const addPush = read('skills/add-push-notifications/SKILL.md');
  const lifecycle = read('shared/references/push-lifecycle.md');

  assert.match(addPush, /`\/create-push-notification-flow --working-dir <root>` synchronously/);
  assert.match(addPush, /deterministic Android-then-iOS order/);
  assert.match(addPush, /platform build\/verification blocker stops only\s+that platform/);
  assert.match(
    lifecycle,
    /FlowAgent authoring, wrapped builds, installation handoffs, and physical\s+verification remain sequential owner boundaries/,
  );
});

test('parallel orchestration evals cover success and safe degradation', () => {
  const addPushPath = 'skills/add-push-notifications/evals/evals.json';
  const setupFcmPath = 'skills/setup-fcm/evals/evals.json';
  const cases = [
    [addPushPath, 'parallel-success-both-platforms', /max-three wave/],
    [addPushPath, 'single-track-single-platform', /one synchronous/],
    [addPushPath, 'task-unavailable-serial-fallback', /serial owner\/inline path/],
    [addPushPath, 'malformed-worker-result', /BLOCKED/],
    [addPushPath, 'memory-sha-drift', /SHA-256|pre-wave hash/],
    [addPushPath, 'platform-specific-partial-blocker', /iOS as blocked/],
    [addPushPath, 'worker-contract-preflight-plan-paths-and-ios-fallback', /operation: preflight/],
    [addPushPath, 'cold-wif-identity-bootstrap-reapproval', /second explicit approval/],
    [addPushPath, 'apns-question-after-firebase', /Only then/],
    [addPushPath, 'noninteractive-stopping-point-and-links', /approved HTTPS origin of null/],
    [setupFcmPath, 'parallel-platform-success', /exactly two/],
    [setupFcmPath, 'single-platform-worker', /one synchronous/],
    [setupFcmPath, 'task-unavailable-inline-fallback', /Android-then-iOS/],
    [setupFcmPath, 'malformed-platform-result', /rejects Android as blocked/],
    [setupFcmPath, 'partial-platform-dispatch', /joins and validates Android first/],
    [setupFcmPath, 'firebase-worker-executable-contract', /scratchCleanupComplete true/],
    [setupFcmPath, 'conditional-project-creation-questions', /Only after/],
    [setupFcmPath, 'new-project-propagation-wait', /every 5 seconds for up to 60 seconds/],
    ['skills/setup-push-wif/evals/evals.json', 'orchestrated-cold-identity-bootstrap', /server-generated client ID/],
    ['skills/setup-push-wif/evals/evals.json', 'no-broader-fcm-role-question', /wif-custom-role-policy-blocked/],
  ];

  for (const [relativePath, coverage, expectedPattern] of cases) {
    const evaluation = evalByCoverage(relativePath, coverage);
    assert.match(evaluation.expected_output, expectedPattern, coverage);
  }
});

test('owner-mode evals preserve parent-only decisions and memory writes', () => {
  const cases = [
    ['skills/setup-push-wif/evals/evals.json', 'orchestrated-worker-contract'],
    ['skills/setup-apple-ios/evals/evals.json', 'orchestrated-parent-confirmations'],
    ['skills/setup-apns/evals/evals.json', 'orchestrated-parent-upload-attestation'],
  ];

  for (const [relativePath, coverage] of cases) {
    const evaluation = evalByCoverage(relativePath, coverage);
    assert.match(evaluation.expected_output, /asks no questions|without asking questions/);
    assert.match(evaluation.expected_output, /no nested|invokes no nested/);
    assert.match(evaluation.expected_output, /writes no memory|never writes memory-bank/);
    assert.match(evaluation.expected_output, /WORKER_RESULT/);
  }
});
