'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { verifyDataverseServices } = require('../verify-dataverse-services');
const { checkQuerySupport } = require('../check-dataverse-query-support');
const { runCliSync } = require('../lib/process-runner');

const environmentId = process.env.POWER_APPS_LIVE_DATAVERSE_ENVIRONMENT_ID;
const environmentUrl = process.env.POWER_APPS_LIVE_DATAVERSE_URL;
const defaultCli = path.resolve(__dirname, '..', '..', 'template', 'node_modules', '.bin',
  process.platform === 'win32' ? 'pa.cmd' : 'pa');
const cliBin = process.env.POWER_APPS_LIVE_CLI_BIN || defaultCli;
const skipReason = environmentId && environmentUrl && fs.existsSync(cliBin)
  ? false
  : 'set Dataverse environment variables and POWER_APPS_LIVE_CLI_BIN';

function runCli(cwd, args) {
  const stdout = runCliSync(
    cliBin,
    args,
    { cwd, encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL' },
  );
  return { stdout };
}

test('pinned Power Apps CLI emits a verifiable Dataverse service contract', {
  skip: skipReason,
  timeout: 210000,
}, (testContext) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'power-apps-dataverse-contract-'));
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
    'app', 'init',
    '--non-interactive',
    '--environment-id',
    environmentId,
    '--app-type',
    'MobileApp',
    '--display-name',
    'Power Apps Dataverse Contract Probe',
    '--build-path',
    './dist',
    '--file-entry-point',
    'index.html',
    '--app-url',
    'http://localhost:8081',
    '--json',
  ]);
  runCli(root, [
    'app', 'add', 'data-source',
    '--non-interactive',
    '--connector',
    'dataverse',
    '--org-url',
    environmentUrl,
    '--table',
    'systemuser',
    '--json',
  ]);

  const services = verifyDataverseServices(root, ['systemuser']);
  assert.equal(services.length, 1);
  assert.equal(services[0].logicalName, 'systemuser');
  assert.equal(services[0].entitySetName, 'systemusers');
  assert.equal(services[0].serviceFile, 'SystemusersService.ts');
  // The probe project uses the template's installed SDK without downloading a second copy.
  fs.symlinkSync(
    path.resolve(__dirname, '..', '..', 'template', 'node_modules'),
    path.join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.deepEqual(checkQuerySupport(root).services[0].supported, {
    expand: true, apply: true, 'saved-query': true,
  });
});
