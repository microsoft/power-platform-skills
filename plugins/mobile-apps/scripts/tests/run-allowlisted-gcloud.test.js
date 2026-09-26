'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  main,
  isAllowedGcloudArgs,
  loadAllowlist,
} = require('../run-allowlisted-gcloud');
const {
  buildGcloudProcessInvocation,
  resolveWindowsGcloud,
} = require('../lib/gcloud-cli');

const WINDOWS_SDK_BIN = 'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin';
const WINDOWS_GCLOUD_CMD = `${WINDOWS_SDK_BIN}\\gcloud.cmd`;
const WINDOWS_PYTHON = 'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe';
const WINDOWS_GCLOUD_PY = 'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\lib\\gcloud.py';

function windowsExists(candidate) {
  return new Set([
    WINDOWS_GCLOUD_CMD,
    WINDOWS_PYTHON,
    WINDOWS_GCLOUD_PY,
  ]).has(candidate);
}

test('allows checked-in gcloud command families with explicit flags', () => {
  const allowlist = loadAllowlist();
  assert.equal(
    isAllowedGcloudArgs(
      ['config', 'list', 'account', '--format=json'],
      allowlist,
    ),
    true,
  );
  assert.equal(
    isAllowedGcloudArgs(
      [
        'iam',
        'list-testable-permissions',
        '//cloudresourcemanager.googleapis.com/projects/contoso-mobile',
        '--filter=name:cloudmessaging.messages.create',
        '--format=json(name,stage,customRolesSupportLevel)',
      ],
      allowlist,
    ),
    true,
  );
  assert.equal(
    isAllowedGcloudArgs(
      [
        'iam',
        'workload-identity-pools',
        'describe',
        'power-automate-push',
        '--location=global',
        '--project=contoso-mobile',
        '--format=json',
      ],
      allowlist,
    ),
    true,
  );
});

test('rejects unlisted, shell-shaped, and malformed commands', () => {
  const allowlist = loadAllowlist();
  assert.equal(isAllowedGcloudArgs(['auth', 'print-access-token'], allowlist), false);
  assert.equal(isAllowedGcloudArgs(['iam', 'permissions', 'query-testable'], allowlist), false);
  assert.equal(isAllowedGcloudArgs(['projects', 'delete', 'prod'], allowlist), false);
  assert.equal(isAllowedGcloudArgs(['iam', 'service-accounts', 'keys', 'create'], allowlist), false);
  assert.equal(isAllowedGcloudArgs(['projects', 'describe', 'prod\nwhoami'], allowlist), false);
  assert.equal(isAllowedGcloudArgs([], allowlist), false);
});

test('builds a direct shell-free invocation on non-Windows platforms', () => {
  const invocation = buildGcloudProcessInvocation(
    ['projects', 'describe', 'contoso-mobile', '--format=json'],
    { platform: 'darwin', env: { PATH: '/usr/bin' } },
  );
  assert.equal(invocation.command, 'gcloud');
  assert.deepEqual(invocation.args, [
    'projects', 'describe', 'contoso-mobile', '--format=json',
  ]);
  assert.equal(invocation.env.CLOUDSDK_CORE_DISABLE_PROMPTS, '1');
});

test('bypasses gcloud.cmd and preserves Windows arguments as process tokens', () => {
  const gcloudArgs = [
    'iam',
    'workload-identity-pools',
    'providers',
    'update-oidc',
    '--attribute-condition=assertion.appid=="client" && assertion.tid=="tenant"',
  ];
  const invocation = buildGcloudProcessInvocation(gcloudArgs, {
    platform: 'win32',
    env: {
      Path: WINDOWS_SDK_BIN,
      pythonhome: 'C:\\Unexpected\\Python',
      cloudsdk_core_disable_prompts: '0',
    },
    existsSync: windowsExists,
  });

  assert.equal(invocation.command, WINDOWS_PYTHON);
  assert.deepEqual(invocation.args, [
    '-S',
    WINDOWS_GCLOUD_PY,
    ...gcloudArgs,
  ]);
  assert.equal(
    invocation.env.CLOUDSDK_ROOT_DIR,
    'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk',
  );
  assert.equal(invocation.env.CLOUDSDK_PYTHON, WINDOWS_PYTHON);
  assert.equal(invocation.env.PYTHONIOENCODING, 'UTF-8');
  assert.equal(invocation.env.CLOUDSDK_CORE_DISABLE_PROMPTS, '1');
  assert.equal(invocation.env.Path, WINDOWS_SDK_BIN);
  assert.equal(
    Object.keys(invocation.env).some((key) => key.toUpperCase() === 'PYTHONHOME'),
    false,
  );
  assert.equal(
    Object.keys(invocation.env).filter(
      (key) => key.toUpperCase() === 'CLOUDSDK_CORE_DISABLE_PROMPTS',
    ).length,
    1,
  );
});

test('uses an explicit CLOUDSDK_PYTHON path when the SDK has no bundled runtime', () => {
  const customPython = 'C:\\Python313\\python.exe';
  const resolved = resolveWindowsGcloud({
    env: {
      PATH: WINDOWS_SDK_BIN,
      CLOUDSDK_PYTHON: `"${customPython}"`,
      CLOUDSDK_PYTHON_SITEPACKAGES: '1',
    },
    existsSync(candidate) {
      return [WINDOWS_GCLOUD_CMD, WINDOWS_GCLOUD_PY, customPython].includes(candidate);
    },
  });
  assert.equal(resolved.command, customPython);
  assert.deepEqual(resolved.argsPrefix, [WINDOWS_GCLOUD_PY]);
});

test('resolves a system Python when the Windows SDK omits bundled Python', () => {
  const systemPythonDir = 'C:\\Python313';
  const systemPython = `${systemPythonDir}\\python3.exe`;
  const resolved = resolveWindowsGcloud({
    env: {
      Path: `${WINDOWS_SDK_BIN};${systemPythonDir}`,
      CLOUDSDK_PYTHON: 'python3',
    },
    existsSync(candidate) {
      return [WINDOWS_GCLOUD_CMD, WINDOWS_GCLOUD_PY, systemPython].includes(candidate);
    },
  });
  assert.equal(resolved.command, systemPython);
  assert.deepEqual(resolved.argsPrefix, ['-S', WINDOWS_GCLOUD_PY]);
});

test('executes an allowed Windows command without a command interpreter', () => {
  let observed;
  const status = main(
    ['--', 'projects', 'describe', 'contoso-mobile', '--format=json'],
    {
      platform: 'win32',
      env: { PATH: WINDOWS_SDK_BIN },
      existsSync: windowsExists,
      spawnSync(command, args, options) {
        observed = { command, args, options };
        return { status: 0 };
      },
    },
  );

  assert.equal(status, 0);
  assert.equal(observed.command, WINDOWS_PYTHON);
  assert.deepEqual(observed.args, [
    '-S',
    WINDOWS_GCLOUD_PY,
    'projects',
    'describe',
    'contoso-mobile',
    '--format=json',
  ]);
  assert.equal(observed.options.shell, false);
});
