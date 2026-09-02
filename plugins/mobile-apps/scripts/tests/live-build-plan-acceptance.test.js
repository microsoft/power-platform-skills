'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MATRIX,
  STAGES,
  runAcceptanceMatrix,
} = require('../run-live-build-plan-acceptance');

function read(directory, fileName) {
  return fs.readFileSync(path.join(directory, fileName), 'utf8');
}

test('acceptance matrix covers four briefs, all persistence modes, and explicit offline pairing', (context) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-hardening-acceptance-'));
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));

  const summary = runAcceptanceMatrix(output);
  assert.equal(summary.allPassed, true);
  assert.equal(summary.runCount, 6);
  assert.deepEqual(summary.domains, [
    'flightCommerce',
    'gymMaintenance',
    'icrcReceiving',
    'itAssetTracking',
  ]);
  assert.deepEqual(summary.persistenceModes, [
    'connector-only',
    'dataverse',
    'local-prototype',
    'mixed',
  ]);
  assert.equal(MATRIX.filter((entry) => entry.pair === 'it-offline').length, 2);
  assert.equal(summary.offlineInvariance.passed, true);
  assert.deepEqual(summary.offlineInvariance.unchangedSurfaces, [
    'Product Experience',
    'Product Scope',
    'screen packs',
    'navigation',
    'domain tables',
  ]);
  assert.deepEqual(summary.executionBoundary, {
    metroStarted: false,
    nativeRuntimeRendered: false,
    nativeScreenshotsCaptured: false,
    storyboardAuthority: 'approved experience intent and canonical planning inputs only',
  });

  for (const run of summary.runs) {
    assert.equal(run.withinBudget, true, run.id);
    assert.equal(run.checks.canonicalContracts, true, run.id);
    assert.equal(run.checks.requirementCoverage, true, run.id);
    assert.equal(run.checks.noCrudMultiplication, true, run.id);
    assert.equal(run.checks.exactlyOnePersistenceOwner, true, run.id);
    assert.equal(run.checks.scenarioInvariants, true, run.id);
    assert.equal(run.checks.identityAndMediaBindings, true, run.id);
    assert.equal(run.checks.navigationLayout, true, run.id);
    assert.equal(run.checks.packageOwnedOffline, true, run.id);
    assert.equal(run.fixtureContradictionRejectedAs, 'scenario-invariant-failed');
    assert.match(run.scenarioRevision, /^[a-f0-9]{64}$/);
    assert.ok(run.storyboardScreenIds.length >= 1 && run.storyboardScreenIds.length <= 3);
    assert.ok(run.completeGraphScreenCount >= run.storyboardScreenIds.length);
    for (const stage of ['beforeComparableCore', ...STAGES, 'afterHardenedPipeline']) {
      assert.equal(typeof run.timings[stage], 'number');
      assert.ok(run.timings[stage] >= 0);
    }
  }

  for (const run of summary.runs.filter((entry) => (
    ['connector-only', 'local-prototype'].includes(entry.mode)
  ))) {
    assert.equal(run.dataverseSkipped, true);
    assert.equal(run.dataverseTableCount, 0);
    assert.deepEqual(run.dataverseLifecycle, {
      planning: false,
      approval: false,
      schemaGeneration: false,
      serviceGeneration: false,
      seeding: false,
      execution: false,
      forbiddenArtifactCheck: true,
    });
  }
  const mixed = summary.runs.find((run) => run.mode === 'mixed');
  assert.ok(mixed.dataverseTableCount > 0);
  const offline = summary.runs.filter((run) => run.offline);
  assert.ok(offline.every((run) => run.offlineAdapter && run.offlineMediaBindingCount >= 0));

  assert.equal(summary.warnings.length, 1);
  assert.equal(summary.warnings[0].code, 'non-dataverse-offline-adapters-not-host-verified');
});

test('acceptance runner emits deterministic contract examples and two three-frame storyboards', (context) => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-hardening-output-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-hardening-output-b-'));
  context.after(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });

  runAcceptanceMatrix(first);
  runAcceptanceMatrix(second);
  for (const fileName of [
    'persistence-contract-examples.json',
    'navigation-manifest-example.json',
    'data-model-usage-example.json',
    'route-layout-evidence.json',
    'offline-invariance.json',
    'commerce-storyboard.html',
    'operational-storyboard.html',
  ]) {
    assert.equal(read(first, fileName), read(second, fileName), fileName);
  }

  const persistence = JSON.parse(read(first, 'persistence-contract-examples.json'));
  assert.deepEqual(Object.keys(persistence).sort(), [
    'connector-only',
    'dataverse',
    'local-prototype',
    'mixed',
  ]);
  const navigation = JSON.parse(read(first, 'navigation-manifest-example.json'));
  assert.match(navigation.manifestRevision, /^[a-f0-9]{64}$/);
  const usage = JSON.parse(read(first, 'data-model-usage-example.json'));
  assert.match(usage.usageRevision, /^[a-f0-9]{64}$/);

  const commerce = read(first, 'commerce-storyboard.html');
  const operational = read(first, 'operational-storyboard.html');
  for (const html of [commerce, operational]) {
    assert.equal((html.match(/<article class="phone/g) || []).length, 3);
    assert.match(html, /<details class="all-screens">/);
    assert.match(html, /data-contract-fingerprint="[a-f0-9]{64}"/);
    assert.match(html, /data-target-viewport="390x844"/);
    assert.doesNotMatch(html, /React Native (?:was|has been) rendered|pixel-verified/);
  }
  assert.match(commerce, /https:\/\/cdn\.contoso\.com\/mobile-acceptance\//);

  const timingEvidence = JSON.parse(read(first, 'timings.json'));
  assert.match(timingEvidence.measurement, /local Node\.js contract/);
  assert.match(timingEvidence.comparison.interpretation, /not model-time/);
  assert.deepEqual(timingEvidence.stages, [
    'beforeComparableCore',
    ...STAGES,
    'afterHardenedPipeline',
  ]);
});