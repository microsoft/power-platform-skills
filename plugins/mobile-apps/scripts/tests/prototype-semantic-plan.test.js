'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compilePrototypePlanDraft } = require('../compile-prototype-plan-bundle');
const { deriveExperienceFromBrief, foundationContract } = require('../experience-patterns');
const { finalizePrototypePlan } = require('../finalize-prototype-plan');
const { RESPONSE_LIMIT_BYTES, validatePrototypeSemanticPlan } = require('../lib/prototype-semantic-plan');
const { prepareExecutionPreflight } = require('../prepare-mobile-plan-execution-contract');
const { preparePrototypePlannerRepair } = require('../prepare-prototype-planner-repair');
const { preparePrototypePlannerRequest } = require('../prepare-prototype-planner-request');
const { renderNativePrototypePlan } = require('../render-native-prototype-plan');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { resolveNavigationContract } = require('../resolve-navigation-contract');
const { resolveWorkflowJourney } = require('../resolve-workflow-journey');
const { parseRawSemanticPlan, stagePrototypePlannerResponse } = require('../stage-prototype-planner-response');
const { validatePlanArtifactBundle } = require('../validate-plan-artifact-bundle');
const { validatePrototypeSemanticPreservation } = require('../validate-prototype-semantic-preservation');

const pluginRoot = path.resolve(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'template', 'package.json'), 'utf8'));
const fixturesRoot = path.join(__dirname, 'fixtures', 'prototype-semantic');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesRoot, name), 'utf8'));
}

function setupProject(t, golden, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-semantic-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const mediaPolicy = golden.semanticPlan.domain.mediaPolicy.mode;
  const experience = deriveExperienceFromBrief(golden.brief, { mediaPolicy });
  const context = resolveContextEnrichment(golden.brief, experience);
  const journey = resolveWorkflowJourney(golden.brief, experience, context);
  const preflight = prepareExecutionPreflight(golden.brief, experience, packageJson);
  fs.writeFileSync(path.join(root, 'brief.md'), golden.brief);
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const [name, value] of [
    ['experience-contract.json', experience],
    ['context-enrichment-contract.json', context],
    ['workflow-journey-contract.json', journey],
    ['mobile-plan-execution-preflight.json', preflight],
  ]) fs.writeFileSync(path.join(root, '.tmp', name), `${JSON.stringify(value, null, 2)}\n`);
  const prepared = preparePrototypePlannerRequest(root);
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-planner-request.json'), prepared.content);
  if (options.stage !== false) stagePrototypePlannerResponse(root, Buffer.from(JSON.stringify(golden.semanticPlan)), 1);
  return { root, experience, context, journey, preflight, prepared };
}

function compileFinal(project, golden) {
  const compiled = compilePrototypePlanDraft(project.root, golden.semanticPlan);
  const navigation = resolveNavigationContract(
    golden.brief,
    project.experience,
    compiled.bundle.artifacts.workflowJourneyContract,
    compiled.bundle.artifacts.experienceScreenContract,
    { navigationIntent: golden.semanticPlan.navigationIntent, productStructure: golden.semanticPlan.screens.productStructure },
  );
  compiled.bundle.artifacts.navigationContract = navigation.contract;
  compiled.bundle.artifacts.experienceScreenContract = navigation.screenContract;
  const rendered = renderNativePrototypePlan(golden.semanticPlan, compiled.bundle, project.experience);
  compiled.bundle.artifacts.nativeAppPlanMarkdown = rendered.markdown;
  compiled.bundle.sections = rendered.sections;
  return compiled.bundle;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('goldens are independently schema-valid and remain below 256 KiB', () => {
  assert.equal(RESPONSE_LIMIT_BYTES, 256 * 1024);
  for (const name of ['icrc-receiving.json', 'flight-shop.json']) {
    const golden = fixture(name);
    const bytes = Buffer.byteLength(JSON.stringify(golden.semanticPlan));
    assert.ok(bytes < RESPONSE_LIMIT_BYTES, `${name}: ${bytes} >= ${RESPONSE_LIMIT_BYTES}`);
    assert.deepEqual(parseRawSemanticPlan(Buffer.from(JSON.stringify(golden.semanticPlan))), golden.semanticPlan);
  }
  assert.throws(() => parseRawSemanticPlan(Buffer.alloc(RESPONSE_LIMIT_BYTES + 1, 0x20)), /exceeds 262144 bytes/);
});

test('planner request is inline and contains no project path execution dependency', (t) => {
  const golden = fixture('icrc-receiving.json');
  const project = setupProject(t, golden, { stage: false });
  const prepared = project.prepared;
  assert.equal(prepared.content.includes(project.root), false);
  assert.equal(prepared.request.restrictions.filesystemAccess, false);
  assert.equal(prepared.request.restrictions.finalNavigationContractForbidden, true);
  assert.equal(prepared.request.restrictions.responseLimitBytes, RESPONSE_LIMIT_BYTES);
  assert.equal(prepared.request.responseSchema.properties.kind.const, 'prototype-semantic-plan');
  stagePrototypePlannerResponse(project.root, Buffer.from(JSON.stringify(golden.semanticPlan)), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project.root, '.tmp', 'prototype-semantic-plan.staged.json'), 'utf8')), golden.semanticPlan);
});

test('semantic schema rejects final artifacts, copied contracts, hashes, and Dataverse leakage', (t) => {
  const golden = fixture('icrc-receiving.json');
  const project = setupProject(t, golden);
  const invalid = clone(golden.semanticPlan);
  invalid.navigationContract = {};
  invalid.domain.entities[0].logicalName = 'cr_goodsreceipt';
  invalid.domain.experienceContractSha256 = '0'.repeat(64);
  const result = validatePrototypeSemanticPlan(invalid, {
    experienceContract: project.experience,
    contextContract: project.context,
    workflowJourney: project.journey,
    executionPreflight: project.preflight,
    foundationContract: foundationContract(project.experience),
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /navigationContract.*unknown property|final-artifact boilerplate/);
  assert.match(result.errors.join('\n'), /logicalName.*unknown property|Dataverse/);
  assert.match(result.errors.join('\n'), /experienceContractSha256.*unknown property|hashes and revisions/);
});

test('product roles and capability bindings fail closed at their owning paths', (t) => {
  const golden = fixture('icrc-receiving.json');
  const project = setupProject(t, golden);
  const invalid = clone(golden.semanticPlan);
  invalid.screens.items.find((screen) => screen.id === 'identify').productRole = 'capture-surface';
  invalid.capabilitySelections.find((capability) => capability.capabilityId === 'native-barcode-scanner').owningScreenId = 'identify';
  invalid.capabilitySelections.find((capability) => capability.capabilityId === 'native-location').operationId = 'missingOperation';
  invalid.capabilitySelections.find((capability) => capability.capabilityId === 'native-location').evidencePaths = ['/screens/items/@missing'];
  const validation = validatePrototypeSemanticPlan(invalid, {
    experienceContract: project.experience,
    contextContract: project.context,
    workflowJourney: project.journey,
    executionPreflight: project.preflight,
    foundationContract: foundationContract(project.experience),
  });
  const errors = validation.errors.join('\n');
  assert.match(errors, /screens\/items\/identify\/productRole: permanent primary/);
  assert.match(errors, /capabilitySelections\/native-barcode-scanner\/owningScreenId: supporting capability cannot own permanent Home/);
  assert.match(errors, /capabilitySelections\/native-location\/operationId: must reference a domain operation/);
  assert.match(errors, /capabilitySelections\/native-location\/evidencePaths: evidence path does not exist/);
});

test('both goldens compile to stable Markdown and validator-compatible final bundles', (t) => {
  for (const name of ['icrc-receiving.json', 'flight-shop.json']) {
    const golden = fixture(name);
    const project = setupProject(t, golden);
    const validation = validatePrototypeSemanticPlan(golden.semanticPlan, {
      experienceContract: project.experience,
      contextContract: project.context,
      workflowJourney: project.journey,
      executionPreflight: project.preflight,
      foundationContract: foundationContract(project.experience),
    });
    assert.deepEqual(validation.errors, [], name);
    const bundle = compileFinal(project, golden);
    assert.equal(bundle.artifacts.navigationContract.model, 'tabs-stack');
    assert.equal(bundle.artifacts.navigationContract.decision.selectedBy, 'navigation-resolver');
    assert.deepEqual(validatePrototypeSemanticPreservation(golden.semanticPlan, bundle, project.experience).errors, [], name);
    assert.deepEqual(validatePlanArtifactBundle(project.root, bundle).errors, [], name);
    const renderedAgain = renderNativePrototypePlan(golden.semanticPlan, bundle, project.experience);
    assert.equal(renderedAgain.markdown, bundle.artifacts.nativeAppPlanMarkdown, `${name} Markdown drift`);
    assert.deepEqual(renderedAgain.sections, bundle.sections, `${name} section drift`);
  }
});

test('screen generation order cannot change final Screen or Navigation contracts', (t) => {
  for (const name of ['icrc-receiving.json', 'flight-shop.json']) {
    const golden = fixture(name);
    const project = setupProject(t, golden);
    const baseline = compileFinal(project, golden);
    const reordered = clone(golden);
    reordered.semanticPlan.screens.items.reverse();
    const reorderedBundle = compileFinal(project, reordered);
    assert.notDeepEqual(reordered.semanticPlan.screens.items.map((screen) => screen.id), golden.semanticPlan.screens.items.map((screen) => screen.id));
    assert.deepEqual(reorderedBundle.artifacts.experienceScreenContract, baseline.artifacts.experienceScreenContract, `${name}: Screen Contract changed with generation order`);
    assert.deepEqual(reorderedBundle.artifacts.navigationContract, baseline.artifacts.navigationContract, `${name}: Navigation changed with generation order`);
  }
});

test('draft compilation rejects foreground authority drift after planner dispatch', (t) => {
  const golden = fixture('flight-shop.json');
  const project = setupProject(t, golden);
  const experiencePath = path.join(project.root, '.tmp', 'experience-contract.json');
  const changed = JSON.parse(fs.readFileSync(experiencePath, 'utf8'));
  changed.primaryJob = 'A changed job after planner dispatch.';
  fs.writeFileSync(experiencePath, `${JSON.stringify(changed, null, 2)}\n`);
  assert.throws(() => compilePrototypePlanDraft(project.root, golden.semanticPlan), /stale prototype planner request/);
});

test('finalizer follows the amended order and atomically writes the existing artifact set', (t) => {
  const golden = fixture('flight-shop.json');
  const project = setupProject(t, golden);
  const result = finalizePrototypePlan(project.root, golden.semanticPlan);
  assert.equal(result.preservation.valid, true);
  assert.equal(result.bundle.artifacts.navigationContract.model, 'tabs-stack');
  for (const relativePath of [
    'native-app-plan.md',
    '.tmp/context-enrichment-contract.json',
    '.tmp/workflow-journey-contract.json',
    '.tmp/navigation-contract.json',
    '.tmp/prototype-domain-model.json',
    '.tmp/experience-screen-contract.json',
    '.tmp/experience-foundation-contract.json',
    '.tmp/mobile-plan-execution-contract.json',
    '.tmp/prototype-semantic-map.json',
    '.tmp/prototype-semantic-preservation.json',
  ]) assert.equal(fs.existsSync(path.join(project.root, relativePath)), true, relativePath);
  assert.equal(fs.existsSync(path.join(project.root, '.tmp', 'dataverse-schema-contract.json')), false);
  assert.deepEqual(validatePlanArtifactBundle(project.root, result.bundle).errors, []);
});

test('semantic preservation reports exact paths for every protected decision class', (t) => {
  const golden = fixture('icrc-receiving.json');
  const project = setupProject(t, golden);
  const baseline = compileFinal(project, golden);
  const screen = (bundle, screenId) => bundle.artifacts.experienceScreenContract.screens.find((candidate) => candidate.id === screenId);
  const cases = [
    ['hierarchy', (bundle) => { screen(bundle, 'identify').presentation.hierarchy[0] = 'Generic dashboard'; }, '/screens/items/0/presentation/hierarchy/0'],
    ['action', (bundle) => { screen(bundle, 'record').primaryAction.label = 'Submit'; }, '/screens/items/1/primaryAction/label'],
    ['state', (bundle) => { screen(bundle, 'record').states = screen(bundle, 'record').states.filter((state) => state !== 'recovery'); }, '/screens/items/1/states'],
    ['signature', (bundle) => { screen(bundle, 'record').signatureComponent.testId = 'generic-signature'; }, '/screens/items/1/signatureComponent/testId'],
    ['media', (bundle) => { screen(bundle, 'record').media.aspectRatio = '1:1'; }, '/screens/items/1/media/aspectRatio'],
    ['parent', (bundle) => { screen(bundle, 'review').navigation.parentRoute = '/(app)/home'; }, '/screens/items/2/routeIntent/parentScreenId'],
    ['operation', (bundle) => { screen(bundle, 'record').data.operations[0].hook = 'useGeneric'; }, '/screens/items/1/data/operations/0/hook'],
    ['relationship', (bundle) => { bundle.artifacts.prototypeDomainModel.relationships[0].deleteBehavior = 'orphan'; }, '/domain/relationships/0/deleteBehavior'],
    ['fixture', (bundle) => { bundle.artifacts.prototypeDomainModel.fixtures.GoodsReceipt[0].supplierName = 'Supplier 1'; }, '/domain/fixtures/GoodsReceipt/0/supplierName'],
    ['rationale', (bundle) => { bundle.artifacts.nativeAppPlanMarkdown = bundle.artifacts.nativeAppPlanMarkdown.replace(golden.semanticPlan.designIntent.rationale, 'Generic mobile layout.'); }, '/designIntent/rationale'],
    ['visual character', (bundle) => { bundle.artifacts.nativeAppPlanMarkdown = bundle.artifacts.nativeAppPlanMarkdown.replace(golden.semanticPlan.designIntent.visualCharacter, 'generic blue app'); }, '/designIntent/visualCharacter'],
    ['navigation', (bundle) => { bundle.artifacts.navigationContract.destinations[0].label = 'Dashboard'; }, '/navigationIntent/durableDestinations/0/label'],
  ];
  for (const [label, mutate, sourcePath] of cases) {
    const changed = clone(baseline);
    mutate(changed);
    const report = validatePrototypeSemanticPreservation(golden.semanticPlan, changed, project.experience);
    assert.equal(report.valid, false, label);
    assert.ok(report.errors.some((error) => error.sourcePath === sourcePath || error.sourcePath.startsWith(sourcePath)), `${label}: ${JSON.stringify(report.errors)}`);
  }
});

test('transport allows one schema repair and stops after the second invalid response', (t) => {
  const golden = fixture('flight-shop.json');
  const project = setupProject(t, golden, { stage: false });
  const prepared = project.prepared;
  assert.throws(() => stagePrototypePlannerResponse(project.root, Buffer.from('{'), 1), /raw JSON object/);
  const firstError = JSON.parse(fs.readFileSync(path.join(project.root, '.tmp', 'planner-transport-error.json'), 'utf8'));
  assert.equal(firstError.attempt, 1);
  assert.equal(firstError.errorCategory, 'transport-framing');
  fs.writeFileSync(path.join(project.root, '.tmp', 'planner-response-1.json'), '{');
  const repair = preparePrototypePlannerRepair(project.root, '.tmp/planner-response-1.json');
  assert.deepEqual(repair.repair.originalRequest, JSON.parse(prepared.content));
  assert.equal(repair.repair.invalidResponse, '{');
  assert.deepEqual(repair.repair.validationErrors, firstError.errors);
  assert.deepEqual(repair.repair.restrictions, {
    attempt: 2,
    correctOnlyReportedErrors: true,
    rawJsonOnly: true,
    noConversationalReconstruction: true,
  });
  assert.throws(() => stagePrototypePlannerResponse(project.root, Buffer.from('{}'), 2), /schemaVersion|is required/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project.root, '.tmp', 'planner-transport-error.json'), 'utf8')).attempt, 2);
  assert.throws(() => stagePrototypePlannerResponse(project.root, Buffer.from(JSON.stringify(golden.semanticPlan)), 1), /attempt 1 is already recorded/);
});

test('one schema repair can recover to a valid staged semantic plan', (t) => {
  const golden = fixture('flight-shop.json');
  const project = setupProject(t, golden, { stage: false });
  assert.throws(() => stagePrototypePlannerResponse(project.root, Buffer.from('{}'), 1), /schemaVersion|is required/);
  fs.writeFileSync(path.join(project.root, '.tmp', 'planner-response-1.json'), '{}');
  const repair = preparePrototypePlannerRepair(project.root, '.tmp/planner-response-1.json');
  assert.equal(repair.repair.restrictions.attempt, 2);
  stagePrototypePlannerResponse(project.root, Buffer.from(JSON.stringify(golden.semanticPlan)), 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project.root, '.tmp', 'prototype-semantic-plan.staged.json'), 'utf8')), golden.semanticPlan);
  const transport = JSON.parse(fs.readFileSync(path.join(project.root, '.tmp', 'planner-transport.json'), 'utf8'));
  assert.equal(transport.plannerAttempts, 2);
  assert.equal(transport.plannerRepairAttempts, 1);
});
