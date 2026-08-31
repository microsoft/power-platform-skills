'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const { DEFAULT_OUTPUT } = require('../compile-sample-data-obligations');
const { contractRevision } = require('../lib/product-experience-contracts');
const { compileSampleDataObligations } = require('../lib/sample-data-obligations');
const {
  ACCEPTANCE_SCENARIOS,
  acceptanceBundle,
} = require('./helpers/product-experience-acceptance-scenarios');
const { cleanup, makeProjectDir, runCli, writeContracts } = require('./helpers/contract-cli');

function obligationsFor(key) {
  const bundle = acceptanceBundle(key);
  const buildResult = compileScreenBuildPack(bundle.buildPack, bundle);
  assert.deepStrictEqual(buildResult.errors, []);
  return {
    bundle,
    compiled: buildResult.compiled,
    obligations: compileSampleDataObligations({ ...bundle, compiled: buildResult.compiled }),
  };
}

test('all four briefs compile to deterministic, revision-bound sample-data obligations', () => {
  for (const key of Object.keys(ACCEPTANCE_SCENARIOS)) {
    const { bundle, compiled, obligations } = obligationsFor(key);
    const again = obligationsFor(key).obligations;
    assert.strictEqual(obligations.obligationsRevision, again.obligationsRevision, key);
    assert.strictEqual(obligations.experienceRevision, contractRevision(bundle.experience));
    assert.strictEqual(obligations.scopeRevision, contractRevision(bundle.scope));
    assert.strictEqual(obligations.journeyRevision, contractRevision(bundle.journey));
    assert.strictEqual(obligations.compiledRevision, compiled.compiledRevision);
    assert.strictEqual(obligations.requirements.length, bundle.scope.requirements.length);
    assert.strictEqual(obligations.screens.length, bundle.scope.screens.length);
    assert.ok(obligations.screens.every((screen) => screen.previewContent.records.length >= 3));
    assert.ok(obligations.screens.some((screen) => (
      screen.previewContent.records.some((record) => bundle.descriptor.fixtureValues.includes(record.title))
    )));
  }
});

test('sample-data obligations preserve actions, states, operations, and realistic preview values', () => {
  const { obligations } = obligationsFor('itAssetTracking');
  const inventory = obligations.screens.find((screen) => screen.screenId === 'inventory');
  const asset = obligations.screens.find((screen) => screen.screenId === 'asset');
  assert.ok(inventory.actions.some((action) => action.label === 'Find asset'));
  assert.ok(inventory.requirementCoverage.some((row) => row.requirementId === 'no-results-feedback'));
  assert.ok(Object.hasOwn(inventory.states, 'noResults'));
  assert.ok(Object.hasOwn(asset.states, 'permission'));
  assert.ok(asset.dataOperations.some((entry) => entry.operation.kind === 'update'));
  assert.ok(inventory.previewContent.records.some((record) => record.title === 'Laptop LT-2048 - assigned to Morgan Lee'));
});

test('offline obligations appear only for evidence-backed offline products', () => {
  for (const key of ['icrcReceiving', 'gymMaintenance']) {
    const { obligations } = obligationsFor(key);
    assert.ok(obligations.screens.every((screen) => Object.hasOwn(screen.states, 'offline')), key);
  }
  for (const key of ['flightCommerce', 'itAssetTracking']) {
    const { obligations } = obligationsFor(key);
    assert.ok(obligations.screens.every((screen) => !Object.hasOwn(screen.states, 'offline')), key);
  }
});

test('tampered compiled input is rejected before obligations are produced', () => {
  const { bundle, compiled } = obligationsFor('gymMaintenance');
  const tampered = structuredClone(compiled);
  tampered.screens[0].pack.previewContent.headline = 'Tampered after compilation';
  assert.throws(
    () => compileSampleDataObligations({ ...bundle, compiled: tampered }),
    /compiledRevision does not match/,
  );
});

test('CLI writes and checks the canonical sample-data obligation artifact', () => {
  const projectRoot = makeProjectDir('sample-obligations');
  try {
    writeContracts(projectRoot, acceptanceBundle('icrcReceiving'));
    const created = runCli('compile-sample-data-obligations.js', ['--project-root', projectRoot]);
    const output = path.join(projectRoot, DEFAULT_OUTPUT);
    assert.strictEqual(created.code, 0);
    assert.strictEqual(created.json.outputPath, output);
    assert.ok(fs.existsSync(output));
    assert.match(JSON.parse(fs.readFileSync(output, 'utf8')).obligationsRevision, /^[a-f0-9]{64}$/);

    const checked = runCli('compile-sample-data-obligations.js', ['--project-root', projectRoot, '--check']);
    assert.strictEqual(checked.code, 0);

    const stale = JSON.parse(fs.readFileSync(output, 'utf8'));
    stale.connectivity = 'always-online';
    fs.writeFileSync(output, JSON.stringify(stale));
    const rejected = runCli('compile-sample-data-obligations.js', ['--project-root', projectRoot, '--check']);
    assert.strictEqual(rejected.code, 1);
    assert.ok(rejected.json.errors.some((error) => error.code === 'stale-sample-data-obligations'));
  } finally {
    cleanup(projectRoot);
  }
});