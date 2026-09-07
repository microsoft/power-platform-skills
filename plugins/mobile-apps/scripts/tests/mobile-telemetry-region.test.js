'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolve: resolveDestination } = require('../lib/telemetry/resolver');
const { deriveRegion, resolve, resolveClusterEnvironment } = require('../lib/telemetry/region/region-resolver');
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

function resolvedEnvironment(root, clusterGeoName, environmentId = orgId) {
  fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify({
    environmentId, tenantId: environmentId, environmentUrl: 'https://contoso.crm4.dynamics.com',
    clusterEnvironment: 'Prod', clusterGeoName,
  }));
}

test('Mobile declares the seven Power Apps telemetry destinations', () => {
  assert.deepEqual(Object.keys(config.regions).sort(), [
    'dod', 'eu', 'gov', 'high', 'internal', 'mooncake', 'us',
  ]);
});

test('resolveClusterEnvironment returns a saved cluster, resolves a cache miss, or returns null', async (t) => {
  const root = project(t, { appInstanceId: null, cluster: 'us' });
  assert.equal(await resolveClusterEnvironment(root), 'us');
  writeTelemetryCluster(root, null);
  assert.equal(await resolveClusterEnvironment(root), null);
  resolvedEnvironment(root, 'EU');
  assert.equal(await resolveClusterEnvironment(root), 'eu');
  assert.equal(readTelemetryCluster(root), 'eu');
  writeTelemetryCluster(root, null);
  resolvedEnvironment(root, 'unknown');
  assert.equal(await resolveClusterEnvironment(root), null);
  assert.equal(readTelemetryCluster(root), '');
  assert.equal(await resolveClusterEnvironment(''), null);
  assert.deepEqual(fs.readdirSync(root).sort(), ['.resolved-environment.json', 'app.json']);
  resolvedEnvironment(root, 'EU');
  fs.writeFileSync(path.join(root, 'app.json'), '{bad json');
  assert.equal(await resolveClusterEnvironment(root), null);
  assert.equal(fs.readFileSync(path.join(root, 'app.json'), 'utf8'), '{bad json');
  fs.unlinkSync(path.join(root, 'app.json'));
  assert.equal(await resolveClusterEnvironment(root), null);
  assert.equal(fs.existsSync(path.join(root, 'app.json')), false);
});

test('cluster resolution has no dependency on telemetry delivery or the CLI entry point', () => {
  const pending = [require.cache[require.resolve('../lib/telemetry/region/region-resolver')]];
  const visited = new Set();
  const forbidden = new Set([
    require.resolve('../lib/mobile-telemetry-dispatcher'),
    require.resolve('../resolve-environment'),
  ]);
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    assert.equal(forbidden.has(current.id), false, current.id);
    pending.push(...current.children);
  }
});

test('app.json cluster alone selects the collector without mutating configuration', async (t) => {
  const root = project(t, { appInstanceId: null, cluster: 'eu' });
  const before = fs.readFileSync(path.join(root, 'app.json'), 'utf8');
  const destination = await resolve({
    projectRoot: root,
    regionsMap: config.regions,
  });
  assert.equal(destination.region, 'eu');
  assert.equal(destination.iKey, config.regions.eu.instrumentation_key);
  assert.equal(destination.collectorUrl, config.regions.eu.collector_url);
  assert.equal(fs.readFileSync(path.join(root, 'app.json'), 'utf8'), before);
});

test('routing follows cluster updates and clearing in app.json', async (t) => {
  const root = project(t, { appInstanceId: null, cluster: 'eu' });
  writeTelemetryCluster(root, 'us');
  assert.equal((await resolve({ projectRoot: root, regionsMap: config.regions })).region, 'us');
  writeTelemetryCluster(root, null);
  assert.equal(await resolve({ projectRoot: root, regionsMap: config.regions }), null);
});

test('missing or invalid clusters resolve from the known environment before choosing a destination', async (t) => {
  const root = project(t, { appInstanceId: null, cluster: null });
  resolvedEnvironment(root, 'EU');
  for (const cluster of [null, '', 'moon-base']) {
    fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({ expo: { extra: { telemetry: { cluster } } } }));
    assert.equal((await resolve({ projectRoot: root, regionsMap: config.regions })).region, 'eu');
    assert.equal(readTelemetryCluster(root), 'eu');
  }
  assert.equal(await resolve({ projectRoot: root, regionsMap: config.regions, cluster: null }), null);
  assert.equal(await resolveDestination({ cfg: config, projectRoot: '' }), null);
});

test('a hand-edited cluster is ignored rather than trusted', (t) => {
  const root = project(t, { appInstanceId: null, cluster: 'moon-base' });
  assert.equal(readTelemetryCluster(root), '');
});

test('routing ignores CLI configuration and environment caches', async (t) => {
  const root = project(t, { cluster: 'us' });
  fs.writeFileSync(path.join(root, 'power.config.json'), '{bad json');
  fs.writeFileSync(path.join(root, 'auth.config.json'), '{bad json');
  resolvedEnvironment(root, 'EU');
  assert.equal((await resolve({ projectRoot: root, regionsMap: config.regions })).region, 'us');
});

test('all seven saved clusters select their configured destinations', async (t) => {
  const root = project(t, { cluster: null });
  for (const [cluster, entry] of Object.entries(config.regions)) {
    writeTelemetryCluster(root, cluster);
    assert.deepEqual(await resolve({ projectRoot: root, regionsMap: config.regions }), {
      region: cluster, iKey: entry.instrumentation_key, collectorUrl: entry.collector_url,
    });
  }
});

test('persisting a cluster preserves unrelated app.json content', (t) => {
  const root = project(t, { appInstanceId: 'keep-me', cluster: null });
  writeTelemetryCluster(root, 'gov');
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.equal(appJson.expo.name, 'demo');
  assert.equal(appJson.expo.extra.telemetry.appInstanceId, 'keep-me');
  assert.equal(appJson.expo.extra.telemetry.cluster, 'gov');
});

// Canonical BAP `location` names from the live public-cloud catalog, verified 2026-09-07.
// Display names, properties.code, macroRegionId, and azureRegions are separate fields.
// See: https://learn.microsoft.com/en-us/powershell/module/microsoft.powerapps.administration.powershell/get-adminpowerappenvironmentlocations
test('every catalogued public BAP location maps to the expected cluster', () => {
  const locationsByCluster = {
    us: [
      'unitedstates', 'unitedstatesfirstrelease', 'asia', 'australia', 'india', 'japan',
      'canada', 'southamerica', 'unitedarabemirates', 'korea', 'southafrica',
    ],
    eu: [
      'europe', 'unitedkingdom', 'france', 'germany', 'switzerland', 'norway',
      'sweden', 'italy', 'poland',
    ],
  };
  for (const [cluster, locations] of Object.entries(locationsByCluster)) {
    for (const location of locations) {
      assert.equal(deriveRegion('Public', location), cluster, location);
      assert.equal(deriveRegion('Public', location.toUpperCase()), cluster, location);
      assert.equal(deriveRegion('Preview', location), cluster, location);
    }
  }
  for (const location of ['EMEA', 'north-america', 'eu-efta', 'eastus', 'westeurope', 'europefirstrelease']) {
    assert.equal(deriveRegion('Public', location), '', location);
  }
});

test('cloud and public geography map to the expected cluster', () => {
  assert.equal(deriveRegion('Public', 'us'), 'us');
  assert.equal(deriveRegion('Public', 'unitedstatesfirstrelease'), 'us');
  assert.equal(deriveRegion('Preview', 'UnitedStatesFirstRelease'), 'us');
  assert.equal(deriveRegion('Public', 'unitedstatesfirstrelease-unknown'), '');
  assert.equal(deriveRegion('unknown', 'unitedstatesfirstrelease'), '');
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
test('end to end: a connector start initializes a null cluster before app prerequisites', (t) => {
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
    JSON.stringify({ expo: { name: 'demo', extra: { telemetry: { appInstanceId: null, cluster: null } } } }),
  );
  resolvedEnvironment(projectRoot, 'EU');
  assert.equal(readTelemetryCluster(projectRoot), '');
  assert.equal(fs.existsSync(path.join(projectRoot, 'power.config.json')), false);

  const probePath = path.join(root, 'probe.json');
  const result = spawnSync(
    process.execPath,
    [path.join(PLUGIN_ROOT, 'hooks', 'run-telemetry.js'), 'prompt'],
    {
      cwd: projectRoot,
      input: JSON.stringify({ cwd: projectRoot, session_id: 'session-1',
        prompt: 'The user explicitly invoked the "/mobile-app:add-connector" skill. Follow its instructions now.\n\n' +
          '<skill-context name="add-connector">\nredacted instructions\n</skill-context>\ntet' }),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: REAL_IKEY_PATH,
        // The probe keeps this off the network while still proving which key won.
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
        POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '',
        PATH: '',
      },
    },
  );

  assert.equal(result.status, 0);
  const probe = waitForJson(probePath);
  assert.ok(probe, 'dispatcher should write the fake HTTPS probe');
  assert.equal(readTelemetryCluster(projectRoot), 'eu');
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
        // A missing cluster must leave the event local without CLI discovery.
        PATH: '',
      },
    },
  );

  assert.equal(result.status, 0);
  sleep(1500);
  assert.equal(fs.existsSync(probePath), false, 'nothing may be transmitted without a cluster');
});
