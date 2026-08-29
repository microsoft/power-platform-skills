'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const {
  describeResponseShape,
  formatRequestFailure,
  parseArgs,
  redactDiagnostic,
  resolveEnvironment,
  writeCacheIfProject,
} = require('../resolve-environment');

const resolverPath = path.resolve(__dirname, '../resolve-environment.js');

test('no-cache mode permits reads but performs no filesystem writes', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-no-cache-'));
  const authPath = path.join(projectRoot, 'auth.config.json');
  fs.writeFileSync(authPath, `${JSON.stringify({ msal: { clientId: '', tenantId: '' } }, null, 2)}\n`);
  const before = fs.readFileSync(authPath);
  const previousCwd = process.cwd();

  try {
    process.chdir(projectRoot);
    const wrote = writeCacheIfProject({
      environmentId: '11111111-1111-1111-1111-111111111111',
      environmentUrl: 'https://example.crm.dynamics.com',
      tenantId: '22222222-2222-2222-2222-222222222222',
    }, { noCache: true });
    assert.strictEqual(wrote, false);
    assert.deepStrictEqual(fs.readFileSync(authPath), before);
    assert.ok(!fs.existsSync(path.join(projectRoot, '.resolved-environment.json')));
  } finally {
    process.chdir(previousCwd);
  }
});

test('resolver argument parsing accepts no-cache in either position', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  assert.deepStrictEqual(parseArgs([id, '--no-cache']), { noCache: true, target: id });
  assert.deepStrictEqual(parseArgs(['--no-cache', id]), { noCache: true, target: id });
});

test('resolver CLI can reuse and refresh cached project resolution', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-cli-no-cache-'));
  const environment = {
    environmentId: '11111111-1111-1111-1111-111111111111',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: '22222222-2222-2222-2222-222222222222',
  };
  const authPath = path.join(projectRoot, 'auth.config.json');
  const authConfig = {
    msal: { clientId: '', tenantId: '' },
    environment,
  };
  fs.writeFileSync(authPath, `${JSON.stringify(authConfig, null, 2)}\n`);
  const result = spawnSync(
    process.execPath,
    [resolverPath, environment.environmentId],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(JSON.parse(result.stdout).source, 'cache');
  const refreshed = JSON.parse(fs.readFileSync(authPath, 'utf8')).environment;
  assert.strictEqual(refreshed.environmentId, environment.environmentId);
  assert.strictEqual(refreshed.environmentUrl, environment.environmentUrl);
  assert.ok(Number.isFinite(Date.parse(refreshed.cachedAt)));
  assert.ok(fs.existsSync(path.join(projectRoot, '.resolved-environment.json')));
});

test('no-cache mode bypasses stale cache reads during environment resolution', async () => {
  let cacheReads = 0;
  const result = await resolveEnvironment(
    '11111111-1111-1111-1111-111111111111',
    { noCache: true },
    {
      readCachedResolution: () => {
        cacheReads += 1;
        return {
          environmentId: '11111111-1111-1111-1111-111111111111',
          environmentUrl: 'https://stale.crm.dynamics.com',
          tenantId: '22222222-2222-2222-2222-222222222222',
        };
      },
      getAzTenantId: () => '33333333-3333-3333-3333-333333333333',
      resolveEnvironmentId: async () => ({
        environmentId: '11111111-1111-1111-1111-111111111111',
        environmentUrl: 'https://fresh.crm.dynamics.com',
        tenantId: '33333333-3333-3333-3333-333333333333',
        displayName: 'Fresh',
      }),
    },
  );
  assert.strictEqual(cacheReads, 0);
  assert.strictEqual(result.environmentUrl, 'https://fresh.crm.dynamics.com');
  assert.strictEqual(result.source, 'environment-id');
});

test('HTTP diagnostics report status and safe response shape without body contents', () => {
  const cases = [
    [401, {}, 'empty object'],
    [403, { error: { code: 'Forbidden', message: 'secret response detail' } }, 'object keys [error]'],
    [404, null, 'null body'],
    [500, 'not-json-secret', 'text(15)'],
  ];

  for (const [statusCode, data, shape] of cases) {
    const message = formatRequestFailure('Environment lookup failed', { statusCode, data });
    assert.match(message, new RegExp(`HTTP ${statusCode}`));
    assert.match(message, new RegExp(shape.replace(/[()[\]]/g, '\\$&')));
    assert.doesNotMatch(message, /secret response detail|not-json-secret/);
  }
});

test('diagnostic redaction removes bearer tokens, JWTs, and token query values', () => {
  const jwt = `eyJ${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(12)}`;
  const redacted = redactDiagnostic(
    `Bearer abc.def.ghi ${jwt} https://example.test?access_token=top-secret`,
  );
  assert.doesNotMatch(redacted, /abc\.def\.ghi|top-secret|eyJ/);
  assert.match(redacted, /\[redacted\]/);
});

test('response shape distinguishes empty, malformed, and structured payloads', () => {
  assert.strictEqual(describeResponseShape({}), 'empty object');
  assert.strictEqual(describeResponseShape('bad-json'), 'text(8)');
  assert.strictEqual(describeResponseShape({ error: {}, traceId: 'x' }), 'object keys [error, traceId]');
});
