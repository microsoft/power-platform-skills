'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { stableStringify, uiContractFingerprint, uiContractProjection } = require('../compile-screen-build-pack');

function issue(rule, message, details = {}) {
  return { rule, message, ...details };
}

function screenSelection(pack, screenIds) {
  const selected = screenIds?.length ? new Set(screenIds) : null;
  return (pack.screens || [])
    .filter((screen) => !selected || selected.has(screen.id))
    .map((screen) => ({
      ...screen,
      ...(screen.ux || {}),
      data: {
        ...(screen.data || {}),
        ...(screen.ux?.data || {}),
      },
    }));
}

function sourceFor(projectRoot, screen) {
  if (!projectRoot || !screen?.file) return null;
  const root = path.resolve(projectRoot);
  const filePath = path.resolve(root, screen.file);
  if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function validateActionState(pack, options = {}) {
  const issues = [];
  const stages = pack.journey?.stages || [];
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const stageByScreen = new Map(stages.flatMap((stage) => stage.screenIds.map((screenId) => [screenId, stage])));
  const actions = new Map((pack.journey?.actions || []).map((action) => [action.id, action]));
  const guards = new Map((pack.journey?.completionGuards || []).map((guard) => [guard.id, guard]));
  for (const screen of screenSelection(pack, options.screenIds)) {
    const states = screen.actionState?.stateActions || [];
    const stateKeys = new Set();
    for (const state of states) {
      if (stateKeys.has(state.state)) issues.push(issue('duplicate-action-state', `Screen ${screen.id} defines state ${state.state} more than once.`, { screenId: screen.id }));
      stateKeys.add(state.state);
      if (!actions.has(state.primaryAction)) issues.push(issue('unknown-primary-action', `Screen ${screen.id} state ${state.state} references unknown primary action ${state.primaryAction}.`, { screenId: screen.id }));
      if (!(state.enabledActions || []).includes(state.primaryAction)) issues.push(issue('primary-action-not-enabled', `Screen ${screen.id} state ${state.state} does not enable its primary action.`, { screenId: screen.id }));
      if ((state.disabledActions || []).includes(state.primaryAction) || (state.hiddenActions || []).includes(state.primaryAction)) issues.push(issue('primary-action-conflict', `Screen ${screen.id} state ${state.state} disables or hides its primary action.`, { screenId: screen.id }));
      if (state.guardId !== null && !guards.has(state.guardId)) issues.push(issue('unknown-action-guard', `Screen ${screen.id} state ${state.state} references unknown guard ${state.guardId}.`, { screenId: screen.id }));
      const enabledPrimaryActions = (state.enabledActions || []).filter((actionId) => actions.get(actionId)?.semanticRole === 'primary');
      if (enabledPrimaryActions.length !== 1) issues.push(issue('competing-primary-actions', `Screen ${screen.id} state ${state.state} enables ${enabledPrimaryActions.length} primary actions.`, { screenId: screen.id }));
    }
    const incomplete = states.find((state) => state.state === 'incomplete');
    if (incomplete && screen.primaryAction?.id && incomplete.primaryAction !== screen.primaryAction.id) issues.push(issue('competing-primary-actions', `Screen ${screen.id} has competing Screen and Journey primary actions.`, { screenId: screen.id }));
    const stage = stageByScreen.get(screen.id);
    if (stage && incomplete) {
      const blocked = new Set([...(incomplete.disabledActions || []), ...(incomplete.hiddenActions || [])]);
      const laterStages = new Set(stages.filter((candidate) => candidate.order > stage.order).map((candidate) => candidate.id));
      for (const action of actions.values()) {
        if (laterStages.has(action.stageId) && !blocked.has(action.id)) issues.push(issue('premature-stage-action', `Screen ${screen.id} incomplete state exposes later-stage action ${action.id}.`, { screenId: screen.id, actionId: action.id }));
        if (action.kind === 'route') {
          const targetStage = stageByScreen.get(action.target);
          if (targetStage && targetStage.order > stage.order + 1) issues.push(issue('stage-skip', `Action ${action.id} skips from stage ${stage.id} to ${targetStage.id}.`, { screenId: screen.id, actionId: action.id }));
        }
      }
    }
  }
  for (const scenario of pack.journey?.scenarios || []) {
    const incomplete = scenario.completedStageCount < scenario.requiredStageCount;
    if (incomplete && !(scenario.completionBlockers || []).length) issues.push(issue('unguarded-incomplete-scenario', `Scenario ${scenario.id} is incomplete but has no completion blocker.`));
    if (!incomplete && (scenario.completionBlockers || []).length) issues.push(issue('completed-scenario-blocked', `Scenario ${scenario.id} is complete but still has completion blockers.`));
    if (!stageById.has(scenario.currentStageId)) issues.push(issue('unknown-scenario-stage', `Scenario ${scenario.id} references unknown stage ${scenario.currentStageId}.`));
  }
  return issues;
}

function validateCrossScreenContinuity(pack, options = {}) {
  const issues = [];
  const keys = pack.journey?.continuityKeys || [];
  const criticalIds = new Set(pack.navigation?.criticalFlow?.screenIds || []);
  for (const screen of screenSelection(pack, options.screenIds)) {
    if (criticalIds.size && !criticalIds.has(screen.id) && !screen.journey?.stageId) continue;
    const bindings = new Set((screen.journey?.continuityBindings || []).map((binding) => binding.key));
    for (const key of keys) if (!bindings.has(key)) issues.push(issue('missing-continuity-binding', `Screen ${screen.id} drops continuity key ${key}.`, { screenId: screen.id, key }));
    const requiredParameters = (screen.routeParameters || []).filter((parameter) => parameter.required).map((parameter) => parameter.name);
    const routeBindings = new Set((screen.data?.operations || []).flatMap((operation) => operation.routeBindings || []).map((binding) => binding.parameter));
    for (const parameter of requiredParameters) if (!routeBindings.has(parameter)) issues.push(issue('unbound-route-identity', `Screen ${screen.id} route parameter ${parameter} is not bound to a repository operation.`, { screenId: screen.id }));
  }
  for (const scenario of pack.journey?.scenarios || []) {
    for (const key of keys) if (!Object.prototype.hasOwnProperty.call(scenario.continuityValues || {}, key)) issues.push(issue('missing-scenario-continuity', `Scenario ${scenario.id} lacks continuity value ${key}.`, { key }));
    if (scenario.continuityValues?.primaryRecordId !== scenario.primaryRecordId
      || scenario.continuityValues?.displayReference !== scenario.displayReference
      || scenario.continuityValues?.offlineState !== scenario.offlineState
      || scenario.continuityValues?.currentStageId !== scenario.currentStageId) {
      issues.push(issue('scenario-story-drift', `Scenario ${scenario.id} canonical identity, reference, stage, or offline state drifts from its continuity values.`));
    }
  }
  if (options.projectRoot && pack.sourcePaths?.domainModel) {
    try {
      const domain = JSON.parse(fs.readFileSync(path.join(options.projectRoot, pack.sourcePaths.domainModel), 'utf8'));
      const fixtureIds = new Set(Object.values(domain.fixtures || {}).flatMap((records) => (
        Array.isArray(records) ? records.map((record) => record?.id).filter(Boolean) : []
      )));
      if (fixtureIds.size) {
        for (const scenario of pack.journey?.scenarios || []) {
          if (!fixtureIds.has(scenario.primaryRecordId)) issues.push(issue('unresolved-scenario-identity', `Scenario ${scenario.id} primary record ${scenario.primaryRecordId} does not resolve in the Domain fixture graph.`));
        }
      }
      for (const relationship of domain.relationships || []) {
        if (relationship.cardinality !== 'one-to-many' || !relationship.childField) continue;
        const parents = domain.fixtures?.[relationship.parent] || [];
        const children = domain.fixtures?.[relationship.child] || [];
        if (!Array.isArray(parents) || !Array.isArray(children)) continue;
        const childStem = String(relationship.child || '').replace(/[^A-Za-z0-9]/g, '').replace(/(?:Item|Line|Record)s?$/i, '').toLowerCase();
        for (const parent of parents) {
          for (const [field, value] of Object.entries(parent || {})) {
            if (!Number.isInteger(value) || !/count$/i.test(field)) continue;
            const fieldStem = field.replace(/(?:Completed|Required|Total|Count)/gi, '').toLowerCase();
            if (fieldStem && childStem && !fieldStem.includes(childStem) && !childStem.includes(fieldStem)) continue;
            const relatedCount = children.filter((child) => child?.[relationship.childField] === parent.id).length;
            if (value !== relatedCount) issues.push(issue('fixture-aggregate-drift', `${relationship.parent}.${field} is ${value}, but ${relatedCount} related ${relationship.child} fixture records resolve through ${relationship.childField}.`, { entity: relationship.parent, field }));
          }
        }
      }
    } catch (error) {
      issues.push(issue('invalid-domain-fixtures', `Cannot verify journey fixture identity: ${error.message}`));
    }
  }
  return issues;
}

function validateSignatureComponents(pack, options = {}) {
  const issues = [];
  const stages = pack.journey?.stages || [];
  const stageScreens = new Set(stages.flatMap((stage) => stage.screenIds));
  const requiredStageSignatures = (pack.journey?.signatureComponents || []).filter((component) => component.requiredOnStageScreens);
  for (const screen of screenSelection(pack, options.screenIds)) {
    const signatures = screen.signatureComponents || [];
    if (stageScreens.has(screen.id)) {
      for (const required of requiredStageSignatures) {
        if (!signatures.some((component) => component.kind === required.kind && component.testId === required.testId)) issues.push(issue('missing-required-signature', `Screen ${screen.id} is missing required ${required.kind}.`, { screenId: screen.id }));
      }
    }
    const source = sourceFor(options.projectRoot, screen);
    for (const signature of signatures) {
      if (!screen.testIds?.includes(signature.testId)) issues.push(issue('missing-signature-test-id', `Screen ${screen.id} does not declare ${signature.testId}.`, { screenId: screen.id }));
      if (source && !new RegExp(`testID\\s*=\\s*["']${signature.testId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(source)) issues.push(issue('signature-not-rendered', `Screen ${screen.id} does not render literal journey signature ${signature.testId}.`, { screenId: screen.id }));
    }
  }
  return issues;
}

function validateCapabilityComposition(pack, options = {}) {
  const issues = [];
  for (const screen of screenSelection(pack, options.screenIds)) {
    const source = sourceFor(options.projectRoot, screen);
    for (const composition of screen.capabilityComposition || []) {
      if (!['loading', 'permission-denied', 'unavailable'].every((state) => composition.fallbackStates?.includes(state))) issues.push(issue('capability-fallback-missing', `Screen ${screen.id} ${composition.capability} lacks required fallback states.`, { screenId: screen.id }));
      if (composition.mode !== 'primary' && composition.maxViewportShare > 0.32) issues.push(issue('capability-overprominence', `Screen ${screen.id} over-promotes non-primary ${composition.capability}.`, { screenId: screen.id }));
      if (composition.mode === 'primary' && screen.layoutBudgets?.requiredFirstViewportRegions?.length < 2) issues.push(issue('primary-capability-context-missing', `Screen ${screen.id} primary ${composition.capability} lacks another required task/context region.`, { screenId: screen.id }));
      if (source && composition.mode === 'on-demand' && /<CameraView\b/.test(source)) {
        const conditional = /(?:showCamera|cameraOpen|isScanning|scannerOpen)[\s\S]{0,300}(?:&&|\?)[\s\S]{0,300}<CameraView\b/.test(source);
        if (!conditional) issues.push(issue('on-demand-camera-always-mounted', `Screen ${screen.id} mounts an on-demand camera without an explicit open-state guard.`, { screenId: screen.id }));
      }
    }
  }
  return issues;
}

function validateSemanticColorUsage(pack, options = {}) {
  const issues = [];
  for (const screen of screenSelection(pack, options.screenIds)) {
    const roles = new Set((screen.semanticColorRoles || []).map((role) => role.role));
    if (!['brand-accent', 'primary-action', 'selection', 'warning', 'error', 'destructive'].every((role) => roles.has(role))) issues.push(issue('semantic-role-separation-missing', `Screen ${screen.id} lacks separate semantic color roles.`, { screenId: screen.id }));
    const roleMap = new Map((screen.semanticColorRoles || []).map((role) => [role.role, role]));
    if (!roleMap.get('selection')?.token
      || ['warning', 'error', 'destructive'].some((role) => roleMap.get(role)?.token === roleMap.get('selection')?.token)) {
      issues.push(issue('selection-color-role-drift', `Screen ${screen.id} selection color is not distinct from warning/error/destructive roles.`, { screenId: screen.id }));
    }
    const source = sourceFor(options.projectRoot, screen);
    if (!source) continue;
    const tags = source.match(/<[A-Z][^>]*>/g) || [];
    let accentCount = 0;
    for (const tag of tags) {
      if (/\$(?:accentBase|brandPrimary|primaryAction)\b/.test(tag)) accentCount += 1;
      const usesCritical = /\$(?:statusOverdue|error|destructive|danger|red\d*)\b/i.test(tag);
      if (!usesCritical) continue;
      const ordinarySelection = /(?:selected|active|isSelected|aria-selected)/i.test(tag);
      const destructiveMeaning = /(?:delete|remove|discard|destroy|fail|invalid|error|damage|cancel)/i.test(tag);
      if (ordinarySelection && !destructiveMeaning) issues.push(issue('error-color-for-selection', `Screen ${screen.id} uses error/destructive color for ordinary selection.`, { screenId: screen.id }));
      if (/<Button\b/.test(tag) && !destructiveMeaning) issues.push(issue('error-color-for-ordinary-action', `Screen ${screen.id} uses error/destructive color for an ordinary action.`, { screenId: screen.id }));
    }
    if (accentCount > 4) issues.push(issue('brand-accent-flood', `Screen ${screen.id} repeats brand/primary accent across ${accentCount} surfaces.`, { screenId: screen.id }));
  }
  return issues;
}

function validateStaticLayoutBudgets(pack, options = {}) {
  const issues = [];
  for (const screen of screenSelection(pack, options.screenIds)) {
    const budget = screen.layoutBudgets;
    if (!budget) {
      issues.push(issue('layout-budget-missing', `Screen ${screen.id} has no static layout budget.`, { screenId: screen.id }));
      continue;
    }
    if (stableStringify(budget.requiredFirstViewportRegions) !== stableStringify(screen.firstViewport?.regionIds || [])) issues.push(issue('first-viewport-budget-drift', `Screen ${screen.id} drops or reorders required first-viewport regions.`, { screenId: screen.id }));
    if (budget.maxFocalViewportShare > pack.design?.recipe?.hierarchy?.maxFeatureViewportShare || budget.maxFocalViewportShare > 0.6) issues.push(issue('focal-surface-oversized', `Screen ${screen.id} focal surface exceeds the approved viewport share.`, { screenId: screen.id }));
    if (budget.maxReservedFooterShare > 0.2) issues.push(issue('footer-space-oversized', `Screen ${screen.id} reserves excessive footer space.`, { screenId: screen.id }));
    const expectedOrder = ['content', ...(screen.primaryAction?.placement === 'sticky-bottom' ? ['primary-action'] : []), ...(screen.navigation?.kind === 'tab-root' ? ['tabs'] : []), 'safe-area'];
    if (stableStringify(budget.stickySurfaceOrder) !== stableStringify(expectedOrder)) issues.push(issue('sticky-surface-order-drift', `Screen ${screen.id} sticky content/action/tabs/safe-area order is invalid.`, { screenId: screen.id }));
    if (budget.requireJourneyContext && !(screen.signatureComponents || []).some((component) => component.kind === 'workflow-stepper')) issues.push(issue('journey-context-missing', `Screen ${screen.id} is staged but has no workflow progress signature.`, { screenId: screen.id }));
    const source = sourceFor(options.projectRoot, screen);
    if (source && /(?:minH|minHeight|height)\s*(?:=|:)\s*(?:\{\s*)?(?:3[2-9]\d|[4-9]\d{2,})/.test(source) && screen.firstViewport?.regionIds?.length > 1) issues.push(issue('fixed-placeholder-dead-space', `Screen ${screen.id} uses a large fixed region while multiple first-viewport regions are required.`, { screenId: screen.id }));
  }
  return issues;
}

function validatePrimaryExperience(pack) {
  const issues = [];
  const screens = screenSelection(pack);
  const primaryScreens = screens.filter((screen) => screen.role === 'primary');
  if (primaryScreens.length !== 1) {
    issues.push(issue('primary-screen-count', `Build pack requires exactly one primary screen; found ${primaryScreens.length}.`));
    return issues;
  }
  const primary = primaryScreens[0];
  const initialDestination = (pack.navigation?.destinations || [])
    .find((destination) => destination.id === pack.navigation?.initialDestinationId);
  const initialRoute = pack.navigation?.routingPolicy?.launchRoute
    || initialDestination?.route
    || pack.navigation?.initialRoute;
  if (initialRoute && initialRoute !== primary.route) {
    issues.push(issue('primary-route-drift', `Navigation starts at ${initialRoute}, not primary screen ${primary.route}.`, { screenId: primary.id }));
  }
  const scanner = (primary.capabilityComposition || []).find((capability) => /(?:barcode|qr|scanner|camera)/i.test(capability.capability));
  if (scanner?.mode === 'primary' && pack.experience?.primarySurface !== 'capture-led-utility') {
    issues.push(issue('scanner-home-hijack', `Primary screen ${primary.id} promotes ${scanner.capability} as the product surface without an immersive capture contract.`, { screenId: primary.id }));
  }
  if (primary.presentation?.pattern === 'capture' && pack.experience?.primarySurface !== 'capture-led-utility') {
    issues.push(issue('capture-home-hijack', `Primary screen ${primary.id} uses a capture composition for a non-capture product.`, { screenId: primary.id }));
  }
  if (!primary.firstViewport?.focalPoint || !primary.primaryAction) {
    issues.push(issue('primary-hierarchy-incomplete', `Primary screen ${primary.id} requires a focal point and visible primary action.`, { screenId: primary.id }));
  }
  return issues;
}

function validateRuntimeStateCoverage(pack, options = {}) {
  const issues = [];
  const journeyStages = new Set((pack.journey?.stages || []).flatMap((stage) => stage.screenIds || []));
  for (const screen of screenSelection(pack, options.screenIds)) {
    // Schema v1 contracts remain valid. Rich state coverage is required only
    // from structured screen contracts that can represent the full policy.
    if (screen.contractSource !== 'structured') continue;
    const states = new Set(screen.states || []);
    const dataDriven = (screen.data?.entities || []).length > 0 || (screen.data?.operations || []).length > 0;
    const required = dataDriven
      ? ['populated', 'loading', 'empty', 'error', 'offline', 'retry']
      : [];
    const capabilities = screen.capabilityComposition || [];
    if (capabilities.length) required.push('permission-denied', 'unavailable');
    const mutates = (screen.data?.operations || []).some((operation) => ['create', 'update', 'delete'].includes(operation.kind));
    if (mutates) required.push('success');
    if (pack.journey?.resume?.supported && journeyStages.has(screen.id)) required.push('interrupted', 'resumed');
    const missing = [...new Set(required)].filter((state) => !states.has(state));
    if (missing.length) {
      issues.push(issue('runtime-state-coverage-missing', `Screen ${screen.id} is missing applicable runtime states: ${missing.join(', ')}.`, { screenId: screen.id, states: missing }));
    }
    const source = sourceFor(options.projectRoot, screen);
    if (source) {
      const implementedStates = [...new Set([...required, ...states])];
      const unimplemented = implementedStates.filter((state) => {
        const marker = `runtime-state-${String(state).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
        return !source.includes(`testID="${marker}"`) && !source.includes(`testID='${marker}'`);
      });
      if (unimplemented.length) {
        issues.push(issue('runtime-state-implementation-missing', `Screen ${screen.id} does not render deterministic markers for runtime states: ${unimplemented.join(', ')}.`, { screenId: screen.id, states: unimplemented }));
      }
    }
  }
  return issues;
}

function changedPaths(before, after, prefix = '') {
  if (stableStringify(before) === stableStringify(after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return [prefix || '<root>'];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((key) => changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
}

function validateUiNeutralDataMigration(beforePack, afterPack) {
  const issues = [];
  const sourceNames = new Set([...Object.keys(beforePack.sources || {}), ...Object.keys(afterPack.sources || {})]);
  const changedSources = [...sourceNames].filter((source) => beforePack.sources?.[source] !== afterPack.sources?.[source]);
  const uiAuthoritySources = new Set([
    'confirmedBrief', 'experienceContract', 'screenContract', 'contextEnrichment',
    'workflowJourney', 'navigationContract', 'navigationShell',
    'foundationContract', 'foundationRuntime', 'designRecipe', 'tokens',
  ]);
  const uiAuthorityChanged = changedSources.some((source) => uiAuthoritySources.has(source));
  if (!changedSources.length || uiAuthorityChanged) return { applicable: false, changedSources, issues };
  const expectedBefore = uiContractFingerprint(beforePack);
  const expectedAfter = uiContractFingerprint(afterPack);
  if (beforePack.uiContractFingerprint !== expectedBefore || afterPack.uiContractFingerprint !== expectedAfter) issues.push(issue('invalid-ui-fingerprint', 'One migration pack contains a stale UI contract fingerprint.'));
  if (expectedBefore !== expectedAfter) {
    const paths = changedPaths(uiContractProjection(beforePack), uiContractProjection(afterPack));
    issues.push(issue('ui-contract-drift', `Data-only migration changed approved UI contract paths: ${paths.slice(0, 12).join(', ')}`, { paths }));
  }
  return { applicable: true, changedSources, issues };
}

module.exports = {
  validateActionState,
  validateCapabilityComposition,
  validateCrossScreenContinuity,
  validateSemanticColorUsage,
  validateSignatureComponents,
  validateStaticLayoutBudgets,
  validatePrimaryExperience,
  validateRuntimeStateCoverage,
  validateUiNeutralDataMigration,
};