'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolve: resolveDestination } = require('../lib/telemetry/resolver');
const { deriveRegion, resolve } = require('../lib/telemetry/region/region-resolver');
const { urlFor } = require('../lib/telemetry/region/artemis-service');
const { readTelemetryCluster, writeTelemetryCluster } = require('../lib/app-identity');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const REAL_IKEY_PATH = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'telemetry', 'ikey.json');
const config = JSON.parse(fs.readFileSync(REAL_IKEY_PATH, 'utf8'));
const orgId = '11111111-1111-1111-1111-111111111111';

function project(t, telemetry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cluster-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'app.json'),
    JSON.stringify({ expo: { name: 'demo', extra: { telemetry } } }, null, 2),
  );
  return root;
}

const neverCalled = () => { throw new Error('must not run'); };

test('Mobile declares the seven Power Apps telemetry destinations', () => {
  assert.deepEqual(Object.keys(config.regions).sort(), [
    'dod', 'eu', 'gov', 'high', 'internal', 'mooncake', 'us',
  ]);
});

test('step 1: a cluster in app.json is used without touching pac or Artemis', async (t) => {
  const root = project(t, { appInstanceId: null, cluster: 'eu' });
  const destination = await resolve({
    projectRoot: root,
    regionsMap: config.regions,
    _readPacAuth: neverCalled,
    _fetchGeo: neverCalled,
  });
  assert.equal(destination.region, 'eu');
  assert.equal(destination.iKey, config.regions.eu.instrumentation_key);
  assert.equal(destination.collectorUrl, config.regions.eu.collector_url);
});

test('step 2: an unresolved cluster falls back to whoami and is persisted', async (t) => {
  const root = project(t, { appInstanceId: null, cluster: null });
  const destination = await resolve({
    projectRoot: root,
    regionsMap: config.regions,
    _readPacAuth: () => ({ orgId, cloud: 'Public' }),
    _fetchGeo: () => Promise.resolve({ geoName: 'eu', stamp: 'Public' }),
  });
  assert.equal(destination.region, 'eu');
  assert.equal(readTelemetryCluster(root), 'eu');

  // The persisted value is what makes later events skip the pac fork entirely.
  const second = await resolve({
    projectRoot: root,
    regionsMap: config.regions,
    _readPacAuth: neverCalled,
    _fetchGeo: neverCalled,
  });
  assert.equal(second.region, 'eu');
});

test('step 3: still unresolved stays local', async (t) => {
  const root = project(t, { appInstanceId: null, cluster: null });
  const cases = [
    { _readPacAuth: () => null, _fetchGeo: neverCalled },
    { _readPacAuth: () => ({ orgId, cloud: 'Public' }), _fetchGeo: () => Promise.resolve(null) },
    { _readPacAuth: () => ({ orgId, cloud: 'Public' }), _fetchGeo: () => Promise.reject(new Error('offline')) },
    { _readPacAuth: () => ({ orgId, cloud: 'Public' }), _fetchGeo: () => Promise.resolve({ geoName: 'zz' }) },
  ];
  for (const seam of cases) {
    assert.equal(await resolve({ projectRoot: root, regionsMap: config.regions, ...seam }), null);
  }
  assert.equal(readTelemetryCluster(root), '');
  assert.equal(await resolveDestination({ cfg: config, projectRoot: '' }), null);
});

test('a hand-edited cluster is ignored rather than trusted', (t) => {
  const root = project(t, { appInstanceId: null, cluster: 'moon-base' });
  assert.equal(readTelemetryCluster(root), '');
});

test('persisting a cluster preserves unrelated app.json content', (t) => {
  const root = project(t, { appInstanceId: 'keep-me', cluster: null });
  writeTelemetryCluster(root, 'gov');
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.equal(appJson.expo.name, 'demo');
  assert.equal(appJson.expo.extra.telemetry.appInstanceId, 'keep-me');
  assert.equal(appJson.expo.extra.telemetry.cluster, 'gov');
});

test('cloud and public geography map to the expected cluster', () => {
  assert.equal(deriveRegion('Public', 'us'), 'us');
  assert.equal(deriveRegion('Public', 'eu'), 'eu');
  assert.equal(deriveRegion('UsGov', 'anything'), 'gov');
  assert.equal(deriveRegion('UsGovHigh', 'anything'), 'high');
  assert.equal(deriveRegion('UsGovDod', 'anything'), 'dod');
  assert.equal(deriveRegion('China', 'anything'), 'mooncake');
  assert.equal(deriveRegion('Tip1', 'anything'), 'internal');
  assert.equal(deriveRegion('Public', 'unknown'), '');
});

test('Artemis endpoint follows the selected cloud', () => {
  assert.match(urlFor(orgId, 'Public'), /organization\.api\.powerplatform\.com/);
  assert.match(urlFor(orgId, 'UsGov'), /organization\.api\.gov\.powerplatform\.microsoft\.us/);
  assert.match(urlFor(orgId, 'UsGovHigh'), /organization\.api\.high\.powerplatform\.microsoft\.us/);
  assert.match(urlFor(orgId, 'UsGovDod'), /organization\.api\.appsplatform\.us/);
  assert.match(urlFor(orgId, 'China'), /organization\.api\.powerplatform\.partner\.microsoftonline\.cn/);
});

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

// The other tests inject seams. This one runs the real hook against the real
// ikey.json so the shipped resolver.js is actually loaded and its regional keys
// are the ones that reach the wire.
test('end to end: the real hook routes to the cluster recorded in app.json', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-region-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ dependencies: { expo: '^55', '@microsoft/power-apps-native-host': '^1' } }),
  );
  fs.writeFileSync(
    path.join(projectRoot, 'app.json'),
    JSON.stringify({ expo: { name: 'demo', extra: { telemetry: { appInstanceId: null, cluster: 'eu' } } } }),
  );

  const probePath = path.join(root, 'probe.json');
  const result = spawnSync(
    process.execPath,
    [path.join(PLUGIN_ROOT, 'hooks', 'run-telemetry.js'), 'prompt'],
    {
      cwd: projectRoot,
      input: JSON.stringify({ cwd: projectRoot, session_id: 'session-1', prompt: '/mobile-app:deploy' }),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: REAL_IKEY_PATH,
        // The probe keeps this off the network while still proving which key won.
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
        POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '',
      },
    },
  );

  assert.equal(result.status, 0);
  const probe = waitForJson(probePath);
  assert.ok(probe, 'dispatcher should write the fake HTTPS probe');
  assert.equal(probe.headers['x-apikey'], config.regions.eu.instrumentation_key);
  assert.equal(probe.url, config.regions.eu.collector_url);
  // US and EU share the production key, so the collector is the real discriminator.
  assert.notEqual(config.regions.eu.collector_url, config.regions.us.collector_url);
});

test('end to end: an unresolvable cluster transmits nothing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-region-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'app.json'),
    JSON.stringify({ expo: { name: 'demo', extra: { telemetry: { appInstanceId: null, cluster: null } } } }),
  );

  const probePath = path.join(root, 'probe.json');
  const result = spawnSync(
    process.execPath,
    [path.join(PLUGIN_ROOT, 'hooks', 'run-telemetry.js'), 'prompt'],
    {
      cwd: projectRoot,
      input: JSON.stringify({ cwd: projectRoot, session_id: 'session-1', prompt: '/mobile-app:deploy' }),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: REAL_IKEY_PATH,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
        POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '',
        // No PAC on PATH, so step 2 cannot resolve and the event must stay local.
        PATH: '',
      },
    },
  );

  assert.equal(result.status, 0);
  sleep(1500);
  assert.equal(fs.existsSync(probePath), false, 'nothing may be transmitted without a cluster');
});
