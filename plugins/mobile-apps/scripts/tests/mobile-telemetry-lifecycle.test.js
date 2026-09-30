'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  createTelemetryContext,
  emitLifecycle,
  lifecycle,
} = require('../lib/mobile-telemetry');
const { publishOwnedLock } = require('../lib/mobile-lifecycle');
const { sanitizeData } = require('../lib/mobile-telemetry-dispatcher');
const {
  readProjectTelemetryContext,
} = require('../lib/mobile-telemetry-context');
const { readProjectEnvironment } = require('../lib/environment-resolution');
const {
  captureSuccessfulDataverseRequest,
  runCommand,
} = require('../emit-telemetry-checkpoint');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const COMMAND_RUNNER = path.join(PLUGIN_ROOT, 'scripts', 'run-with-telemetry.sh');
const provisioned = {
  instrumentationKey: 'test-mobile-key',
  collector_url: 'https://example.invalid/OneCollector/1.0/',
  event_stream_name: 'MobileAppsTestEvent',
  disabled: false,
};

function tempProject(context) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-lifecycle-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}

function telemetryContext(projectRoot) {
  const configDir = path.join(projectRoot, 'config');
  const ikeyPath = path.join(configDir, 'ikey.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(ikeyPath, JSON.stringify(provisioned));
  return createTelemetryContext(
    { session_id: '11111111-1111-4111-8111-111111111111' },
    {
      env: {
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
      },
    },
  );
}

test('durable lifecycle spans preserve identity and measured time', (context) => {
  const projectRoot = tempProject(context);
  const configDir = path.join(projectRoot, 'config');
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir,
    skillName: 'create-mobile-app',
    now: 1000,
  });
  const step = lifecycle.beginSpan({
    projectRoot,
    configDir,
    skillName: 'create-mobile-app',
    runId: root.runId,
    parentSpanId: root.spanId,
    checkpointName: 'gather_app_requirements',
    now: 1500,
  });
  assert.throws(() => lifecycle.resumeSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    spanId: step.spanId,
  }), /invalid_resume/);

  const completed = lifecycle.finishSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    spanId: step.spanId,
    state: 'completed',
    now: 4500,
  });
  assert.equal(completed.durationMs, 3000);
  assert.equal(completed.timingStatus, 'measured');
  assert.notEqual(completed.eventId, step.eventId);
  assert.deepEqual(
    lifecycle.finishSpan({
      projectRoot,
      configDir,
      runId: root.runId,
      spanId: step.spanId,
      state: 'completed',
      now: 9000,
    }),
    completed,
  );
});

test('durable lifecycle rejects unknown checkpoints and cross-project context', (context) => {
  const projectRoot = tempProject(context);
  const configDir = path.join(projectRoot, 'config');
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir,
    skillName: 'create-mobile-app',
    now: 1000,
  });
  assert.throws(
    () => lifecycle.beginSpan({
      projectRoot,
      configDir,
      skillName: 'create-mobile-app',
      runId: root.runId,
      parentSpanId: root.spanId,
      checkpointName: 'customer_private_data',
    }),
    /invalid_checkpoint/,
  );
  assert.throws(
    () => lifecycle.beginSpan({
      projectRoot,
      configDir,
      skillName: 'create-mobile-app',
      runId: root.runId,
      parentSpanId: root.spanId,
      checkpointName: 'gather_app_requirements',
      additionalInfo: 'customer_private_data',
    }),
    /invalid_additional_info/,
  );
  assert.throws(
    () => lifecycle.finishSpan({
      projectRoot: tempProject(context),
      configDir,
      runId: root.runId,
      spanId: root.spanId,
      state: 'completed',
    }),
    /invalid_context/,
  );
  const completed = lifecycle.finishSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    spanId: root.spanId,
    state: 'completed',
    now: 500,
  });
  assert.equal(completed.timingStatus, 'clock_invalid');
  assert.equal(completed.durationMs, undefined);
});

test('lifecycle events filter dynamic customer content before dispatch', (context) => {
  const projectRoot = tempProject(context);
  const telemetry = telemetryContext(projectRoot);
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir: telemetry.configDir,
    skillName: 'create-mobile-app',
    now: 1000,
  });
  const completed = lifecycle.finishSpan({
    projectRoot,
    configDir: telemetry.configDir,
    runId: root.runId,
    spanId: root.spanId,
    state: 'completed',
    now: 2500,
  });
  let captured;
  const event = emitLifecycle(telemetry, completed, {
    cwd: projectRoot,
    emit: (value) => {
      captured = value;
    },
    readAiAgent: () => ({}),
  });
  assert.equal(captured, event);
  assert.equal(event.time, '1970-01-01T00:00:02.500Z');
  assert.equal(event.data.durationMs, 1500);
  assert.equal(event.data.eventInfo.runId, root.runId);

  const filtered = sanitizeData({
    ...event.data,
    aiAgentName: 'private@example.com',
    aiAgentVersion: 'customer secret',
    osVersion: '/private/host',
    errorDescription: 'customer document contents',
    errorClass: 'private.customer@example.com',
    objectId: '33333333-3333-4333-8333-333333333333',
    tenantId: 'not-an-id',
    eventInfo: {
      ...event.data.eventInfo,
      aadObjectId: '33333333-3333-4333-8333-333333333333',
      identitySource: 'dataverse',
      principalType: 'user',
      userId: '55555555-5555-4555-8555-555555555555',
      prompt: 'private prompt',
      filePath: '/private/customer-file',
      email: 'private@example.com',
      nested: { token: 'secret' },
    },
  });
  assert.equal(filtered.errorDescription, undefined);
  assert.equal(filtered.errorClass, undefined);
  assert.equal(filtered.tenantId, undefined);
  assert.equal(filtered.objectId, undefined);
  assert.equal(filtered.eventInfo.aadObjectId, undefined);
  assert.equal(filtered.eventInfo.identitySource, undefined);
  assert.equal(filtered.eventInfo.principalType, undefined);
  assert.equal(filtered.eventInfo.userId, undefined);
  assert.doesNotMatch(JSON.stringify(filtered), /private|customer|secret|33333333|55555555/);
});

test('command runner preserves exit code and propagates measured span context', (context) => {
  const projectRoot = tempProject(context);
  const telemetry = telemetryContext(projectRoot);
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir: telemetry.configDir,
    skillName: 'create-mobile-app',
  });
  const capturedEnv = path.join(projectRoot, 'captured-env.json');
  const env = {
    ...process.env,
    POWER_PLATFORM_SKILLS_CONFIG_DIR: telemetry.configDir,
    POWER_PLATFORM_SKILLS_IKEY_JSON: telemetry.ikeyPath,
    POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
    POWER_PLATFORM_SKILLS_NODE_BINARY: process.execPath,
  };
  const result = spawnSync('bash', [
    COMMAND_RUNNER,
    '--execute',
    'create-mobile-app|validate_fresh_template',
    '--run-id',
    root.runId,
    '--parent-span-id',
    root.spanId,
    '--project-root',
    projectRoot,
    '--',
    process.execPath,
    '-e',
    [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(capturedEnv)}, JSON.stringify({`,
      '  runId: process.env.POWER_PLATFORM_SKILLS_MOBILE_RUN_ID,',
      '  spanId: process.env.POWER_PLATFORM_SKILLS_MOBILE_SPAN_ID,',
      '  parentSpanId: process.env.POWER_PLATFORM_SKILLS_MOBILE_SKILL_SPAN_ID,',
      '  projectRoot: process.env.POWER_PLATFORM_SKILLS_PROJECT_ROOT,',
      '}));',
      'process.exit(7);',
    ].join('\n'),
  ], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
  assert.equal(result.status, 7, result.stderr);
  const commandEnv = JSON.parse(fs.readFileSync(capturedEnv, 'utf8'));
  assert.equal(commandEnv.runId, root.runId);
  assert.match(commandEnv.spanId, /^[0-9a-f-]{36}$/);
  assert.equal(commandEnv.parentSpanId, root.spanId);
  assert.equal(commandEnv.projectRoot, projectRoot);

  const report = lifecycle.reportRun({
    projectRoot,
    configDir: telemetry.configDir,
    runId: root.runId,
  });
  assert.equal(report.supportId, root.runId);
  assert.equal(
    report.spans.find((span) => span.spanId === commandEnv.spanId).state,
    'failed',
  );
  assert.doesNotMatch(JSON.stringify(report), /captured-env|writeFileSync/);
});

test('command runner executes once when telemetry has syntax or import failures', (context) => {
  for (const [name, emitter] of [
    ['syntax', 'this is not valid JavaScript'],
    ['import', "require('./missing-telemetry-module');"],
  ]) {
    const projectRoot = tempProject(context);
    const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), `mobile-runner-${name}-`));
    context.after(() => fs.rmSync(wrapperRoot, { recursive: true, force: true }));
    fs.copyFileSync(COMMAND_RUNNER, path.join(wrapperRoot, 'run-with-telemetry.sh'));
    fs.writeFileSync(
      path.join(wrapperRoot, 'emit-telemetry-checkpoint.js'),
      emitter,
    );
    const marker = path.join(projectRoot, `${name}.txt`);
    const result = spawnSync('bash', [
      path.join(wrapperRoot, 'run-with-telemetry.sh'),
      '--execute',
      'create-mobile-app|validate_fresh_template',
      '--run-id',
      '11111111-1111-4111-8111-111111111111',
      '--parent-span-id',
      '22222222-2222-4222-8222-222222222222',
      '--project-root',
      projectRoot,
      '--',
      process.execPath,
      '-e',
      `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(7);`,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        POWER_PLATFORM_SKILLS_NODE_BINARY: process.execPath,
      },
      timeout: 10_000,
    });
    assert.equal(result.status, 7, `${name}: ${result.stderr}`);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'x');
  }
});

test('command runner bounds a hung telemetry emitter', (context) => {
  const projectRoot = tempProject(context);
  const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-runner-hang-'));
  context.after(() => fs.rmSync(wrapperRoot, { recursive: true, force: true }));
  fs.copyFileSync(COMMAND_RUNNER, path.join(wrapperRoot, 'run-with-telemetry.sh'));
  fs.writeFileSync(
    path.join(wrapperRoot, 'emit-telemetry-checkpoint.js'),
    'setInterval(() => {}, 1000);',
  );
  const marker = path.join(projectRoot, 'hang.txt');
  const startedAt = Date.now();
  const result = spawnSync('bash', [
    path.join(wrapperRoot, 'run-with-telemetry.sh'),
    '--execute',
    'create-mobile-app|validate_fresh_template',
    '--run-id',
    '11111111-1111-4111-8111-111111111111',
    '--parent-span-id',
    '22222222-2222-4222-8222-222222222222',
    '--project-root',
    projectRoot,
    '--',
    process.execPath,
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_NODE_BINARY: process.execPath,
    },
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
  assert.ok(Date.now() - startedAt < 3000, 'telemetry hang must stay bounded');
});

test('tracked checkpoints preserve allowlisted static classifications', (context) => {
  const projectRoot = tempProject(context);
  const telemetry = telemetryContext(projectRoot);
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir: telemetry.configDir,
    skillName: 'create-mobile-app',
  });
  const spans = [];
  const overrides = {
    createTelemetryContext: () => telemetry,
    emitLifecycle: (_telemetry, span) => spans.push(span),
  };
  const started = runCommand([
    'create-mobile-app|gather_app_requirements|started|with_dataverse',
    '--run-id', root.runId,
    '--parent-span-id', root.spanId,
    '--project-root', projectRoot,
  ], overrides);
  const completed = runCommand([
    'create-mobile-app|gather_app_requirements|completed',
    '--run-id', root.runId,
    '--span-id', started.spanId,
    '--project-root', projectRoot,
  ], overrides);

  assert.equal(started.state, 'started');
  assert.equal(completed.state, 'completed');
  assert.equal(spans.length, 2);
  assert.equal(spans[0].additionalInfo, 'with_dataverse');
  assert.equal(spans[1].additionalInfo, 'with_dataverse');

  const event = emitLifecycle(telemetry, spans[1], {
    cwd: projectRoot,
    emit: () => {},
    readAiAgent: () => ({}),
  });
  assert.equal(event.data.eventInfo.additionalInfo, 'with_dataverse');
  const report = lifecycle.reportRun({
    projectRoot,
    configDir: telemetry.configDir,
    runId: root.runId,
  });
  assert.equal(
    report.spans.find((span) => span.spanId === started.spanId).additionalInfo,
    'with_dataverse',
  );
});

test('checkpoint CLI carries lifecycle context across fresh processes', (context) => {
  const projectRoot = tempProject(context);
  const configDir = path.join(projectRoot, 'config');
  const ikeyPath = path.join(configDir, 'ikey.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(ikeyPath, JSON.stringify(provisioned));
  const env = {
    ...process.env,
    POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
    POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
  };
  const cli = path.join(PLUGIN_ROOT, 'scripts', 'emit-telemetry-checkpoint.js');
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const root = run(
    '--begin',
    'create-mobile-app',
    '--project-root',
    projectRoot,
  );
  const step = run(
    'create-mobile-app|gather_app_requirements|started',
    '--run-id',
    root.runId,
    '--parent-span-id',
    root.spanId,
    '--project-root',
    projectRoot,
  );
  const completedStep = run(
    'create-mobile-app|gather_app_requirements|completed',
    '--run-id',
    root.runId,
    '--span-id',
    step.spanId,
    '--project-root',
    projectRoot,
  );
  assert.equal(completedStep.state, 'completed');
  assert.equal(completedStep.runId, root.runId);

  const completedRoot = run(
    '--finish',
    'completed',
    '--run-id',
    root.runId,
    '--span-id',
    root.spanId,
    '--project-root',
    projectRoot,
  );
  assert.equal(completedRoot.state, 'completed');

  const report = run(
    '--report',
    '--run-id',
    root.runId,
    '--project-root',
    projectRoot,
  );
  assert.equal(report.supportId, root.runId);
  assert.equal(report.state, 'completed');
  assert.deepEqual(
    report.spans.map((span) => span.state).sort(),
    ['completed', 'completed'],
  );

  const paused = run(
    '--begin',
    'create-mobile-app',
    '--project-root',
    projectRoot,
  );
  const pause = run(
    '--finish',
    'needs_context',
    '--run-id',
    paused.runId,
    '--span-id',
    paused.spanId,
    '--project-root',
    projectRoot,
  );
  assert.equal(pause.state, 'needs_context');

  const resumed = run(
    '--resume',
    paused.spanId,
    '--run-id',
    paused.runId,
    '--project-root',
    projectRoot,
  );
  assert.equal(resumed.state, 'started');
  assert.notEqual(resumed.spanId, paused.spanId);
  const resumedComplete = run(
    '--finish',
    'completed',
    '--run-id',
    paused.runId,
    '--span-id',
    resumed.spanId,
    '--project-root',
    projectRoot,
  );
  assert.equal(resumedComplete.state, 'completed');
  const resumedReport = run(
    '--report',
    '--run-id',
    paused.runId,
    '--project-root',
    projectRoot,
  );
  assert.equal(resumedReport.state, 'completed');
  assert.deepEqual(
    resumedReport.spans
      .map((span) => [span.attempt, span.state])
      .sort((left, right) => left[0] - right[0]),
    [[1, 'needs_context'], [2, 'completed']],
  );
});

test('successful parent completion requires every child to finish', (context) => {
  const projectRoot = tempProject(context);
  const configDir = path.join(projectRoot, 'config');
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir,
    skillName: 'create-mobile-app',
  });
  const child = lifecycle.beginSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    parentSpanId: root.spanId,
    skillName: 'create-mobile-app',
    checkpointName: 'gather_app_requirements',
  });
  const finishRoot = {
    projectRoot,
    configDir,
    runId: root.runId,
    spanId: root.spanId,
    state: 'completed',
  };
  assert.throws(() => lifecycle.finishSpan(finishRoot), /children_pending/);
  lifecycle.finishSpan({
    ...finishRoot,
    spanId: child.spanId,
    state: 'cancelled',
    errorClass: 'user_cancelled',
  });
  assert.equal(lifecycle.finishSpan(finishRoot).state, 'completed');
});

test('nested needs-context attempts keep their parent open until resumed', (context) => {
  const projectRoot = tempProject(context);
  const configDir = path.join(projectRoot, 'config');
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir,
    skillName: 'create-mobile-app',
  });
  const child = lifecycle.beginSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    parentSpanId: root.spanId,
    skillName: 'add-dataverse',
  });
  lifecycle.finishSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    spanId: child.spanId,
    state: 'needs_context',
  });
  const finishRoot = {
    projectRoot,
    configDir,
    runId: root.runId,
    spanId: root.spanId,
    state: 'completed',
  };
  assert.throws(() => lifecycle.finishSpan(finishRoot), /children_pending/);

  const resumed = lifecycle.resumeSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    spanId: child.spanId,
  });
  assert.equal(resumed.parentSpanId, root.spanId);
  assert.equal(resumed.retryOfSpanId, child.spanId);
  assert.equal(resumed.attempt, 2);
  assert.throws(() => lifecycle.finishSpan(finishRoot), /children_pending/);

  lifecycle.finishSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    spanId: resumed.spanId,
    state: 'completed',
  });
  assert.equal(lifecycle.finishSpan(finishRoot).state, 'completed');
});

test('run lock serializes child creation with parent completion across processes', async (context) => {
  const projectRoot = tempProject(context);
  const configDir = path.join(projectRoot, 'config');
  const ikeyPath = path.join(configDir, 'ikey.json');
  const cli = path.join(PLUGIN_ROOT, 'scripts', 'emit-telemetry-checkpoint.js');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(ikeyPath, JSON.stringify(provisioned));
  const env = {
    ...process.env,
    POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
    POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
  };
  const runCli = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const root = lifecycle.beginSpan({
      projectRoot,
      configDir,
      skillName: 'create-mobile-app',
    });
    const [childResult, parentResult] = await Promise.all([
      runCli([
        'create-mobile-app|gather_app_requirements|started',
        '--run-id', root.runId,
        '--parent-span-id', root.spanId,
        '--project-root', projectRoot,
      ]),
      runCli([
        '--finish', 'completed',
        '--run-id', root.runId,
        '--span-id', root.spanId,
        '--project-root', projectRoot,
      ]),
    ]);
    assert.equal(childResult.code, 0, childResult.stderr);
    assert.equal(parentResult.code, 0, parentResult.stderr);

    const report = lifecycle.reportRun({ projectRoot, configDir, runId: root.runId });
    const rootSpan = report.spans.find((span) => span.spanId === root.spanId);
    const openChild = report.spans.some(
      (span) => span.parentSpanId === root.spanId && span.state === 'incomplete',
    );
    assert.equal(
      rootSpan.state === 'completed' && openChild,
      false,
      'a completed parent must never gain an incomplete child',
    );
  }
});

test('run lock times out instead of writing through another process lock', (context) => {
  const projectRoot = tempProject(context);
  const configDir = path.join(projectRoot, 'config');
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir,
    skillName: 'create-mobile-app',
  });
  const lockPath = path.join(
    lifecycle.runDirectory(configDir, root.runId),
    '.lifecycle.lock',
  );
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    token: '11111111-1111-4111-8111-111111111111',
    acquiredAtMs: Date.now(),
  }));
  try {
    assert.throws(() => lifecycle.beginSpan({
      projectRoot,
      configDir,
      runId: root.runId,
      parentSpanId: root.spanId,
      skillName: 'create-mobile-app',
      checkpointName: 'gather_app_requirements',
      lockTimeoutMs: 0,
    }), /lock_timeout/);
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

test('lock publication treats transient EEXIST as contention after release', (context) => {
  const directory = tempProject(context);
  const lockPath = path.join(directory, '.lifecycle.lock');
  const pendingPaths = [];
  const fakeFs = {
    writeFileSync(filename, contents, options) {
      pendingPaths.push(filename);
      fs.writeFileSync(filename, contents, options);
    },
    linkSync() {
      // Simulate another process winning and releasing before this catch runs.
      throw Object.assign(new Error('already existed'), { code: 'EEXIST' });
    },
    rmSync(filename, options) {
      fs.rmSync(filename, options);
    },
  };
  assert.equal(
    publishOwnedLock(
      lockPath,
      '11111111-1111-4111-8111-111111111111',
      { fs: fakeFs },
    ),
    false,
  );
  assert.equal(fs.existsSync(lockPath), false);
  assert.ok(pendingPaths.every((filename) => !fs.existsSync(filename)));
});

test('run lock recovers when its recorded owner process is dead', (context) => {
  const projectRoot = tempProject(context);
  const configDir = path.join(projectRoot, 'config');
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir,
    skillName: 'create-mobile-app',
  });
  const runDirectory = lifecycle.runDirectory(configDir, root.runId);
  const lockPath = path.join(runDirectory, '.lifecycle.lock');
  const recoveryPath = path.join(runDirectory, '.lifecycle.lock.recovery');
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 424242,
    token: '11111111-1111-4111-8111-111111111111',
    acquiredAtMs: Date.now() - 5000,
  }));
  fs.linkSync(lockPath, recoveryPath);

  const child = lifecycle.beginSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    parentSpanId: root.spanId,
    skillName: 'create-mobile-app',
    checkpointName: 'gather_app_requirements',
    isProcessAlive: () => false,
  });
  assert.equal(child.parentSpanId, root.spanId);
  assert.equal(fs.existsSync(lockPath), false);
});

test('verified Dataverse context excludes user identity and token claims', (context) => {
  const projectRoot = tempProject(context);
  const configDir = path.join(projectRoot, 'config');
  const environmentId = '11111111-1111-4111-8111-111111111111';
  const tenantId = '22222222-2222-4222-8222-222222222222';
  const orgId = '44444444-4444-4444-8444-444444444444';
  const environmentUrl = 'https://contoso.crm.dynamics.com';
  fs.writeFileSync(
    path.join(projectRoot, 'power.config.json'),
    JSON.stringify({ environmentId }),
  );
  fs.writeFileSync(
    path.join(projectRoot, '.resolved-environment.json'),
    JSON.stringify({
      environmentId,
      tenantId,
      environmentUrl,
      displayName: 'PRIVATE CUSTOMER NAME',
    }),
  );
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir,
    skillName: 'create-mobile-app',
  });
  const verifiedStep = lifecycle.beginSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    parentSpanId: root.spanId,
    skillName: 'create-mobile-app',
    checkpointName: 'select_app_environment',
  });
  const descendant = lifecycle.beginSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    parentSpanId: verifiedStep.spanId,
    skillName: 'add-dataverse',
  });
  const sibling = lifecycle.beginSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    parentSpanId: root.spanId,
    skillName: 'create-mobile-app',
    checkpointName: 'gather_app_requirements',
  });
  const token = `header.${Buffer.from(JSON.stringify({
    oid: '33333333-3333-4333-8333-333333333333',
    tid: tenantId,
    exp: Math.floor(Date.now() / 1000) + 300,
    scp: 'user_impersonation',
    preferred_username: 'private@example.com',
  })).toString('base64url')}.signature`;
  const options = {
    projectRoot,
    configDir,
    lifecycle,
    runId: root.runId,
    spanId: verifiedStep.spanId,
  };
  assert.deepEqual(readProjectTelemetryContext(projectRoot, options), {});
  assert.deepEqual(readProjectTelemetryContext(projectRoot), {});
  let unverified;
  emitLifecycle({
    configDir,
    env: {},
    eventStreamName: 'event',
    sessionId: root.sessionId,
  }, root, {
    cwd: projectRoot,
    emit: (value) => {
      unverified = value;
    },
    readAiAgent: () => ({}),
  });
  assert.equal(unverified.data.orgId, undefined);
  assert.equal(unverified.data.tenantId, undefined);
  assert.equal(unverified.data.eventInfo.environmentId, undefined);

  const ikeyPath = path.join(configDir, 'ikey.json');
  fs.writeFileSync(ikeyPath, JSON.stringify(provisioned));
  assert.equal(captureSuccessfulDataverseRequest(
    environmentUrl,
    token,
    {
      OrganizationId: orgId,
      UserId: '55555555-5555-4555-8555-555555555555',
    },
    {
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
      POWER_PLATFORM_SKILLS_MOBILE_RUN_ID: root.runId,
      POWER_PLATFORM_SKILLS_MOBILE_SPAN_ID: verifiedStep.spanId,
      POWER_PLATFORM_SKILLS_PROJECT_ROOT: projectRoot,
    },
  ), true);
  assert.deepEqual(readProjectTelemetryContext(projectRoot, options), {
    environmentId,
    tenantId,
    orgId,
  });
  assert.deepEqual(readProjectTelemetryContext(projectRoot, {
    ...options,
    spanId: descendant.spanId,
  }), {
    environmentId,
    tenantId,
    orgId,
  });
  assert.deepEqual(readProjectTelemetryContext(projectRoot, {
    ...options,
    spanId: root.spanId,
  }), {});
  assert.deepEqual(readProjectTelemetryContext(projectRoot, {
    ...options,
    spanId: sibling.spanId,
  }), {});
  let captured;
  const event = emitLifecycle({
    configDir,
    env: {},
    eventStreamName: 'event',
    sessionId: root.sessionId,
  }, verifiedStep, {
    cwd: projectRoot,
    emit: (value) => {
      captured = value;
    },
    readAiAgent: () => ({}),
  });
  assert.equal(captured, event);
  assert.equal(event.data.orgId, orgId);
  assert.equal(event.data.tenantId, tenantId);
  assert.equal(event.data.eventInfo.environmentId, environmentId);
  assert.equal(event.data.eventInfo.aadObjectId, undefined);
  assert.equal(event.data.eventInfo.userId, undefined);

  let siblingEvent;
  emitLifecycle({
    configDir,
    env: {},
    eventStreamName: 'event',
    sessionId: root.sessionId,
  }, sibling, {
    cwd: projectRoot,
    emit: (value) => {
      siblingEvent = value;
    },
    readAiAgent: () => ({}),
  });
  assert.equal(siblingEvent.data.orgId, undefined);
  assert.equal(siblingEvent.data.tenantId, undefined);
  assert.equal(siblingEvent.data.eventInfo.environmentId, undefined);

  const runDirectory = lifecycle.runDirectory(configDir, root.runId);
  const recorded = fs.readdirSync(runDirectory)
    .map((name) => fs.readFileSync(path.join(runDirectory, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    recorded,
    /PRIVATE|private@example|signature|user_impersonation|55555555|33333333/,
  );
});

test('project environment rejects malformed cached environment IDs', (context) => {
  const projectRoot = tempProject(context);
  fs.writeFileSync(path.join(projectRoot, '.resolved-environment.json'), JSON.stringify({
    environmentId: '../outside',
    environmentUrl: 'https://contoso.crm.dynamics.com',
    tenantId: '22222222-2222-4222-8222-222222222222',
  }));
  assert.equal(readProjectEnvironment(projectRoot), null);
});

test('mobile telemetry reuses canonical helpers without parallel modules', () => {
  const lib = path.join(PLUGIN_ROOT, 'scripts', 'lib');
  for (const obsolete of [
    'mobile-telemetry-fields.js',
    'mobile-telemetry-identity.js',
    'mobile-telemetry-lifecycle.js',
  ]) {
    assert.equal(fs.existsSync(path.join(lib, obsolete)), false, obsolete);
  }
  assert.equal(
    fs.existsSync(path.join(PLUGIN_ROOT, 'scripts', 'planning-timings.js')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(lib, 'mobile-lifecycle.js')),
    true,
  );
});
