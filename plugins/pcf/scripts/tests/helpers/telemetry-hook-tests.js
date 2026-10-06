'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PLUGIN_ROOT, ORG_ID, TENANT_ID, OBJECT_ID, USER, FAKE_CONFIG, FAKE_REGIONS,
  tempRoot, seedRegion, writeConfig, waitForJson, waitForDispatcher, writePacStub, runHook,
} = require('./telemetry-fixtures.js');

function registerHookTests(hookName, payloadFor) {
  let toolsDir;
  let marker;
  test.before((t) => {
    toolsDir = path.join(tempRoot(t, 'pcf-offline-pac-'), 'tools');
    marker = writePacStub(toolsDir);
  });
  test.beforeEach(() => fs.rmSync(marker, { force: true }));

  const payload = (skill = 'pcf:pcf') => ({
    session_id: 'pcf-offline-session',
    ...payloadFor(skill),
  });
  const assertNoWork = (configDir) => {
    assert.deepEqual(fs.readdirSync(configDir), [], 'hard-off must create no config, mirror or probe files');
    assert.equal(fs.existsSync(marker), false, 'hard-off must gate before any PAC invocation');
  };
  const provision = (root, cfg = FAKE_CONFIG) => {
    const configDir = path.join(root, 'config');
    fs.mkdirSync(configDir);
    seedRegion(configDir);
    return writeConfig(root, cfg);
  };

  test('shipped config is a fast no-op: no emission, local files or PAC', (t) => {
    const root = tempRoot(t);
    const { configDir } = runHook(hookName, root, toolsDir, { payload: payload() });
    assertNoWork(configDir);
  });

  test('fake provisioned config emits one region-routed skill_started with only PCF base fields', (t) => {
    const root = tempRoot(t);
    const ikeyPath = provision(root);
    const { configDir, probe } = runHook(hookName, root, toolsDir, { payload: payload(), ikeyPath });
    const captured = waitForJson(probe);
    waitForDispatcher(ikeyPath);
    const envelope = JSON.parse(captured.body);
    assert.equal(envelope.name, 'event');
    assert.equal(envelope.data.clientType, 'PcfAIPlugin');
    assert.equal(envelope.data.event_Name, 'skill_started');
    assert.equal(envelope.data.tenantId, TENANT_ID);
    assert.equal(captured.headers['x-apikey'], FAKE_REGIONS.eu.instrumentation_key);
    const dimensions = JSON.parse(envelope.data.customDimensions);
    assert.equal(dimensions.pluginName, 'pcf');
    assert.equal(dimensions.skillName, 'pcf');
    assert.equal(dimensions.orgId, ORG_ID);
    assert.equal(dimensions.tenantId, TENANT_ID);
    assert.equal(dimensions.pacCliVersion, '9.9.9');
    assert.equal(dimensions.sessionId, 'pcf-offline-session');
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(dimensions.pluginVersion, manifest.version);
    assert.deepEqual(Object.keys(dimensions).sort(), [
      'aiAgentName', 'aiAgentVersion', 'correlationId', 'nodeVersion', 'orgId', 'osName',
      'osVersion', 'pacCliVersion', 'pluginName', 'pluginVersion', 'sessionId', 'skillName', 'tenantId',
    ]);
    const log = path.join(configDir, 'telemetry', 'pcf', 'sessions', dimensions.sessionId, 'events.jsonl');
    const records = waitForJson(log, 5000, true);
    waitForDispatcher(ikeyPath);
    assert.equal(records.length, 1, 'one hook invocation must write one skill_started');
    assert.equal(records[0].data.eventName, 'skill_started');
    assert.equal(records[0].data.eventInfo, undefined);
    const raw = captured.body + JSON.stringify(records);
    for (const forbidden of [OBJECT_ID, USER, 'aadObjectId', 'private arguments', 'https://contoso.crm.dynamics.com']) {
      assert.equal(raw.includes(forbidden), false, `${forbidden} must not reach the mirror or envelope`);
    }
    assert.ok(fs.existsSync(marker), 'enrichment must have exercised the offline native PAC parser');
  });

  for (const optOut of ['1', 'true']) {
    test(`environment opt-out ${optOut} keeps the local mirror but never POSTs`, (t) => {
      const root = tempRoot(t);
      const ikeyPath = provision(root);
      const { configDir, probe } = runHook(hookName, root, toolsDir, { payload: payload(), ikeyPath, optOut });
      const log = path.join(configDir, 'telemetry', 'pcf', 'sessions', 'pcf-offline-session', 'events.jsonl');
      const records = waitForJson(log, 5000, true);
      assert.equal(records.length, 1);
      assert.equal(records[0].data.pluginName, 'pcf');
      assert.equal(records[0].data.eventName, 'skill_started');
      assert.equal(records[0].data.eventInfo, undefined);
      assert.equal(fs.existsSync(probe), false);
    });
  }

  test('a saved PCF opt-out also keeps the mirror without transmission', (t) => {
    const root = tempRoot(t);
    const ikeyPath = provision(root);
    fs.writeFileSync(path.join(root, 'config', 'config.json'), JSON.stringify({ telemetry: { pcf: 'off' } }));
    const { configDir, probe } = runHook(hookName, root, toolsDir, { payload: payload(), ikeyPath });
    const records = waitForJson(path.join(configDir, 'telemetry', 'pcf', 'sessions', 'pcf-offline-session', 'events.jsonl'), 5000, true);
    waitForDispatcher(ikeyPath);
    assert.equal(records.length, 1);
    assert.equal(fs.existsSync(probe), false);
  });

  for (const skill of ['other-plugin:pcf', 'pcf:telemetry']) {
    test(`${skill} emits nothing and performs no enrichment`, (t) => {
      const root = tempRoot(t);
      const ikeyPath = writeConfig(root);
      const { configDir } = runHook(hookName, root, toolsDir, { payload: payload(skill), ikeyPath });
      assertNoWork(configDir);
    });
  }

  for (const killSwitch of ['1', 'true']) {
    test(`PCF_DISABLE_HOOKS=${killSwitch} gates the hook before any work`, (t) => {
      const root = tempRoot(t);
      const ikeyPath = writeConfig(root);
      const { configDir } = runHook(hookName, root, toolsDir, { payload: payload(), ikeyPath, killSwitch });
      assertNoWork(configDir);
    });
  }

  test('disabled:false with placeholder keys is still a no-op before PAC', (t) => {
    const root = tempRoot(t);
    const regions = Object.fromEntries(Object.entries(FAKE_REGIONS).map(([region, entry]) =>
      [region, { ...entry, instrumentation_key: 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING' }]));
    const ikeyPath = writeConfig(root, { ...FAKE_CONFIG, regions });
    const { configDir } = runHook(hookName, root, toolsDir, { payload: payload(), ikeyPath });
    assertNoWork(configDir);
  });

  test('malformed host JSON exits 0 with no telemetry side effects', (t) => {
    const root = tempRoot(t);
    const { configDir } = runHook(hookName, root, toolsDir, { payload: '{not json', ikeyPath: writeConfig(root) });
    assertNoWork(configDir);
  });

  for (const corrupt of [false, true]) {
    test(`${corrupt ? 'corrupt' : 'missing'} config fails closed before PAC`, (t) => {
      const root = tempRoot(t);
      const ikeyPath = path.join(root, 'unreadable-ikey.json');
      if (corrupt) fs.writeFileSync(ikeyPath, '{not json');
      const { configDir } = runHook(hookName, root, toolsDir, { payload: payload(), ikeyPath });
      assertNoWork(configDir);
    });
  }

  test('a throwing provision check cannot block the skill or invoke PAC', (t) => {
    const root = tempRoot(t);
    const ikeyPath = writeConfig(root);
    fs.writeFileSync(path.join(path.dirname(ikeyPath), 'resolver.js'),
      "module.exports = { isProvisioned() { throw new Error('offline broken resolver'); } };\n");
    const { configDir } = runHook(hookName, root, toolsDir, { payload: payload(), ikeyPath });
    assertNoWork(configDir);
  });

  test('the bare PCF host spelling is tracked too', (t) => {
    const root = tempRoot(t);
    const ikeyPath = provision(root);
    const { probe } = runHook(hookName, root, toolsDir, { payload: payload('pcf'), ikeyPath });
    const envelope = JSON.parse(waitForJson(probe).body);
    waitForDispatcher(ikeyPath);
    assert.equal(envelope.data.clientType, 'PcfAIPlugin');
    assert.equal(JSON.parse(envelope.data.customDimensions).skillName, 'pcf');
  });
}

module.exports = { registerHookTests };
