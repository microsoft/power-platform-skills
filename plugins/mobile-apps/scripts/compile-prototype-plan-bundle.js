#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contractHash, foundationContract, primaryComposition } = require('./experience-patterns');
const { domainModelRevision, validatePrototypeDomainModel } = require('./lib/prototype-domain-model');
const { validateExperienceScreenContract } = require('./lib/experience-screen-contract');
const { sha256, validateMobilePlanExecutionContract } = require('./lib/mobile-plan-execution-contract');
const { semanticPlanRevision, validatePrototypeSemanticPlan } = require('./lib/prototype-semantic-plan');
const { safeExistingProjectFile, safeProjectOutput } = require('./lib/project-path');
const { contextEnrichmentRevision, stableStringify } = require('./resolve-context-enrichment');
const { workflowJourneyRevision } = require('./resolve-workflow-journey');
const { validateWorkflowJourney } = require('./validate-workflow-journey');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporaryPath, filePath);
}

function validatePlannerRequestSnapshot(root, current) {
  const request = readJson(safeExistingProjectFile(root, '.tmp/prototype-planner-request.json', 'prototype planner request'), 'prototype planner request');
  const errors = [];
  if (request.kind !== 'mobile-prototype-planner-request') errors.push('planner request kind is invalid');
  if (request.brief !== current.briefText.trim()) errors.push('confirmed brief changed after planner request preparation');
  for (const [key, value] of Object.entries({
    experience: current.experienceContract,
    context: current.contextContract,
    workflowJourney: current.workflowJourney,
    executionPreflight: current.preflight,
  })) if (stableStringify(request.contracts?.[key]) !== stableStringify(value)) errors.push(`${key} changed after planner request preparation`);
  if (request.derived?.experienceContractSha256 !== contractHash(current.experienceContract)) errors.push('Experience Contract revision changed after planner request preparation');
  if (request.derived?.contextEnrichmentSha256 !== contextEnrichmentRevision(current.contextContract)) errors.push('Context Contract revision changed after planner request preparation');
  if (request.derived?.workflowJourneySha256 !== workflowJourneyRevision(current.workflowJourney)) errors.push('Workflow Journey revision changed after planner request preparation');
  if (stableStringify(request.derived?.foundationContract) !== stableStringify(current.foundation)) errors.push('Foundation projection changed after planner request preparation');
  if (stableStringify(request.templateFacts?.dependencies || {}) !== stableStringify(current.packageJson.dependencies || {})) errors.push('template dependencies changed after planner request preparation');
  if (stableStringify(request.templateFacts?.devDependencies || {}) !== stableStringify(current.packageJson.devDependencies || {})) errors.push('template devDependencies changed after planner request preparation');
  if (errors.length) throw new Error(`stale prototype planner request: ${errors.join('; ')}`);
  return request;
}

function segmentValue(segment) {
  return segment.kind === 'parameter' ? `[${segment.name}]` : segment.value;
}

function routeFromSegments(segments) {
  return `/(app)/${segments.map(segmentValue).join('/')}`;
}

function routeFileFromSegments(segments, ownsChildren) {
  const relative = segments.map(segmentValue).join('/');
  return `app/(app)/${relative}${ownsChildren ? '/index.tsx' : '.tsx'}`;
}

function isPrefix(left, right) {
  if (left.length >= right.length) return false;
  return left.every((segment, index) => stableStringify(segment) === stableStringify(right[index]));
}

function orderedSemanticScreens(semanticPlan) {
  const screenById = new Map(semanticPlan.screens.items.map((screen) => [screen.id, screen]));
  const structure = semanticPlan.screens.productStructure;
  const orderedIds = [
    structure.primaryScreenId,
    ...structure.durableDestinationIds,
    ...structure.boundedFlows.flatMap((flow) => flow.screenIds),
    ...structure.keyFlowScreenIds,
  ];
  const seen = new Set();
  const ordered = [];
  for (const screenId of orderedIds) {
    if (seen.has(screenId) || !screenById.has(screenId)) continue;
    seen.add(screenId);
    ordered.push(screenById.get(screenId));
  }
  for (const screen of [...semanticPlan.screens.items].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!seen.has(screen.id)) ordered.push(screen);
  }
  return ordered;
}

function compileRouteGraph(semanticPlan, experienceContract) {
  const items = orderedSemanticScreens(semanticPlan);
  const primaryId = semanticPlan.screens.primaryScreenId;
  const routes = new Map();
  const routeKeys = new Set();
  for (const screen of items) {
    if (screen.id === primaryId) {
      routes.set(screen.id, { route: experienceContract.primaryScreen.route, file: experienceContract.primaryScreen.file });
      routeKeys.add(experienceContract.primaryScreen.route);
      continue;
    }
    const route = routeFromSegments(screen.routeIntent.pathSegments);
    if (routeKeys.has(route)) throw new Error(`semantic route collision at ${route}`);
    routeKeys.add(route);
    const ownsChildren = items.some((candidate) => candidate.id !== screen.id && isPrefix(screen.routeIntent.pathSegments, candidate.routeIntent.pathSegments));
    routes.set(screen.id, { route, file: routeFileFromSegments(screen.routeIntent.pathSegments, ownsChildren) });
  }
  const primary = routes.get(primaryId);
  for (const screen of items) {
    if (screen.id === primaryId) continue;
    const candidate = routes.get(screen.id);
    if (candidate.file.startsWith(primary.file.replace(/\.tsx$/, '/'))) {
      throw new Error(`semantic route ${candidate.route} collides with foreground primary file ${primary.file}`);
    }
  }
  return routes;
}

function navigationEvidenceFor(screenId, semanticPlan) {
  const revisit = semanticPlan.navigationIntent.revisitPatterns.find((item) => item.screenId === screenId);
  return {
    hasStableRoot: true,
    revisitedIndependently: true,
    preservesOwnState: revisit.preservesState,
    crossSessionValue: revisit.crossSessionValue,
    peerToOtherDestinations: true,
    isNotAFlowStep: true,
    isNotAnAction: true,
    supportedByBriefOrSafeProductInference: true,
  };
}

function compilePreliminaryNavigation(screen, semanticPlan, routes) {
  const destination = semanticPlan.navigationIntent.durableDestinations.find((item) => item.screenId === screen.id);
  if (destination) {
    const persistentPeers = semanticPlan.navigationIntent.tabsStackRecommendation.recommended
      && semanticPlan.navigationIntent.durableDestinations.length >= 3;
    return {
      kind: persistentPeers ? 'tab-root' : 'stack-root',
      intent: persistentPeers ? 'navigate' : 'replace',
      tabLabel: destination.label,
      candidate: {
        ...navigationEvidenceFor(screen.id, semanticPlan),
        badgeBinding: destination.badgeBinding,
        iconIntent: destination.iconIntent,
      },
    };
  }
  const parent = screen.routeIntent.parentScreenId;
  const modal = ['modal', 'full-screen-modal'].includes(screen.routeIntent.presentation);
  return {
    kind: modal ? 'modal' : 'pushed',
    intent: modal ? 'present' : 'push',
    parentRoute: routes.get(parent).route,
    presentation: screen.routeIntent.presentation,
    candidate: {
      hasStableRoot: false,
      revisitedIndependently: false,
      preservesOwnState: false,
      crossSessionValue: false,
      peerToOtherDestinations: false,
      isNotAFlowStep: false,
      isNotAnAction: true,
      supportedByBriefOrSafeProductInference: true,
    },
  };
}

function compilePrimaryAction(action, routes) {
  if (!action) return null;
  const { destinationScreenId, ...compiled } = action;
  return {
    ...compiled,
    ...(destinationScreenId ? { destination: routes.get(destinationScreenId).route } : {}),
  };
}

function compileScreenContext(contextIntent, contextContract) {
  if (contextIntent.source !== 'foreground-primary-context') return contextIntent;
  const entries = (contextContract.displayContext || []).filter((entry) => entry.placementIntent === 'primary-screen-context-rail');
  return {
    entryIds: entries.map((entry) => entry.id),
    placementIntent: entries.length ? 'primary-screen-context-rail' : 'none',
    assumptions: [...new Set(entries.map((entry) => entry.assumption))],
  };
}

function compileSignatureComponent(signatureIntent, experienceContract) {
  return signatureIntent.source === 'experience-primary-signature'
    ? { ...experienceContract.visualCompositionIntent.signatureComponent }
    : signatureIntent;
}

function compileScreenContract(semanticPlan, experienceContract, foundation, contextContract) {
  const routes = compileRouteGraph(semanticPlan, experienceContract);
  const primitiveByMotif = new Map(foundation.primitives.map((primitive) => [primitive.motif, primitive]));
  const screens = orderedSemanticScreens(semanticPlan).map((screen) => ({
    id: screen.id,
    route: routes.get(screen.id).route,
    file: routes.get(screen.id).file,
    role: screen.role,
    productRole: screen.productRole,
    purpose: screen.purpose,
    routeParameters: screen.routeIntent.parameters,
    navigation: compilePreliminaryNavigation(screen, semanticPlan, routes),
    presentation: screen.presentation,
    regions: screen.regions,
    firstViewport: screen.firstViewport,
    context: compileScreenContext(screen.context, contextContract),
    signatureComponent: compileSignatureComponent(screen.signatureComponent, experienceContract),
    header: screen.header,
    primaryAction: compilePrimaryAction(screen.primaryAction, routes),
    media: screen.media,
    states: screen.states,
    qualityCriteria: screen.qualityCriteria,
    testIds: screen.testIds,
    dependencies: {
      foundation: screen.foundationMotifs.map((motif) => primitiveByMotif.get(motif).component),
      fixtures: screen.dependencies.fixtures,
      screens: screen.dependencies.screens,
    },
    data: screen.data,
    forbiddenDefaults: screen.forbiddenDefaults,
  }));
  const keyFlow = semanticPlan.screens.keyFlowScreenIds.map((screenId) => {
    const semantic = semanticPlan.screens.items.find((screen) => screen.id === screenId);
    const compiled = screens.find((screen) => screen.id === screenId);
    return { route: compiled.route, file: compiled.file, outcome: semantic.outcome };
  });
  return {
    schemaVersion: 3,
    experienceContractSha256: contractHash(experienceContract),
    primaryScreen: {
      route: experienceContract.primaryScreen.route,
      file: experienceContract.primaryScreen.file,
      ...primaryComposition(experienceContract),
    },
    keyFlow: keyFlow[0],
    criticalFlow: semanticPlan.screens.criticalFlow,
    screens,
  };
}

function compileDomainModel(semanticPlan, experienceContract, contextContract) {
  return {
    schemaVersion: 1,
    mode: 'prototype-domain',
    experienceContractSha256: contractHash(experienceContract),
    contextEnrichmentSha256: contextEnrichmentRevision(contextContract),
    entities: semanticPlan.domain.entities,
    relationships: semanticPlan.domain.relationships,
    choices: semanticPlan.domain.choices,
    operations: semanticPlan.domain.operations,
    actors: semanticPlan.domain.actors,
    uxPermissions: semanticPlan.domain.uxPermissions,
    offlineUxIntent: semanticPlan.domain.offlineIntent,
    fixtureRequirements: semanticPlan.domain.fixtureRequirements,
    mediaPolicy: semanticPlan.domain.mediaPolicy,
    fixtures: semanticPlan.domain.fixtures,
    fixtureScenarios: semanticPlan.domain.scenarios,
  };
}

function bindWorkflowJourney(workflowJourney, semanticPlan) {
  const orderedScreens = orderedSemanticScreens(semanticPlan);
  const stageScreens = new Map((workflowJourney.stages || []).map((stage) => [
    stage.id,
    orderedScreens.filter((screen) => screen.journeyStageIds.includes(stage.id)).map((screen) => screen.id),
  ]));
  const oldScreenToNew = new Map();
  const actionIds = new Map();
  for (const stage of workflowJourney.stages || []) {
    const screenIds = stageScreens.get(stage.id) || [];
    if (!screenIds.length) throw new Error(`foreground Journey stage ${stage.id} has no semantic screen binding`);
    for (const oldScreenId of stage.screenIds || []) oldScreenToNew.set(oldScreenId, screenIds[0]);
    const oldIncomplete = (workflowJourney.stateActions || []).find((item) => item.screenId === stage.screenIds?.[0] && item.state === 'incomplete');
    const semanticScreen = semanticPlan.screens.items.find((screen) => screen.id === screenIds[0]);
    if (oldIncomplete?.primaryAction && semanticScreen?.primaryAction?.id) actionIds.set(oldIncomplete.primaryAction, semanticScreen.primaryAction.id);
  }
  const replaceAction = (value) => actionIds.get(value) || value;
  const stages = (workflowJourney.stages || []).map((stage) => ({ ...stage, screenIds: stageScreens.get(stage.id) }));
  const actions = (workflowJourney.actions || []).map((action) => {
    const stageScreen = stageScreens.get(action.stageId)?.[0];
    const nextId = replaceAction(action.id);
    const semanticScreen = semanticPlan.screens.items.find((screen) => screen.id === stageScreen);
    return {
      ...action,
      id: nextId,
      target: oldScreenToNew.get(action.target) || action.target,
      ...(nextId !== action.id && semanticScreen?.primaryAction ? { label: semanticScreen.primaryAction.label } : {}),
    };
  });
  const stateActions = (workflowJourney.stateActions || []).map((state) => ({
    ...state,
    screenId: oldScreenToNew.get(state.screenId) || state.screenId,
    primaryAction: replaceAction(state.primaryAction),
    enabledActions: (state.enabledActions || []).map(replaceAction),
    disabledActions: (state.disabledActions || []).map(replaceAction),
    hiddenActions: (state.hiddenActions || []).map(replaceAction),
  }));
  return { ...workflowJourney, stages, actions, stateActions };
}

function compileExecutionContract(semanticPlan, preflight, domainModel) {
  const bindingByOrdinal = new Map(semanticPlan.requirementBindings.map((binding) => [binding.requirementOrdinal, binding]));
  return {
    schemaVersion: 1,
    experienceContractSha256: preflight.experienceContractSha256,
    contextEnrichmentSha256: domainModel.contextEnrichmentSha256,
    domainModelSha256: domainModelRevision(domainModel),
    briefSha256: preflight.briefSha256,
    requirements: preflight.requirements.map((requirement) => {
      const binding = bindingByOrdinal.get(requirement.ordinal);
      return {
        id: requirement.id,
        source: requirement.source,
        priority: requirement.priority,
        kind: requirement.kind,
        satisfiedBy: binding.satisfiedBy,
        status: binding.status,
        ...(binding.reason ? { reason: binding.reason } : {}),
      };
    }),
    nativeCapabilities: preflight.nativeCapabilities,
    javascriptDependencies: preflight.javascriptDependencies,
    connectorOperations: preflight.connectorOperations,
  };
}

function mappingEntries(semanticPlan) {
  const entries = [
    ['domain', 'artifacts/prototypeDomainModel'],
    ['screens/productStructure', 'artifacts/nativeAppPlanMarkdown#product-structure'],
    ['designIntent', 'artifacts/nativeAppPlanMarkdown#semantic-design-intent'],
    ['navigationIntent', 'artifacts/navigationContract'],
    ['requirementBindings', 'artifacts/executionContract/requirements'],
    ['capabilitySelections', 'artifacts/executionContract/nativeCapabilities'],
    ['connectorIntentBindings', 'artifacts/executionContract/connectorOperations'],
    ['assumptions', 'artifacts/nativeAppPlanMarkdown#assumptions'],
    ['warnings', 'warnings'],
  ].map(([sourcePath, targetPath]) => ({ sourcePath: `/${sourcePath}`, targetPath: `/${targetPath}`, transform: 'deterministic' }));
  for (const screen of orderedSemanticScreens(semanticPlan)) {
    entries.push({ sourcePath: `/screens/items/${screen.id}`, targetPath: `/artifacts/experienceScreenContract/screens/${screen.id}`, transform: 'compile-route-and-foundation-identities' });
  }
  return entries;
}

function compilePrototypePlanDraft(projectRoot, semanticPlan) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const readAuthority = (relativePath, label) => readJson(safeExistingProjectFile(root, relativePath, label), label);
  const briefPath = fs.existsSync(path.join(root, '.tmp', 'experience-brief.md')) ? '.tmp/experience-brief.md' : 'brief.md';
  const briefText = fs.readFileSync(safeExistingProjectFile(root, briefPath, 'confirmed brief'), 'utf8');
  const experienceContract = readAuthority('.tmp/experience-contract.json', 'Experience Contract');
  const contextContract = readAuthority('.tmp/context-enrichment-contract.json', 'Context Contract');
  const workflowJourney = readAuthority('.tmp/workflow-journey-contract.json', 'Workflow Journey Contract');
  const preflight = readAuthority('.tmp/mobile-plan-execution-preflight.json', 'execution preflight');
  const packageJson = readAuthority('package.json', 'package manifest');
  const foundation = foundationContract(experienceContract);
  validatePlannerRequestSnapshot(root, { briefText, experienceContract, contextContract, workflowJourney, preflight, packageJson, foundation });
  const semanticValidation = validatePrototypeSemanticPlan(semanticPlan, {
    experienceContract,
    contextContract,
    workflowJourney,
    executionPreflight: preflight,
    foundationContract: foundation,
  });
  if (!semanticValidation.valid) throw new Error(`invalid prototype semantic plan: ${semanticValidation.errors.join('; ')}`);

  const domainModel = compileDomainModel(semanticPlan, experienceContract, contextContract);
  const screenContract = compileScreenContract(semanticPlan, experienceContract, foundation, contextContract);
  const boundWorkflow = bindWorkflowJourney(workflowJourney, semanticPlan);
  const executionContract = compileExecutionContract(semanticPlan, preflight, domainModel);
  const domainValidation = validatePrototypeDomainModel(domainModel, {
    experienceContractSha256: contractHash(experienceContract),
    contextEnrichmentSha256: contextEnrichmentRevision(contextContract),
  });
  if (!domainValidation.valid) throw new Error(`compiled Domain Model is invalid: ${domainValidation.errors.join('; ')}`);
  const screenErrors = validateExperienceScreenContract(screenContract, experienceContract, {
    dataContract: domainModel,
    executionContract,
    contextContract,
    navigationContract: {
      model: semanticPlan.navigationIntent.tabsStackRecommendation.recommended
        ? semanticPlan.navigationIntent.durableDestinations.length > 5 ? 'drawer' : 'tabs-stack'
        : 'stack',
    },
  });
  if (screenErrors.length) throw new Error(`compiled Screen Contract is invalid: ${screenErrors.join('; ')}`);
  const workflowValidation = validateWorkflowJourney(boundWorkflow, {
    briefText,
    experienceContract,
    contextContract,
    screenContract,
    domainModel,
  });
  if (!workflowValidation.valid) throw new Error(`compiled Workflow Journey is invalid: ${workflowValidation.errors.join('; ')}`);
  const executionValidation = validateMobilePlanExecutionContract(executionContract, {
    briefText,
    experienceContractSha256: contractHash(experienceContract),
    contextEnrichmentSha256: contextEnrichmentRevision(contextContract),
    domainModelSha256: domainModelRevision(domainModel),
    screenContract,
    dataContract: domainModel,
    packageJson,
    preflight,
  });
  if (!executionValidation.valid) throw new Error(`compiled execution contract is invalid: ${executionValidation.errors.join('; ')}`);

  const bundle = {
    version: 3,
    kind: 'mobile-plan-artifact-bundle',
    workflow: 'create-mobile-prototype',
    planningMode: 'prototype',
    artifacts: {
      nativeAppPlanMarkdown: '',
      contextEnrichmentContract: contextContract,
      workflowJourneyContract: boundWorkflow,
      navigationContract: null,
      prototypeDomainModel: domainModel,
      dataverseSchemaContract: null,
      experienceScreenContract: screenContract,
      experienceFoundationContract: foundation,
      executionContract,
    },
    sections: {
      dataModel: null,
      nativeCapabilities: null,
      connectors: null,
      screenPlan: null,
    },
    warnings: semanticPlan.warnings,
  };
  const preservationMap = {
    schemaVersion: 1,
    semanticPlanSha256: semanticPlanRevision(semanticPlan),
    entries: mappingEntries(semanticPlan),
  };
  return { bundle, preservationMap };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--semantic-plan') args.semanticPlan = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--map-output') args.mapOutput = argv[++index];
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node compile-prototype-plan-bundle.js --project-root <dir> [--semantic-plan .tmp/prototype-semantic-plan.staged.json] [--output .tmp/plan-artifact-bundle.json]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const semanticPath = safeExistingProjectFile(root, args.semanticPlan || '.tmp/prototype-semantic-plan.staged.json', 'staged prototype semantic plan');
    const result = compilePrototypePlanDraft(root, readJson(semanticPath, 'prototype semantic plan'));
    writeJsonAtomic(safeProjectOutput(root, args.output || '.tmp/plan-artifact-bundle.json', 'prototype draft bundle'), result.bundle);
    writeJsonAtomic(safeProjectOutput(root, args.mapOutput || '.tmp/prototype-semantic-map.json', 'prototype semantic map'), result.preservationMap);
    process.stdout.write(`${JSON.stringify({ status: 'compiled-draft', semanticPlanSha256: result.preservationMap.semanticPlanSha256 })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`compile-prototype-plan-bundle: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  bindWorkflowJourney,
  compileDomainModel,
  compileExecutionContract,
  compileScreenContext,
  compileSignatureComponent,
  compilePrototypePlanDraft,
  compileRouteGraph,
  compileScreenContract,
  mappingEntries,
  orderedSemanticScreens,
  validatePlannerRequestSnapshot,
};
