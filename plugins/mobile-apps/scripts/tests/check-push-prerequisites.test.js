'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  STAGE_REQUIREMENTS,
  checkStage,
  commandSpec,
  parseArgs,
  probeNode,
  probeVersion,
  sanitizeVersion,
} = require('../check-push-prerequisites');

function fakeSpawn(available) {
  return (command, args) => {
    const key = command === 'npx' && args[0] === '--no-install'
      ? 'power-apps'
      : command;
    if (!available.has(key)) {
      return { status: 127, stdout: '', stderr: '', error: new Error('missing') };
    }
    return { status: 0, stdout: `${key} 1.2.3\nignored\n`, stderr: '' };
  };
}

test('parses one required stage and rejects unknown arguments', () => {
  assert.deepEqual(parseArgs(['--stage', 'firebase-client']), {
    stage: 'firebase-client',
    help: false,
  });
  assert.throws(() => parseArgs(['--other']), /Unknown argument/);
});

test('stage requirements are lazy and do not require gcloud for Firebase', () => {
  assert.deepEqual(STAGE_REQUIREMENTS['firebase-client'], ['node', 'npm', 'npx']);
  assert.ok(STAGE_REQUIREMENTS.wif.includes('gcloud'));
  assert.ok(STAGE_REQUIREMENTS['flow-authoring'].includes('power-apps'));
  assert.ok(!STAGE_REQUIREMENTS['firebase-client'].includes('gcloud'));
  assert.ok(!STAGE_REQUIREMENTS['firebase-client'].includes('az'));
});

test('Firebase readiness succeeds with only Node npm and npx', () => {
  const result = checkStage('firebase-client', {
    nodeVersion: 'v22.14.0',
    spawnSync: fakeSpawn(new Set(['npm', 'npx'])),
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.issues, []);
});

test('WIF readiness reports a missing gcloud executable without account probing', () => {
  const result = checkStage('wif', {
    nodeVersion: 'v22.14.0',
    spawnSync: fakeSpawn(new Set(['npm', 'npx', 'az'])),
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.issues, [{
    name: 'gcloud',
    code: 'local-runtime-missing',
    status: 'missing',
  }]);
});

test('WIF readiness probes gcloud.cmd safely on Windows', () => {
  const calls = [];
  const sdkBin = 'C:\\Google\\CloudSDK\\google-cloud-sdk\\bin';
  const gcloudCmd = `${sdkBin}\\gcloud.cmd`;
  const python = 'C:\\Google\\CloudSDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe';
  const gcloudPy = 'C:\\Google\\CloudSDK\\google-cloud-sdk\\lib\\gcloud.py';
  const result = checkStage('wif', {
    platform: 'win32',
    nodeVersion: 'v22.14.0',
    env: { Path: sdkBin },
    existsSync(candidate) {
      return [gcloudCmd, python, gcloudPy].includes(candidate);
    },
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: 'tool 1.2.3\n', stderr: '' };
    },
  });

  assert.equal(result.status, 'ready');
  const gcloudProbe = calls.find(({ command }) => command === python);
  assert.ok(gcloudProbe, 'Windows gcloud probe bypasses the command script');
  assert.equal(gcloudProbe.options.shell, undefined);
  assert.deepEqual(gcloudProbe.args, ['-S', gcloudPy, '--version']);
});

test('flow readiness reports each independently missing local command', () => {
  const result = checkStage('flow-authoring', {
    nodeVersion: 'v22.14.0',
    spawnSync: fakeSpawn(new Set(['npm', 'npx', 'power-apps'])),
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(
    result.issues.map(({ name }) => name),
    ['pac', 'az'],
  );
});

test('PAC readiness uses the supported help command and parses its version banner', () => {
  assert.deepEqual(commandSpec('pac'), {
    command: 'pac',
    args: ['help'],
  });

  const calls = [];
  const result = checkStage('flow-authoring', {
    nodeVersion: 'v22.14.0',
    spawnSync(command, args) {
      calls.push({ command, args });
      if (command === 'pac') {
        return {
          status: 0,
          stdout: 'Microsoft PowerPlatform CLI\nVersion: 1.46.2+g1234567\n',
          stderr: '',
        };
      }
      return { status: 0, stdout: `${command} 1.2.3\n`, stderr: '' };
    },
  });

  assert.equal(result.status, 'ready');
  assert.deepEqual(
    calls.find(({ command }) => command === 'pac'),
    { command: 'pac', args: ['help'] },
  );
  assert.equal(
    result.checks.find(({ name }) => name === 'pac').version,
    '1.46.2+g1234567',
  );
});

test('unsupported Node and non-macOS Xcode use stable categories', () => {
  assert.deepEqual(probeNode({ nodeVersion: 'v18.20.0' }), {
    name: 'node',
    status: 'unsupported',
    code: 'local-runtime-unsupported',
    version: 'v18.20.0',
    minimum: '20.0.0',
  });
  const result = checkStage('ios-build', {
    platform: 'linux',
    nodeVersion: 'v22.14.0',
    spawnSync: fakeSpawn(new Set(['npm', 'npx'])),
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.issues, [{
    name: 'xcodebuild',
    code: 'local-runtime-unsupported',
    status: 'unsupported',
  }]);
});

test('iOS verification does not unnecessarily require Xcode after build', () => {
  const result = checkStage('ios-verify', {
    platform: 'linux',
    nodeVersion: 'v22.14.0',
    spawnSync: fakeSpawn(new Set(['npm', 'npx', 'power-apps', 'pac', 'az'])),
  });
  assert.equal(result.status, 'ready');
  assert.ok(!STAGE_REQUIREMENTS['ios-verify'].includes('xcodebuild'));
});

test('version output is bounded and strips unsafe punctuation', () => {
  assert.equal(sanitizeVersion('tool 1.2.3\nsecret=ignored'), 'tool 1.2.3');
  assert.equal(sanitizeVersion('{"azure-cli":"2.0"}'), 'azure-cli2.0');
  assert.equal(
    probeVersion('pac', 'Microsoft PowerPlatform CLI\nVersion: 1.46.2+g1234567\n'),
    '1.46.2+g1234567',
  );
});
