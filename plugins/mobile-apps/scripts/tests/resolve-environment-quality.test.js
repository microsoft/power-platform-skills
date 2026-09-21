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
  main,
  parseArgs,
  redactDiagnostic,
  resolveEnvironment,
  writeCacheIfProject,
} = require('../resolve-environment');

const resolverPath = path.resolve(__dirname, '../resolve-environment.js');

test('no-cache mode permits reads but performs no filesystem writes', (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-no-cache-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
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

test('resolver accepts required-tenant and help options and rejects unknown flags', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  for (const args of [
    [id, '--no-cache', '--require-tenant'],
    ['--require-tenant', '--no-cache', id],
  ]) {
    assert.deepStrictEqual(parseArgs(args), { noCache: true, target: id, requireTenant: true });
  }
  for (const help of ['--help', '-h']) {
    assert.deepStrictEqual(parseArgs([help]), { noCache: false, target: null, help: true });
  }
  for (const args of [['--typo'], ['--typo', id], [id, '--typo'], ['--help', '--typo']]) {
    assert.throws(() => parseArgs(args), /Unknown option: --typo/);
  }
  assert.throws(() => parseArgs([id, id]), /Unknown argument/);
});

test('resolver help and invalid options exit without resolving or writing project files', (testContext) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-cli-options-'));
  testContext.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const target = '11111111-1111-1111-1111-111111111111';
  const run = (args) => spawnSync(process.execPath, [resolverPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, PATH: '', POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  for (const args of [['--help'], ['-h'], [target, '--no-cache', '--require-tenant', '--help']]) {
    const result = run(args);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:.*<environment-url-or-id>/);
    assert.match(result.stdout, /--require-tenant/);
    assert.match(result.stdout, /Existing identity metadata may still be read/);
    assert.strictEqual(result.stderr, '');
  }
  for (const args of [['--typo'], [target, '--typo']]) {
    const result = run(args);
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /^Unknown option: --typo/);
    assert.strictEqual(result.stdout, '');
  }
  assert.deepStrictEqual(fs.readdirSync(projectRoot), []);
});

test('required-tenant mode rejects incomplete resolution before emitting JSON', async (testContext) => {
  const environmentResolution = require('../lib/environment-resolution');
  let resolved;
  const resolution = testContext.mock.method(environmentResolution, 'resolveEnvironment', async () => resolved);
  const output = testContext.mock.method(console, 'log', () => {});
  const environment = {
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: '22222222-2222-2222-2222-222222222222',
  };
  const args = ['11111111-1111-1111-1111-111111111111', '--no-cache', '--require-tenant'];
  for (const incomplete of [
    null,
    {},
    { environmentUrl: environment.environmentUrl },
    { tenantId: environment.tenantId },
    { ...environment, tenantId: null },
    { ...environment, tenantId: ' ' },
    { ...environment, tenantId: 42 },
    { ...environment, environmentUrl: '' },
  ]) {
    resolved = incomplete;
    await assert.rejects(main(args), /Could not resolve a Dataverse environment URL and tenant ID/);
  }
  assert.strictEqual(output.mock.callCount(), 0);
  resolved = environment;
  await main(args);
  assert.strictEqual(output.mock.callCount(), 1);
  assert.deepStrictEqual(JSON.parse(output.mock.calls[0].arguments[0]), environment);
  assert.deepStrictEqual(resolution.mock.calls[0].arguments[3], {
    noCache: true, target: args[0], requireTenant: true,
  });
});

test('resolver export retains project lookup while the CLI requires an explicit target', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-export-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const environment = {
    environmentId: '11111111-1111-1111-1111-111111111111',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: '22222222-2222-2222-2222-222222222222',
  };
  fs.writeFileSync(path.join(projectRoot, 'power.config.json'), JSON.stringify({
    environmentId: environment.environmentId,
  }));
  for (const allowLegacyCache of [false, true]) {
    const cached = allowLegacyCache ? environment : {
      ...environment, clusterEnvironment: 'Prod', clusterGeoName: 'EU',
    };
    fs.writeFileSync(path.join(projectRoot, '.resolved-environment.json'), JSON.stringify(cached));
    const result = await resolveEnvironment(null, projectRoot, allowLegacyCache);
    assert.strictEqual(result.environmentId, environment.environmentId);
    assert.strictEqual(result.environmentUrl, environment.environmentUrl);
    assert.strictEqual(result.source, 'cache');
  }
  const cli = spawnSync(process.execPath, [resolverPath, '--no-cache'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, PATH: '', POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.strictEqual(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /Usage:.*<environment-url-or-id>/);
  assert.strictEqual(cli.stdout, '');
});

test('resolver CLI and exported API leave cached project files byte-identical in no-cache mode', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-cli-no-cache-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const environment = {
    environmentId: '11111111-1111-1111-1111-111111111111',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: '22222222-2222-2222-2222-222222222222',
  };
  const authPath = path.join(projectRoot, 'auth.config.json');
  const appPath = path.join(projectRoot, 'app.json');
  const cachePath = path.join(projectRoot, '.resolved-environment.json');
  fs.writeFileSync(path.join(projectRoot, 'power.config.json'), JSON.stringify({
    environmentId: environment.environmentId,
  }));
  fs.writeFileSync(appPath, JSON.stringify({
    expo: { extra: { telemetry: { appInstanceId: environment.environmentId, cluster: null } } },
  }));
  const appBefore = fs.readFileSync(appPath);

  for (const clusterMetadata of [{}, { clusterEnvironment: 'Prod', clusterGeoName: 'EU' }]) {
    const cached = { ...environment, ...clusterMetadata };
    const authConfig = {
      msal: { clientId: '', tenantId: '' },
      environment: cached,
    };
    fs.writeFileSync(authPath, `${JSON.stringify(authConfig, null, 2)}\n`);
    const before = fs.readFileSync(authPath);
    for (const existingSidecar of [false, true]) {
      if (existingSidecar) fs.writeFileSync(cachePath, JSON.stringify(cached));
      const filesBefore = fs.readdirSync(projectRoot).sort();
      const result = spawnSync(
        process.execPath,
        [resolverPath, environment.environmentId, '--no-cache', '--require-tenant'],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, PATH: '', POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
        },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      const exportedResult = await resolveEnvironment(null, projectRoot, false, { noCache: true });
      assert.deepStrictEqual(exportedResult, JSON.parse(result.stdout));
      assert.deepStrictEqual(fs.readFileSync(authPath), before);
      assert.deepStrictEqual(fs.readFileSync(appPath), appBefore);
      assert.deepStrictEqual(fs.readdirSync(projectRoot).sort(), filesBefore);
      assert.strictEqual(JSON.parse(result.stdout).source, 'cache');
      assert.strictEqual(JSON.parse(result.stdout).clusterGeoName, clusterMetadata.clusterGeoName || null);
      if (existingSidecar) {
        assert.strictEqual(fs.readFileSync(cachePath, 'utf8'), JSON.stringify(cached));
        fs.unlinkSync(cachePath);
      }
    }
  }
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
