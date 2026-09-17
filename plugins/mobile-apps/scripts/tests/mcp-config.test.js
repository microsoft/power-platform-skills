'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const validateScript = path.join(pluginRoot, 'scripts', 'validate-mcp-config.js');
const {
  AZURE_NAMESPACES,
  AZURE_PACKAGE,
  AZURE_VERSION,
  FIREBASE_ALLOWED_TOOLS,
  FIREBASE_PACKAGE,
  FIREBASE_VERSION,
  GCLOUD_PACKAGE,
  GCLOUD_VERSION,
  MICROSOFT_LEARN_URL,
  buildOfficialMcpInvocation,
  getGcloudAllowlistPath,
} = require('../lib/official-mcp-servers');
const { validateMcpConfig } = require('../validate-mcp-config');

function createFixtureDir() {
  const dir = path.join(__dirname, `.mcp-config-fixture-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createFakeNpx(dir) {
  const commandPath = path.join(dir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const script = process.platform === 'win32'
    ? '@echo off\r\necho fake-npx %*\r\n'
    : '#!/bin/sh\necho "fake-npx $*"\n';
  fs.writeFileSync(commandPath, script, { mode: 0o755 });
  return commandPath;
}

test('validate-mcp-config reports the checked-in MCP bootstrap as valid', () => {
  const result = validateMcpConfig(pluginRoot);
  assert.equal(result.ok, true, result.issues.join('\n'));
  assert.deepEqual(result.issues, []);
  assert.equal(result.summary.microsoftLearn, MICROSOFT_LEARN_URL);
});

test('validate-mcp-config CLI exits successfully', () => {
  const result = spawnSync(process.execPath, [validateScript, pluginRoot], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true, result.stdout);
});

test('official MCP invocation plans stay pinned and capability-bounded', () => {
  const firebase = buildOfficialMcpInvocation('firebase', pluginRoot);
  assert.equal(firebase.command, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  assert.deepEqual(firebase.args, [
    '-y',
    `${FIREBASE_PACKAGE}@${FIREBASE_VERSION}`,
    'mcp',
    '--mode',
    'stdio',
    '--tools',
    FIREBASE_ALLOWED_TOOLS.join(','),
  ]);

  const gcloud = buildOfficialMcpInvocation('gcloud', pluginRoot);
  assert.deepEqual(gcloud.args, [
    '-y',
    `${GCLOUD_PACKAGE}@${GCLOUD_VERSION}`,
    '--config',
    getGcloudAllowlistPath(pluginRoot),
  ]);

  const azure = buildOfficialMcpInvocation('azure', pluginRoot);
  assert.deepEqual(azure.args, [
    '-y',
    '-p',
    `${AZURE_PACKAGE}@${AZURE_VERSION}`,
    'azmcp',
    'server',
    'start',
    '--transport',
    'stdio',
    '--mode',
    'namespace',
    ...AZURE_NAMESPACES.flatMap((namespace) => ['--namespace', namespace]),
  ]);
});

test('azure MCP bootstrap uses the verified azmcp binary invocation', () => {
  const azure = buildOfficialMcpInvocation('azure', pluginRoot);
  assert.equal(azure.command, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  assert.deepEqual(azure.args.slice(0, 5), [
    '-y',
    '-p',
    `${AZURE_PACKAGE}@${AZURE_VERSION}`,
    'azmcp',
    'server',
  ]);
  assert.doesNotMatch(azure.args.join(' '), /@azure\/mcp@\S+\s+--help/);
});

test('bootstrap entries resolve the launcher without host env vars and dispatch pinned npx commands', (t) => {
  const fixtureDir = createFixtureDir();
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  createFakeNpx(fixtureDir);

  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const pathSeparator = process.platform === 'win32' ? ';' : ':';

  for (const serverId of ['firebase', 'gcloud', 'azure']) {
    const server = config.mcpServers[serverId];
    const result = spawnSync(server.command, server.args, {
      cwd: pluginRoot,
      encoding: 'utf8',
      env: {
        HOME: process.env.HOME,
        PATH: `${fixtureDir}${pathSeparator}${process.env.PATH || ''}`,
        USERPROFILE: process.env.USERPROFILE,
      },
      timeout: 5_000,
    });

    assert.equal(result.status, 0, `${serverId}: ${result.stderr}`);
    assert.match(result.stdout, /fake-npx/);
  }

  const firebaseOutput = spawnSync(config.mcpServers.firebase.command, config.mcpServers.firebase.args, {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: {
      HOME: process.env.HOME,
      PATH: `${fixtureDir}${pathSeparator}${process.env.PATH || ''}`,
      USERPROFILE: process.env.USERPROFILE,
    },
    timeout: 5_000,
  }).stdout;
  assert.match(firebaseOutput, new RegExp(`${FIREBASE_PACKAGE}@${FIREBASE_VERSION}`));
  assert.match(firebaseOutput, /--tools/);
  assert.match(firebaseOutput, new RegExp(FIREBASE_ALLOWED_TOOLS.join(',')));

  const gcloudOutput = spawnSync(config.mcpServers.gcloud.command, config.mcpServers.gcloud.args, {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: {
      HOME: process.env.HOME,
      PATH: `${fixtureDir}${pathSeparator}${process.env.PATH || ''}`,
      USERPROFILE: process.env.USERPROFILE,
    },
    timeout: 5_000,
  }).stdout;
  assert.match(gcloudOutput, new RegExp(`${GCLOUD_PACKAGE}@${GCLOUD_VERSION}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(gcloudOutput, new RegExp(getGcloudAllowlistPath(pluginRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const azureOutput = spawnSync(config.mcpServers.azure.command, config.mcpServers.azure.args, {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: {
      HOME: process.env.HOME,
      PATH: `${fixtureDir}${pathSeparator}${process.env.PATH || ''}`,
      USERPROFILE: process.env.USERPROFILE,
    },
    timeout: 5_000,
  }).stdout;
  assert.match(azureOutput, new RegExp(`${AZURE_PACKAGE}@${AZURE_VERSION}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const namespace of AZURE_NAMESPACES) {
    assert.match(azureOutput, new RegExp(`--namespace ${namespace}`));
  }
});

test('microsoft-learn entry is preserved as hosted HTTP MCP', () => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers['microsoft-learn'], {
    type: 'http',
    url: MICROSOFT_LEARN_URL,
  });
});
