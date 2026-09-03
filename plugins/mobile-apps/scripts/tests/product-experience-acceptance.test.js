'use strict';

const assert = require('node:assert');
const test = require('node:test');

const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const { SCREEN_BUDGETS } = require('../lib/product-experience-contracts');
const { validateExperienceContract } = require('../validate-product-experience');
const { validateScopeContract } = require('../validate-product-scope');
const { validateJourneyContract } = require('../validate-workflow-journey');
const {
  ACCEPTANCE_SCENARIOS,
  acceptanceBundle,
} = require('./helpers/product-experience-acceptance-scenarios');

const SCENARIO_KEYS = Object.keys(ACCEPTANCE_SCENARIOS);

function validateBundle(key) {
  const bundle = acceptanceBundle(key);
  const experienceResult = validateExperienceContract(bundle.experience);
  const scopeResult = validateScopeContract(bundle.scope, bundle.experience);
  const journeyResult = validateJourneyContract(bundle.journey, bundle);
  const compileResult = compileScreenBuildPack(bundle.buildPack, bundle);
  return { bundle, experienceResult, scopeResult, journeyResult, compileResult };
}

function screenIds(bundle) {
  return bundle.scope.screens.map((screen) => screen.id);
}

function pack(bundle, screenId) {
  return bundle.buildPack.packs.find((item) => item.screenId === screenId);
}

test('five concrete briefs pass the canonical contract pipeline without a universal screen count', () => {
  const counts = [];
  for (const key of SCENARIO_KEYS) {
    const {
      bundle,
      experienceResult,
      scopeResult,
      journeyResult,
      compileResult,
    } = validateBundle(key);
    assert.deepStrictEqual(experienceResult.errors, [], `${key} Product Experience`);
    assert.deepStrictEqual(scopeResult.errors, [], `${key} Product Scope`);
    assert.deepStrictEqual(journeyResult.errors, [], `${key} Workflow Journey`);
    assert.deepStrictEqual(compileResult.errors, [], `${key} screen build packs`);

    const shippingRequirements = bundle.scope.requirements
      .filter((requirement) => requirement.disposition === 'shipping');
    assert.strictEqual(scopeResult.summary.shippingRequirementCount, shippingRequirements.length);
    assert.ok(shippingRequirements.every((requirement) => (
      bundle.descriptor.brief.includes(requirement.evidence)
    )), `${key} has requirement evidence not copied from its brief`);
    assert.ok(shippingRequirements.every((requirement) => (
      bundle.scope.requirementCoverage.some((row) => row.requirementId === requirement.id)
    )), `${key} has an uncovered locked requirement`);

    const ceiling = SCREEN_BUDGETS[bundle.scope.productComplexity].max;
    assert.ok(bundle.scope.screens.length <= ceiling, `${key} exceeds its review ceiling`);
    assert.ok(bundle.scope.screens.length < 16, `${key} inflated to a 16-screen template`);
    assert.strictEqual(scopeResult.summary.entitiesWithFullCrudTriplet, 0);
    assert.ok(bundle.scope.navigation.visibleTabIds.length <= 5);
    assert.deepStrictEqual(
      [...bundle.scope.navigation.durableDestinationIds].sort(),
      bundle.scope.screens
        .filter((screen) => screen.classification === 'durable-destination')
        .map((screen) => screen.id)
        .sort(),
    );

    for (const screen of bundle.scope.screens) {
      const screenPack = pack(bundle, screen.id);
      assert.ok(screen.jobIds.length > 0, `${key}/${screen.id} has no job`);
      assert.ok(screen.justification, `${key}/${screen.id} has no justification`);
      assert.ok(screen.classification, `${key}/${screen.id} has no classification`);
      assert.ok(screenPack.firstViewport.focalContent, `${key}/${screen.id} has no focal point`);
      assert.ok(screenPack.primaryActions.length, `${key}/${screen.id} has no primary action`);
      assert.ok(screenPack.signatureInteraction.name, `${key}/${screen.id} has no signature interaction`);
      assert.ok(screenPack.previewContent.records.length >= 3, `${key}/${screen.id} has thin fixtures`);
      assert.ok(screenPack.previewContent.records.some((record) => (
        bundle.descriptor.fixtureValues.includes(record.title)
      )), `${key}/${screen.id} preview is not contract-led`);
    }

    counts.push(bundle.scope.screens.length);
    assert.strictEqual(
      compileScreenBuildPack(bundle.buildPack, bundle).compiled.compiledRevision,
      compileResult.compiled.compiledRevision,
      `${key} compilation is not deterministic`,
    );
  }
  assert.ok(new Set(counts).size > 1, 'benchmarks collapsed to one fixed screen count');
});

test('flight commerce keeps checkout bounded and Profile reachable outside its tabs', () => {
  const { bundle } = validateBundle('flightCommerce');
  const required = ['search-catalog', 'select-product', 'purchase-order', 'manage-booking', 'open-profile'];
  assert.ok(required.every((id) => bundle.scope.requirements.some((item) => item.id === id)));
  assert.strictEqual(bundle.scope.navigation.pattern, 'tabs-plus-stacks');
  assert.deepStrictEqual(bundle.scope.navigation.visibleTabIds, ['shop', 'trip', 'orders']);
  assert.strictEqual(bundle.scope.navigation.profileAccess, 'account-action');
  assert.ok(!bundle.scope.navigation.visibleTabIds.includes('profile'));
  assert.strictEqual(bundle.scope.screens.find((screen) => screen.id === 'checkout').classification, 'bounded-flow-step');
  assert.ok(bundle.scope.screens.some((screen) => screen.id === 'product' && screen.parentScreenId === 'shop'));
  assert.strictEqual(pack(bundle, 'product').primaryActions[0].label, 'Add to bag');
  assert.doesNotMatch(JSON.stringify(bundle), /warehouse|pallet/i);
  assert.strictEqual(bundle.scope.newTables.length, 0);
  assert.ok(bundle.scope.dataEntities.filter((entity) => entity.name !== 'Cart')
    .every((entity) => entity.realization === 'connector-source'));
  assert.strictEqual(
    bundle.scope.dataEntities.find((entity) => entity.name === 'Cart').realization,
    'transient-ui-state',
  );
  assert.ok(bundle.buildPack.packs.every((item) => !Object.hasOwn(item.states, 'offline')));
});

test('offline prompt text does not create offline requirements or product UX', () => {
  const { bundle } = validateBundle('icrcReceiving');
  const required = [
    'view-expected-shipments',
    'receive-items',
    'record-quantities',
    'inspect-packages',
    'record-batch-expiry',
    'resolve-discrepancy',
    'attach-evidence',
    'capture-location',
    'handoff-custody',
  ];
  assert.match(bundle.descriptor.brief, /offline[\s\S]*limited connectivity/i);
  assert.ok(required.every((id) => bundle.scope.requirements.some((item) => item.id === id)));
  assert.doesNotMatch(
    JSON.stringify({
      scope: bundle.scope,
      journey: bundle.journey,
      buildPack: bundle.buildPack,
    }),
    /offline|sync/i,
  );
  assert.ok(!screenIds(bundle).some((id) => /scan|barcode|role|offline|retry/.test(id)));
  assert.strictEqual(pack(bundle, 'receiving').primaryActions[0].label, 'Scan or enter shipment');
  assert.ok(bundle.buildPack.packs.every((item) => !Object.hasOwn(item.states, 'offline')));
  assert.strictEqual(bundle.scope.navigation.pattern, 'stack-only');
  assert.ok(bundle.scope.screens.length <= SCREEN_BUDGETS.complex.max);
  assert.strictEqual(
    bundle.scope.screens.find((screen) => screen.id === 'evidence').cannotMergeBecause.kind,
    'capture-or-workflow-fit',
  );
  assert.deepStrictEqual(bundle.experience.primaryUser.secondaryUsers, [
    'Warehouse officer',
    'Quality inspector',
    'Headquarters planner',
  ]);
});

test('gym maintenance embeds scanning without inventing offline screens or states', () => {
  const { bundle } = validateBundle('gymMaintenance');
  const required = ['scan-equipment', 'inspect-equipment', 'record-defect', 'attach-evidence', 'record-repair', 'review-maintenance-warranty', 'close-work'];
  assert.ok(required.every((id) => bundle.scope.requirements.some((item) => item.id === id)));
  assert.ok(!screenIds(bundle).some((id) => /scanner|dashboard/.test(id)));
  assert.strictEqual(bundle.scope.screens.find((screen) => screen.id === 'home').title, 'My shift');
  assert.strictEqual(pack(bundle, 'home').primaryActions[0].label, 'Scan equipment');
  assert.strictEqual(bundle.scope.screens.find((screen) => screen.id === 'equipment').parameterizedBy, 'equipmentType');
  assert.strictEqual(bundle.scope.navigation.profileScreenId, 'profile');
  assert.strictEqual(bundle.scope.navigation.profileAccess, 'account-action');
  assert.ok(bundle.buildPack.packs.every((item) => !Object.hasOwn(item.states, 'offline')));
  assert.ok(bundle.scope.dataEntities.some((entity) => (
    entity.name === 'Warranty' && entity.realization === 'connector-source'
  )));
});

test('IT asset tracking parameterizes record families and keeps permission/no-results as states', () => {
  const { bundle, scopeResult } = validateBundle('itAssetTracking');
  const required = ['find-assets', 'scan-barcode', 'print-barcode', 'assign-asset', 'transfer-asset', 'audit-condition', 'record-repair', 'retire-device'];
  assert.ok(required.every((id) => bundle.scope.requirements.some((item) => item.id === id)));
  assert.deepStrictEqual(bundle.scope.navigation.durableDestinationIds, ['inventory', 'work-queue', 'account']);
  assert.strictEqual(scopeResult.summary.parameterizedScreenCount, 3);
  assert.strictEqual(bundle.scope.screens.find((screen) => screen.id === 'inventory').parameterizedBy, 'assetCategory');
  assert.strictEqual(bundle.scope.screens.find((screen) => screen.id === 'asset').parameterizedBy, 'assetCategory');
  assert.ok(Object.hasOwn(pack(bundle, 'inventory').states, 'noResults'));
  assert.ok(Object.hasOwn(pack(bundle, 'asset').states, 'permission'));
  assert.ok(!screenIds(bundle).some((id) => /permission|no-results|offline/.test(id)));
  assert.ok(bundle.buildPack.packs.every((item) => !Object.hasOwn(item.states, 'offline')));
  assert.strictEqual(
    bundle.scope.dataEntities.find((entity) => entity.name === 'Barcode label').realization,
    'transient-ui-state',
  );
  assert.strictEqual(bundle.scope.coreJobs[0].surface.screenId, 'inventory');
});

test('connector-only dispatch keeps every persisted concept in the approved connector', () => {
  const { bundle, scopeResult } = validateBundle('connectorOnlyDispatch');
  assert.deepStrictEqual(bundle.scope.navigation.durableDestinationIds, ['assignments']);
  assert.strictEqual(bundle.scope.navigation.profileAccess, 'account-action');
  assert.strictEqual(bundle.scope.newTables.length, 0);
  assert.ok(bundle.scope.dataEntities.every(
    (entity) => entity.realization === 'connector-source',
  ));
  assert.ok(bundle.journey.journeys.flatMap((journey) => journey.steps).every(
    (step) => ['read', 'external-call'].includes(step.dataOperation.kind),
  ));
  assert.strictEqual(scopeResult.summary.entitiesWithFullCrudTriplet, 0);
  assert.ok(!screenIds(bundle).some((id) => /create|edit|offline|dataverse/.test(id)));
});

test('requirement coverage target drift is rejected by build-pack compilation', () => {
  const bundle = acceptanceBundle('itAssetTracking');
  bundle.scope.requirementCoverage.find((row) => row.requirementId === 'assign-asset').target = 'Unplanned action';
  const result = compileScreenBuildPack(bundle.buildPack, bundle);
  assert.ok(result.errors.some((error) => error.code === 'requirement-action-missing'));
});