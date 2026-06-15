'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const helpers = require('../lib/validation-helpers');

let requestHandler = async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) });
const originalMakeRequest = helpers.makeRequest;
helpers.makeRequest = async (opts) => requestHandler(opts);

const { validateBlockedAttachments } = require('../lib/validate-blocked-attachments');
const { validateDependencies } = require('../lib/validate-dependencies');
const { classifyEntry } = require('../lib/validate-deployment-settings');
const { validateFileSizes } = require('../lib/validate-file-sizes');
const { validateNoAction3Conflicts } = require('../lib/validate-no-action-3-conflicts');
const { validateNoIscustomizableFalseRows } = require('../lib/validate-no-iscustomizable-false-rows');
const { validateNoOrphanSourceControlRows } = require('../lib/validate-no-orphan-source-control-rows');
const { validateNoSharedComponents } = require('../lib/validate-no-shared-components');
const { validateNotDefaultSolution } = require('../lib/validate-not-default-solution');
const { validatePublisherPrefixConsistency } = require('../lib/validate-publisher-prefix-consistency');
const { validateSolutionVersionBumped } = require('../lib/validate-solution-version-bumped');
const { validateStageRunsBatch } = require('../lib/validate-stage-runs-batch');
const { validateSupportedObjectTypes } = require('../lib/validate-supported-object-types');
const { validateTotalPayloadSize } = require('../lib/validate-total-payload-size');

helpers.makeRequest = originalMakeRequest;

const CODE_PATTERN = /^IL-[A-Z]+-\d{3}$/;
const GUID_1 = '11111111-1111-1111-1111-111111111111';
const GUID_2 = '22222222-2222-2222-2222-222222222222';

function assertRef(finding) {
  assert.match(finding.ref, CODE_PATTERN);
}

function testDir(t) {
  const dir = path.join(__dirname, '.finding-codes-tmp');
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(t, name, value) {
  const file = path.join(testDir(t), name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function pacOut(blocked) {
  return `Setting            Value\nblockedattachments ${blocked}\n`;
}

test('validator findings have stable IL diagnostic refs', async (t) => {
  const findings = [];

  const blocked = await validateBlockedAttachments({
    envUrl: 'https://env.example',
    extensions: ['js'],
    execImpl: (cmd) => {
      if (cmd.includes('list-settings')) return pacOut('ade;js;vbs');
      throw new Error('unexpected mutation');
    },
  });
  findings.push(...blocked.blocking);

  findings.push(...validateDependencies([
    { componentId: GUID_1, componentName: 'Page', mspp_websiteid: GUID_2 },
  ]).missing);

  findings.push(classifyEntry({
    schemaName: 'contoso_secret',
    value: '@KeyVault(vaultName=v;secretName=s)',
    type: 'Secret',
  }));

  findings.push(...validateFileSizes([
    { componentId: 'big', estimatedBytes: 13 * 1024 * 1024 },
  ]).blocking);

  requestHandler = async (opts) => {
    if (opts.url.includes('sourcecontrolcomponents')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          '@odata.count': 1,
          value: [{
            sourcecontrolcomponentid: GUID_1,
            componenttypename: 'Web Page',
            componentpath: 'pages/home.yml',
            useraction: 0,
          }],
        }),
      };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  };
  findings.push(...(await validateNoAction3Conflicts({
    envUrl: 'https://env.example',
    token: 'token',
  })).blocking);

  const pendingFile = writeJson(t, 'pending.json', {
    items: [{ componentId: GUID_1, componentType: 'Entity', componentName: 'contoso_widget' }],
  });
  requestHandler = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      value: [{
        MetadataId: GUID_1,
        LogicalName: 'contoso_widget',
        IsCustomizable: { Value: false },
      }],
    }),
  });
  findings.push(...(await validateNoIscustomizableFalseRows({
    envUrl: 'https://env.example',
    token: 'token',
    pendingFile,
  })).warnings);

  requestHandler = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      '@odata.count': 1,
      value: [{
        sourcecontrolcomponentid: GUID_1,
        componentid: GUID_2,
        componenttypename: 'Web Page',
        componentpath: 'pages/home.yml',
        action: 1,
      }],
    }),
  });
  findings.push(...(await validateNoOrphanSourceControlRows({
    envUrl: 'https://env.example',
    token: 'token',
  })).blocking);

  requestHandler = async (opts) => {
    if (opts.url.includes('/solutions')) {
      return {
        statusCode: 200,
        body: JSON.stringify({ value: [{ solutionid: GUID_1, uniquename: 'Target' }, { solutionid: GUID_2, uniquename: 'Other' }] }),
      };
    }
    if (opts.url.includes(`_solutionid_value eq ${GUID_1}`)) {
      return { statusCode: 200, body: JSON.stringify({ value: [{ objectid: 'object-1', componenttype: 61 }] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [{ objectid: 'object-1', componenttype: 61 }] }) };
  };
  findings.push(...(await validateNoSharedComponents({
    envUrl: 'https://env.example',
    token: 'token',
    solutionUniqueName: 'Target',
  })).blocking);

  findings.push(...validateNotDefaultSolution({
    bindingType: 'solution',
    solutionUniqueName: 'Default',
  }).blocking);

  const prefixPendingFile = writeJson(t, 'prefix-pending.json', {
    items: [{ componentId: GUID_1, componentName: 'abc_widget', componentType: 'Entity' }],
  });
  requestHandler = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      value: [{
        solutionid: GUID_1,
        uniquename: 'Target',
        publisherid: { customizationprefix: 'contoso', uniquename: 'ContosoPublisher' },
      }],
    }),
  });
  findings.push(...(await validatePublisherPrefixConsistency({
    envUrl: 'https://env.example',
    token: 'token',
    pendingFile: prefixPendingFile,
    solutionUniqueName: 'Target',
  })).warnings);

  const lastValidationFile = writeJson(t, 'last-validation.json', { lastCommittedSolutionVersion: '1.0.0.0' });
  const versionPendingFile = writeJson(t, 'version-pending.json', { items: [{ componentId: GUID_1 }] });
  requestHandler = async () => ({
    statusCode: 200,
    body: JSON.stringify({ value: [{ solutionid: GUID_1, uniquename: 'Target', version: '1.0.0.0' }] }),
  });
  findings.push(...(await validateSolutionVersionBumped({
    envUrl: 'https://env.example',
    token: 'token',
    solutionUniqueName: 'Target',
    lastValidationFile,
    pendingFile: versionPendingFile,
    projectRoot: testDir(t),
  })).warnings);

  findings.push(...(await validateStageRunsBatch({
    hostEnvUrl: 'https://host.example',
    token: 'token',
    stageId: GUID_1,
    sourceDeploymentEnvironmentId: GUID_2,
    specs: [{ solutionUniqueName: 'Broken' }],
  })).results);

  findings.push(...validateSupportedObjectTypes([
    { componentId: 'legacy', componentType: 'workflow_xaml' },
  ]).unsupported);

  findings.push(...validateTotalPayloadSize([
    { componentId: 'large', estimatedBytes: 2 * 1024 * 1024 },
  ], { thresholdMb: 1 }).warnings);

  assert.equal(findings.length, 14);
  for (const finding of findings) assertRef(finding);
});
