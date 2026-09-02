'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  createTelemetryContext,
  emitAppInsightsSelection,
  emitSkillStarted,
} = require('../lib/mobile-telemetry');
const { ensureAppInstanceId, findAppInstanceId } = require('../lib/app-identity');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const TELEMETRY_CLI = path.join(
  PLUGIN_ROOT,
  'scripts',
  'lib',
  'mobile-telemetry-config.js',
);
const BUNDLED_TELEMETRY_LIB = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'telemetry', 'lib');
const SHARED_TELEMETRY_LIB = path.resolve(PLUGIN_ROOT, '..', '..', 'shared', 'telemetry', 'lib');

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

test('Application Insights prompt selections emit only the approved choice', (t) => {
  const context = contextFor(provisioned);
  for (const selection of ['enabled', 'disabled']) {
    let captured;
    const event = emitAppInsightsSelection(context, selection, {
      emit: (value) => { captured = value; },
      readAiAgent: () => ({}),
      correlationId: 'correlation-1',
      cwd: tempProject(t),
    });
    assert.equal(captured, event);
    assert.equal(event.data.eventName, 'app_insights_selection');
    assert.equal(event.data.skillName, 'create-mobile-app');
    assert.deepEqual(event.data.eventInfo, {
      appInstanceId: null,
      appInsightsSelection: selection,
    });
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

test('two apps in one session emit distinct app identities', (t) => {
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
  ensureAppInstanceId(projectA);
  ensureAppInstanceId(projectB);
  const a = emitFrom(projectA);
  const b = emitFrom(projectB);
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