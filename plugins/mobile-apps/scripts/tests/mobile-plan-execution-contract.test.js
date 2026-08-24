'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  packageCatalogRevision,
  sha256,
  validateMobilePlanExecutionContract,
} = require('../lib/mobile-plan-execution-contract');
const { prepareExecutionPreflight } = require('../prepare-mobile-plan-execution-contract');

const brief = [
  '- Browse a cached product catalog while offline.',
  '- Add products to a cart.',
  '- Scan a receipt with the camera.',
].join('\n');

const packageJson = {
  dependencies: { 'expo-camera': '16.1.11', 'date-fns': '4.1.0' },
  devDependencies: {},
};

const screenContract = {
  screens: [{
    id: 'Home',
    route: '/(app)/home',
    data: { operations: [{ id: 'list-products' }] },
  }],
};

function validContract() {
  const sources = brief.split('\n').map((line) => line.slice(2));
  return {
    schemaVersion: 1,
    experienceContractSha256: 'a'.repeat(64),
    briefSha256: sha256(brief),
    requirements: [
      { id: 'req-offline-catalog', source: sources[0], priority: 'required', kind: 'constraint', satisfiedBy: ['asset-policy', 'operation:list-products'], status: 'planned' },
      { id: 'req-cart', source: sources[1], priority: 'required', kind: 'job', satisfiedBy: ['screen:Home'], status: 'planned' },
      { id: 'req-camera', source: sources[2], priority: 'required', kind: 'native', satisfiedBy: ['native-camera'], status: 'planned' },
    ],
    nativeCapabilities: [{
      id: 'native-camera',
      capability: 'camera',
      requiredBy: ['req-camera'],
      platforms: ['ios', 'android'],
      support: { status: 'supported', templatePackage: 'expo-camera', templateVersion: '16.1.11', catalogRevision: packageCatalogRevision(packageJson) },
      execution: 'add-native',
    }],
    javascriptDependencies: [{
      package: 'date-fns', version: '4.1.0', requiredBy: ['screen:Home'], classification: 'pure-js', resolution: 'installed',
    }],
    connectorOperations: [],
  };
}

function validate(contract) {
  return validateMobilePlanExecutionContract(contract, {
    briefText: brief,
    experienceContractSha256: 'a'.repeat(64),
    screenContract,
    dataContract: { tables: [{ logicalName: 'cr_product' }] },
    packageJson,
  });
}

test('accepts complete requirement, native, and dependency execution facts', () => {
  assert.deepEqual(validate(validContract()), { valid: true, errors: [] });
});

test('rejects a dropped confirmed brief requirement', () => {
  const contract = validContract();
  contract.requirements.splice(1, 1);
  assert.match(validate(contract).errors.join('\n'), /dropped confirmed brief requirement: Add products to a cart/);
});

test('rejects unsupported or stale native capability facts before approval', () => {
  const unsupported = validContract();
  unsupported.nativeCapabilities[0].support.status = 'unsupported';
  assert.match(validate(unsupported).errors.join('\n'), /not supported/);

  const stale = validContract();
  stale.nativeCapabilities[0].support.catalogRevision = 'b'.repeat(64);
  assert.match(validate(stale).errors.join('\n'), /catalogRevision is stale/);
});

test('rejects non-exact dependencies and dangling coverage targets', () => {
  const contract = validContract();
  contract.javascriptDependencies[0].version = '^4.1.0';
  contract.requirements[0].satisfiedBy.push('operation:missing');
  const errors = validate(contract).errors.join('\n');
  assert.match(errors, /version must be exact semver/);
  assert.match(errors, /unknown target operation:missing/);
});

test('requires connector operation failure behavior and valid consumers', () => {
  const contract = validContract();
  contract.connectorOperations.push({
    id: 'connector-weather-current',
    connector: 'Weather',
    apiName: 'weather',
    service: 'WeatherService',
    operation: 'GetCurrentWeather',
    requiredBy: ['screen:Missing'],
    input: { location: 'record.location' },
    output: {},
    failure: { state: 'offline', userAction: '' },
    prototype: { behavior: 'typed-throw-stub' },
  });
  const errors = validate(contract).errors.join('\n');
  assert.match(errors, /requiredBy references unknown target screen:Missing/);
  assert.match(errors, /output must be a non-empty object/);
  assert.match(errors, /failure is incomplete/);
});

test('final contract cannot drop a dense critical constraint extracted by preflight', () => {
  const denseBrief = 'Keep an offline catalog with CDN caching, a cart, and accessibility.';
  const preflight = prepareExecutionPreflight(denseBrief, { schemaVersion: 1 }, packageJson);
  const requirements = preflight.requirements.map((requirement) => ({
    id: requirement.id,
    source: requirement.source,
    priority: requirement.priority,
    kind: requirement.kind,
    satisfiedBy: ['screen:Home'],
    status: 'planned',
  }));
  requirements.splice(requirements.findIndex((item) => /accessibility/i.test(item.source)), 1);
  const result = validateMobilePlanExecutionContract({
    schemaVersion: 1,
    experienceContractSha256: preflight.experienceContractSha256,
    briefSha256: preflight.briefSha256,
    requirements,
    nativeCapabilities: [],
    javascriptDependencies: [],
    connectorOperations: [],
  }, {
    briefText: denseBrief,
    experienceContractSha256: preflight.experienceContractSha256,
    preflight,
    screenContract,
    dataContract: { tables: [] },
    packageJson,
  });
  assert.match(result.errors.join('\n'), /did not preserve preflight requirement|dropped confirmed brief requirement/);
});

test('connector metadata is immutable while screen consumers may be added', () => {
  const connectorBrief = '- Send an Outlook email.';
  const metadata = { operations: [{
    id: 'connector-outlook-send-email', connector: 'Office 365 Outlook', apiName: 'office365', service: 'Office365OutlookService', operation: 'SendEmail',
    input: { to: 'record.email' }, output: { type: 'SendResult' }, failure: { state: 'offline', userAction: 'Retry' },
  }] };
  const preflight = prepareExecutionPreflight(connectorBrief, { schemaVersion: 1 }, packageJson, metadata);
  const connector = { ...preflight.connectorOperations[0], requiredBy: [...preflight.connectorOperations[0].requiredBy, 'screen:Home'] };
  const requirement = preflight.requirements[0];
  const contract = {
    schemaVersion: 1,
    experienceContractSha256: preflight.experienceContractSha256,
    briefSha256: preflight.briefSha256,
    requirements: [{
      id: requirement.id,
      source: requirement.source,
      priority: requirement.priority,
      kind: requirement.kind,
      satisfiedBy: [`connector:${connector.id}`],
      status: 'planned',
    }],
    nativeCapabilities: [], javascriptDependencies: [], connectorOperations: [connector],
  };
  const context = { briefText: connectorBrief, experienceContractSha256: preflight.experienceContractSha256, preflight, screenContract, dataContract: { tables: [] }, packageJson };
  assert.deepEqual(validateMobilePlanExecutionContract(contract, context), { valid: true, errors: [] });

  contract.connectorOperations[0].operation = 'InventedMethod';
  assert.match(validateMobilePlanExecutionContract(contract, context).errors.join('\n'), /did not preserve connector preflight fact/);
});