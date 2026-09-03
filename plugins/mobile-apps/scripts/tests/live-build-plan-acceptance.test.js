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
  runVariant,
} = require('../run-live-build-plan-acceptance');

function read(directory, fileName) {
  return fs.readFileSync(path.join(directory, fileName), 'utf8');
}

test('acceptance matrix covers five briefs, all persistence modes, and explicit offline pairing', (context) => {
  const runnerSource = fs.readFileSync(
    path.join(__dirname, '..', 'run-live-build-plan-acceptance.js'),
    'utf8',
  );
  assert.doesNotMatch(runnerSource, /readColors\(|readTokenContract|readDesignTokenContract|preview-mode="final"/);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-hardening-acceptance-'));
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));

  const summary = runAcceptanceMatrix(output);
  assert.equal(summary.allPassed, true);
  assert.equal(summary.runCount, 7);
  assert.deepEqual(summary.domains, [
    'connectorOnlyDispatch',
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
    storyboardAuthority: 'neutral structural projection of canonical planning inputs only',
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
  const connectorOnly = summary.runs.find((run) => run.id === 'connector-only-dispatch');
  assert.equal(connectorOnly.dataverseSkipped, true);
  assert.equal(connectorOnly.dataverseTableCount, 0);
  assert.equal(connectorOnly.ownedConceptCount, 3);
  const offline = summary.runs.filter((run) => run.offline);
  assert.ok(offline.every((run) => run.offlineAdapter && run.offlineMediaBindingCount >= 0));

  assert.equal(summary.warnings.length, 1);
  assert.equal(summary.warnings[0].code, 'non-dataverse-offline-adapters-not-host-verified');
});

test('flight, gym, and ICRC structural storyboards preserve approved semantic differences', () => {
  const runs = Object.fromEntries([
    { id: 'flight', scenario: 'flightCommerce', mode: 'connector-only', offline: false },
    { id: 'gym', scenario: 'gymMaintenance', mode: 'mixed', offline: false },
    { id: 'icrc', scenario: 'icrcReceiving', mode: 'dataverse', offline: true },
  ].map((definition) => [definition.id, runVariant(definition)]));

  assert.deepEqual(runs.flight.storyboardScreenIds, ['shop', 'product', 'checkout']);
  assert.deepEqual(runs.gym.storyboardScreenIds, ['home', 'inspection', 'defect']);
  assert.deepEqual(runs.icrc.storyboardScreenIds, ['receiving', 'inspection', 'evidence']);
  assert.equal(runs.flight.navigationPattern, 'tabs-plus-stacks');
  assert.equal(runs.gym.navigationPattern, 'stack-only');
  assert.equal(runs.icrc.navigationPattern, 'stack-only');

  const directives = Object.values(runs).map(
    (run) => JSON.stringify(run.artifacts.compiled.experienceDirective),
  );
  assert.equal(new Set(directives).size, 3);
  assert.deepEqual(runs.flight.artifacts.compiled.experienceDirective, {
    tone: 'editorial',
    expressiveness: 'expressive',
    density: 'balanced',
    tempo: 'brisk',
    emphasis: 'imagery',
    mediaNecessity: 'essential',
    riskLevel: 'moderate',
    regionOrder: ['context', 'focal-content', 'primary-action'],
    accessibilityPriorities: ['large-touch-targets', 'one-handed-reach', 'high-contrast'],
    forbiddenDefaults: ['Undifferentiated card list with no visual hierarchy'],
  });
  assert.equal(runs.gym.artifacts.compiled.experienceDirective.riskLevel, 'high');
  assert.equal(runs.icrc.artifacts.compiled.experienceDirective.density, 'dense');
  assert.equal(runs.icrc.artifacts.compiled.experienceDirective.tempo, 'rapid');

  const selectedPatterns = (run) => run.artifacts.compiled.screens
    .filter((screen) => run.storyboardScreenIds.includes(screen.screenId))
    .map((screen) => screen.pattern);
  assert.deepEqual(selectedPatterns(runs.flight), ['discovery', 'detail', 'workflow-step']);
  assert.deepEqual(selectedPatterns(runs.gym), ['overview', 'workflow-step', 'capture']);
  assert.deepEqual(selectedPatterns(runs.icrc), ['queue', 'workflow-step', 'capture']);
  assert.match(runs.flight.artifacts.structuralPreviewHtml, /data-tone="editorial"/);
  assert.match(runs.flight.artifacts.structuralPreviewHtml, /data-preview-mode="structural"/);
  assert.match(runs.flight.artifacts.structuralPreviewHtml, /class="phone-nav"/);
  assert.match(runs.gym.artifacts.structuralPreviewHtml, /data-emphasis="status-signals"/);
  assert.match(runs.icrc.artifacts.structuralPreviewHtml, /data-density="dense"/);
  assert.match(runs.icrc.artifacts.structuralPreviewHtml, /--preview-pad:14px/);
  assert.match(runs.icrc.artifacts.structuralPreviewHtml, /class="stack-return"/);
  const cssValue = (html, name) => html.match(new RegExp(`--${name}:([^;]+)`))?.[1];
  const primaryColors = Object.values(runs).map(
    (run) => cssValue(run.artifacts.structuralPreviewHtml, 'primary'),
  );
  assert.deepEqual(primaryColors, ['#4d514f', '#4d514f', '#4d514f']);
  assert.ok(Object.values(runs).every((run) => run.previewMode === 'structural'));
  assert.ok(Object.values(runs).every((run) => run.designTokensReady === false));
  assert.notEqual(runs.flight.artifacts.structuralPreviewHtml, runs.gym.artifacts.structuralPreviewHtml);
  assert.notEqual(runs.gym.artifacts.structuralPreviewHtml, runs.icrc.artifacts.structuralPreviewHtml);
});

test('acceptance runner emits deterministic contract examples and three three-frame storyboards', (context) => {
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
    'commerce-structural-storyboard.html',
    'gym-structural-storyboard.html',
    'operational-structural-storyboard.html',
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

  const commerce = read(first, 'commerce-structural-storyboard.html');
  const gym = read(first, 'gym-structural-storyboard.html');
  const operational = read(first, 'operational-structural-storyboard.html');
  for (const html of [commerce, gym, operational]) {
    assert.equal((html.match(/<article class="phone/g) || []).length, 3);
    assert.match(html, /<details class="all-screens">/);
    assert.match(html, /data-contract-fingerprint="[a-f0-9]{64}"/);
    assert.match(html, /data-target-viewport="390x844"/);
    assert.match(html, /data-preview-mode="structural"/);
    assert.match(html, /Neutral structural preview/);
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