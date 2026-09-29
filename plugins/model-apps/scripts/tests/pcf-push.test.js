'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');

const scriptPath = path.join(__dirname, '..', 'pcf-push.js');
const workspaceRoot = path.join(__dirname, '.pcf-push-workspace');

function resetWorkspace() {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
}

function makeProject(name, opts = {}) {
  const projectDir = path.join(workspaceRoot, name);
  fs.mkdirSync(path.join(projectDir, 'StarRating'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8');
  fs.writeFileSync(path.join(projectDir, 'StarRating.pcfproj'), opts.pcfproj || productionPcfproj(), 'utf8');
  fs.writeFileSync(path.join(projectDir, 'StarRating', 'ControlManifest.Input.xml'), manifestXml(opts), 'utf8');
  return projectDir;
}

function productionPcfproj() {
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <Import Project="$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props" />',
    '  <PropertyGroup>',
    '    <Name>StarRating</Name>',
    '    <PcfBuildMode>production</PcfBuildMode>',
    '  </PropertyGroup>',
    '</Project>',
  ].join('\n');
}

function developmentPcfproj() {
  return productionPcfproj().replace('<PcfBuildMode>production</PcfBuildMode>', '<PcfBuildMode>development</PcfBuildMode>');
}

function ineffectivePcfproj() {
  return productionPcfproj()
    .replace('    <PcfBuildMode>production</PcfBuildMode>\n', '')
    .replace('  <Import Project="$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props" />', '  <PropertyGroup>\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>\n  <Import Project="$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props" />');
}

function conditionedPcfproj() {
  return productionPcfproj()
    .replace('    <PcfBuildMode>production</PcfBuildMode>\n', '')
    .replace('  </PropertyGroup>', '  </PropertyGroup>\n  <PropertyGroup Condition="\'$(Configuration)\'==\'Release\'">\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>');
}

function manifestXml(opts = {}) {
  const version = opts.version || '1.2.3';
  return [
    '<manifest>',
    `  <control namespace="Contoso.Controls" constructor="StarRating" version="${version}" display-name-key="StarRating" description-key="StarRating description" control-type="standard">`,
    '    <property name="value" display-name-key="Value" of-type="Whole.None" usage="bound" required="false" />',
    '    <resources><code path="index.ts" order="1" /></resources>',
    '  </control>',
    '</manifest>',
  ].join('\n');
}

async function run(argv, overrides = {}) {
  const calls = [];
  const emitted = { stdout: '', stderr: '', exitCode: null };
  const realAuth = require('../lib/dataverse-auth.js');
  const stubs = {
    './lib/dataverse-auth': {
      parseArgs: realAuth.parseArgs,
      validateFlags: realAuth.validateFlags,
      emitResult: (ok, payload) => {
        if (payload && typeof payload === 'object') emitted.stdout += `${JSON.stringify(payload)}\n`;
        else emitted.stderr += `${String(payload)}\n`;
        if (!ok && payload instanceof Error) emitted.stderr += `${payload.message}\n`;
        emitted.exitCode = ok ? 0 : 1;
        const err = new Error(`process.exit(${emitted.exitCode})`);
        err.exitCode = emitted.exitCode;
        throw err;
      },
    },
    './lib/pac-exec': {
      runPac: (args, options) => {
        calls.push(['runPac', args, options]);
        return overrides.runPac ? overrides.runPac(args, options) : { status: 0, stdout: 'pushed', stderr: '' };
      },
    },
    ...(overrides.requires || {}),
    './lib/pcf-dataverse': {
      makePcfSdk: async (env, workspace) => {
        calls.push(['makePcfSdk', env, workspace]);
        if (overrides.makePcfSdk) return overrides.makePcfSdk(env, workspace);
        return { tag: 'sdk' };
      },
      findCustomControl: async (sdk, name) => {
        calls.push(['findCustomControl', sdk, name]);
        if (overrides.findCustomControl) return overrides.findCustomControl(sdk, name);
        return { name, version: '1.2.3', componentState: 0 };
      },
      solutionPrefix: async (sdk, solution) => {
        calls.push(['solutionPrefix', sdk, solution]);
        if (overrides.solutionPrefix) return overrides.solutionPrefix(sdk, solution);
        return 'new';
      },
    },
  };
  const cli = loadCli(scriptPath, { argv, requires: stubs });
  cli.calls = calls;
  cli.emitted = emitted;
  assert.equal(typeof cli.main, 'function');
  try {
    await cli.main(argv);
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }
  if (emitted.exitCode !== null) {
    cli.stdoutText = () => emitted.stdout;
    cli.stderrText = () => emitted.stderr;
    Object.defineProperty(cli, 'exitCode', { get: () => emitted.exitCode });
  }
  return cli;
}

test.beforeEach(resetWorkspace);
test.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

test('happy path forwards exact pac argv, verifies registration, and writes a safe receipt', async () => {
  const projectDir = makeProject('happy');
  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--solution', 'ContosoPcf',
    '--verbosity', 'detailed',
  ]);

  assert.equal(cli.exitCode, 0);
  assert.deepEqual(cli.calls.find((call) => call[0] === 'runPac'), [
    'runPac',
    ['pcf', 'push', '--environment', 'https://contoso.crm.dynamics.com', '--solution-unique-name', 'ContosoPcf', '--verbosity', 'detailed'],
    { cwd: projectDir, timeoutMs: 15 * 60 * 1000 },
  ]);
  assert.deepEqual(cli.calls.filter((call) => call[0] === 'solutionPrefix').map((call) => call[2]), ['ContosoPcf']);
  assert.deepEqual(cli.calls.filter((call) => call[0] === 'findCustomControl').map((call) => call[2]), ['new_Contoso.Controls.StarRating']);

  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.registered, { ok: true, version: '1.2.3', expected: '1.2.3' });
  assert.equal(payload.receipt, path.join(projectDir, 'pcf-receipt.json'));

  const receipt = JSON.parse(fs.readFileSync(path.join(projectDir, 'pcf-receipt.json'), 'utf8'));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.envOrigin, 'https://contoso.crm.dynamics.com');
  assert.equal(receipt.control, 'new_Contoso.Controls.StarRating');
  assert.equal(receipt.version, '1.2.3');
  assert.equal(receipt.solution, 'ContosoPcf');
  assert.equal(receipt.incremental, false);
  assert.deepEqual(receipt.tool.node, process.version);
  assert.match(receipt.pushedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(JSON.stringify(receipt), /token|Bearer|secret/i);
});

test('forwards --incremental with publisher prefix and skips read-back when --no-verify is set', async () => {
  const projectDir = makeProject('incremental');
  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--publisher-prefix', 'abc',
    '--incremental',
    '--no-verify',
  ]);

  assert.equal(cli.exitCode, 0);
  assert.deepEqual(cli.calls.find((call) => call[0] === 'runPac')[1], [
    'pcf', 'push', '--environment', 'https://contoso.crm.dynamics.com', '--publisher-prefix', 'abc', '--incremental', '--verbosity', 'minimal',
  ]);
  assert.equal(cli.calls.some((call) => call[0] === 'makePcfSdk'), false);
  const receipt = JSON.parse(fs.readFileSync(path.join(projectDir, 'pcf-receipt.json'), 'utf8'));
  assert.equal(receipt.publisherPrefix, 'abc');
  assert.equal(receipt.incremental, true);
  assert.deepEqual(receipt.registered, { ok: false, reason: 'not verified' });
});

test('rejects both solution and publisher-prefix as a usage error before push', async () => {
  const projectDir = makeProject('both-selectors');
  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--solution', 'One',
    '--publisher-prefix', 'abc',
  ]);

  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderrText(), /Usage:/);
  assert.match(cli.stderrText(), /exactly one of --solution or --publisher-prefix/);
  assert.equal(cli.stdoutText(), '');
  assert.equal(cli.calls.some((call) => call[0] === 'runPac'), false);
});

test('push failure emits hints and appends the last 40 build log lines', async () => {
  const projectDir = makeProject('push-failure');
  fs.mkdirSync(path.join(projectDir, 'obj'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'obj', 'pcf-push-build.log'), Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join('\n'), 'utf8');

  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--publisher-prefix', 'abc',
  ], {
    runPac: () => ({
      status: 1,
      stdout: 'Missing required tool dotnet',
      stderr: 'platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform.',
    }),
  });

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.equal(payload.stage, 'push');
  assert.match(payload.hints.join('\n'), /Install or update the missing tool/);
  assert.match(payload.hints.join('\n'), /PLATFORM_LIB_VERSION/);
  assert.match(payload.hints.join('\n'), /pcf-upgrade\.js/);
  assert.equal(payload.logTail.length, 40);
  assert.equal(payload.logTail[0], 'line-6');
  assert.equal(payload.logTail[39], 'line-45');
});

test('timeout reports best-effort state and log path without claiming the push was aborted', async () => {
  const projectDir = makeProject('timeout');
  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--publisher-prefix', 'abc',
  ], {
    runPac: () => ({ status: 1, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync pac ETIMEDOUT'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM' }),
  });

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.equal(payload.stage, 'push');
  assert.equal(payload.timedOut, true);
  assert.equal(payload.log, path.join(projectDir, 'obj', 'pcf-push-build.log'));
  assert.match(payload.message, /may still be running/i);
  assert.doesNotMatch(payload.message, /aborted|killed/i);
});

test('version mismatch makes the result fail with caching or publish guidance and still writes receipt', async () => {
  const projectDir = makeProject('mismatch');
  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--publisher-prefix', 'abc',
  ], {
    findCustomControl: async (sdk, name) => ({ name, version: '1.2.2', componentState: 0 }),
  });

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.registered, {
    ok: false,
    version: '1.2.2',
    expected: '1.2.3',
    reason: 'Registered version does not match the manifest; Dataverse caching or the push/publish may not have taken effect yet.',
  });
  const receipt = JSON.parse(fs.readFileSync(path.join(projectDir, 'pcf-receipt.json'), 'utf8'));
  assert.deepEqual(receipt.registered, payload.registered);
});

test('read-back failures are captured in registered instead of crashing', async () => {
  const projectDir = makeProject('read-failure');
  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--solution', 'ContosoPcf',
  ], {
    solutionPrefix: async () => { throw new Error('publisher lookup failed'); },
  });

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.deepEqual(payload.registered, { ok: false, reason: 'publisher lookup failed' });
});

test('refuses development and ineffective build modes unless --allow-dev-bundle is set', async () => {
  const devProject = makeProject('dev-mode', { pcfproj: developmentPcfproj() });
  const dev = await run(['--project', devProject, '--env', 'https://contoso.crm.dynamics.com', '--publisher-prefix', 'abc']);
  assert.equal(dev.exitCode, 1);
  assert.match(dev.stderrText(), /development bundle/i);
  assert.match(dev.stderrText(), /solution checker/i);
  assert.equal(dev.calls.some((call) => call[0] === 'runPac'), false);

  const ineffectiveProject = makeProject('ineffective-mode', { pcfproj: ineffectivePcfproj() });
  const ineffective = await run(['--project', ineffectiveProject, '--env', 'https://contoso.crm.dynamics.com', '--publisher-prefix', 'abc']);
  assert.equal(ineffective.exitCode, 1);
  assert.match(ineffective.stderrText(), /set but ineffective — move it below the Microsoft\.Common\.props import/);

  const allowed = await run(['--project', devProject, '--env', 'https://contoso.crm.dynamics.com', '--publisher-prefix', 'abc', '--allow-dev-bundle']);
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.calls.some((call) => call[0] === 'runPac'), true);
});

test('refuses conditioned PcfBuildMode with Debug-specific guidance', async () => {
  const projectDir = makeProject('conditioned-mode', { pcfproj: conditionedPcfproj() });
  const cli = await run(['--project', projectDir, '--env', 'https://contoso.crm.dynamics.com', '--publisher-prefix', 'abc']);

  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderrText(), /pac pcf push builds Debug/i);
  assert.match(cli.stderrText(), /make the production setting unconditional below the Microsoft\.Common\.props import/i);
  assert.doesNotMatch(cli.stderrText(), /move it below/);
  assert.equal(cli.calls.some((call) => call[0] === 'runPac'), false);
});

test('rejects invalid solution unique names before passing them to pac', async () => {
  const projectDir = makeProject('bad-solution-name');
  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--solution', 'Bad & Solution',
  ]);

  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderrText(), /Solution unique name/);
  assert.equal(cli.calls.some((call) => call[0] === 'runPac'), false);
});

test('push failure emits scrubbed bounded stdout and stderr tails', async () => {
  const projectDir = makeProject('scrubbed-output');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature';
  const stdout = Array.from({ length: 65 }, (_, i) => `out-${i + 1}`).join('\n') + `\nBearer secret-token\naccess_token=${jwt}`;
  const stderr = Array.from({ length: 64 }, (_, i) => `err-${i + 1}`).join('\n') + '\nclient_secret=abc123 password=p@ss';

  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--publisher-prefix', 'abc',
  ], {
    runPac: () => ({ status: 1, stdout, stderr }),
  });

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.stdout.length, 60);
  assert.equal(payload.stdout[0], 'out-8');
  assert.equal(payload.stdout.at(-2), 'Bearer <redacted>');
  assert.equal(payload.stdout.at(-1), 'access_token=<redacted>');
  assert.equal(payload.stderr.length, 60);
  assert.equal(payload.stderr[0], 'err-6');
  assert.equal(payload.stderr.at(-1), 'client_secret=<redacted> password=<redacted>');
  assert.doesNotMatch(JSON.stringify(payload), /secret-token|eyJhbGci|abc123|p@ss/);
});

test('push failure scrubs common secret shapes while preserving surrounding text', async () => {
  const projectDir = makeProject('secret-shapes');
  const rows = [
    ['query access token', 'prefix https://contoso.crm.dynamics.com/path?access_token=abc123&x=1 suffix', /abc123|\/path|\?access_token/, /prefix https:\/\/contoso\.crm\.dynamics\.com\/… suffix/],
    ['refresh token equals', 'prefix refresh_token=refresh-secret suffix', /refresh-secret/, /prefix refresh_token=<redacted> suffix/],
    ['id token colon', 'prefix id_token: id-secret suffix', /id-secret/, /prefix id_token: <redacted> suffix/],
    ['clientSecret json', 'prefix "clientSecret": "client-secret" suffix', /client-secret/, /prefix "clientSecret": "<redacted>" suffix/],
    ['pwd query', 'prefix https://example.test/callback?pwd=pwd-secret suffix', /pwd-secret|\/callback|\?pwd/, /prefix https:\/\/example\.test\/… suffix/],
    ['sig query', 'prefix https://storage.test/file.zip?sig=sig-secret suffix', /sig-secret|file\.zip|\?sig/, /prefix https:\/\/storage\.test\/… suffix/],
    ['code equals', 'prefix code=auth-code suffix', /auth-code/, /prefix code=<redacted> suffix/],
    ['authorization bearer', 'prefix Authorization: Bearer bearer-secret, suffix', /bearer-secret/, /prefix Authorization: Bearer <redacted>, suffix/],
    ['bare bearer', 'prefix Bearer bare-secret; suffix', /bare-secret/, /prefix Bearer <redacted>; suffix/],
    ['jwt', 'prefix eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature suffix', /eyJhbGci|eyJzdWIi|signature/, /prefix <redacted-jwt> suffix/],
    ['password json', 'prefix "password":"json-secret" suffix', /json-secret/, /prefix "password":"<redacted>" suffix/],
  ];

  const stdout = rows.map(([, line]) => line).join('\n');
  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--publisher-prefix', 'abc',
  ], {
    runPac: () => ({ status: 1, stdout, stderr: '' }),
  });

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  for (const [name, , secretPattern, surroundingPattern] of rows) {
    const line = payload.stdout.find((item) => surroundingPattern.test(item));
    assert.ok(line, `missing preserved surrounding text for ${name}: ${JSON.stringify(payload.stdout)}`);
    assert.doesNotMatch(line, secretPattern, name);
  }
});

test('failed receipt write emits receipt-stage JSON and leaves no partial receipt behind', async () => {
  const projectDir = makeProject('receipt-write-failure');
  const realFs = require('node:fs');
  const fsStub = {
    ...realFs,
    renameSync: (from, to) => {
      if (String(to).endsWith('pcf-receipt.json')) throw new Error('rename failed');
      return realFs.renameSync(from, to);
    },
  };

  const cli = await run([
    '--project', projectDir,
    '--env', 'https://contoso.crm.dynamics.com',
    '--publisher-prefix', 'abc',
  ], { requires: { 'node:fs': fsStub } });

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.equal(payload.stage, 'receipt');
  assert.match(payload.reason, /rename failed/);
  assert.deepEqual(payload.registered, { ok: true, version: '1.2.3', expected: '1.2.3' });
  assert.equal(realFs.existsSync(path.join(projectDir, 'pcf-receipt.json')), false);
  assert.deepEqual(realFs.readdirSync(projectDir).filter((entry) => entry.startsWith('.pcf-receipt-')), []);
});
