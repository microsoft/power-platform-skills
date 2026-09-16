'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { cacheMatchesTarget, canUseCachedResolution, toEnvironmentResult, environmentFromPowerPlatformPayload } = require('../resolve-environment');

const environmentId = '11111111-1111-4111-8111-111111111111';

test('environment resolution preserves cluster routing metadata through cache serialization', () => {
  for (const metadata of [{ location: 'unitedstatesfirstrelease', properties: {} }, { properties: { location: 'europe' } }]) {
    const resolved = environmentFromPowerPlatformPayload({
      ...metadata,
      name: environmentId,
      properties: {
        ...metadata.properties,
        linkedEnvironmentMetadata: { instanceUrl: 'https://contoso.crm4.dynamics.com' },
        cluster: { environment: 'Prod', geoShortName: 'EU', category: 'FirstRelease' },
      },
    }, environmentId);
    assert.equal(resolved.environmentId, environmentId);
    assert.equal(Object.hasOwn(resolved, 'organizationId'), false);
    assert.equal(resolved.clusterEnvironment, 'Prod');
    assert.equal(resolved.clusterGeoName, 'EU');
    assert.equal(toEnvironmentResult(resolved, 'cache').clusterEnvironment, 'Prod');
    assert.equal(toEnvironmentResult(resolved, 'cache').clusterGeoName, 'EU');
    assert.equal(Object.hasOwn(resolved, 'location'), false);
    assert.equal(Object.hasOwn(toEnvironmentResult({ ...resolved, location: 'europe' }, 'cache'), 'location'), false);
    assert.equal(cacheMatchesTarget(resolved, environmentId), true);
    assert.equal(cacheMatchesTarget(resolved, '22222222-2222-4222-8222-222222222222'), false);
  }
  for (const cluster of [undefined, null, { category: 'FirstRelease' }, { environment: ['Prod'], geoShortName: ['EU'] }]) {
    const resolved = environmentFromPowerPlatformPayload({
      name: environmentId, properties: { cluster },
    }, environmentId);
    assert.equal(resolved.clusterEnvironment, null);
    assert.equal(resolved.clusterGeoName, null);
  }
  assert.equal(Object.hasOwn(toEnvironmentResult({}, 'cache'), 'location'), false);
  assert.equal(toEnvironmentResult({}, 'cache').clusterEnvironment, null);
  assert.equal(toEnvironmentResult({}, 'cache').clusterGeoName, null);
});

test('old ID caches refresh for cluster metadata while URL caches remain compatible', () => {
  const cached = { environmentId, environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId };
  assert.equal(canUseCachedResolution(cached, environmentId), false);
  assert.equal(canUseCachedResolution(cached, environmentId, 'eu'), true);
  assert.equal(canUseCachedResolution(null, environmentId, 'eu'), false);
  assert.equal(canUseCachedResolution({ ...cached, location: 'europe' }, environmentId), false);
  assert.equal(canUseCachedResolution({ ...cached, clusterEnvironment: 'Prod', clusterGeoName: 'EU' }, environmentId), true);
  assert.equal(canUseCachedResolution({ ...cached, clusterGeoName: 'EU' }, environmentId), false);
  assert.equal(canUseCachedResolution({ ...cached, clusterEnvironment: 'Prod', clusterGeoName: ' ' }, environmentId), false);
  assert.equal(canUseCachedResolution(cached, cached.environmentUrl), true);
});

test('failed cluster metadata refresh preserves connection details and auth settings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-env-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cached = { environmentId, environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId, displayName: 'Example' };
  fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify({ ...cached, location: 'europe' }));
  fs.writeFileSync(path.join(root, 'auth.config.json'), JSON.stringify({ msal: { clientId: 'preserve' } }));
  const appPath = path.join(root, 'app.json');
  fs.writeFileSync(appPath, JSON.stringify({ expo: { name: 'demo', extra: { telemetry: { appInstanceId: 'preserve', cluster: null } } } }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), environmentId], {
    cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ...cached, clusterEnvironment: null, clusterGeoName: null, source: 'cache-refresh' });
  const auth = JSON.parse(fs.readFileSync(path.join(root, 'auth.config.json'), 'utf8'));
  assert.equal(auth.msal.clientId, 'preserve');
  assert.equal(auth.environment.environmentId, environmentId);
  assert.equal(Object.hasOwn(auth.environment, 'location'), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(root, '.resolved-environment.json'), 'utf8')), 'location'), false);
  assert.equal(JSON.parse(fs.readFileSync(appPath, 'utf8')).expo.extra.telemetry.cluster, null);

  cached.clusterEnvironment = 'Prod';
  cached.clusterGeoName = 'EU';
  fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify(cached));
  const hit = spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), environmentId], {
    cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
  });
  assert.equal(hit.status, 0, hit.stderr);
  assert.deepEqual(JSON.parse(hit.stdout), { ...cached, source: 'cache' });
  const app = JSON.parse(fs.readFileSync(appPath, 'utf8'));
  assert.equal(app.expo.extra.telemetry.cluster, 'eu');
  assert.equal(app.expo.extra.telemetry.appInstanceId, 'preserve');
  assert.equal(app.expo.name, 'demo');

  const failed = spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), '22222222-2222-4222-8222-222222222222'], {
    cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
  });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(appPath, 'utf8')).expo.extra.telemetry.cluster, 'eu');
});

test('a valid saved cluster avoids metadata refresh and is never overwritten', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-env-saved-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'app.json');
  const app = JSON.stringify({ expo: { name: 'demo', extra: { telemetry: { cluster: 'eu' } } } });
  fs.writeFileSync(appPath, app);
  for (const clusterGeoName of [null, 'US', 'unknown']) {
    const cached = { environmentId, environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId, clusterEnvironment: 'Prod', clusterGeoName };
    fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify(cached));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), environmentId], {
      cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).source, 'cache');
    assert.equal(fs.readFileSync(appPath, 'utf8'), app);
  }
});

test('an invalid cluster is filled when existing environment resolution provides cluster metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-env-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'app.json');
  for (const [clusterEnvironment, clusterGeoName, expected] of [
    ['Prod', 'US', 'us'], ['Prod', 'EU', 'eu'], ['GccModerate', 'US', 'gov'],
    ['GccHigh', 'US', 'high'], ['DoD', 'US', 'dod'], ['Mooncake', 'CN', 'mooncake'], ['Test', 'US', 'internal'],
  ]) {
    fs.writeFileSync(appPath, JSON.stringify({ expo: { extra: { telemetry: { cluster: 'unknown' } } } }));
    fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify({
      environmentId, environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId, clusterEnvironment, clusterGeoName,
    }));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), environmentId], {
      cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(appPath, 'utf8')).expo.extra.telemetry.cluster, expected, clusterEnvironment);
  }
});

test('missing or unknown cluster metadata never falls back to provisioning location', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-env-unresolved-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'app.json');
  const app = JSON.stringify({ expo: { extra: { telemetry: { cluster: null } } } });
  fs.writeFileSync(appPath, app);
  for (const clusterMetadata of [
    {}, { clusterEnvironment: 'Prod' }, { clusterGeoName: 'US' },
    { clusterEnvironment: 'unknown', clusterGeoName: 'US' },
    { clusterEnvironment: 'Prod', clusterGeoName: 'unknown' },
  ]) {
    fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify({
      environmentId, environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: environmentId,
      location: 'unitedstatesfirstrelease', ...clusterMetadata,
    }));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), environmentId], {
      cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Object.hasOwn(JSON.parse(result.stdout), 'location'), false);
    assert.equal(fs.readFileSync(appPath, 'utf8'), app);
  }
});

test('cached cluster geo overrides legacy provisioning location without discovery', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-env-first-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'app.json');
  fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify({
    environmentId, environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: environmentId, location: 'unitedstatesfirstrelease',
    clusterEnvironment: 'Prod', clusterGeoName: 'EU',
  }));
  for (const cluster of [null, 'unknown']) {
    const app = { expo: { name: 'demo', extra: { telemetry: { appInstanceId: environmentId, cluster } } } };
    fs.writeFileSync(appPath, JSON.stringify(app));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), environmentId], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: '', POWER_PLATFORM_SKILLS_CONFIG_DIR: path.join(root, 'config'), POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).source, 'cache');
    assert.equal(Object.hasOwn(JSON.parse(result.stdout), 'location'), false);
    app.expo.extra.telemetry.cluster = 'eu';
    assert.deepEqual(JSON.parse(fs.readFileSync(appPath, 'utf8')), app);
  }
});

test('resolveClusterEnvironment refreshes legacy metadata, skips saved lookups, and returns null on failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-env-initialize-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'app.json');
  const cachePath = path.join(root, '.resolved-environment.json');
  const authPath = path.join(root, 'auth.config.json');
  const powerPath = path.join(root, 'power.config.json');
  const app = { expo: { name: 'demo', extra: { telemetry: { appInstanceId: environmentId, cluster: null } } } };
  fs.writeFileSync(appPath, JSON.stringify(app));
  fs.writeFileSync(cachePath, JSON.stringify({ environmentId,
    environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: environmentId, location: 'europe' }));
  fs.writeFileSync(authPath, JSON.stringify({ msal: { clientId: 'preserve' } }));

  const scriptPath = path.resolve(__dirname, '../lib/environment-resolution.js');
  const requireFromScript = createRequire(scriptPath);
  const cliCalls = [];
  const requests = [];
  const environmentReads = [];
  const resolverModule = { exports: {} };
  let offline = false;
  const mockedRequire = (name) => {
    if (name === 'child_process') return { execFileSync(command, args) {
      cliCalls.push({ command, args });
      assert.equal(command, 'az');
      if (offline) throw new Error('offline');
      return args[1] === 'show' ? environmentId : 'test-token';
    } };
    if (name === 'https') return { request(url, options, callback) {
      requests.push(url);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.emit('data', JSON.stringify({
          name: new URL(url).pathname.split('/').pop(),
          properties: { tenantId: environmentId,
            linkedEnvironmentMetadata: { instanceUrl: 'https://contoso.crm.dynamics.com' },
            cluster: { environment: 'Prod', geoShortName: 'US', category: 'FirstRelease' } },
        }));
        response.emit('end');
      };
      return request;
    } };
    if (name === 'fs') return { ...fs, readFileSync(filePath, ...args) {
      environmentReads.push(filePath);
      return fs.readFileSync(filePath, ...args);
    } };
    return requireFromScript(name);
  };
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), {
    require: mockedRequire, module: resolverModule, process, console, URL,
  }, { filename: scriptPath });
  const clusterPath = path.resolve(__dirname, '../lib/telemetry/region/region-resolver.js');
  const requireFromCluster = createRequire(clusterPath);
  const clusterModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(clusterPath, 'utf8'), {
    require: name => name === '../../environment-resolution' ? resolverModule.exports : requireFromCluster(name),
    module: clusterModule,
  }, { filename: clusterPath });
  const { resolveClusterEnvironment } = clusterModule.exports;
  assert.equal(await resolveClusterEnvironment(root), 'us');
  assert.equal(requests.length, 1);
  assert.match(requests[0], new RegExp(`/scopes/admin/environments/${environmentId}\\?`));
  assert.deepEqual(cliCalls.map(call => call.args[1]), ['show', 'get-access-token']);
  app.expo.extra.telemetry.cluster = 'us';
  assert.deepEqual(JSON.parse(fs.readFileSync(appPath, 'utf8')), app);
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.equal(auth.msal.clientId, 'preserve');
  assert.equal(auth.environment.clusterEnvironment, 'Prod');
  assert.equal(auth.environment.clusterGeoName, 'US');
  assert.equal(Object.hasOwn(auth.environment, 'location'), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(cachePath, 'utf8')), 'location'), false);

  const readsBefore = environmentReads.slice();
  const savedApp = fs.readFileSync(appPath, 'utf8');
  fs.writeFileSync(powerPath, '{bad json');
  fs.writeFileSync(cachePath, '{bad json');
  fs.writeFileSync(authPath, '{bad json');
  assert.equal(await resolveClusterEnvironment(root), 'us');
  assert.deepEqual(environmentReads, readsBefore);
  assert.equal(cliCalls.length, 2);
  assert.equal(requests.length, 1);
  assert.equal(fs.readFileSync(appPath, 'utf8'), savedApp);

  const selectedEnvironmentId = '22222222-2222-4222-8222-222222222222';
  app.expo.extra.telemetry.cluster = null;
  fs.writeFileSync(appPath, JSON.stringify(app));
  fs.writeFileSync(powerPath, JSON.stringify({ environmentId: selectedEnvironmentId }));
  fs.writeFileSync(cachePath, JSON.stringify({ environmentId,
    environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId,
    clusterEnvironment: 'Prod', clusterGeoName: 'EU' }));
  assert.equal(await resolveClusterEnvironment(root), 'us');
  assert.equal(requests.length, 2);
  assert.match(requests[1], new RegExp(`/scopes/admin/environments/${selectedEnvironmentId}\\?`));
  assert.equal(JSON.parse(fs.readFileSync(appPath, 'utf8')).expo.extra.telemetry.cluster, 'us');

  fs.writeFileSync(appPath, JSON.stringify(app));
  fs.unlinkSync(cachePath);
  offline = true;
  assert.equal(await resolveClusterEnvironment(root), null);
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(appPath, 'utf8')), app);
});