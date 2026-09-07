'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cacheMatchesTarget, canUseCachedResolution, toEnvironmentResult, environmentFromPowerPlatformPayload } = require('../resolve-environment');

const environmentId = '11111111-1111-4111-8111-111111111111';

test('environment resolution preserves geography through cache serialization', () => {
  for (const metadata of [{ location: 'europe', properties: {} }, { properties: { location: 'europe' } }]) {
    const resolved = environmentFromPowerPlatformPayload({
      ...metadata,
      name: environmentId,
      properties: {
        ...metadata.properties,
        linkedEnvironmentMetadata: { instanceUrl: 'https://contoso.crm4.dynamics.com' },
      },
    }, environmentId);
    assert.equal(resolved.location, 'europe');
    assert.equal(toEnvironmentResult(resolved, 'cache').location, 'europe');
    assert.equal(cacheMatchesTarget(resolved, environmentId), true);
    assert.equal(cacheMatchesTarget(resolved, '22222222-2222-4222-8222-222222222222'), false);
  }
  assert.equal(toEnvironmentResult({}, 'cache').location, null);
});

test('old ID caches refresh for geography while URL caches remain compatible', () => {
  const cached = { environmentId, environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId };
  assert.equal(canUseCachedResolution(cached, environmentId), false);
  assert.equal(canUseCachedResolution(cached, environmentId, 'eu'), true);
  assert.equal(canUseCachedResolution(null, environmentId, 'eu'), false);
  assert.equal(canUseCachedResolution({ ...cached, location: 'europe' }, environmentId), true);
  assert.equal(canUseCachedResolution(cached, cached.environmentUrl), true);
});

test('failed geography refresh preserves connection details and auth settings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-env-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cached = { environmentId, environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId, displayName: 'Example' };
  fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify(cached));
  fs.writeFileSync(path.join(root, 'auth.config.json'), JSON.stringify({ msal: { clientId: 'preserve' } }));
  const appPath = path.join(root, 'app.json');
  fs.writeFileSync(appPath, JSON.stringify({ expo: { name: 'demo', extra: { telemetry: { appInstanceId: 'preserve', cluster: null } } } }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), environmentId], {
    cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ...cached, location: null, source: 'cache-refresh' });
  const auth = JSON.parse(fs.readFileSync(path.join(root, 'auth.config.json'), 'utf8'));
  assert.equal(auth.msal.clientId, 'preserve');
  assert.equal(auth.environment.environmentId, environmentId);
  assert.equal(JSON.parse(fs.readFileSync(appPath, 'utf8')).expo.extra.telemetry.cluster, null);

  cached.location = 'europe';
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

test('a valid saved cluster avoids geography refresh and is never overwritten', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-env-saved-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'app.json');
  const app = JSON.stringify({ expo: { name: 'demo', extra: { telemetry: { cluster: 'eu' } } } });
  fs.writeFileSync(appPath, app);
  for (const location of [null, 'unitedstates', 'unknown']) {
    const cached = { environmentId, environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId, location };
    fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify(cached));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), environmentId], {
      cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).source, 'cache');
    assert.equal(fs.readFileSync(appPath, 'utf8'), app);
  }
});

test('an invalid cluster is filled when existing environment resolution provides geography', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-env-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'app.json');
  fs.writeFileSync(appPath, JSON.stringify({ expo: { extra: { telemetry: { cluster: 'unknown' } } } }));
  fs.writeFileSync(path.join(root, '.resolved-environment.json'), JSON.stringify({
    environmentId, environmentUrl: 'https://contoso.crm4.dynamics.com', tenantId: environmentId, location: 'europe',
  }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../resolve-environment.js'), environmentId], {
    cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(appPath, 'utf8')).expo.extra.telemetry.cluster, 'eu');
});