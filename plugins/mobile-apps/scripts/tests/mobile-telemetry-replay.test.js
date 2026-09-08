'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { appendLocal } = require('../lib/telemetry/lib/local-log');
const { readPriorEvents } = require('../lib/mobile-telemetry-dispatcher');

const appInstanceId = '11111111-1111-4111-8111-111111111111';
const environmentId = '22222222-2222-4222-8222-222222222222';

test('prior event scan reads nested and rotated logs without Dirent path metadata', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-replay-paths-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const env = { POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '' };
  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({
    expo: { extra: { telemetry: { appInstanceId, cluster: null } } },
  }));
  const makeRecord = (sessionId, time) => ({
    time, name: 'event',
    data: { pluginName: 'mobile-app', eventName: 'skill_started', sessionId,
      eventInfo: { appInstanceId } },
  });
  const records = [
    makeRecord('older', '2026-09-07T01:00:00.000Z'),
    makeRecord('newer', '2026-09-07T02:00:00.000Z'),
  ];
  for (const record of records) appendLocal(record, { configDir });
  const history = path.join(configDir, 'telemetry', 'mobile-app', 'sessions', 'older');
  fs.renameSync(path.join(history, 'events.jsonl'), path.join(history, 'events.20260907010000.old'));

  const readDirectory = fs.readdirSync;
  context.mock.method(fs, 'readdirSync', (directory, options) => {
    const entries = readDirectory(directory, options);
    if (!options?.withFileTypes) return entries;
    return entries.map((entry) => ({
      name: entry.name,
      isFile: () => entry.isFile(),
      isDirectory: () => entry.isDirectory(),
    }));
  });

  assert.deepEqual(readPriorEvents(root, env), records);
});

test('first resolution replays this app across sessions without duplicating logs or replaying twice', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const probe = path.join(root, 'probe.json');
  const env = { ...process.env, PATH: '', POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    POWER_PLATFORM_SKILLS_IKEY_JSON: path.resolve(__dirname, '../lib/telemetry/ikey.json'),
    POWER_PLATFORM_SKILLS_FAKE_HTTPS: probe, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '' };
  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({ expo: { extra: { telemetry: { appInstanceId, cluster: null } } } }));
  fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify({ environmentId,
    environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId,
    clusterEnvironment: 'Prod', clusterGeoName: 'EU' }));
  const makeRecord = (sessionId, identity = appInstanceId) => ({
    time: '2026-09-07T01:00:00.000Z', name: 'event',
    data: { pluginName: 'mobile-app', eventName: 'skill_started', sessionId, eventInfo: { appInstanceId: identity } },
  });
  appendLocal(makeRecord('first'), { configDir });
  appendLocal(makeRecord('second'), { configDir });
  appendLocal(makeRecord('other', environmentId), { configDir });
  const history = path.join(configDir, 'telemetry/mobile-app/sessions/first');
  fs.renameSync(path.join(history, 'events.jsonl'), path.join(history, 'events.20260907010000.old'));
  fs.writeFileSync(path.join(history, 'events.jsonl'), '{incomplete\n');
  assert.equal(readPriorEvents(root, { ...env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' }).length, 0);
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ telemetry: { 'mobile-app': 'off' } }));
  assert.equal(readPriorEvents(root, env).length, 0);
  fs.writeFileSync(path.join(configDir, 'config.json'), '{}');
  const run = () => spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), environmentId], {
    cwd: root, env, encoding: 'utf8', timeout: 5000,
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  let captured;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { captured = JSON.parse(fs.readFileSync(probe, 'utf8')); break; } catch { await delay(20); }
  }
  assert.ok(captured, 'first resolution should send existing logs without another event');
  const envelopes = captured.body.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(envelopes.map(event => event.data.session_Id).sort(), ['first', 'second']);
  assert.ok(envelopes.every(event => event.time === '2026-09-07T01:00:00.000Z'));
  const log = path.join(history, 'events.20260907010000.old');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
  fs.writeFileSync(probe, 'unchanged');
  assert.equal(run().status, 0);
  await delay(100);
  assert.equal(fs.readFileSync(probe, 'utf8'), 'unchanged');
});

test('null results stay local and the first non-null cluster dispatches history once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-replay-auto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const env = { ...process.env, PATH: '', POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    POWER_PLATFORM_SKILLS_PROJECT_ROOT: root,
    POWER_PLATFORM_SKILLS_IKEY_JSON: path.resolve(__dirname, '../lib/telemetry/ikey.json'),
    POWER_PLATFORM_SKILLS_FAKE_HTTPS: path.join(root, 'probe.json'), POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '' };
  const appPath = path.join(root, 'app.json');
  const authPath = path.join(root, 'auth.config.json');
  fs.writeFileSync(appPath, JSON.stringify({ expo: { extra: { telemetry: { appInstanceId, cluster: null } } } }));
  const dataFor = (sessionId, identity = appInstanceId) => ({ pluginName: 'mobile-app', sessionId,
    eventName: 'skill_started', skillName: 'add-connector', eventInfo: { appInstanceId: identity } });
  const previousTime = '2026-09-07T01:00:00.000Z';
  appendLocal({ time: previousTime, name: 'event', data: dataFor('previous') }, { configDir });
  appendLocal({ time: previousTime, name: 'event', data: dataFor('other', environmentId) }, { configDir });
  const run = (sessionId) => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../lib/mobile-telemetry-dispatcher.js')], {
      cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ name: 'event', data: dataFor(sessionId) }),
    });
    assert.equal(result.status, 0, result.stderr);
    if (!fs.existsSync(env.POWER_PLATFORM_SKILLS_FAKE_HTTPS)) return [];
    const captured = JSON.parse(fs.readFileSync(env.POWER_PLATFORM_SKILLS_FAKE_HTTPS, 'utf8'));
    return captured.body.trim().split('\n').map(line => JSON.parse(line));
  };
  assert.deepEqual(run('waiting'), []);
  assert.equal(JSON.parse(fs.readFileSync(appPath, 'utf8')).expo.extra.telemetry.cluster, null);
  const waitingPath = path.join(configDir, 'telemetry/mobile-app/sessions/waiting/events.jsonl');
  const waitingRecord = fs.readFileSync(waitingPath, 'utf8');
  fs.writeFileSync(authPath, JSON.stringify({ msal: { clientId: 'preserve' }, environment: { environmentId,
    environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId,
    clusterEnvironment: 'Prod', clusterGeoName: 'EU' } }));
  const first = run('current');
  assert.deepEqual(first.map(event => event.data.session_Id), ['previous', 'waiting', 'current']);
  assert.equal(first[0].time, previousTime);
  assert.equal(first[1].time, JSON.parse(waitingRecord).time);
  assert.equal(fs.readFileSync(waitingPath, 'utf8'), waitingRecord);
  const savedApp = fs.readFileSync(appPath, 'utf8');
  assert.deepEqual(JSON.parse(savedApp).expo.extra.telemetry, { appInstanceId, cluster: 'eu' });
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).msal.clientId, 'preserve');

  fs.unlinkSync(path.join(root, '.resolved-environment.json'));
  fs.writeFileSync(authPath, '{bad json');
  fs.writeFileSync(path.join(root, 'power.config.json'), '{bad json');
  const second = run('next');
  assert.deepEqual(second.map(event => event.data.session_Id), ['next']);
  assert.equal(fs.readFileSync(appPath, 'utf8'), savedApp);
  assert.equal(fs.readFileSync(authPath, 'utf8'), '{bad json');
  assert.equal(fs.existsSync(path.join(root, '.resolved-environment.json')), false);
  const records = readPriorEvents(root, env);
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['data', 'name', 'time']);
    assert.deepEqual(record.data, dataFor(record.data.sessionId));
  }
});

test('dispatcher preserves the original event shape for unresolved, opted-out and routed events', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-replay-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const env = { ...process.env, PATH: '', POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    POWER_PLATFORM_SKILLS_PROJECT_ROOT: root,
    POWER_PLATFORM_SKILLS_IKEY_JSON: path.resolve(__dirname, '../lib/telemetry/ikey.json'),
    POWER_PLATFORM_SKILLS_FAKE_HTTPS: path.join(root, 'probe.json'), POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '' };
  const appPath = path.join(root, 'app.json');
  fs.writeFileSync(appPath, JSON.stringify({ expo: { extra: { telemetry: { appInstanceId, cluster: null } } } }));
  const cached = { environmentId, environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId };
  fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify(cached));
  const run = (sessionId, childEnv = env) => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../lib/mobile-telemetry-dispatcher.js')], {
      cwd: root, env: childEnv, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ name: 'event', data: { pluginName: 'mobile-app', sessionId, eventInfo: { appInstanceId } } }),
    });
    assert.equal(result.status, 0, result.stderr);
  };
  run('unresolved');
  fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify({ ...cached,
    clusterEnvironment: 'Prod', clusterGeoName: 'EU' }));
  run('opted-out', { ...env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' });
  assert.equal(JSON.parse(fs.readFileSync(appPath, 'utf8')).expo.extra.telemetry.cluster, null);
  assert.equal(fs.existsSync(env.POWER_PLATFORM_SKILLS_FAKE_HTTPS), false);
  fs.writeFileSync(appPath, JSON.stringify({ expo: { extra: { telemetry: { appInstanceId, cluster: 'eu' } } } }));
  run('routed');
  assert.ok(fs.existsSync(env.POWER_PLATFORM_SKILLS_FAKE_HTTPS));
  for (const sessionId of ['unresolved', 'opted-out', 'routed']) {
    const logPath = path.join(configDir, 'telemetry/mobile-app/sessions', sessionId, 'events.jsonl');
    const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.deepEqual(Object.keys(record).sort(), ['data', 'name', 'time']);
    assert.equal(record.name, 'event');
    assert.ok(Number.isFinite(Date.parse(record.time)));
    assert.deepEqual(record.data, { pluginName: 'mobile-app', sessionId, eventInfo: { appInstanceId } });
  }
});