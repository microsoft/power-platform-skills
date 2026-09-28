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
const { sanitizeData } = require('../lib/mobile-telemetry-dispatcher');
const {
  readProjectTelemetryContext,
  recordVerifiedDataverseOrganization,
} = require('../lib/app-identity');
const { runCommand } = require('../emit-telemetry-checkpoint');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
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
  const resumed = lifecycle.resumeSpan({
    projectRoot,
    configDir,
    runId: root.runId,
    spanId: step.spanId,
  });
  assert.equal(resumed.sessionId, root.sessionId);

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

test('command wrapper preserves exit code without recording command content', (context) => {
  const projectRoot = tempProject(context);
  const telemetry = telemetryContext(projectRoot);
  const root = lifecycle.beginSpan({
    projectRoot,
    configDir: telemetry.configDir,
    skillName: 'create-mobile-app',
  });
  const emitted = [];
  const result = runCommand([
    '--execute',
    'create-mobile-app|validate_fresh_template',
    '--run-id',
    root.runId,
    '--parent-span-id',
    root.spanId,
    '--project-root',
    projectRoot,
    '--',
    'private-executable',
    'customer-secret',
  ], {
    createTelemetryContext: () => telemetry,
    emitLifecycle: (_telemetry, span) => emitted.push(span),
    spawnSync: (command, args, options) => {
      assert.equal(command, 'private-executable');
      assert.deepEqual(args, ['customer-secret']);
      assert.equal(options.shell, false);
      assert.equal(options.env.POWER_PLATFORM_SKILLS_MOBILE_RUN_ID, root.runId);
      assert.ok(options.env.POWER_PLATFORM_SKILLS_MOBILE_SPAN_ID);
      return { status: 7 };
    },
  });
  assert.equal(result.exitCode, 7);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].state, 'failed');

  const report = lifecycle.reportRun({
    projectRoot,
    configDir: telemetry.configDir,
    runId: root.runId,
  });
  assert.equal(report.supportId, root.runId);
  assert.doesNotMatch(JSON.stringify(report), /private-executable|customer-secret/);
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
  fs.mkdirSync(lockPath);
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
    fs.rmdirSync(lockPath);
  }
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

  assert.equal(recordVerifiedDataverseOrganization({
    ...options,
    environmentUrl,
    token,
    whoAmI: {
      OrganizationId: orgId,
      UserId: '55555555-5555-4555-8555-555555555555',
    },
  }), true);
  assert.deepEqual(readProjectTelemetryContext(projectRoot, options), {
    environmentId,
    tenantId,
    orgId,
  });
  let captured;
  const event = emitLifecycle({
    configDir,
    env: {},
    eventStreamName: 'event',
    sessionId: root.sessionId,
  }, root, {
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

  const runDirectory = lifecycle.runDirectory(configDir, root.runId);
  const recorded = fs.readdirSync(runDirectory)
    .map((name) => fs.readFileSync(path.join(runDirectory, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    recorded,
    /PRIVATE|private@example|signature|user_impersonation|55555555|33333333/,
  );
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
