'use strict';

// Fixture builders for the product-experience compiler tests.
//
// The builders are deliberately domain-agnostic: a scenario supplies its own vocabulary,
// semantic dimensions, jobs, steps, and compositions. Nothing in this file maps a domain to a
// layout, a palette, or a screen set — if it did, the tests could not tell the difference
// between a compiler that reasons from the contract and one that guesses from the industry.

const {
  contractRevision,
} = require('../../lib/product-experience-contracts');

// Contracts are pure JSON, so a serialize/parse round trip is a complete deep clone. Every
// builder clones its base before merging: a test that mutates a returned contract (deleting an
// evidence key, for example) must not corrupt the shared base for later tests.
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Arrays are replaced wholesale rather than merged: a scenario that overrides
// accessibilityPriorities means "these, not the base ones plus these".
function deepMerge(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined) {
      delete result[key];
      continue;
    }
    result[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return result;
}

function evidence(text) {
  return [{ text, source: 'user-prompt' }];
}

const BASE_EXPERIENCE = {
  schemaVersion: 1,
  contractType: 'product-experience',
  productName: 'Base Product',
  domainVocabulary: ['record'],
  primaryUser: {
    role: 'Frontline user',
    proficiency: 'practiced',
    situation: 'Works between other tasks, usually standing, on a personal phone',
  },
  primaryGoal: 'Finish the recurring task without switching to a laptop',
  primaryIntent: 'transact',
  workflowShape: 'linear-sequence',
  operatingContext: { environment: 'indoor-mobile', connectivity: 'always-online', interruptionLevel: 'moderate' },
  sessionPattern: { frequency: 'daily', duration: 'one-to-three-minutes', resumability: 'helpful-to-resume' },
  informationDensity: 'balanced',
  interactionTempo: 'steady',
  decisionRisk: { level: 'moderate', drivers: ['A wrong entry is visible to other people'] },
  contentEmphasis: { primary: 'status-signals', secondary: [] },
  collaborationMode: 'solo',
  visualPersonality: {
    tone: 'confident',
    expressiveness: 'moderate',
    rationale: 'The user is mid-task, so the next step has to be unmistakable at a glance.',
  },
  mediaStrategy: {
    necessity: 'supportive',
    types: ['photo'],
    capture: 'sourced',
    fallback: 'Neutral block carrying the record name when no image exists',
  },
  accessibilityPriorities: ['large-touch-targets', 'high-contrast'],
  firstViewport: {
    focalQuestion: 'What do I need to deal with next?',
    regionOrder: ['context', 'focal-content', 'primary-action'],
    primaryAction: 'Continue',
  },
  signatureExperience: {
    name: 'Next-step band',
    description: 'A persistent band that always states the single next step and its consequence.',
    whyNotGeneric: 'A plain list would make the user re-derive the next step on every visit.',
  },
  forbiddenDefaults: ['Undifferentiated card list with no visual hierarchy'],
  promptEvidence: {
    primaryUser: evidence('my team uses their own phones'),
    primaryGoal: evidence('they should be able to finish it on the phone'),
    primaryIntent: evidence('they need to get it done, not browse'),
    workflowShape: evidence('one thing after another'),
    operatingContext: evidence('they are moving around all day'),
    contentEmphasis: evidence('show them where things stand'),
    mediaStrategy: evidence('pictures help but are not the point'),
    visualPersonality: evidence('should feel dependable'),
  },
  confidence: { overall: 'high', byDimension: { primaryGoal: 'high', workflowShape: 'medium' } },
  assumptions: [],
  source: 'brief',
};

function buildExperience(overrides = {}) {
  return deepMerge(clone(BASE_EXPERIENCE), overrides);
}

function buildScope(experience, overrides = {}) {
  const base = {
    schemaVersion: 1,
    contractType: 'product-scope',
    experienceRevision: contractRevision(experience),
    productComplexity: 'focused',
    complexityJustification: 'One journey, one primary role, no independent back-office workspace.',
    coreJobs: [],
    supportingJobs: [],
    deferredJobs: [],
    screenBudget: { target: 4, max: 6 },
    screens: [],
    newTableBudget: { target: 2, max: 4 },
    newTables: [],
    dataEntities: [],
  };
  const scope = deepMerge(base, overrides);
  // Any override may change the experience the scope was derived from, so re-bind unless the
  // test is deliberately exercising a stale binding.
  if (!Object.prototype.hasOwnProperty.call(overrides, 'experienceRevision')) {
    scope.experienceRevision = contractRevision(experience);
  }
  return scope;
}

function buildJourney(experience, scope, overrides = {}) {
  const base = {
    schemaVersion: 1,
    contractType: 'workflow-journey',
    experienceRevision: contractRevision(experience),
    scopeRevision: contractRevision(scope),
    journeys: [],
  };
  const journey = deepMerge(base, overrides);
  if (!Object.prototype.hasOwnProperty.call(overrides, 'experienceRevision')) {
    journey.experienceRevision = contractRevision(experience);
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'scopeRevision')) {
    journey.scopeRevision = contractRevision(scope);
  }
  return journey;
}

function buildBuildPack(experience, scope, journey, overrides = {}) {
  const base = {
    schemaVersion: 1,
    contractType: 'screen-build-pack',
    experienceRevision: contractRevision(experience),
    scopeRevision: contractRevision(scope),
    journeyRevision: contractRevision(journey),
    packs: [],
  };
  const buildPack = deepMerge(base, overrides);
  for (const [field, source] of [['experienceRevision', experience], ['scopeRevision', scope], ['journeyRevision', journey]]) {
    if (!Object.prototype.hasOwnProperty.call(overrides, field)) buildPack[field] = contractRevision(source);
  }
  return buildPack;
}

function defaultStates(label) {
  return {
    loading: `Skeleton of the ${label} layout`,
    empty: `Explains why ${label} is empty and what to do`,
    error: `States what failed on ${label} and offers a retry`,
    populated: `${label} with real content`,
    offline: `${label} from the last synced snapshot, marked as such`,
  };
}

/**
 * Fills the mechanical text fields of a step so scenario descriptors only have to declare what
 * is genuinely different between products: the step's name, its composition family, the
 * question it answers, its focal content, its primary action, and its signature interaction.
 */
function normalizeStep(step, descriptor, index, total) {
  const title = step.title;
  const action = step.action;
  const previewNeedsMedia = Boolean(
    step.media
    || (descriptor.dimensions?.mediaStrategy?.necessity
      && descriptor.dimensions.mediaStrategy.necessity !== 'none')
    || ['imagery', 'mixed-media', 'map-spatial'].includes(descriptor.dimensions?.contentEmphasis?.primary),
  );
  const previewContent = step.previewContent || {
    eyebrow: step.context || `${title} context`,
    headline: step.focal,
    supportingText: step.question,
    ...(previewNeedsMedia ? { heroMediaLabel: `${title} visual` } : {}),
    metrics: [
      { label: 'Status', value: index === 0 ? 'Ready to start' : 'In progress' },
      { label: 'Confidence', value: step.trust || `Evidence available for ${title}` },
    ],
    records: [
      {
        title: step.dominant || `${title} priority`,
        subtitle: step.supporting?.[0] || `Most relevant information for ${title.toLowerCase()}`,
        meta: step.context || `${title} context`,
        badge: index === 0 ? 'Recommended' : 'Current',
        ...(previewNeedsMedia ? { mediaLabel: `${title} primary record` } : {}),
      },
      {
        title: `${title} alternative`,
        subtitle: step.supporting?.[1] || 'A second path with distinct supporting evidence',
        meta: step.decide || `Decision support for ${title}`,
        ...(previewNeedsMedia ? { mediaLabel: `${title} alternative record` } : {}),
      },
      {
        title: `${title} recent`,
        subtitle: step.supporting?.[2] || 'Recently viewed information for comparison',
        meta: step.trust || `Source verified for ${title}`,
        ...(previewNeedsMedia ? { mediaLabel: `${title} recent record` } : {}),
      },
    ],
    fields: [
      { label: step.context || 'Context', value: step.dominant || title },
      { label: 'Next decision', value: action },
    ],
    summaryRows: [
      { label: 'Outcome', value: step.outcome || `Advance from ${title}` },
      { label: 'Evidence', value: step.trust || `Verified context for ${title}` },
    ],
  };

  return {
    id: step.id,
    screenId: step.screenId,
    title,
    pattern: step.pattern,
    surfaceKind: step.surfaceKind,
    purpose: step.purpose || `${title}: ${step.question}`,
    justification: step.justification
      || `Hosts the "${title}" step of the ${descriptor.job.journeyName} journey.`,
    userQuestion: step.question,
    focalContent: step.focal,
    primaryAction: action,
    primaryActionOutcome: step.outcome || `Moves the user forward from ${title}`,
    dominant: step.dominant,
    supporting: step.supporting || [`Secondary detail for ${title}`],
    trustSignal: step.trust || `Evidence shown on ${title}`,
    decisionSupport: step.decide || `Comparison aid on ${title}`,
    contextLabel: step.context || `${title} context`,
    signatureName: step.signature,
    signatureDescription: step.signatureDetail || `${step.signature}: the interaction that makes ${title} specific to this product.`,
    forbiddenDefault: step.forbidden,
    compositionRationale: step.why,
    userAction: step.userAction || `${action} on ${title}`,
    entryCondition: step.entry || (index === 0 ? 'App opened' : `Previous step completed`),
    exitCondition: step.exit || (index === total - 1 ? 'Journey complete' : `${action} succeeded`),
    regionOrder: step.regionOrder,
    dataOperation: step.dataOperation,
    media: step.media,
    incoming: step.incoming,
    outgoing: step.outgoing,
    dataAssumptions: step.dataAssumptions,
    previewContent,
  };
}

/**
 * Expands a compact scenario descriptor into a fully bound four-contract bundle.
 *
 * A descriptor declares: the product name, its vocabulary, whichever semantic dimensions it
 * overrides, one core job, and an ordered list of steps. Each step becomes one screen, one
 * journey step, and one build pack. The mapping is mechanical and identical for every
 * scenario, which is the point — the differences between scenarios come only from what the
 * descriptor declares.
 */
function scenarioBundle(descriptor) {
  const experience = buildExperience({
    productName: descriptor.productName,
    domainVocabulary: descriptor.vocabulary,
    primaryGoal: descriptor.primaryGoal,
    ...descriptor.dimensions,
  });

  const jobId = descriptor.job.id;
  const steps = descriptor.steps.map((step, index) => normalizeStep(step, descriptor, index, descriptor.steps.length));
  const primaryEntity = descriptor.entity;
  const entityScreenId = descriptor.entityScreenId || null;

  const screens = steps.map((step) => ({
    id: step.screenId,
    route: `/${step.screenId}`,
    title: step.title,
    purpose: step.purpose,
    userFacing: true,
    pattern: step.pattern,
    ...(entityScreenId === step.screenId ? { entity: primaryEntity } : {}),
    jobIds: [jobId],
    justification: step.justification,
  }));

  const scope = buildScope(experience, {
    productComplexity: descriptor.productComplexity || 'focused',
    complexityJustification: descriptor.complexityJustification
      || 'A single primary journey performed by one role; no independent second workspace.',
    coreJobs: [{
      id: jobId,
      statement: descriptor.job.statement,
      actor: descriptor.job.actor,
      outcome: descriptor.job.outcome,
      criticality: 'critical',
      surface: { kind: 'screen', screenId: steps[0].screenId },
      criticalSteps: steps.map((step) => step.id),
      evidence: descriptor.job.evidence,
    }],
    screens,
    screenBudget: descriptor.screenBudget || { target: Math.max(3, steps.length), max: 6 },
    newTableBudget: { target: 2, max: 4 },
    newTables: [{
      name: primaryEntity,
      jobIds: [jobId],
      lifecycleJustification: {
        reasons: ['independent-lifecycle', 'independent-querying-or-reporting'],
        statement: descriptor.tableJustification,
      },
    }],
    dataEntities: [
      { name: primaryEntity, role: 'primary', realization: 'new-table', screenIds: entityScreenId ? [entityScreenId] : [] },
      {
        name: descriptor.referenceEntity,
        role: 'reference',
        realization: 'choice-column',
        screenIds: [],
        note: 'A fixed set of values with no lifecycle of its own, so it stays a Choice column.',
      },
    ],
  });

  const journey = buildJourney(experience, scope, {
    journeys: [{
      id: `${jobId}-journey`,
      jobId,
      name: descriptor.job.journeyName,
      resumable: descriptor.resumable === true,
      steps: steps.map((step, index) => ({
        id: step.id,
        order: index + 1,
        label: step.title,
        satisfies: [step.id],
        surface: { kind: step.surfaceKind || 'screen', screenId: step.screenId },
        userAction: step.userAction,
        dataOperation: step.dataOperation || { kind: 'read', entity: primaryEntity, classification: 'schema-backed' },
        entryCondition: step.entryCondition,
        exitCondition: step.exitCondition,
        states: defaultStates(step.title),
      })),
      successOutcome: descriptor.job.successOutcome,
      failureRecovery: descriptor.job.failureRecovery,
    }],
  });

  const mediaRequired = experience.mediaStrategy.necessity !== 'none'
    || ['imagery', 'mixed-media', 'map-spatial'].includes(experience.contentEmphasis.primary);

  const buildPack = buildBuildPack(experience, scope, journey, {
    packs: steps.map((step, index) => ({
      screenId: step.screenId,
      route: `/${step.screenId}`,
      purpose: step.purpose,
      userQuestion: step.userQuestion,
      firstViewport: {
        regionOrder: step.regionOrder || ['context', 'focal-content', 'primary-action'],
        focalContent: step.focalContent,
        primaryAction: step.primaryAction,
      },
      hierarchy: { dominant: step.dominant, supporting: step.supporting },
      primaryActions: [{
        label: step.primaryAction,
        outcome: step.primaryActionOutcome,
        ...(steps[index + 1] ? { targetScreenId: steps[index + 1].screenId } : {}),
      }],
      secondaryActions: [],
      trustSignals: [{ label: step.trustSignal, classification: 'safe-presentation' }],
      decisionSupport: [{ label: step.decisionSupport, classification: 'safe-presentation' }],
      media: mediaRequired || step.media
        ? {
          role: step.media?.role || (experience.mediaStrategy.necessity === 'supportive' ? 'supportive' : 'essential'),
          treatment: step.media?.treatment || 'Full-bleed image at the top of the focal region',
          source: step.media?.source || 'sourced',
          fallback: step.media?.fallback || 'Typographic block using the record name',
        }
        : { role: 'none' },
      context: {
        vocabulary: descriptor.vocabulary,
        contextualData: [{ label: step.contextLabel, classification: 'safe-presentation' }],
      },
      states: defaultStates(step.title),
      navigation: { incoming: step.incoming || [], outgoing: step.outgoing || [] },
      signatureInteraction: { name: step.signatureName, description: step.signatureDescription },
      forbiddenDefaults: [step.forbiddenDefault],
      dataAssumptions: step.dataAssumptions || [],
      previewContent: step.previewContent,
      composition: { kind: step.pattern, rationale: step.compositionRationale },
    })),
  });

  return { experience, scope, journey, buildPack };
}

module.exports = {
  BASE_EXPERIENCE,
  buildBuildPack,
  clone,
  buildExperience,
  buildJourney,
  buildScope,
  deepMerge,
  defaultStates,
  evidence,
  normalizeStep,
  scenarioBundle,
};
