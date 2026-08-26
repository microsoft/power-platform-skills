#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');
const { parseScreenMap } = require('./compile-screen-build-pack');
const { normalizeScreenContract } = require('./lib/experience-screen-contract');
const { inferIconIntent } = require('./lib/navigation-icons');
const { stableStringify } = require('./resolve-context-enrichment');
const { resolveWorkflowJourney, workflowJourneyRevision } = require('./resolve-workflow-journey');
const { validateWorkflowJourney } = require('./validate-workflow-journey');

const ACTION_WORDS = /\b(?:scan|add|create|capture|pay|submit|sync|search|edit|delete|confirm|review)\b/i;
const DURABLE_WORDS = /\b(?:home|today|overview|records?|assignments?|queue|drafts?|inbox|conversations?|favorites?|saved|cart|bag|orders?|activity|history|progress|library|catalog|shop|accounts?|goals?|contacts?|calls?|settings|profile)\b/i;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function navigationContractRevision(contract) {
  return sha256(stableStringify(contract));
}

function screenGraphRevision(screenContract) {
  return sha256(stableStringify(screenContract));
}

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'destination';
}

function briefSupportsScreen(brief, screen) {
  const terms = `${screen.id || ''} ${screen.header?.title || ''}`.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4);
  return terms.some((term) => brief.toLowerCase().includes(term));
}

function candidateEvidence(screen, brief, journey, primaryScreenId) {
  const explicit = screen.navigation?.candidate || {};
  const semantic = `${screen.id || ''} ${screen.header?.title || ''} ${screen.purpose || ''} ${screen.route || ''}`;
  const stage = (journey.stages || []).find((item) => item.screenIds.includes(screen.id));
  const primary = screen.id === primaryScreenId || screen.role === 'primary';
  const declaredDurable = screen.productRole === 'durable-destination';
  const dynamic = (screen.routeParameters || []).some((parameter) => parameter.source === 'path' && parameter.required);
  const modal = screen.navigation?.kind === 'modal';
  const actionLike = explicit.isNotAnAction === false
    || (!primary && !declaredDurable && ACTION_WORDS.test(semantic) && !DURABLE_WORDS.test(semantic));
  const flowStep = explicit.isNotAFlowStep === false
    || Boolean(stage && !primary && !declaredDurable && explicit.revisitedIndependently !== true);
  const durableVocabulary = DURABLE_WORDS.test(semantic);
  const hasStableRoot = explicit.hasStableRoot ?? (primary || declaredDurable || (['tab-root', 'stack-root'].includes(screen.navigation?.kind) && !dynamic && !modal));
  const revisitedIndependently = explicit.revisitedIndependently ?? (primary || declaredDurable || screen.navigation?.kind === 'tab-root' || durableVocabulary);
  const preservesOwnState = explicit.preservesOwnState ?? (revisitedIndependently && !flowStep);
  const crossSessionValue = explicit.crossSessionValue ?? (/\b(?:draft|saved|history|inbox|record|assignment|progress|activity)\b/i.test(semantic));
  const peerToOtherDestinations = explicit.peerToOtherDestinations ?? (primary || declaredDurable || screen.navigation?.kind === 'tab-root' || durableVocabulary);
  const isNotAFlowStep = explicit.isNotAFlowStep ?? !flowStep;
  const isNotAnAction = explicit.isNotAnAction ?? !actionLike;
  const supportedByBriefOrSafeProductInference = explicit.supportedByBriefOrSafeProductInference ?? (primary || declaredDurable || screen.navigation?.kind === 'tab-root' || briefSupportsScreen(brief, screen));
  return {
    hasStableRoot,
    revisitedIndependently,
    preservesOwnState,
    crossSessionValue,
    peerToOtherDestinations,
    isNotAFlowStep,
    isNotAnAction,
    supportedByBriefOrSafeProductInference,
  };
}

function isDurable(evidence) {
  return evidence.hasStableRoot
    && evidence.revisitedIndependently
    && evidence.peerToOtherDestinations
    && evidence.isNotAFlowStep
    && evidence.isNotAnAction
    && evidence.supportedByBriefOrSafeProductInference;
}

function destinationLabel(screen) {
  return String(screen.navigation?.tabLabel || screen.header?.title || screen.id).replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

function isProfileScreen(screen) {
  return screen?.route === '/(app)/profile'
    || screen?.file === 'app/(app)/profile.tsx'
    || String(screen?.id || '').toLowerCase() === 'profile';
}

function navigationRole(screen, { destination = false, stage = null, presentation = null } = {}) {
  if (destination) return 'durable-destination';
  if (isProfileScreen(screen) || screen?.productRole === 'global-utility') return 'global-utility';
  if (presentation === 'full-screen-modal'
    || ['capture-surface', 'immersive-utility', 'immersive-modal'].includes(screen?.productRole)) return 'immersive-modal';
  if (stage || ['workflow-step', 'bounded-flow-step'].includes(screen?.productRole)) return 'bounded-flow-step';
  return 'nested-detail';
}

function profilePolicy(screens, destinations) {
  const profiles = screens.filter(isProfileScreen);
  if (profiles.length !== 1) throw new Error(`screen graph requires exactly one Profile screen; found ${profiles.length}`);
  const profile = profiles[0];
  const destination = destinations.find((item) => item.rootScreenId === profile.id);
  return {
    profileScreenId: profile.id,
    profileRoute: profile.route,
    profileAccess: destination ? 'destination' : 'header-action',
    profileReachableFromDestinationIds: destinations.map((item) => item.id),
  };
}

function ownerForScreen(screen, destinations, screenByRoute) {
  let parentRoute = screen.navigation?.parentRoute;
  const visited = new Set();
  while (parentRoute && !visited.has(parentRoute)) {
    visited.add(parentRoute);
    const destination = destinations.find((item) => item.route === parentRoute);
    if (destination) return destination;
    const parent = screenByRoute.get(parentRoute);
    parentRoute = parent?.navigation?.parentRoute;
  }
  const prefix = destinations
    .filter((destination) => screen.route.startsWith(`${destination.route}/`))
    .sort((left, right) => right.route.length - left.route.length)[0];
  return prefix || destinations[0];
}

function applyNavigationContractToScreenGraph(screenContract, contract) {
  const destinationByScreen = new Map(contract.destinations.map((destination) => [destination.rootScreenId, destination]));
  const flowByScreen = new Map(contract.flows.flatMap((flow) => flow.screenIds.map((screenId) => [screenId, flow])));
  return {
    ...screenContract,
    screens: screenContract.screens.map((screen) => {
      const destination = destinationByScreen.get(screen.id);
      const flow = flowByScreen.get(screen.id);
      if (destination) {
        return {
          ...screen,
          navigation: {
            ...screen.navigation,
            kind: contract.model === 'stack' ? 'stack-root' : 'tab-root',
            intent: contract.model === 'stack' ? 'replace' : 'navigate',
            ...(contract.model === 'stack' ? {} : { tabLabel: destination.label }),
            destinationId: destination.id,
            role: 'durable-destination',
            presentation: 'root',
            tabVisibility: contract.model === 'stack' ? 'not-applicable' : 'visible',
            backTarget: null,
            completionTarget: null,
            cancelTarget: null,
            deepLinkable: true,
          },
        };
      }
      const owner = contract.destinations.find((item) => item.id === flow?.ownerDestinationId) || contract.destinations[0];
      const modal = flow?.presentation !== 'nested-stack';
      return {
        ...screen,
        navigation: {
          ...screen.navigation,
          kind: modal ? 'modal' : 'pushed',
          intent: modal ? 'present' : 'push',
          parentRoute: screen.navigation?.parentRoute || owner.route,
          destinationId: owner.id,
          role: navigationRole(screen, {
            stage: (contract.flows.find((item) => item.id === flow?.id)?.id || '').includes('journey') ? {} : null,
            presentation: flow?.presentation,
          }),
          presentation: flow?.presentation || 'nested-stack',
          tabVisibility: flow?.tabVisibility || (contract.model === 'stack' ? 'not-applicable' : 'visible'),
          backTarget: modal ? 'owner-root' : 'nearest-stack',
          completionTarget: owner.id,
          cancelTarget: owner.id,
          deepLinkable: true,
        },
      };
    }),
  };
}

function bindWorkflowJourneyToScreenGraph(workflowJourney, screenContract) {
  const screens = screenContract?.screens || [];
  const screenById = new Map(screens.map((screen) => [screen.id, screen]));
  const primary = screens.find((screen) => screen.role === 'primary') || screens[0];
  const candidates = screens.filter((screen) => !isProfileScreen(screen));
  const usedFallbacks = new Set();
  const screenIdMap = new Map();
  const stages = (workflowJourney?.stages || []).map((stage, stageIndex) => {
    const mappedScreenIds = (stage.screenIds || []).map((screenId) => {
      if (screenById.has(screenId)) return screenId;
      const terms = [screenId, stage.id, stage.label].map(slug).filter(Boolean);
      const semanticMatch = candidates.find((screen) => {
        const semantic = slug(`${screen.id} ${screen.purpose || ''} ${screen.header?.title || ''}`);
        return terms.some((term) => semantic.includes(term));
      });
      const fallback = semanticMatch
        || (stageIndex === 0 ? primary : null)
        || candidates.find((screen) => !usedFallbacks.has(screen.id))
        || primary;
      if (!fallback) return screenId;
      usedFallbacks.add(fallback.id);
      screenIdMap.set(screenId, fallback.id);
      return fallback.id;
    });
    return { ...stage, screenIds: [...new Set(mappedScreenIds)] };
  });
  const mapScreenId = (screenId) => screenIdMap.get(screenId) || screenId;
  return {
    ...workflowJourney,
    stages,
    actions: (workflowJourney?.actions || []).map((action) => ({
      ...action,
      target: mapScreenId(action.target),
    })),
    stateActions: (workflowJourney?.stateActions || []).map((stateAction) => ({
      ...stateAction,
      screenId: mapScreenId(stateAction.screenId),
    })),
  };
}

function finalizeWorkflowJourney(brief, experience, contextContract, workflowJourney, screenContract, domainModel = null, sourceSchemaVersion = screenContract?.schemaVersion) {
  if (contextContract && sourceSchemaVersion === 1 && workflowJourney?.decisionOwner !== 'model') {
    return resolveWorkflowJourney(brief, experience, contextContract, { screenContract, domainModel });
  }
  return bindWorkflowJourneyToScreenGraph(workflowJourney, screenContract);
}

function applyActionContractToScreenGraph(screenContract, actionContract, navigationModel = 'stack') {
  if (actionContract?.decisionOwner !== 'model' || !Array.isArray(actionContract.actions)) return screenContract;
  const primaryByScreen = new Map();
  for (const action of actionContract.actions.filter((candidate) => candidate.semanticRole === 'primary')) {
    const actions = primaryByScreen.get(action.screenId) || [];
    actions.push(action);
    primaryByScreen.set(action.screenId, actions);
  }
  return {
    ...screenContract,
    screens: (screenContract.screens || []).map((screen) => {
      const actions = primaryByScreen.get(screen.id) || [];
      if (actions.length > 1) throw new Error(`screen ${screen.id} has ${actions.length} model-owned primary actions`);
      if (!actions.length) return screen;
      const action = actions[0];
      const placement = ['inline', 'sticky-bottom', 'header', 'floating'].includes(action.placement)
        ? action.placement
        : 'inline';
      const pending = action.pendingLabel || ['operation', 'connector', 'native', 'sequence'].includes(action.executor?.kind);
      return {
        ...screen,
        primaryAction: {
          id: action.id,
          label: action.label,
          placement,
          binding: `action:${action.id}`,
          doubleTapPolicy: pending ? 'disable-while-pending' : 'not-applicable',
          ...(placement === 'sticky-bottom' ? {
            clearance: {
              safeArea: true,
              tabBar: navigationModel === 'tabs-stack' ? 'above' : 'not-applicable',
            },
          } : {}),
        },
      };
    }),
  };
}

function withCriticalFlow(screenContract, workflowJourney) {
  const screens = screenContract?.screens || [];
  const screenIds = new Set(screens.map((screen) => screen.id));
  const current = screenContract?.criticalFlow;
  if (Array.isArray(current?.screenIds)
    && current.screenIds.length >= 2
    && current.screenIds.every((screenId) => screenIds.has(screenId))
    && typeof current.outcome === 'string'
    && current.outcome.trim()) {
    return screenContract;
  }
  const primary = screens.find((screen) => screen.role === 'primary') || screens[0];
  const keyFlow = screens.find((screen) => screen.route === screenContract?.keyFlow?.route)
    || screens.find((screen) => screen.role === 'key-flow');
  const stagedScreenIds = (workflowJourney?.stages || [])
    .flatMap((stage) => stage.screenIds || [])
    .filter((screenId) => screenIds.has(screenId));
  const criticalScreenIds = [...new Set([
    primary?.id,
    ...stagedScreenIds,
    keyFlow?.id,
  ].filter(Boolean))];
  if (criticalScreenIds.length < 2) {
    const supporting = screens.find((screen) => screen.id !== primary?.id && !isProfileScreen(screen));
    if (supporting) criticalScreenIds.push(supporting.id);
  }
  return {
    ...screenContract,
    criticalFlow: {
      screenIds: criticalScreenIds,
      outcome: current?.outcome || screenContract?.keyFlow?.outcome || workflowJourney?.primaryOutcome || 'Complete the primary product flow.',
    },
  };
}

function resolveNavigationFromIntent(experienceContract, workflowJourney, preliminaryScreenContract, navigationIntent, productStructure = null) {
  const screens = preliminaryScreenContract?.screens || [];
  const screenById = new Map(screens.map((screen) => [screen.id, screen]));
  const screenByRoute = new Map(screens.map((screen) => [screen.route, screen]));
  const revisitByScreen = new Map(navigationIntent.revisitPatterns.map((pattern) => [pattern.screenId, pattern]));
  const visibilityByScreen = new Map(navigationIntent.nestedScreenTabVisibility.map((item) => [item.screenId, item.visibility]));
  const durableCount = navigationIntent.durableDestinations.length;
  const model = navigationIntent.stackOnlyEvidence.length
    ? 'stack'
    : navigationIntent.tabsStackRecommendation.recommended
      ? durableCount > 5 ? 'drawer' : 'tabs-stack'
      : 'stack';
  const destinations = navigationIntent.durableDestinations.map((intent, index) => {
    const screen = screenById.get(intent.screenId);
    if (!screen) throw new Error(`navigationIntent durable destination references unknown screen ${intent.screenId}`);
    const revisit = revisitByScreen.get(intent.screenId);
    if (!revisit) throw new Error(`navigationIntent lacks revisit evidence for ${intent.screenId}`);
    return {
      id: slug(intent.screenId),
      label: intent.label,
      purpose: screen.purpose,
      order: index + 1,
      rootScreenId: screen.id,
      route: screen.route,
      iconIntent: intent.iconIntent,
      durabilityEvidence: [
        `revisit:${revisit.frequency}`,
        `evidence:${revisit.evidence}`,
        `jobs:${navigationIntent.jobStructure.mode}`,
        ...(revisit.preservesState ? ['preserves-state'] : []),
        ...(revisit.crossSessionValue ? ['cross-session-value'] : []),
      ],
      independentJob: true,
      statePolicy: 'preserve',
      badgeBinding: intent.badgeBinding,
      nestedScreenIds: [],
      testId: `navigation-destination-${slug(intent.screenId)}`,
    };
  });
  const initialDestination = destinations.find((destination) => destination.rootScreenId === navigationIntent.primaryDestinationScreenId);
  if (!initialDestination) throw new Error('navigationIntent primary destination is not durable');
  const primaryScreenId = productStructure?.primaryScreenId || navigationIntent.primaryDestinationScreenId;
  const launchScreenId = productStructure?.launchRoute || primaryScreenId;
  const launchScreen = screenById.get(launchScreenId);
  const resumeScreenId = productStructure?.resumeRoute ?? null;
  const resumeScreen = resumeScreenId ? screenById.get(resumeScreenId) : null;
  if (!launchScreen) throw new Error(`productStructure launchRoute references unknown screen ${launchScreenId}`);
  if (resumeScreenId && !resumeScreen) throw new Error(`productStructure resumeRoute references unknown screen ${resumeScreenId}`);
  const nonRoots = screens.filter((screen) => !destinations.some((destination) => destination.rootScreenId === screen.id));
  const flows = nonRoots.map((screen) => {
    const owner = ownerForScreen(screen, destinations, screenByRoute);
    const presentation = screen.navigation?.presentation || (screen.navigation?.kind === 'modal' ? 'modal' : 'nested-stack');
    owner.nestedScreenIds.push(screen.id);
    return {
      id: `flow-${slug(screen.id)}`,
      ownerDestinationId: owner.id,
      presentation,
      screenIds: [screen.id],
      tabVisibility: model === 'stack' ? 'not-applicable' : visibilityByScreen.get(screen.id),
      dismissBehavior: presentation === 'nested-stack' ? 'nearest-stack-back' : 'return-to-owner-preserving-state',
      completionDestinationId: owner.id,
      cancelDestinationId: owner.id,
      deepLinkRestoration: 'activate-owner-and-build-back-path',
    };
  });
  let contract = {
    schemaVersion: 1,
    experienceContractSha256: contractHash(experienceContract),
    workflowContractSha256: workflowJourneyRevision(workflowJourney),
    screenGraphSha256: '',
    model,
    initialDestinationId: initialDestination.id,
    destinationCount: destinations.length,
    destinations,
    flows,
    routingPolicy: {
      primaryScreenId,
      launchScreenId,
      launchRoute: launchScreen.route,
      launchRationale: productStructure?.launchRationale || 'Compatibility launch uses the initial durable destination.',
      resumeScreenId,
      resumeRoute: resumeScreen?.route || null,
      resumeRoutePolicy: productStructure?.resumeRoutePolicy || 'none',
      resumeRationale: productStructure?.resumeRationale || 'Compatibility navigation does not declare a resumable route.',
      keyFlowEntryScreenId: productStructure?.keyFlowScreenIds?.[0] || null,
    },
    globalRoutePolicy: {
      homeReturnRequired: destinations.length > 1 || nonRoots.length > 0,
      deepLinksRestoreOwningDestination: true,
      tabReselectBehavior: model === 'tabs-stack' ? 'pop-owner-stack-to-root' : 'not-applicable',
      backBehavior: 'nearest-stack-then-system',
      unknownRouteBehavior: 'safe-root',
      logoutDestination: '/login',
      ...profilePolicy(screens, destinations),
    },
    adaptivePresentation: {
      compact: model === 'tabs-stack' ? 'bottom-tabs' : model,
      medium: model === 'tabs-stack' ? 'navigation-rail' : model,
      expanded: model === 'tabs-stack' ? 'sidebar-or-rail' : model,
      destinationIdentityStableAcrossSizes: true,
    },
    accessibility: { labelsRequired: true, selectedStateRequired: true, badgesHaveAccessibleValues: true, minimumTouchTarget: 44 },
    decision: {
      selectedBy: 'navigation-resolver',
      provisionalHint: experienceContract.provisionalNavigationHint || experienceContract.navigationModel || null,
      evidence: [
        ...navigationIntent.jobStructure.evidence,
        `tabs-stack:${navigationIntent.tabsStackRecommendation.recommended ? 'recommended' : 'not-recommended'}:${navigationIntent.tabsStackRecommendation.rationale}`,
      ],
      rejectedAlternatives: model === 'stack' ? ['tabs-stack: semantic intent supplied stack-only evidence'] : ['stack: semantic intent requires durable peer switching'],
      stackOnlyReason: model === 'stack' ? navigationIntent.stackOnlyEvidence.join(' ') : null,
      stackOnlyEvidence: [...navigationIntent.stackOnlyEvidence],
      returnHomeMechanism: model === 'stack' ? 'root stack back/replace to initial destination' : 'persistent destination shell',
    },
  };
  const screenContract = applyNavigationContractToScreenGraph(preliminaryScreenContract, contract);
  contract = { ...contract, screenGraphSha256: screenGraphRevision(screenContract) };
  return { contract, screenContract };
}

function resolveNavigationContract(briefText, experienceContract, workflowJourney, preliminaryScreenContract, options = {}) {
  const brief = String(briefText || '').trim();
  if (!brief) throw new Error('confirmed brief must be non-empty');
  const screens = preliminaryScreenContract?.screens || [];
  if (!screens.length) throw new Error('preliminary Screen Graph must contain screens');
  if (options.navigationIntent) return resolveNavigationFromIntent(experienceContract, workflowJourney, preliminaryScreenContract, options.navigationIntent, options.productStructure);
  const primary = screens.find((screen) => screen.role === 'primary') || screens[0];
  const candidates = screens.map((screen) => ({ screen, evidence: candidateEvidence(screen, brief, workflowJourney, primary.id) }));
  const durable = candidates.filter((candidate) => isDurable(candidate.evidence));
  if (!durable.some((candidate) => candidate.screen.id === primary.id)) durable.unshift(candidates.find((candidate) => candidate.screen.id === primary.id));
  const uniqueDurable = [...new Map(durable.filter(Boolean).map((candidate) => [candidate.screen.id, candidate])).values()];
  const model = uniqueDurable.length > 5 ? 'drawer' : uniqueDurable.length >= 2 ? 'tabs-stack' : 'stack';
  const destinations = uniqueDurable.map(({ screen, evidence }, index) => {
    const label = destinationLabel(screen);
    return {
      id: slug(screen.id),
      label,
      purpose: screen.purpose,
      order: index + 1,
      rootScreenId: screen.id,
      route: screen.route,
      iconIntent: screen.navigation?.candidate?.iconIntent || inferIconIntent(`${label} ${screen.purpose || ''}`),
      durabilityEvidence: Object.entries(evidence).filter(([, value]) => value === true).map(([key]) => key),
      independentJob: true,
      statePolicy: 'preserve',
      badgeBinding: screen.navigation?.candidate?.badgeBinding || null,
      nestedScreenIds: [],
      testId: `navigation-destination-${slug(screen.id)}`,
    };
  });
  const screenByRoute = new Map(screens.map((screen) => [screen.route, screen]));
  const nonRoots = screens.filter((screen) => !destinations.some((destination) => destination.rootScreenId === screen.id));
  const flows = nonRoots.map((screen) => {
    const owner = ownerForScreen(screen, destinations, screenByRoute);
    const stage = (workflowJourney.stages || []).find((item) => item.screenIds.includes(screen.id));
    const immersive = screen.navigation?.kind === 'modal' || /\b(?:camera|capture|signature|payment)\b/i.test(`${screen.id} ${screen.purpose}`);
    owner.nestedScreenIds.push(screen.id);
    return {
      id: `${stage ? 'journey' : 'flow'}-${slug(screen.id)}`,
      ownerDestinationId: owner.id,
      presentation: immersive ? 'full-screen-modal' : 'nested-stack',
      screenIds: [screen.id],
      tabVisibility: model === 'stack' ? 'not-applicable' : immersive ? 'covered-by-modal' : 'visible',
      dismissBehavior: immersive ? 'return-to-owner-preserving-state' : 'nearest-stack-back',
      completionDestinationId: owner.id,
      cancelDestinationId: owner.id,
      deepLinkRestoration: 'activate-owner-and-build-back-path',
    };
  });
  const provisionalHint = experienceContract.provisionalNavigationHint || experienceContract.navigationModel || null;
  let contract = {
    schemaVersion: 1,
    experienceContractSha256: contractHash(experienceContract),
    workflowContractSha256: workflowJourneyRevision(workflowJourney),
    screenGraphSha256: '',
    model,
    initialDestinationId: destinations[0].id,
    destinationCount: destinations.length,
    destinations,
    flows,
    routingPolicy: {
      primaryScreenId: primary.id,
      launchScreenId: primary.id,
      launchRoute: primary.route,
      launchRationale: 'Compatibility launch uses the resolved permanent primary destination.',
      resumeScreenId: null,
      resumeRoute: null,
      resumeRoutePolicy: 'none',
      resumeRationale: 'Compatibility navigation has no explicit semantic resume policy.',
      keyFlowEntryScreenId: screens.find((screen) => screen.role === 'key-flow')?.id || null,
    },
    globalRoutePolicy: {
      homeReturnRequired: destinations.length > 1 || nonRoots.length > 0,
      deepLinksRestoreOwningDestination: true,
      tabReselectBehavior: model === 'tabs-stack' ? 'pop-owner-stack-to-root' : 'not-applicable',
      backBehavior: 'nearest-stack-then-system',
      unknownRouteBehavior: 'safe-root',
      logoutDestination: '/login',
      ...profilePolicy(screens, destinations),
    },
    adaptivePresentation: {
      compact: model === 'tabs-stack' ? 'bottom-tabs' : model,
      medium: model === 'tabs-stack' ? 'navigation-rail' : model,
      expanded: model === 'tabs-stack' ? 'sidebar-or-rail' : model,
      destinationIdentityStableAcrossSizes: true,
    },
    accessibility: { labelsRequired: true, selectedStateRequired: true, badgesHaveAccessibleValues: true, minimumTouchTarget: 44 },
    decision: {
      selectedBy: 'navigation-resolver',
      provisionalHint,
      evidence: [
        `${destinations.length} durable destination${destinations.length === 1 ? '' : 's'} survived action/flow filtering`,
        `${nonRoots.length} screen${nonRoots.length === 1 ? '' : 's'} remain nested or temporary flows`,
      ],
      rejectedAlternatives: [model === 'stack' ? 'tabs-stack: fewer than two durable peers' : 'stack: durable peer destinations require persistent switching'],
      stackOnlyReason: model === 'stack' ? 'Fewer than two durable peer destinations remain after action and workflow-step filtering.' : null,
      stackOnlyEvidence: model === 'stack' ? [
        `${destinations.length} durable destination${destinations.length === 1 ? '' : 's'}`,
        `${nonRoots.length} nested or temporary flow screen${nonRoots.length === 1 ? '' : 's'}`,
      ] : [],
      returnHomeMechanism: model === 'stack' ? 'root stack back/replace to initial destination' : 'persistent destination shell',
    },
  };
  const screenContract = applyNavigationContractToScreenGraph(preliminaryScreenContract, contract);
  contract = { ...contract, screenGraphSha256: screenGraphRevision(screenContract) };
  return { contract, screenContract };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--bundle') args.bundle = argv[++index];
    else if (argv[index] === '--brief') args.brief = argv[++index];
    else if (argv[index] === '--experience-contract') args.experienceContract = argv[++index];
    else if (argv[index] === '--workflow-contract') args.workflowContract = argv[++index];
    else if (argv[index] === '--screen-contract') args.screenContract = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--update-bundle') args.updateBundle = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node resolve-navigation-contract.js --project-root <dir> [--bundle .tmp/planner-artifact-bundle.json --update-bundle] [--brief <path>] [--experience-contract <path>] [--workflow-contract <path>] [--screen-contract <path>] [--output .tmp/navigation-contract.json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const bundlePath = args.bundle ? path.resolve(root, args.bundle) : null;
    const bundle = bundlePath ? JSON.parse(fs.readFileSync(bundlePath, 'utf8')) : null;
    const readJson = (value, fallback) => JSON.parse(fs.readFileSync(path.resolve(root, value || fallback), 'utf8'));
    const briefPath = path.resolve(root, args.brief || (fs.existsSync(path.join(root, '.tmp', 'experience-brief.md')) ? '.tmp/experience-brief.md' : 'brief.md'));
    const experience = readJson(args.experienceContract, '.tmp/experience-contract.json');
    const rawWorkflow = bundle?.artifacts?.workflowJourneyContract || readJson(args.workflowContract, '.tmp/workflow-journey-contract.json');
    const rawScreens = bundle?.artifacts?.experienceScreenContract || readJson(args.screenContract, '.tmp/experience-screen-contract.json');
    const planPath = path.join(root, 'native-app-plan.md');
    const fallbackScreens = fs.existsSync(planPath) ? parseScreenMap(fs.readFileSync(planPath, 'utf8')) : [];
    const sourceScreenSchemaVersion = rawScreens.schemaVersion;
    const screens = Array.isArray(rawScreens.screens)
      ? rawScreens
      : {
          ...rawScreens,
          schemaVersion: 2,
          screens: normalizeScreenContract(rawScreens, experience, fallbackScreens),
        };
    const brief = fs.readFileSync(briefPath, 'utf8');
    const contextPath = path.join(root, '.tmp', 'context-enrichment-contract.json');
    const domainPath = path.join(root, '.tmp', 'prototype-domain-model.json');
    const actionPath = path.join(root, '.tmp', 'screen-action-contract.json');
    const contextContract = fs.existsSync(contextPath) ? JSON.parse(fs.readFileSync(contextPath, 'utf8')) : null;
    const domainModel = fs.existsSync(domainPath) ? JSON.parse(fs.readFileSync(domainPath, 'utf8')) : null;
    const actionContract = fs.existsSync(actionPath) ? JSON.parse(fs.readFileSync(actionPath, 'utf8')) : null;
    const actionBoundScreens = applyActionContractToScreenGraph(screens, actionContract, experience.navigationModel);
    const workflow = finalizeWorkflowJourney(brief, experience, contextContract, rawWorkflow, actionBoundScreens, domainModel, sourceScreenSchemaVersion);
    const finalizedScreens = withCriticalFlow(actionBoundScreens, workflow);
    const workflowValidation = validateWorkflowJourney(workflow, {
      briefText: brief,
      experienceContract: experience,
      ...(contextContract ? { contextContract } : {}),
      screenContract: finalizedScreens,
      ...(domainModel ? { domainModel } : {}),
    });
    if (!workflowValidation.valid) throw new Error(`finalized Workflow Journey is invalid: ${workflowValidation.errors.join('; ')}`);
    const result = resolveNavigationContract(brief, experience, workflow, finalizedScreens);
    const outputPath = path.resolve(root, args.output || '.tmp/navigation-contract.json');
    if (bundle && args.updateBundle) {
      bundle.artifacts.workflowJourneyContract = workflow;
      bundle.artifacts.navigationContract = result.contract;
      bundle.artifacts.experienceScreenContract = result.screenContract;
      writeJsonAtomic(bundlePath, bundle);
    } else {
      writeJsonAtomic(path.resolve(root, args.workflowContract || '.tmp/workflow-journey-contract.json'), workflow);
      writeJsonAtomic(outputPath, result.contract);
      writeJsonAtomic(path.resolve(root, args.screenContract || '.tmp/experience-screen-contract.json'), result.screenContract);
    }
    process.stdout.write(`${bundle && args.updateBundle ? 'Navigation attached to staged bundle' : `Navigation contract written: ${outputPath}`} (${result.contract.model})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`resolve-navigation-contract: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  applyActionContractToScreenGraph,
  applyNavigationContractToScreenGraph,
  bindWorkflowJourneyToScreenGraph,
  finalizeWorkflowJourney,
  isProfileScreen,
  navigationRole,
  navigationContractRevision,
  profilePolicy,
  resolveNavigationContract,
  resolveNavigationFromIntent,
  screenGraphRevision,
  withCriticalFlow,
};