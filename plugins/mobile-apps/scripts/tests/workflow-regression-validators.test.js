'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { uiContractFingerprint } = require('../compile-screen-build-pack');
const {
  validateActionState,
  validateCapabilityComposition,
  validateCrossScreenContinuity,
  validatePrimaryExperience,
  validateRuntimeStateCoverage,
  validateSemanticColorUsage,
  validateSignatureComponents,
  validateStaticLayoutBudgets,
  validateUiNeutralDataMigration,
} = require('../lib/workflow-regression');

const SEMANTIC_ROLES = [
  ['brand-accent', 'limited-brand-emphasis', '$accentDeep'],
  ['primary-action', 'single-state-primary-action', '$accentBase'],
  ['selection', 'selected-navigation-or-option', '$accentSoft'],
  ['warning', 'blocked-progress-or-risk', '$statusPending'],
  ['error', 'invalid-or-failed-state', '$statusOverdue'],
  ['destructive', 'destructive-action-only', '$statusOverdue'],
].map(([role, intent, token]) => ({ role, intent, token }));

function continuityBindings() {
  return ['primaryRecordId', 'displayReference', 'offlineState', 'currentStageId', 'completedStageCount', 'requiredStageCount', 'draftState']
    .map((key) => ({ key, source: 'workflow-state' }));
}

function screen({ id, role, stageId = null, order = null, primaryActionId, signatures = [], capabilityComposition = [] }) {
  const regionIds = [`${id.toLowerCase()}-context`, `${id.toLowerCase()}-content`];
  return {
    id,
    route: `/(app)/${id.toLowerCase()}`,
    file: `app/(app)/${id.toLowerCase()}.tsx`,
    role,
    routeParameters: [],
    navigation: role === 'primary' ? { kind: 'stack-root', intent: 'replace' } : { kind: 'pushed', intent: 'push', parentRoute: '/(app)/home' },
    headerMode: role === 'primary' ? 'root' : 'back',
    purpose: role === 'primary' ? 'Resume or start the current work.' : `Complete ${id.toLowerCase()} without skipping required work.`,
    presentation: { pattern: 'workflow', density: 'balanced', hierarchy: ['Context', 'Progress', 'Action'] },
    regions: regionIds.map((regionId, index) => ({ id: regionId, kind: index ? 'content' : 'context', priority: index + 1, viewport: 'first', mediaRequired: false })),
    firstViewport: { regionIds, focalPoint: 'The current required work and next safe action', maxRegions: 3, nextContentVisible: true, maxFeatureViewportShare: 0.4, visiblePrimaryAction: true, primaryActionPlacement: 'sticky-bottom' },
    context: { placementIntent: 'primary-screen-context-rail', entries: [], assumptions: [], forbiddenInferences: [] },
    signatureComponent: { kind: 'next-action-workflow', required: true, testId: 'experience-signature-workflow' },
    primaryAction: { id: primaryActionId, label: primaryActionId.replace(/-/g, ' '), placement: 'sticky-bottom', destination: '/(app)/work', clearance: { safeArea: true, tabBar: 'not-applicable' } },
    media: { required: false, role: 'supporting', aspectRatio: '4:3', minCoverage: 0, fallback: 'text-only', prominence: 'none', source: 'user-content', delivery: 'bundled', sizing: 'not-applicable', maxViewportShare: 0 },
    states: ['loading', 'empty', 'error', 'offline'],
    qualityCriteria: ['One focal point.', 'One primary action.', 'Progress remains visible.'],
    dependencies: { foundation: [], fixtures: [], screens: [], artifacts: [] },
    testIds: ['experience-signature-workflow', ...signatures.map((item) => item.testId)],
    forbiddenDefaults: [],
    data: { operations: [], routeBindings: [] },
    journey: { journeyId: 'primary-job', journeyKind: 'linear-resumable', stageId, stageOrder: order, visibleStages: [{ id: 'work', label: 'Work', order: 1 }, { id: 'review', label: 'Review', order: 2 }], completionRuleIds: stageId ? [`stage-${stageId}-complete`] : [], resumeBehavior: 'restore-current-stage-and-draft', continuityBindings: continuityBindings() },
    actionState: { primaryActionId, stateActions: [], guardedActions: [] },
    signatureComponents: signatures,
    semanticColorRoles: structuredClone(SEMANTIC_ROLES),
    capabilityComposition,
    layoutBudgets: { maxFocalViewportShare: 0.4, requiredFirstViewportRegions: regionIds, requireJourneyContext: Boolean(stageId), maxReservedFooterShare: 0.2, stickySurfaceOrder: ['content', 'primary-action', 'safe-area'] },
  };
}

function basePack() {
  const stepper = { kind: 'workflow-stepper', placement: 'task-screen-header', requiredOnStageScreens: true, requiredWhen: null, testId: 'journey-primary-stepper', semanticRole: 'progress' };
  const resume = { kind: 'resume-draft-module', placement: 'primary-screen', requiredOnStageScreens: false, requiredWhen: 'resume.supported && draftState != empty', testId: 'journey-resume-draft', semanticRole: 'resume' };
  const work = screen({ id: 'Work', role: 'key-flow', stageId: 'work', order: 1, primaryActionId: 'continue-work', signatures: [stepper] });
  const review = screen({ id: 'Review', role: 'supporting', stageId: 'review', order: 2, primaryActionId: 'complete-review', signatures: [stepper] });
  const home = screen({
    id: 'Home', role: 'primary', primaryActionId: 'open-work', signatures: [resume],
    capabilityComposition: [{ capability: 'barcode-scanner', mode: 'on-demand', fallbackStates: ['loading', 'permission-denied', 'unavailable', 'offline', 'manual-entry'], maxViewportShare: 0.24 }],
  });
  work.actionState.stateActions = [
    { screenId: 'Work', state: 'incomplete', primaryAction: 'continue-work', guardId: null, enabledActions: ['continue-work'], disabledActions: ['advance-work', 'complete-review', 'finish-review'], hiddenActions: [] },
    { screenId: 'Work', state: 'complete', primaryAction: 'advance-work', guardId: 'stage-work-complete', enabledActions: ['advance-work'], disabledActions: [], hiddenActions: [] },
  ];
  work.actionState.guardedActions = [{ actionId: 'advance-work', guardId: 'stage-work-complete', falseBehavior: 'disabled-with-reason', blockingMessage: 'Complete work before continuing.' }];
  review.actionState.stateActions = [
    { screenId: 'Review', state: 'incomplete', primaryAction: 'complete-review', guardId: null, enabledActions: ['complete-review'], disabledActions: ['finish-review'], hiddenActions: [] },
    { screenId: 'Review', state: 'complete', primaryAction: 'finish-review', guardId: 'all-required-stages-complete', enabledActions: ['finish-review'], disabledActions: [], hiddenActions: [] },
  ];
  review.actionState.guardedActions = [{ actionId: 'finish-review', guardId: 'all-required-stages-complete', falseBehavior: 'disabled-with-reason', blockingMessage: 'Complete all required work.' }];
  home.actionState.stateActions = [];
  const pack = {
    schemaVersion: 2,
    screenContractVersion: 3,
    sources: { domainModel: 'a'.repeat(64), domainLayer: 'b'.repeat(64), executionContract: 'c'.repeat(64), experienceContract: 'd'.repeat(64) },
    journey: {
      journeyId: 'primary-job', journeyKind: 'linear-resumable', primaryOutcome: 'Complete and review the current assigned work', entryPoints: ['home', 'saved-draft'],
      resume: { supported: true, restoreLastCompletedStage: true, restoreDraftData: true, visibleOnPrimaryScreen: true },
      declaredStateFields: ['primaryRecordId', 'displayReference', 'offlineState', 'currentStageId', 'completedStageCount', 'requiredStageCount', 'draftState', 'stage.work.complete', 'stage.review.complete'],
      stages: [
        { id: 'work', label: 'Work', order: 1, screenIds: ['Work'], completionRuleId: 'stage-work-complete' },
        { id: 'review', label: 'Review', order: 2, screenIds: ['Review'], completionRuleId: 'stage-review-complete' },
      ],
      completionGuards: [
        { id: 'stage-work-complete', expression: 'stage.work.complete == true', referencedFields: ['stage.work.complete'], blockingMessage: 'Complete work before continuing.' },
        { id: 'stage-review-complete', expression: 'stage.review.complete == true', referencedFields: ['stage.review.complete'], blockingMessage: 'Complete review before finishing.' },
        { id: 'all-required-stages-complete', expression: 'stage.work.complete == true && stage.review.complete == true', referencedFields: ['stage.work.complete', 'stage.review.complete'], blockingMessage: 'Complete all required work.' },
      ],
      actions: [
        { id: 'open-work', label: 'Open work', kind: 'route', target: 'Work', stageId: 'work', semanticRole: 'primary' },
        { id: 'continue-work', label: 'Continue work', kind: 'local', target: 'Work', stageId: 'work', semanticRole: 'primary' },
        { id: 'advance-work', label: 'Continue to review', kind: 'route', target: 'Review', stageId: 'work', semanticRole: 'primary' },
        { id: 'complete-review', label: 'Continue review', kind: 'local', target: 'Review', stageId: 'review', semanticRole: 'primary' },
        { id: 'finish-review', label: 'Complete workflow', kind: 'local', target: 'Review', stageId: 'review', semanticRole: 'primary' },
      ],
      stateActions: [...work.actionState.stateActions, ...review.actionState.stateActions],
      signatureComponents: [stepper, resume],
      continuityKeys: ['primaryRecordId', 'displayReference', 'offlineState', 'currentStageId', 'completedStageCount', 'requiredStageCount', 'draftState'],
      scenarios: [{ id: 'primary-scenario', primaryRecordId: 'work-1', displayReference: 'Work 1', offlineState: 'saved-locally', currentStageId: 'work', completedStageCount: 0, requiredStageCount: 2, draftState: 'saved-draft', completionBlockers: ['stage-work-complete'], continuityValues: { primaryRecordId: 'work-1', displayReference: 'Work 1', offlineState: 'saved-locally', currentStageId: 'work', completedStageCount: 0, requiredStageCount: 2, draftState: 'saved-draft' } }],
      capabilityComposition: home.capabilityComposition,
    },
    shell: { safeAreaOwner: 'screen', rootSafeAreaProviderOnly: true, headerModes: { '/(app)/home': 'root', '/(app)/work': 'back', '/(app)/review': 'back' } },
    navigation: { initialRoute: '/(app)/home', keyFlowRoute: '/(app)/work', routes: ['/(app)/home', '/(app)/work', '/(app)/review'], criticalFlow: { screenIds: ['Home', 'Work', 'Review'], outcome: 'Complete required work and review it.' } },
    design: { recipe: { hierarchy: { maxFeatureViewportShare: 0.42 }, actions: {}, navigation: {}, signatureComponent: {} }, primitives: [] },
    screens: [home, work, review],
  };
  pack.uiContractFingerprint = uiContractFingerprint(pack);
  return pack;
}

function writeSources(context, pack) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-regression-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const screenValue of pack.screens) {
    const filePath = path.join(root, screenValue.file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const signatures = screenValue.signatureComponents.map((component) => `<YStack testID="${component.testId}" />`).join('\n');
    fs.writeFileSync(filePath, `export default function Screen() { return <YStack>${signatures}<Button bg="$accentBase">Continue</Button></YStack>; }\n`);
  }
  return root;
}

test('baseline staged journey passes action, continuity, signature, capability, color, and layout checks', (context) => {
  const pack = basePack();
  const root = writeSources(context, pack);
  assert.deepEqual(validateActionState(pack), []);
  assert.deepEqual(validateCrossScreenContinuity(pack), []);
  assert.deepEqual(validateSignatureComponents(pack, { projectRoot: root }), []);
  assert.deepEqual(validateCapabilityComposition(pack, { projectRoot: root }), []);
  assert.deepEqual(validateSemanticColorUsage(pack, { projectRoot: root }), []);
  assert.deepEqual(validateStaticLayoutBudgets(pack, { projectRoot: root }), []);
});

test('incomplete progress cannot expose review or enable two primary actions', () => {
  const pack = basePack();
  const incomplete = pack.screens.find((item) => item.id === 'Work').actionState.stateActions[0];
  incomplete.disabledActions = incomplete.disabledActions.filter((id) => id !== 'complete-review');
  incomplete.enabledActions.push('advance-work');
  const rules = new Set(validateActionState(pack).map((item) => item.rule));
  assert.ok(rules.has('premature-stage-action'));
  assert.ok(rules.has('competing-primary-actions'));
});

test('a completed state may promote its selected action without changing its static semantic role', () => {
  const pack = basePack();
  pack.journey.actions.find((action) => action.id === 'advance-work').semanticRole = 'secondary';
  assert.equal(validateActionState(pack).some((item) => item.rule === 'competing-primary-actions'), false);
});

test('every enabled Journey action requires a same-screen executable binding when Actions are compiled', () => {
  const pack = basePack();
  pack.sourcePaths = { actionContract: '.tmp/screen-action-contract.json' };
  pack.actionBindings = [
    { id: 'continue-work', screenId: 'Work' },
    { id: 'advance-work', screenId: 'Work' },
    { id: 'complete-review', screenId: 'Review' },
    { id: 'finish-review', screenId: 'Review' },
  ];
  pack.screens.find((screen) => screen.id === 'Work').actionBindings = pack.actionBindings.filter((action) => action.screenId === 'Work');
  pack.screens.find((screen) => screen.id === 'Review').actionBindings = pack.actionBindings.filter((action) => action.screenId === 'Review');
  assert.equal(validateActionState(pack).some((item) => item.rule === 'journey-action-not-executable'), false);
  pack.actionBindings = pack.actionBindings.filter((action) => action.id !== 'advance-work');
  assert.ok(validateActionState(pack).some((item) => item.rule === 'journey-action-not-executable' && item.actionId === 'advance-work'));
});

test('completion and resume scenario progress must remain mathematically coherent', () => {
  const pack = basePack();
  const scenario = pack.journey.scenarios[0];
  scenario.completedStageCount = 3;
  scenario.requiredStageCount = 2;
  assert.ok(validateActionState(pack).some((item) => item.rule === 'completed-scenario-blocked'));
});

test('journey validation rejects a resumed stage that does not follow completed progress', () => {
  const pack = basePack();
  const scenario = pack.journey.scenarios[0];
  scenario.completedStageCount = 1;
  scenario.currentStageId = 'work';
  scenario.continuityValues.completedStageCount = 1;
  scenario.continuityValues.currentStageId = 'work';
  scenario.continuityValues['stage.work.complete'] = true;
  const { validateWorkflowJourney } = require('../validate-workflow-journey');
  assert.ok(validateWorkflowJourney({ schemaVersion: 1, experienceContractSha256: 'a'.repeat(64), contextEnrichmentSha256: 'b'.repeat(64), ...pack.journey }).errors.some((error) => /current stage does not follow completed progress/.test(error)));
});

test('critical screens cannot drop a continuity key or route identity binding', () => {
  const pack = basePack();
  pack.screens[1].journey.continuityBindings.pop();
  pack.screens[1].routeParameters = [{ name: 'id', source: 'path', required: true }];
  const rules = new Set(validateCrossScreenContinuity(pack).map((item) => item.rule));
  assert.ok(rules.has('missing-continuity-binding'));
  assert.ok(rules.has('unbound-route-identity'));
});

test('compiled operation action inputs can bind a required route identity', () => {
  const pack = basePack();
  const work = pack.screens.find((item) => item.id === 'Work');
  work.routeParameters = [{ name: 'id', source: 'path', required: true }];
  work.actionBindings = [{
    id: 'load-work',
    executor: { kind: 'operation', provider: 'domain-hook' },
    inputs: [{ target: 'id', source: { kind: 'route', path: 'id' } }],
  }];
  assert.equal(validateCrossScreenContinuity(pack).some((item) => item.rule === 'unbound-route-identity'), false);
});

test('relationship-backed fixture aggregate counts must equal related rows', (context) => {
  const pack = basePack();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-aggregate-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  pack.sourcePaths = { domainModel: '.tmp/prototype-domain-model.json' };
  pack.journey.scenarios[0].primaryRecordId = 'work-1';
  pack.journey.scenarios[0].continuityValues.primaryRecordId = 'work-1';
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-domain-model.json'), JSON.stringify({
    relationships: [{ key: 'WorkTasks', parent: 'Work', child: 'Task', cardinality: 'one-to-many', childField: 'workId' }],
    fixtures: {
      Work: [{ id: 'work-1', taskCount: 2 }],
      Task: [{ id: 'task-1', workId: 'work-1' }],
    },
  }));
  assert.ok(validateCrossScreenContinuity(pack, { projectRoot: root }).some((item) => item.rule === 'fixture-aggregate-drift'));
});

test('required workflow signature cannot be replaced by generic content', (context) => {
  const pack = basePack();
  const root = writeSources(context, pack);
  fs.writeFileSync(path.join(root, 'app/(app)/work.tsx'), 'export default function Screen() { return <YStack><Text>Step 1 of 2</Text></YStack>; }\n');
  assert.ok(validateSignatureComponents(pack, { projectRoot: root, screenIds: ['Work'] }).some((item) => item.rule === 'signature-not-rendered'));
});

test('optional camera cannot be always mounted or dominate the first viewport', (context) => {
  const pack = basePack();
  const home = pack.screens[0];
  home.capabilityComposition[0].maxViewportShare = 0.5;
  const root = writeSources(context, pack);
  fs.writeFileSync(path.join(root, home.file), 'export default function Screen() { return <CameraView />; }\n');
  const rules = new Set(validateCapabilityComposition(pack, { projectRoot: root, screenIds: ['Home'] }).map((item) => item.rule));
  assert.ok(rules.has('capability-overprominence'));
  assert.ok(rules.has('on-demand-camera-always-mounted'));
});

test('scanner cannot replace a non-capture Home experience', () => {
  const pack = basePack();
  pack.experience = { primarySurface: 'task-led-workflow' };
  pack.screens[0].capabilityComposition[0].mode = 'primary';
  assert.ok(validatePrimaryExperience(pack).some((item) => item.rule === 'scanner-home-hijack'));

  pack.experience.primarySurface = 'capture-led-utility';
  assert.deepEqual(validatePrimaryExperience(pack), []);
});

test('primary experience follows the production navigation launch route', () => {
  const pack = basePack();
  delete pack.navigation.initialRoute;
  pack.navigation.initialDestinationId = 'work';
  pack.navigation.destinations = [
    { id: 'home', route: '/(app)/home' },
    { id: 'work', route: '/(app)/work' },
  ];
  pack.navigation.routingPolicy = { launchRoute: '/(app)/work' };
  assert.ok(validatePrimaryExperience(pack).some((item) => item.rule === 'primary-route-drift'));
});

test('structured screens declare applicable data, mutation, capability, and resume states', () => {
  const pack = basePack();
  for (const item of pack.screens) {
    item.contractSource = 'structured';
    item.states = ['populated', 'loading', 'empty', 'error', 'offline', 'retry'];
  }
  pack.screens[0].states.push('permission-denied', 'unavailable');
  pack.screens[1].states.push('interrupted', 'resumed');
  pack.screens[2].states.push('interrupted', 'resumed');
  assert.deepEqual(validateRuntimeStateCoverage(pack), []);

  pack.screens[0].states = pack.screens[0].states.filter((state) => state !== 'permission-denied');
  const issue = validateRuntimeStateCoverage(pack).find((item) => item.rule === 'runtime-state-coverage-missing');
  assert.equal(issue.screenId, 'Home');
  assert.deepEqual(issue.states, ['permission-denied']);
});

test('structured runtime states require source implementation markers', (context) => {
  const pack = basePack();
  for (const item of pack.screens) item.contractSource = 'structured';
  const home = pack.screens[0];
  home.states = ['permission-denied', 'unavailable'];
  home.data = { operations: [], routeBindings: [] };
  const root = writeSources(context, pack);
  const issue = validateRuntimeStateCoverage(pack, { projectRoot: root, screenIds: ['Home'] })
    .find((item) => item.rule === 'runtime-state-implementation-missing');
  assert.deepEqual(issue.states, ['permission-denied', 'unavailable']);

  fs.writeFileSync(path.join(root, home.file), [
    'export default function Screen() { return <YStack>',
    '<YStack testID="runtime-state-permission-denied" />',
    '<YStack testID="runtime-state-unavailable" />',
    '</YStack>; }',
  ].join('\n'));
  assert.deepEqual(validateRuntimeStateCoverage(pack, { projectRoot: root, screenIds: ['Home'] }), []);

  home.states.push('scanner-failed');
  const customIssue = validateRuntimeStateCoverage(pack, { projectRoot: root, screenIds: ['Home'] })
    .find((item) => item.rule === 'runtime-state-implementation-missing');
  assert.deepEqual(customIssue.states, ['scanner-failed']);
});

test('error colors cannot represent ordinary selection and brand accent cannot flood the screen', (context) => {
  const pack = basePack();
  const root = writeSources(context, pack);
  fs.writeFileSync(path.join(root, 'app/(app)/work.tsx'), [
    'export default function Screen() { return <YStack>',
    '<Button selected bg="$statusOverdue">Choose</Button>',
    '<YStack bg="$accentBase" /><YStack bg="$accentBase" /><YStack bg="$accentBase" />',
    '<YStack bg="$accentBase" /><YStack bg="$accentBase" />',
    '</YStack>; }',
  ].join('\n'));
  const rules = new Set(validateSemanticColorUsage(pack, { projectRoot: root, screenIds: ['Work'] }).map((item) => item.rule));
  assert.ok(rules.has('error-color-for-selection'));
  assert.ok(rules.has('brand-accent-flood'));
});

test('large fixed placeholders and missing journey context fail static layout budgets', (context) => {
  const pack = basePack();
  const work = pack.screens[1];
  work.signatureComponents = [];
  const root = writeSources(context, pack);
  fs.writeFileSync(path.join(root, work.file), 'export default function Screen() { return <YStack minH={500} />; }\n');
  const rules = new Set(validateStaticLayoutBudgets(pack, { projectRoot: root, screenIds: ['Work'] }).map((item) => item.rule));
  assert.ok(rules.has('journey-context-missing'));
  assert.ok(rules.has('fixed-placeholder-dead-space'));
});

test('data-only migration preserves the UI fingerprint and reports exact UI drift paths', () => {
  const before = basePack();
  const unchanged = structuredClone(before);
  unchanged.sources.domainLayer = '9'.repeat(64);
  unchanged.sources.packageManifest = '8'.repeat(64);
  assert.deepEqual(validateUiNeutralDataMigration(before, unchanged).issues, []);

  const drifted = structuredClone(unchanged);
  drifted.navigation.initialRoute = '/(app)/review';
  drifted.uiContractFingerprint = uiContractFingerprint(drifted);
  const result = validateUiNeutralDataMigration(before, drifted);
  assert.equal(result.applicable, true);
  assert.ok(result.issues.some((item) => item.rule === 'ui-contract-drift'));
  assert.ok(result.issues.flatMap((item) => item.paths || []).includes('navigation.initialRoute'));
});