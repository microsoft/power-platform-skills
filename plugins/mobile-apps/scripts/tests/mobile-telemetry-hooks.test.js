'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TRACKED_SKILL_NAMES } = require('../lib/mobileapp-hook-utils');
const { withStableDispatchCwd } = require('../../hooks/run-telemetry');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_VERSION = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
).version;
const HOOKS = path.join(PLUGIN_ROOT, 'hooks');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-telemetry-hooks-'));
  const projectRoot = path.join(root, 'project');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ dependencies: { expo: '^55', '@microsoft/power-apps-native-host': '^1' } }),
  );
  const ikeyPath = path.join(root, 'ikey.json');
  fs.writeFileSync(ikeyPath, JSON.stringify({
    instrumentationKey: 'test-mobile-key',
    collector_url: 'https://example.invalid/OneCollector/1.0/',
    event_stream_name: 'MobileAppsTestEvent',
    disabled: false,
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, projectRoot, configDir, ikeyPath };
}

function runHook(mode, payload, context, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(HOOKS, 'run-telemetry.js'), mode], {
    cwd: context.projectRoot,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: context.configDir,
      POWER_PLATFORM_SKILLS_IKEY_JSON: context.ikeyPath,
      // Positive tests keep the local mirror but can never contact OneCollector.
      POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
      ...extraEnv,
    },
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function logPath(context, sessionId = 'session-1') {
  return path.join(
    context.configDir,
    'telemetry',
    'mobile-app',
    'sessions',
    sessionId,
    'events.jsonl',
  );
}

function waitForEvents(context, expected, sessionId = 'session-1') {
  const filePath = logPath(context, sessionId);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length >= expected) return lines.map((line) => JSON.parse(line));
    } catch {
      // The detached dispatcher has not written yet.
    }
    sleep(25);
  }
  return [];
}

function waitForJson(filePath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // The detached dispatcher has not finished writing the probe yet.
    }
    sleep(25);
  }
  return null;
}

function toolPayload(context) {
  return {
    cwd: context.projectRoot,
    session_id: 'session-1',
    tool_input: { skill: 'deploy' },
  };
}

test('hook dispatch runs outside the caller project and restores its cwd', () => {
  const originalCwd = process.cwd();
  let dispatchCwd;

  withStableDispatchCwd(() => {
    dispatchCwd = fs.realpathSync(process.cwd());
  });

  assert.equal(dispatchCwd, fs.realpathSync(os.tmpdir()));
  assert.equal(process.cwd(), originalCwd);
});

test('runner emits the Application Insights selection event', (t) => {
  const context = fixture(t);
  const probePath = path.join(context.root, 'probe.json');
  const result = spawnSync(
    process.execPath,
    [
      path.join(HOOKS, 'run-telemetry.js'),
      'app-insights-selection',
      'enabled',
      context.projectRoot,
    ],
    {
      cwd: context.projectRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: context.configDir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: context.ikeyPath,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
        POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '',
      },
    },
  );

  assert.equal(result.status, 0);
  const probe = waitForJson(probePath);
  assert.ok(probe);
  const envelope = JSON.parse(probe.body);
  const dimensions = JSON.parse(envelope.data.customDimensions);
  assert.equal(envelope.data.event_Name, 'app_insights_selection');
  assert.deepEqual(dimensions.eventInfo, {
    appInstanceId: null,
    appInsightsSelection: 'enabled',
  });
});

test('prompt and pretool paths emit independent start signals', (t) => {
  const context = fixture(t);
  assert.equal(runHook('prompt', {
    cwd: context.projectRoot,
    session_id: 'session-1',
    prompt: '/deploy',
  }, context).status, 0);
  assert.equal(runHook('pretool', toolPayload(context), context).status, 0);

  const records = waitForEvents(context, 2);
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.data.eventName === 'skill_started'));
  assert.deepEqual(
    records.map((record) => record.data.eventInfo.invocationSource).sort(),
    ['pretool', 'prompt'],
  );
  assert.equal(new Set(records.map((record) => record.data.correlationId)).size, 2);
});

test('pretool-only invocation emits one start', (t) => {
  const context = fixture(t);
  assert.equal(runHook('pretool', toolPayload(context), context).status, 0);
  const records = waitForEvents(context, 1);
  assert.equal(records.filter((record) => record.data.eventName === 'skill_started').length, 1);
  assert.equal(records[0].data.eventInfo.invocationSource, 'pretool');
});

function seedCopilotSession(homeDir, rootSessionId, nestedSessionId) {
  const sessionDir = path.join(homeDir, '.copilot', 'session-state', rootSessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'hook.start', agentId: nestedSessionId })}\n`,
  );
}

test('nested Copilot agents log under their own owning root session', (t) => {
  const context = fixture(t);
  const homeDir = path.join(context.root, 'home');
  const sessions = [
    { root: 'e58e3db3-8361-4516-ac4b-6b143c22100a', nested: 'call_firstAgent', skill: 'deploy' },
    { root: '97bd0a1b-a83b-4e59-a23e-1c6688626401', nested: 'call_secondAgent', skill: 'debug-app' },
  ];
  const invoke = (current) => assert.equal(runHook('pretool', {
    cwd: context.projectRoot,
    sessionId: current.nested,
    tool_input: { skill: current.skill },
  }, context, {
    HOME: homeDir,
    // os.homedir() uses USERPROFILE rather than HOME on Windows.
    USERPROFILE: homeDir,
  }).status, 0);

  for (const current of sessions) {
    seedCopilotSession(homeDir, current.root, current.nested);
    invoke(current);
  }
  for (const current of sessions) {
    assert.equal(waitForEvents(context, 1, current.root).length, 1);
  }

  // Every hook runs in a fresh Node process, so removing the host state proves
  // the second round resolves only through the cross-process alias cache.
  fs.rmSync(path.join(homeDir, '.copilot'), { recursive: true, force: true });
  for (const current of sessions) invoke(current);

  for (const current of sessions) {
    const records = waitForEvents(context, 2, current.root);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.data.sessionId === current.root));
    assert.equal(fs.existsSync(logPath(context, current.nested)), false);
  }
});

test('pretool hook emits every tracked skill from bare and qualified names', (t) => {
  const context = fixture(t);
  for (const skillName of TRACKED_SKILL_NAMES) {
    for (const reportedName of [skillName, `mobile-app:${skillName}`]) {
      assert.equal(runHook('pretool', {
        cwd: context.root,
        session_id: 'session-1',
        tool_input: { skill: reportedName },
      }, context).status, 0);
    }
  }

  const records = waitForEvents(context, TRACKED_SKILL_NAMES.length * 2);
  assert.deepEqual(
    records.map((record) => record.data.skillName).sort(),
    TRACKED_SKILL_NAMES.flatMap((skillName) => [skillName, skillName]).sort(),
  );
  assert.ok(records.every(
    (record) => record.data.eventInfo.invocationSource === 'pretool',
  ));
});

test('bare nested skill emits when the session cwd is outside the mobile project', (t) => {
  const context = fixture(t);
  assert.equal(runHook('pretool', {
    cwd: context.root,
    session_id: 'session-1',
    tool_input: { skill: 'design-system' },
  }, context).status, 0);

  const records = waitForEvents(context, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].data.skillName, 'design-system');
  assert.equal(records[0].data.eventInfo.invocationSource, 'pretool');
});

test('prompt hook builds the Power Apps normal-event envelope without real network access', (t) => {
  const context = fixture(t);
  const probePath = path.join(context.root, 'probe.json');
  const result = runHook('prompt', {
    cwd: context.projectRoot,
    session_id: 'session-1',
    prompt: '/mobile-app:deploy',
  }, context, {
    POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
    // The fake probe is the only positive transmission test. It clears the CI
    // backstop in this child while the dispatcher remains unable to reach a URL.
    POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '',
  });

  assert.equal(result.status, 0);
  const probe = waitForJson(probePath);
  assert.ok(probe, 'dispatcher should write the fake HTTPS probe');
  assert.equal(probe.headers['Content-Type'], 'application/x-json-stream; charset=utf-8');
  assert.equal(probe.headers['x-apikey'], 'test-mobile-key');
  assert.ok(probe.body.endsWith('\n'));
  const envelope = JSON.parse(probe.body);
  assert.deepEqual(Object.keys(envelope).sort(), ['data', 'ext', 'iKey', 'name', 'time', 'ver']);
  assert.equal(envelope.ver, '4.0');
  assert.equal(envelope.name, 'MobileAppsTestEvent');
  assert.equal(envelope.iKey, 'o:test');
  assert.equal(envelope.data.app_Name, 'powerappsclient');
  assert.equal(envelope.data.clientType, 'PowerAppsNative');
  assert.equal(envelope.data.clusterCategory, 'prod');
  assert.equal(envelope.data.device_Id, 'react-native');
  assert.equal(envelope.data.event_Name, 'skill_started');
  assert.equal(envelope.data.session_Id, 'session-1');
  assert.equal(envelope.data.severity, 'Info');
  assert.equal(envelope.data.timestamp, envelope.time);
  assert.equal(envelope.ext.app.sesId, 'session-1');
  assert.equal(envelope.ext.app.ver, PLUGIN_VERSION);
  assert.ok(envelope.ext.os.name);
  assert.ok(envelope.ext.os.ver);

  const dimensions = JSON.parse(envelope.data.customDimensions);
  assert.equal(dimensions.pluginName, 'mobile-app');
  assert.equal(dimensions.pluginVersion, PLUGIN_VERSION);
  assert.equal(dimensions.sessionId, 'session-1');
  assert.match(dimensions.correlationId, /^[0-9a-f-]{36}$/);
  assert.ok(dimensions.osName);
  assert.ok(dimensions.osVersion);
  assert.match(dimensions.nodeVersion, /^v\d+$/);
  assert.equal(dimensions.skillName, 'deploy');
  assert.deepEqual(dimensions.eventInfo, {
    invocationSource: 'prompt',
    appInstanceId: null,
  });
  for (const legacy of ['eventName', 'eventType', 'pluginName', 'sessionId', 'skillName']) {
    assert.equal(Object.prototype.hasOwnProperty.call(envelope.data, legacy), false);
  }
  for (const forbidden of [
    'orgId',
    'tenantId',
    'pacCliVersion',
    'aadObjectId',
    'prompt',
    'cwd',
    'path',
    'outcome',
    'durationMs',
    'errorClass',
    'errorDescription',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(dimensions, forbidden), false);
  }
});

test('environment opt-out keeps the local mirror and suppresses transmission', (t) => {
  const context = fixture(t);
  const probePath = path.join(context.root, 'opted-out-probe.json');
  const result = runHook('pretool', toolPayload(context), context, {
    POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
  });

  assert.equal(result.status, 0);
  assert.equal(waitForEvents(context, 1).length, 1);
  assert.equal(fs.existsSync(probePath), false);
});

test('bare command outside a mobile project emits a start', (t) => {
  const context = fixture(t);
  const unrelated = path.join(context.root, 'unrelated');
  fs.mkdirSync(unrelated);
  runHook('prompt', {
    cwd: unrelated,
    session_id: 'session-1',
    prompt: '/deploy',
  }, context);

  const records = waitForEvents(context, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].data.skillName, 'deploy');
  assert.equal(records[0].data.eventInfo.invocationSource, 'prompt');
  assert.equal(records[0].data.eventInfo.appInstanceId, null);
});

test('manual Copilot slash command emits after host expansion', (t) => {
  const context = fixture(t);
  assert.equal(runHook('prompt', {
    cwd: context.projectRoot,
    session_id: 'session-1',
    prompt: '<skill-context name="add-connector">\n<instructions>redacted</instructions>',
  }, context).status, 0);

  const records = waitForEvents(context, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].data.skillName, 'add-connector');
  assert.equal(records[0].data.eventInfo.invocationSource, 'prompt');
  assert.equal(records[0].data.eventInfo.appInstanceId, null);
});

test('hook attaches app identity from app.json when cwd is a project root', (t) => {
  const context = fixture(t);
  fs.writeFileSync(
    path.join(context.projectRoot, 'app.json'),
    JSON.stringify({
      expo: {
        extra: {
          telemetry: {
            appInstanceId: '5d7e71b1-61d6-4a91-9c2e-cba5db983e38',
          },
        },
      },
    }),
  );

  assert.equal(runHook('pretool', {
    cwd: context.projectRoot,
    session_id: 'session-1',
    tool_input: { skill: 'deploy' },
  }, context).status, 0);

  const records = waitForEvents(context, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].data.eventInfo.invocationSource, 'pretool');
  assert.equal(
    records[0].data.eventInfo.appInstanceId,
    '5d7e71b1-61d6-4a91-9c2e-cba5db983e38',
  );
});

test('hook resolves --working-dir from tool input when cwd is outside the project', (t) => {
  const context = fixture(t);
  fs.writeFileSync(
    path.join(context.projectRoot, 'app.json'),
    JSON.stringify({
      expo: {
        extra: {
          telemetry: {
            appInstanceId: 'e5b2f43c-fa9f-44a0-b8a7-54e4f956f9db',
          },
        },
      },
    }),
  );
  const unrelated = path.join(context.root, 'outside');
  fs.mkdirSync(unrelated);

  assert.equal(runHook('pretool', {
    cwd: unrelated,
    session_id: 'session-1',
    tool_input: {
      skill: 'deploy',
      arguments: `--working-dir "${context.projectRoot}" --non-interactive`,
    },
  }, context).status, 0);

  const records = waitForEvents(context, 1);
  assert.equal(records.length, 1);
  assert.equal(
    records[0].data.eventInfo.appInstanceId,
    'e5b2f43c-fa9f-44a0-b8a7-54e4f956f9db',
  );
});

test('another plugin namespace and embedded command are no-ops', (t) => {
  const context = fixture(t);
  runHook('prompt', {
    cwd: context.projectRoot,
    session_id: 'session-1',
    prompt: '/code-apps:deploy',
  }, context);
  runHook('prompt', {
    cwd: context.projectRoot,
    session_id: 'session-1',
    prompt: 'please run /mobile-app:deploy',
  }, context);
  sleep(300);
  assert.equal(fs.existsSync(logPath(context)), false);
});

test('disabled repository config creates no telemetry artifacts', (t) => {
  const context = fixture(t);
  const disabledIkey = path.join(context.root, 'disabled-ikey.json');
  fs.writeFileSync(disabledIkey, JSON.stringify({
    instrumentationKey: 'test-mobile-key',
    collector_url: 'https://example.invalid/OneCollector/1.0/',
    event_stream_name: 'MobileAppsTestEvent',
    disabled: true,
  }));
  runHook('pretool', toolPayload(context), context, {
    POWER_PLATFORM_SKILLS_IKEY_JSON: disabledIkey,
  });
  sleep(300);
  assert.equal(fs.existsSync(path.join(context.configDir, 'telemetry')), false);
});