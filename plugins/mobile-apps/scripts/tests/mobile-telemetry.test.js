'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  createTelemetryContext,
  emitSkillStarted,
} = require('../lib/mobile-telemetry');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const TELEMETRY_CLI = path.join(
  PLUGIN_ROOT,
  'scripts',
  'lib',
  'telemetry',
  'lib',
  'telemetry-config.js',
);
const BUNDLED_TELEMETRY_LIB = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'telemetry', 'lib');
const SHARED_TELEMETRY_LIB = path.resolve(PLUGIN_ROOT, '..', '..', 'shared', 'telemetry', 'lib');

function tempConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-telemetry-'));
  const ikeyPath = path.join(dir, 'ikey.json');
  fs.writeFileSync(ikeyPath, JSON.stringify(config));
  return { dir, ikeyPath };
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

test('started event is allowlisted and carries no user, tenant, prompt, or path data', () => {
  const context = contextFor(provisioned);
  let captured;
  const event = emitSkillStarted(context, invocation, {
    emit: (value) => { captured = value; },
    readAiAgent: () => ({ aiAgentName: 'GitHub Copilot', aiAgentVersion: '1.2.3' }),
    correlationId: 'correlation-1',
  });
  assert.equal(captured, event);
  assert.equal(event.data.eventName, 'skill_started');
  assert.equal(event.data.pluginName, 'mobile-app');
  assert.equal(event.data.skillName, 'deploy');
  assert.equal(event.data.sessionId, 'session-1');
  assert.equal(event.data.correlationId, 'correlation-1');
  assert.deepEqual(event.data.eventInfo, { invocationSource: 'pretool' });
  for (const forbidden of ['orgId', 'tenantId', 'pacCliVersion', 'aadObjectId', 'prompt', 'cwd', 'path']) {
    assert.equal(Object.prototype.hasOwnProperty.call(event.data, forbidden), false);
  }
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

test('bundled control CLI auto-detects and updates the mobile-app preference', (t) => {
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

  const off = spawnSync(process.execPath, [TELEMETRY_CLI, '--action', 'off'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(off.status, 0);
  assert.match(off.stdout, /Telemetry \(mobile-app\): OFF/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.telemetry['mobile-app'], 'off');
});