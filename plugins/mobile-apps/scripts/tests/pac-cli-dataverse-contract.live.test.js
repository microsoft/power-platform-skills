'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { verifyDataverseServices } = require('../verify-dataverse-services');

const environmentId = process.env.POWER_APPS_LIVE_DATAVERSE_ENVIRONMENT_ID;
const environmentUrl = process.env.POWER_APPS_LIVE_DATAVERSE_URL;
const defaultCli = path.resolve(__dirname, '..', '..', 'template', 'node_modules', '.bin', 'power-apps');
const cliBin = process.env.POWER_APPS_LIVE_CLI_BIN || defaultCli;
const skipReason = environmentId && environmentUrl && fs.existsSync(cliBin)
  ? false
  : 'set Dataverse environment variables and POWER_APPS_LIVE_CLI_BIN';

function runCli(cwd, args) {
  const result = spawnSync(
    cliBin,
    args,
    { cwd, encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL' },
  );
  assert.equal(
    result.status,
    0,
    `${args[0]} failed: ${result.stderr || result.stdout}`,
  );
  return result;
}

test('pinned PAC CLI emits a verifiable Dataverse service contract', {
  skip: skipReason,
  timeout: 210000,
}, (testContext) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-dataverse-contract-'));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const templatePackage = JSON.parse(fs.readFileSync(path.resolve(
    __dirname,
    '..',
    '..',
    'template',
    'package.json',
  ), 'utf8'));
  const version = templatePackage.devDependencies['@microsoft/power-apps-cli'];
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(runCli(root, ['--version']).stdout.trim(), version);

  runCli(root, [
    'init',
    '--non-interactive',
    '--environment-id',
    environmentId,
    '--app-type',
    'MobileApp',
    '--display-name',
    'PAC Dataverse Contract Probe',
    '--build-path',
    './dist',
    '--file-entry-point',
    'index.html',
    '--app-url',
    'http://localhost:8081',
    '--json',
  ]);
  runCli(root, [
    'add-data-source',
    '--non-interactive',
    '--api-id',
    'dataverse',
    '--org-url',
    environmentUrl,
    '--resource-name',
    'systemuser',
    '--json',
  ]);

  const services = verifyDataverseServices(root, ['systemuser']);
  assert.equal(services.length, 1);
  assert.equal(services[0].logicalName, 'systemuser');
  assert.equal(services[0].entitySetName, 'systemusers');
  assert.equal(services[0].serviceFile, 'SystemusersService.ts');
});