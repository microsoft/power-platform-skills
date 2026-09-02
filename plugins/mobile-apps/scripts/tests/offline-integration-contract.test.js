'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  compileOfflineIntegration,
  validateOfflineInvariance,
} = require('../compile-offline-integration');
const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const { canonicalJson, sha256Hex } = require('../lib/product-experience-contracts');
const { cleanup, makeProjectDir, runCli } = require('./helpers/contract-cli');
const { clone } = require('./helpers/product-experience-fixtures');
const { bundleFor } = require('./helpers/product-experience-scenarios');

function persistence(mode, selected, source = selected ? 'explicit-request' : 'not-selected') {
  return {
    schemaVersion: 1,
    contractType: 'persistence-contract',
    persistenceRevision: 'a'.repeat(64),
    mode,
    offline: { selected, source },
    dataverseConceptIds: mode === 'dataverse' || mode === 'mixed' ? ['work-item'] : [],
    connectorConceptIds: mode === 'connector-only' || mode === 'mixed' ? ['catalog'] : [],
    localConceptIds: mode === 'local-prototype' ? ['catalog'] : [],
  };
}

function scenarioFor(persistenceContract) {
  const scenario = {
    schemaVersion: 1,
    contractType: 'scenario-facts',
    persistenceRevision: persistenceContract.persistenceRevision,
    mediaAssets: [{
      key: 'damage-photo',
      source: { kind: 'cdn', value: 'https://cdn.contoso.com/prototypes/damage-photo.jpg' },
      fallback: 'Damage evidence unavailable',
      aspectRatio: 1.5,
      fit: 'cover',
      focalPoint: 'center',
    }],
    screenBindings: [{ screenId: 'evidence', mediaAssetKeys: ['damage-photo'] }],
  };
  scenario.scenarioRevision = sha256Hex(canonicalJson(scenario));
  return scenario;
}

test('unselected offline produces no integration artifact', () => {
  assert.equal(compileOfflineIntegration(persistence('dataverse', false)), null);
});

test('CLI writes the selected offline integration contract', () => {
  const projectRoot = makeProjectDir('offline-integration-selected');
  try {
    const persistencePath = path.join(projectRoot, '.tmp', 'persistence-contract.json');
    fs.mkdirSync(path.dirname(persistencePath), { recursive: true });
    fs.writeFileSync(
      persistencePath,
      `${JSON.stringify(persistence('mixed', true), null, 2)}\n`,
    );

    const result = runCli('compile-offline-integration.js', [
      '--project-root', projectRoot,
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.selected, true);
    assert.equal(result.json.adapter, 'mixed-owner-offline-adapters');
    const output = path.join(projectRoot, '.tmp', 'offline-integration-contract.json');
    assert.equal(fs.existsSync(output), true);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).owner, 'offline-package');
  } finally {
    cleanup(projectRoot);
  }
});

test('CLI emits no artifact when offline is unselected', () => {
  const projectRoot = makeProjectDir('offline-integration-unselected');
  try {
    const persistencePath = path.join(projectRoot, '.tmp', 'persistence-contract.json');
    fs.mkdirSync(path.dirname(persistencePath), { recursive: true });
    fs.writeFileSync(
      persistencePath,
      `${JSON.stringify(persistence('connector-only', false), null, 2)}\n`,
    );

    const result = runCli('compile-offline-integration.js', [
      '--project-root', projectRoot,
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.json, { ok: true, selected: false, output: null });
    assert.equal(
      fs.existsSync(path.join(projectRoot, '.tmp', 'offline-integration-contract.json')),
      false,
    );
  } finally {
    cleanup(projectRoot);
  }
});

test('CLI removes a stale integration artifact when offline becomes unselected', () => {
  const projectRoot = makeProjectDir('offline-integration-stale');
  try {
    const persistencePath = path.join(projectRoot, '.tmp', 'persistence-contract.json');
    const output = path.join(projectRoot, '.tmp', 'offline-integration-contract.json');
    fs.mkdirSync(path.dirname(persistencePath), { recursive: true });
    fs.writeFileSync(
      persistencePath,
      `${JSON.stringify(persistence('local-prototype', false), null, 2)}\n`,
    );
    fs.writeFileSync(output, '{"stale":true}\n');

    const result = runCli('compile-offline-integration.js', [
      '--project-root', projectRoot,
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.selected, false);
    assert.equal(fs.existsSync(output), false);
  } finally {
    cleanup(projectRoot);
  }
});

test('selected offline delegates runtime UX to a mode-specific package adapter', () => {
  const cases = {
    dataverse: 'dataverse-mobile-offline-profile',
    mixed: 'mixed-owner-offline-adapters',
    'connector-only': 'connector-offline-adapter',
    'local-prototype': 'local-repository',
  };
  for (const [mode, adapter] of Object.entries(cases)) {
    const integration = compileOfflineIntegration(persistence(mode, true));
    assert.equal(integration.owner, 'offline-package');
    assert.equal(integration.adapter, adapter);
    assert.deepEqual(integration.productScopeChanges, []);
    assert.deepEqual(integration.navigationChanges, []);
    assert.deepEqual(integration.domainTableChanges, []);
    assert.deepEqual(integration.runtimeStates, [
      'connection-status',
      'queued',
      'syncing',
      'failed',
      'retry',
      'conflict',
    ]);
    assert.equal(integration.mediaCacheOwner, 'offline-package');
    assert.deepEqual(integration.mediaBindings, []);
    assert.equal(integration.scenarioRevision, null);
    assert.equal(
      integration.mobileOfflineProfileRequired,
      ['dataverse', 'mixed'].includes(mode),
    );
  }
});

test('selected offline passes canonical media keys and delivery instructions to the package', () => {
  const persistenceContract = persistence('mixed', true);
  const scenario = scenarioFor(persistenceContract);
  const integration = compileOfflineIntegration(persistenceContract, scenario);
  assert.equal(integration.scenarioRevision, scenario.scenarioRevision);
  assert.deepStrictEqual(integration.mediaBindings, [{
    screenId: 'evidence',
    assetKey: 'damage-photo',
    source: { kind: 'cdn', value: 'https://cdn.contoso.com/prototypes/damage-photo.jpg' },
    fallback: 'Damage evidence unavailable',
    aspectRatio: 1.5,
    fit: 'cover',
    focalPoint: 'center',
  }]);

  const stale = structuredClone(scenario);
  stale.persistenceRevision = 'c'.repeat(64);
  assert.throws(
    () => compileOfflineIntegration(persistenceContract, stale),
    /stale for the current persistence contract/,
  );

  const tampered = structuredClone(scenario);
  tampered.mediaAssets[0].fallback = 'Tampered after scenario approval';
  assert.throws(
    () => compileOfflineIntegration(persistenceContract, tampered),
    /scenarioRevision does not match content/,
  );
});

test('CLI includes scenario media bindings when the canonical artifact exists', () => {
  const projectRoot = makeProjectDir('offline-integration-media');
  try {
    const persistenceContract = persistence('dataverse', true);
    const directory = path.join(projectRoot, '.tmp');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'persistence-contract.json'),
      `${JSON.stringify(persistenceContract, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(directory, 'scenario-facts.json'),
      `${JSON.stringify(scenarioFor(persistenceContract), null, 2)}\n`,
    );

    const result = runCli('compile-offline-integration.js', [
      '--project-root', projectRoot,
      '--scenario', '.tmp/scenario-facts.json',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.mediaBindingCount, 1);
    const compiled = JSON.parse(fs.readFileSync(
      path.join(directory, 'offline-integration-contract.json'),
      'utf8',
    ));
    assert.equal(compiled.mediaCacheOwner, 'offline-package');
    assert.equal(compiled.mediaBindings[0].assetKey, 'damage-photo');
  } finally {
    cleanup(projectRoot);
  }
});

test('offline selection cannot change product scope, packs, or design intent', () => {
  const baseline = bundleFor('inspection');
  const candidate = clone(baseline);
  candidate.experience.operatingContext.connectivity = 'offline-first';
  candidate.persistence = persistence('dataverse', true);
  baseline.persistence = persistence('dataverse', false);

  const result = validateOfflineInvariance(baseline, candidate);
  assert.deepEqual(result.errors, []);

  candidate.scope.screens.push({ id: 'sync-queue' });
  assert.ok(validateOfflineInvariance(baseline, candidate).errors.some(
    (item) => item.code === 'offline-product-scope-drift',
  ));
});

test('screen packs reject package-owned offline runtime states for every connectivity mode', () => {
  for (const connectivity of ['always-online', 'intermittent', 'offline-first']) {
    const bundle = bundleFor('inspection');
    bundle.experience.operatingContext.connectivity = connectivity;
    bundle.buildPack.experienceRevision = require('../lib/product-experience-contracts')
      .contractRevision(bundle.experience);
    bundle.journey.experienceRevision = bundle.buildPack.experienceRevision;
    bundle.buildPack.journeyRevision = require('../lib/product-experience-contracts')
      .contractRevision(bundle.journey);
    bundle.buildPack.packs[0].states.offline = 'Planner-owned offline state';
    const result = compileScreenBuildPack(bundle.buildPack, bundle);
    assert.ok(result.errors.some((item) => item.code === 'screen-owned-offline-state'));
  }
});

test('scanning capability alone does not select offline integration', () => {
  const scanning = persistence('dataverse', false);
  scanning.nativeCapabilities = [{ id: 'barcode-scanner', approved: true }];
  assert.equal(compileOfflineIntegration(scanning), null);
});
