'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  createTelemetryContext,
  emitCheckpoint: emitCheckpointEvent,
  emitSkillStarted,
} = require('../lib/mobile-telemetry');
const {
  emitCheckpoint: emitCheckpointCommand,
  parseCheckpointPayload,
} = require('../emit-telemetry-checkpoint');
const { ensureAppInstanceId, findAppInstanceId } = require('../lib/app-identity');
const { TRACKED_SKILL_NAMES } = require('../lib/mobileapp-hook-utils');
const { readProcessScope } = require('../lib/mobile-telemetry-session');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const TELEMETRY_CLI = path.join(
  PLUGIN_ROOT,
  'scripts',
  'lib',
  'mobile-telemetry-config.js',
);
const BUNDLED_TELEMETRY_LIB = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'telemetry', 'lib');
const SHARED_TELEMETRY_LIB = path.resolve(PLUGIN_ROOT, '..', '..', 'shared', 'telemetry', 'lib');
const CHECKPOINT_EXEMPT_SKILLS = new Set(['telemetry']);
const VAGUE_CHECKPOINT_NAMES = new Set([
  'app_ready',
  'data_model',
  'planning',
  'prerequisites',
  'scaffold',
  'screens',
  'template_gate',
]);

function tempConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-telemetry-'));
  const ikeyPath = path.join(dir, 'ikey.json');
  fs.writeFileSync(ikeyPath, JSON.stringify(config));
  return { dir, ikeyPath };
}

// An empty directory keeps app-identity lookup out of the repo checkout, so
// event assertions do not depend on where the suite happens to run.
function tempProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-app-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function contextFor(config) {
  const { dir, ikeyPath } = tempConfig(config);
  return createTelemetryContext(
    { session_id: 'session-1' },
    {
      env: {
        POWER_PLATFORM_SKILLS_CONFIG_DIR: dir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
      },
    },
  );
}

function copilotOpts(t, roots, now = Date.now()) {
  const { dir, ikeyPath } = tempConfig(provisioned);
  const copilotSessionStateDir = path.join(dir, 'copilot-session-state');
  for (const root of roots) {
    const eventsPath = path.join(copilotSessionStateDir, root.id, 'events.jsonl');
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.writeFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'hook.start', agentId: root.agentId })}\n`,
    );
    const modified = new Date(root.mtimeMs === undefined ? now : root.mtimeMs);
    fs.utimesSync(eventsPath, modified, modified);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    env: {
      POWER_PLATFORM_SKILLS_CONFIG_DIR: dir,
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
    },
    copilotSessionAliasDir: path.join(dir, 'session-aliases'),
    copilotSessionStateDir,
    now,
  };
}

function copilotSessionId(t, roots, nestedSessionId, now) {
  const context = createTelemetryContext(
    { sessionId: nestedSessionId },
    copilotOpts(t, roots, now),
  );
  assert.ok(context);
  return context.sessionId;
}

const provisioned = {
  instrumentationKey: 'test-mobile-key',
  collector_url: 'https://example.invalid/OneCollector/1.0/',
  event_stream_name: 'MobileAppsTestEvent',
  disabled: false,
};

const invocation = {
  skillName: 'deploy',
  source: 'pretool',
};

function relativeFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...relativeFiles(root, absolute));
    if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files.sort();
}

test('hard-off and placeholder configurations create no telemetry context', () => {
  assert.equal(contextFor({ ...provisioned, disabled: true }), null);
  assert.equal(contextFor({ ...provisioned, instrumentationKey: 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING' }), null);
  assert.equal(contextFor({ ...provisioned, collector_url: '' }), null);
});

test('provisioned context uses host session and isolated config paths', () => {
  const context = contextFor(provisioned);
  assert.ok(context);
  assert.equal(context.sessionId, 'session-1');
  assert.equal(context.eventStreamName, 'MobileAppsTestEvent');
});

test('Windows session lookup requests only identity fields within the hook deadline', () => {
  let command;
  const scope = readProcessScope({
    platform: 'win32',
    parentPid: 300,
    exec: (executable, args, options) => {
      command = { executable, args, options };
      return JSON.stringify([
        { ProcessId: 300, ParentProcessId: 200, CreationDate: '/Date(1788850001000)/', Name: 'cmd.exe' },
        { ProcessId: 200, ParentProcessId: 100, CreationDate: '/Date(1788850000000)/', Name: 'C:\\Program Files\\nodejs\\node.exe' },
      ]);
    },
  });

  assert.equal(scope, '200:/Date(1788850000000)/');
  assert.equal(command.executable, 'powershell.exe');
  assert.ok(command.args.includes('-NoProfile'));
  assert.ok(command.args.includes('-NonInteractive'));
  assert.match(command.args.at(-1), /Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name/);
  assert.doesNotMatch(command.args.at(-1), /CommandLine|ExecutablePath/);
  assert.ok(command.options.timeout >= 5000 && command.options.timeout < 10000,
    'allow bounded PowerShell startup time while staying below the ten-second hook deadline');
});

test('Windows session lookup remains fail-open when process metadata is unavailable', () => {
  for (const code of ['ETIMEDOUT', 'ENOENT']) {
    assert.equal(readProcessScope({
      platform: 'win32',
      exec: () => { throw Object.assign(new Error('Process metadata unavailable'), { code }); },
    }), '');
  }
  assert.equal(readProcessScope({ platform: 'win32', exec: () => '{incomplete' }), '');
});

test('nested Copilot call resolves to its owning root session', (t) => {
  const rootSessionId = 'e58e3db3-8361-4516-ac4b-6b143c22100a';
  const nestedSessionId = 'call_ayAuxKIYLLOtpejidbHsMAmu';
  assert.equal(copilotSessionId(t, [
    { id: rootSessionId, agentId: nestedSessionId },
    { id: '97bd0a1b-a83b-4e59-a23e-1c6688626401', agentId: 'call_unrelatedAgent' },
  ], nestedSessionId), rootSessionId);
});

test('oversized partial Copilot record cannot claim a nested session', (t) => {
  const rootSessionId = 'e58e3db3-8361-4516-ac4b-6b143c22100a';
  const nestedSessionId = 'call_partialRecord';
  const opts = copilotOpts(t, [{ id: rootSessionId, agentId: 'call_unrelatedAgent' }]);
  const eventsPath = path.join(opts.copilotSessionStateDir, rootSessionId, 'events.jsonl');
  const parseableFragment = JSON.stringify({ agentId: nestedSessionId });
  const maxTailBytes = 4 * 1024 * 1024;

  // The bounded read starts after the leading byte, making its entire tail look
  // like valid JSON even though no newline proves that it starts at a record.
  fs.writeFileSync(
    eventsPath,
    `x${parseableFragment}${' '.repeat(maxTailBytes - parseableFragment.length)}`,
  );

  const context = createTelemetryContext({ sessionId: nestedSessionId }, opts);
  assert.ok(context);
  assert.equal(context.sessionId, nestedSessionId);
});

test('stale Copilot state does not absorb a nested session', (t) => {
  const now = Date.now();
  const nestedSessionId = 'call_staleNestedAgent';
  assert.equal(copilotSessionId(t, [{
    id: 'e58e3db3-8361-4516-ac4b-6b143c22100a',
    agentId: nestedSessionId,
    mtimeMs: now - (10 * 60 * 1000),
  }], nestedSessionId, now), nestedSessionId);
});

test('ambiguous Copilot ownership does not merge root sessions', (t) => {
  const nestedSessionId = 'call_duplicatedNestedAgent';
  assert.equal(copilotSessionId(t, [
    { id: 'e58e3db3-8361-4516-ac4b-6b143c22100a', agentId: nestedSessionId },
    { id: '97bd0a1b-a83b-4e59-a23e-1c6688626401', agentId: nestedSessionId },
  ], nestedSessionId), nestedSessionId);
});

test('expired Copilot alias does not outlive unavailable host state', (t) => {
  const rootSessionId = 'e58e3db3-8361-4516-ac4b-6b143c22100a';
  const nestedSessionId = 'call_expiringNestedAgent';
  const now = Date.now();
  const opts = copilotOpts(t, [{ id: rootSessionId, agentId: nestedSessionId }], now);

  const initial = createTelemetryContext({ sessionId: nestedSessionId }, opts);
  assert.ok(initial);
  assert.equal(initial.sessionId, rootSessionId);

  fs.rmSync(opts.copilotSessionStateDir, { recursive: true, force: true });
  const expired = createTelemetryContext(
    { sessionId: nestedSessionId },
    { ...opts, now: now + (31 * 60 * 1000) },
  );
  assert.ok(expired);
  assert.equal(expired.sessionId, nestedSessionId);
});

test('started event is allowlisted and carries no user, tenant, prompt, or path data', (t) => {
  const context = contextFor(provisioned);
  let captured;
  const event = emitSkillStarted(context, invocation, {
    emit: (value) => { captured = value; },
    readAiAgent: () => ({ aiAgentName: 'GitHub Copilot', aiAgentVersion: '1.2.3' }),
    correlationId: 'correlation-1',
    cwd: tempProject(t),
  });
  assert.equal(captured, event);
  assert.equal(event.data.eventName, 'skill_started');
  assert.equal(event.data.pluginName, 'mobile-app');
  assert.equal(event.data.skillName, 'deploy');
  assert.equal(event.data.sessionId, 'session-1');
  assert.equal(event.data.correlationId, 'correlation-1');
  assert.deepEqual(event.data.eventInfo, { invocationSource: 'pretool', appInstanceId: null });
  for (const forbidden of ['orgId', 'tenantId', 'pacCliVersion', 'aadObjectId', 'prompt', 'cwd', 'path']) {
    assert.equal(Object.prototype.hasOwnProperty.call(event.data, forbidden), false);
  }
});

test('checkpoint payload accepts only tracked skills and static snake_case fields', () => {
  assert.deepEqual(
    parseCheckpointPayload('create-mobile-app|planning|completed|with_dataverse'),
    {
      skillName: 'create-mobile-app',
      eventName: 'planning_completed',
      severity: 'Info',
      source: 'checkpoint',
      additionalInfo: 'with_dataverse',
    },
  );

  for (const payload of [
    '',
    'unknown-skill|planning|started',
    'create-mobile-app|Planning|started',
    'create-mobile-app|planning|finished',
    'create-mobile-app|planning|started|',
    'create-mobile-app|planning|failed|C:\\secret\\file.txt',
    `create-mobile-app|${'a'.repeat(65)}|started`,
    'create-mobile-app|planning|started|safe|extra',
  ]) {
    assert.equal(parseCheckpointPayload(payload), null, payload);
  }
});

test('checkpoint command emits directly and remains fail-open', () => {
  const context = { sessionId: 'checkpoint-session' };
  let captured;
  const result = emitCheckpointCommand(
    'create-mobile-app|template_gate|started',
    {
      cwd: 'C:\\private-project',
      createTelemetryContext: (payload) => {
        assert.deepEqual(payload, {});
        return context;
      },
      emitCheckpoint: (...args) => {
        captured = args;
        return 'emitted';
      },
    },
  );

  assert.equal(result, 'emitted');
  assert.deepEqual(captured, [
    context,
    {
      skillName: 'create-mobile-app',
      eventName: 'template_gate_started',
      severity: 'Info',
      source: 'checkpoint',
      additionalInfo: undefined,
    },
    { cwd: 'C:\\private-project' },
  ]);
  assert.equal(emitCheckpointCommand('invalid', {
    createTelemetryContext: () => { throw new Error('must not run'); },
  }), null);
  assert.equal(emitCheckpointCommand('create-mobile-app|planning|started', {
    createTelemetryContext: () => { throw new Error('telemetry unavailable'); },
  }), null);
});

test('checkpoint event carries only static checkpoint enrichment', (t) => {
  const context = contextFor(provisioned);
  const event = emitCheckpointEvent(context, {
    skillName: 'create-mobile-app',
    eventName: 'planning_failed',
    severity: 'Error',
    source: 'checkpoint',
    additionalInfo: 'dependency_missing',
  }, {
    emit: () => {},
    readAiAgent: () => ({}),
    correlationId: 'correlation-1',
    cwd: tempProject(t),
  });

  assert.equal(event.data.eventName, 'planning_failed');
  assert.equal(event.data.severity, 'Error');
  assert.equal(event.data.skillName, 'create-mobile-app');
  assert.deepEqual(event.data.eventInfo, {
    invocationSource: 'checkpoint',
    additionalInfo: 'dependency_missing',
    appInstanceId: null,
  });
  for (const forbidden of ['prompt', 'cwd', 'path', 'error', 'errorDescription']) {
    assert.equal(Object.prototype.hasOwnProperty.call(event.data, forbidden), false);
  }
});

test('shared instructions own checkpoint execution and lifecycle rules', () => {
  const shared = fs.readFileSync(path.join(PLUGIN_ROOT, 'shared', 'shared-instructions.md'), 'utf8');
  const checkpointSection = shared.match(/## Workflow Checkpoints\r?\n([\s\S]*?)(?=\r?\n---)/)?.[1];
  assert.ok(checkpointSection, 'shared instructions must define the checkpoint policy');
  assert.match(checkpointSection, /frontmatter `name`/);
  assert.match(checkpointSection, /node "\$\{PLUGIN_ROOT\}\/scripts\/emit-telemetry-checkpoint\.js" "<skill-name>\|<checkpoint-name>\|<state>" \|\| true/);
  for (const state of ['started', 'completed', 'failed', 'skipped']) {
    assert.ok(checkpointSection.includes(`\`${state}\``), `shared policy must explain ${state}`);
  }
  assert.match(checkpointSection, /only `skipped`, without `started`/);
  assert.match(checkpointSection, /author-written `snake_case` values of at most 64 characters/);
  assert.match(checkpointSection, /never include prompts, errors, paths, names, identifiers, URLs, command output, or other runtime data/);
  assert.match(checkpointSection, /fail-open/);
  assert.match(checkpointSection, /Do not duplicate emissions/);
});

test('create-mobile-app uses precise checkpoint names at major workflow boundaries', () => {
  const shared = fs.readFileSync(path.join(PLUGIN_ROOT, 'shared', 'shared-instructions.md'), 'utf8');
  const workflow = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills', 'create-mobile-app', 'SKILL.md'),
    'utf8',
  );

  assert.match(shared, /node "\$\{PLUGIN_ROOT\}\/scripts\/emit-telemetry-checkpoint\.js"/);
  assert.doesNotMatch(shared, /node "\$\{CLAUDE_SKILL_DIR\}/);
  assert.doesNotMatch(shared, /trigger-telemetry/);
  assert.deepEqual(
    [...workflow.matchAll(/\*\*Telemetry checkpoint: `([^`]+)`\*\*/g)]
      .map((match) => match[1]),
    [
      'validate_fresh_template',
      'validate_development_toolchain',
      'gather_app_requirements',
      'plan_app_architecture',
      'select_app_environment',
      'prepare_template_files',
      'initialize_power_apps_project',
      'validate_scaffold_typescript',
      'configure_native_authentication',
      'apply_dataverse_data_model',
      'configure_native_capabilities',
      'install_approved_javascript_dependencies',
      'generate_connector_data_sources',
      'wire_app_navigation',
      'generate_shared_code_and_screen_skeletons',
      'build_and_validate_screens',
      'validate_screen_design_quality',
      'launch_metro_dev_server',
    ],
  );
});

test('every tracked operational skill has precise checkpoint markers', () => {
  for (const skillName of TRACKED_SKILL_NAMES) {
    const workflow = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    const matches = [...workflow.matchAll(/\*\*Telemetry checkpoint: `([^`]+)`\*\*/g)];

    if (CHECKPOINT_EXEMPT_SKILLS.has(skillName)) {
      assert.deepEqual(matches, [], `${skillName} must remain checkpoint-free`);
      continue;
    }

    assert.ok(matches.length > 0, `${skillName} must define at least one checkpoint`);
    assert.match(workflow.slice(0, matches[0].index),
      /\[[^\]]+\]\((?:\.\.\/\.\.\/|\$\{PLUGIN_ROOT\}\/)shared\/shared-instructions\.md\)/,
      `${skillName} must reference shared instructions before its first checkpoint`);
    assert.doesNotMatch(workflow, /\*\*Checkpoint execution:\*\*|emit-telemetry-checkpoint\.js/,
      `${skillName} must inherit checkpoint execution from shared instructions`);
    const names = matches.map((match) => match[1]);
    assert.equal(new Set(names).size, names.length, `${skillName} checkpoint names must be unique`);

    for (const match of matches) {
      const checkpointName = match[1];
      assert.equal(
        VAGUE_CHECKPOINT_NAMES.has(checkpointName),
        false,
        `${skillName} uses vague checkpoint name ${checkpointName}`,
      );
      assert.doesNotMatch(
        checkpointName,
        /_(?:started|completed|skipped|failed)$/,
        `${skillName} checkpoint names must not contain lifecycle state`,
      );
      assert.ok(
        parseCheckpointPayload(`${skillName}|${checkpointName}|started`),
        `${skillName} uses invalid checkpoint name ${checkpointName}`,
      );

      const precedingLine = workflow
        .slice(0, match.index)
        .trimEnd()
        .split(/\r?\n/)
        .at(-1);
      assert.match(
        precedingLine,
        /^#{2,4}\s+\S/,
        `${skillName}:${checkpointName} must appear directly below a heading`,
      );
    }
  }
});

test('app instance id is minted once and reused by later skill runs', (t) => {
  const project = tempProject(t);
  fs.writeFileSync(
    path.join(project, 'app.json'),
    JSON.stringify({
      expo: {
        extra: {
          powerappsNative: {
            schemaVersion: 1,
            templateVersion: 1,
          },
        },
      },
    }),
  );
  const appInstanceId = ensureAppInstanceId(project);
  assert.match(appInstanceId, /^[0-9a-f-]{36}$/);
  assert.equal(ensureAppInstanceId(project), appInstanceId);
  assert.equal(findAppInstanceId(project), appInstanceId);
  assert.equal(findAppInstanceId(path.join(project, 'src', 'screens')), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, 'app.json'), 'utf8')), {
    expo: {
      extra: {
        powerappsNative: {
          schemaVersion: 1,
          templateVersion: 1,
        },
        telemetry: { appInstanceId },
      },
    },
  });
});

test('app identity refuses missing or invalid Expo app.json files', (t) => {
  const invalidProjects = [
    { project: tempProject(t), contents: null },
    { project: tempProject(t), contents: '{ invalid json' },
    { project: tempProject(t), contents: '{}' },
  ];

  for (const { project, contents } of invalidProjects) {
    const filePath = path.join(project, 'app.json');
    if (contents !== null) fs.writeFileSync(filePath, contents);

    assert.throws(
      () => ensureAppInstanceId(project),
      /existing, valid Expo app\.json/,
    );
    assert.equal(
      fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null,
      contents,
    );
  }
});

test('events outside a project carry no app identity', (t) => {
  assert.equal(findAppInstanceId(tempProject(t)), '');
});

test('event identity initialization leaves missing or invalid project files untouched', (t) => {
  const context = contextFor(provisioned);
  const emitFrom = (cwd) => emitSkillStarted(context, invocation, {
    emit: () => {},
    readAiAgent: () => ({}),
    cwd,
  }).data;

  for (const contents of [null, '{ invalid json', '{}']) {
    const project = tempProject(t);
    const filePath = path.join(project, 'app.json');
    if (contents !== null) fs.writeFileSync(filePath, contents);
    assert.equal(emitFrom(project).eventInfo.appInstanceId, null);
    assert.equal(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null, contents);
  }
  assert.equal(emitFrom('').eventInfo.appInstanceId, null);
  assert.equal(emitFrom(undefined).eventInfo.appInstanceId, null);
});

test('a hand-edited app identity is ignored rather than emitted', (t) => {
  const project = tempProject(t);
  fs.writeFileSync(
    path.join(project, 'app.json'),
    JSON.stringify({
      expo: {
        extra: {
          telemetry: {
            appInstanceId: 'contoso-field-inspections',
          },
        },
      },
    }),
  );
  assert.equal(findAppInstanceId(project), '');
});

test('first events generate distinct app identities and later events reuse them', (t) => {
  const context = contextFor(provisioned);
  const emitFrom = (project) => emitSkillStarted(context, invocation, {
    emit: () => {},
    readAiAgent: () => ({}),
    cwd: project,
  }).data;

  const first = emitFrom(tempProject(t));
  const second = emitFrom(tempProject(t));
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.eventInfo.appInstanceId, null);

  const projectA = tempProject(t);
  const projectB = tempProject(t);
  fs.writeFileSync(path.join(projectA, 'app.json'), JSON.stringify({ expo: {} }));
  fs.writeFileSync(path.join(projectB, 'app.json'), JSON.stringify({ expo: {} }));
  const a = emitFrom(projectA);
  const b = emitFrom(projectB);
  assert.match(a.eventInfo.appInstanceId, /^[0-9a-f-]{36}$/);
  assert.match(b.eventInfo.appInstanceId, /^[0-9a-f-]{36}$/);
  assert.equal(findAppInstanceId(projectA), a.eventInfo.appInstanceId);
  assert.equal(findAppInstanceId(projectB), b.eventInfo.appInstanceId);
  assert.equal(emitFrom(projectA).eventInfo.appInstanceId, a.eventInfo.appInstanceId);
  assert.equal(emitFrom(projectB).eventInfo.appInstanceId, b.eventInfo.appInstanceId);
  assert.notEqual(a.eventInfo.appInstanceId, b.eventInfo.appInstanceId);
  assert.equal(a.sessionId, b.sessionId);
});

test('bundled telemetry library is byte-identical to the canonical shared source', (t) => {
  if (!fs.existsSync(SHARED_TELEMETRY_LIB)) {
    t.skip('canonical shared source is unavailable in an installed plugin');
    return;
  }

  const expectedFiles = relativeFiles(SHARED_TELEMETRY_LIB);
  assert.deepEqual(relativeFiles(BUNDLED_TELEMETRY_LIB), expectedFiles);
  for (const relativePath of expectedFiles) {
    assert.deepEqual(
      fs.readFileSync(path.join(BUNDLED_TELEMETRY_LIB, relativePath)),
      fs.readFileSync(path.join(SHARED_TELEMETRY_LIB, relativePath)),
      `${relativePath} must be refreshed from shared/telemetry/lib`,
    );
  }
});

test('Mobile control wrapper updates preference with accurate disclosure', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-telemetry-control-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    POWER_PLATFORM_SKILLS_CONFIG_DIR: dir,
    POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '',
  };

  const status = spawnSync(process.execPath, [TELEMETRY_CLI, '--action', 'status'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(status.status, 0);
  assert.match(status.stdout, /Telemetry \(mobile-app\): ON/);
  assert.match(status.stdout, /does not record PAC CLI version/);
  assert.match(status.stdout, /organization or Entra tenant IDs/);
  assert.doesNotMatch(status.stdout, /when PAC is signed in/);

  const off = spawnSync(process.execPath, [TELEMETRY_CLI, '--action', 'off'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(off.status, 0);
  assert.match(off.stdout, /Telemetry \(mobile-app\): OFF/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.telemetry['mobile-app'], 'off');
});