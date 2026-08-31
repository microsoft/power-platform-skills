'use strict';

// Semantic rules for the workflow-journey and screen-build-pack contracts, plus the
// deterministic compilation of build packs into the artifact screen builders and the HTML
// experience preview consume.
//
// Two things are enforced here that nothing else can enforce: that a journey actually
// completes the job it claims (critical steps covered, surfaces that exist), and that the set
// of build packs is a designed product rather than one composition repeated per record type.

const {
  UNSUPPORTED_PRODUCTION_CLASSIFICATIONS,
  contractRevision,
  experienceDirective,
  experienceSignature,
  finding,
  sha256Hex,
  canonicalJson,
} = require('./product-experience-contracts');
const { userFacingScreens } = require('./product-scope-rules');

const UNSUPPORTED = new Set(UNSUPPORTED_PRODUCTION_CLASSIFICATIONS);
const PRODUCTION_DATA_OPERATIONS = new Set(['read', 'create', 'update', 'delete', 'external-call']);

// Content emphases whose product promise cannot be kept without imagery, maps, or other
// visual content. Derived from the declared emphasis dimension, never from the domain.
const VISUAL_EMPHASES = new Set(['imagery', 'mixed-media', 'map-spatial']);

const GENERIC_COMPOSITIONS = new Set(['list', 'detail', 'create', 'edit', 'form']);

function compareCodePoints(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function bindingErrors(childContract, parents) {
  const errors = [];
  for (const [field, parent] of Object.entries(parents)) {
    if (!parent) continue;
    const expected = contractRevision(parent.contract);
    if (childContract[field] !== expected) {
      // Builders must not consume a pack compiled against an edited upstream contract.
      errors.push(finding(
        'stale-contract-binding',
        `${field} ${childContract[field] || '(missing)'} does not match the supplied ${parent.label} revision ${expected}`,
      ));
    }
  }
  return errors;
}

function validateJourneySemantics(journeyContract, { experience, scope } = {}) {
  const errors = [];
  const warnings = [];
  const summary = {};

  errors.push(...bindingErrors(journeyContract, {
    experienceRevision: experience ? { contract: experience, label: 'product-experience' } : null,
    scopeRevision: scope ? { contract: scope, label: 'product-scope' } : null,
  }));

  const journeys = journeyContract.journeys || [];
  const seenIds = new Set();
  for (const journey of journeys) {
    if (seenIds.has(journey.id)) {
      errors.push(finding('duplicate-journey-id', `journey id "${journey.id}" is declared more than once`));
    }
    seenIds.add(journey.id);
  }

  const coreJobs = new Map((scope?.coreJobs || []).map((job) => [job.id, job]));
  const screens = new Map((scope?.screens || []).map((screen) => [screen.id, screen]));
  const journeysByJob = new Map();
  for (const journey of journeys) journeysByJob.set(journey.jobId, journey);

  if (scope) {
    for (const job of scope.coreJobs || []) {
      if (journeysByJob.has(job.id)) continue;
      errors.push(finding(
        job.criticality === 'critical' ? 'missing-critical-journey' : 'missing-journey',
        `core job "${job.id}" has no workflow journey`,
      ));
    }
  }

  for (const journey of journeys) {
    const job = coreJobs.get(journey.jobId);
    if (scope && !job) {
      errors.push(finding(
        'journey-without-core-job',
        `journey "${journey.id}" targets job "${journey.jobId}", which is not a core job in the approved scope`,
      ));
    }

    const orders = (journey.steps || []).map((step) => step.order);
    const expected = orders.map((_, index) => index + 1).join(',');
    if ([...orders].sort((left, right) => left - right).join(',') !== expected) {
      errors.push(finding(
        'journey-step-order',
        `journey "${journey.id}" step orders must be a contiguous 1..n sequence, received [${orders.join(', ')}]`,
      ));
    }

    const stepIds = new Set();
    for (const step of journey.steps || []) {
      if (stepIds.has(step.id)) {
        errors.push(finding('duplicate-journey-step', `journey "${journey.id}" declares step "${step.id}" twice`));
      }
      stepIds.add(step.id);

      if (scope && !screens.has(step.surface?.screenId)) {
        errors.push(finding(
          'journey-step-unknown-screen',
          `journey "${journey.id}" step "${step.id}" is hosted on screen "${step.surface?.screenId}", which is not in the approved scope`,
        ));
      }

      const operation = step.dataOperation || {};
      if (PRODUCTION_DATA_OPERATIONS.has(operation.kind) && UNSUPPORTED.has(operation.classification)) {
        errors.push(finding(
          'unsupported-production-assumption',
          `journey "${journey.id}" step "${step.id}" uses "${operation.kind}" data classified "${operation.classification}"; production behavior cannot depend on unapproved data`,
        ));
      }
    }

    if (job) {
      const satisfied = new Set();
      for (const step of journey.steps || []) {
        for (const criticalStepId of step.satisfies || []) {
          if (!job.criticalSteps.includes(criticalStepId)) {
            errors.push(finding(
              'unknown-critical-step',
              `journey "${journey.id}" step "${step.id}" claims to satisfy "${criticalStepId}", which job "${job.id}" does not declare`,
            ));
            continue;
          }
          satisfied.add(criticalStepId);
        }
      }
      const missing = job.criticalSteps.filter((criticalStepId) => !satisfied.has(criticalStepId));
      if (missing.length) {
        errors.push(finding(
          'missing-critical-journey-step',
          `journey "${journey.id}" does not cover critical step(s) ${missing.join(', ')} of job "${job.id}"`,
        ));
      }
    }

    if (experience?.sessionPattern?.resumability === 'must-resume' && journey.resumable !== true) {
      warnings.push(finding(
        'journey-not-resumable',
        `sessionPattern.resumability is "must-resume" but journey "${journey.id}" is not marked resumable`,
      ));
    }
  }

  if (experience && experience.workflowShape !== 'single-step') {
    for (const journey of journeys) {
      const job = coreJobs.get(journey.jobId);
      if (job?.criticality === 'critical' && (journey.steps || []).length < 2) {
        warnings.push(finding(
          'single-step-critical-journey',
          `workflowShape is "${experience.workflowShape}" but critical journey "${journey.id}" has a single step`,
        ));
      }
    }
  }

  summary.journeyCount = journeys.length;
  summary.stepCount = journeys.reduce((total, journey) => total + (journey.steps || []).length, 0);
  summary.screensUsed = [...new Set(journeys.flatMap((journey) => (journey.steps || []).map((step) => step.surface?.screenId)))]
    .filter(Boolean)
    .sort();

  return { errors, warnings, summary };
}

function compositionSignature(pack) {
  // A composition is "the same" when the family, the first-viewport region order, and the
  // dominant element all match — that is the level at which screens start to feel generated.
  return [
    pack.composition?.kind,
    (pack.firstViewport?.regionOrder || []).join('>'),
    pack.hierarchy?.dominant,
  ].join('|');
}

function validateBuildPackSemantics(buildPackContract, { experience, scope, journey } = {}) {
  const errors = [];
  const warnings = [];
  const summary = {};

  errors.push(...bindingErrors(buildPackContract, {
    experienceRevision: experience ? { contract: experience, label: 'product-experience' } : null,
    scopeRevision: scope ? { contract: scope, label: 'product-scope' } : null,
    journeyRevision: journey ? { contract: journey, label: 'workflow-journey' } : null,
  }));

  const packs = buildPackContract.packs || [];
  const packById = new Map();
  for (const pack of packs) {
    if (packById.has(pack.screenId)) {
      errors.push(finding('duplicate-build-pack', `screen "${pack.screenId}" has more than one build pack`));
    }
    packById.set(pack.screenId, pack);
  }

  const scopeScreens = scope ? userFacingScreens(scope) : [];
  const scopeScreenIds = new Set(scopeScreens.map((screen) => screen.id));
  const coreJobIds = new Set((scope?.coreJobs || []).map((job) => job.id));

  if (scope) {
    for (const screen of scopeScreens) {
      if (!packById.has(screen.id)) {
        errors.push(finding(
          'missing-build-pack',
          `user-facing screen "${screen.id}" has no build pack; builders would fall back to a generic default`,
        ));
      }
    }
    for (const pack of packs) {
      if (!scopeScreenIds.has(pack.screenId)) {
        errors.push(finding(
          'unknown-screen',
          `build pack targets screen "${pack.screenId}", which is not a user-facing screen in the approved scope`,
        ));
      }
    }
  }

  if (journey) {
    for (const entry of journey.journeys || []) {
      for (const step of entry.steps || []) {
        const screenId = step.surface?.screenId;
        if (screenId && !packById.has(screenId)) {
          errors.push(finding(
            'missing-journey-step-build-pack',
            `journey "${entry.id}" step "${step.id}" is hosted on screen "${screenId}", which has no build pack`,
          ));
        }
      }
    }
  }

  for (const row of scope?.requirementCoverage || []) {
    const pack = packById.get(row.screenId);
    if (!pack) continue;
    if (row.mechanism === 'action') {
      const actionLabels = [
        ...(pack.primaryActions || []),
        ...(pack.secondaryActions || []),
      ].map((action) => action.label);
      if (!actionLabels.includes(row.target)) {
        errors.push(finding(
          'requirement-action-missing',
          `requirement "${row.requirementId}" targets action "${row.target}" on screen "${row.screenId}", but no build-pack action has that label`,
        ));
      }
    } else if (row.mechanism === 'state') {
      if (!Object.prototype.hasOwnProperty.call(pack.states || {}, row.target)) {
        errors.push(finding(
          'requirement-state-missing',
          `requirement "${row.requirementId}" targets state "${row.target}" on screen "${row.screenId}", but the build pack does not declare it`,
        ));
      }
    } else if (row.mechanism === 'domain-operation') {
      const operations = (journey?.journeys || []).flatMap((entry) => (
        (entry.steps || [])
          .filter((step) => step.surface?.screenId === row.screenId)
          .map((step) => `${step.dataOperation?.kind}:${step.dataOperation?.entity || 'none'}`)
      ));
      if (!operations.includes(row.target)) {
        errors.push(finding(
          'requirement-operation-missing',
          `requirement "${row.requirementId}" targets operation "${row.target}" on screen "${row.screenId}", but its journey steps declare [${operations.join(', ') || 'none'}]`,
        ));
      }
    }
  }

  const visualExperience = experience
    && (experience.mediaStrategy?.necessity === 'essential' || VISUAL_EMPHASES.has(experience.contentEmphasis?.primary));
  const highRisk = experience && ['high', 'critical'].includes(experience.decisionRisk?.level);

  for (const pack of packs) {
    const screen = scope ? (scope.screens || []).find((candidate) => candidate.id === pack.screenId) : null;
    const servesCoreJob = screen ? (screen.jobIds || []).some((id) => coreJobIds.has(id)) : false;

    if (pack.states?.offline
      && !['intermittent', 'offline-first'].includes(experience?.operatingContext?.connectivity)) {
      errors.push(finding(
        'offline-state-without-approved-context',
        `screen "${pack.screenId}" declares an offline state while Product Experience connectivity is "${experience?.operatingContext?.connectivity || 'unknown'}"`,
      ));
    }

    if (screen?.route && pack.route && pack.route !== screen.route) {
      errors.push(finding(
        'build-pack-route-mismatch',
        `screen "${pack.screenId}" build-pack route "${pack.route}" does not match approved scope route "${screen.route}"`,
      ));
    }
    if (screen?.pattern && pack.composition?.kind && pack.composition.kind !== screen.pattern) {
      errors.push(finding(
        'build-pack-composition-mismatch',
        `screen "${pack.screenId}" build-pack composition "${pack.composition.kind}" does not match approved scope pattern "${screen.pattern}"`,
      ));
    }

    if (!(pack.firstViewport?.regionOrder || []).includes('primary-action') || !(pack.primaryActions || []).length) {
      errors.push(finding(
        'build-pack-without-primary-action',
        `screen "${pack.screenId}" has no primary action in its first viewport`,
      ));
    }
    if (!(pack.firstViewport?.regionOrder || []).includes('focal-content')) {
      errors.push(finding(
        'build-pack-without-focal-content',
        `screen "${pack.screenId}" first viewport has no focal content region`,
      ));
    }
    if (pack.primaryActions?.[0]?.label !== pack.firstViewport?.primaryAction) {
      errors.push(finding(
        'first-viewport-primary-action-mismatch',
        `screen "${pack.screenId}" firstViewport.primaryAction "${pack.firstViewport?.primaryAction}" does not match its first primary action "${pack.primaryActions?.[0]?.label || '(missing)'}"`,
      ));
    }

    const mediaRole = pack.media?.role;
    const previewContent = pack.previewContent || {};
    const previewDataPointCount = [
      ...(previewContent.metrics || []),
      ...(previewContent.records || []),
      ...(previewContent.fields || []),
      ...(previewContent.summaryRows || []),
    ].length;

    if (previewDataPointCount < 4) {
      errors.push(finding(
        'preview-content-too-thin',
        `screen "${pack.screenId}" declares only ${previewDataPointCount} preview data points; the approval preview needs at least four product-specific records, fields, metrics, or summary rows`,
      ));
    }

    const previewText = JSON.stringify(previewContent);
    if (/\b(sample value|add details|secondary detail for|evidence shown on|comparison aid on)\b/i.test(previewText)) {
      errors.push(finding(
        'generic-preview-placeholder',
        `screen "${pack.screenId}" contains canned preview placeholder text instead of product-specific sample content`,
      ));
    }

    if (visualExperience && servesCoreJob && (!mediaRole || mediaRole === 'none')) {
      errors.push(finding(
        'visual-experience-without-media',
        `screen "${pack.screenId}" serves a core job of a visual experience but declares no media`,
      ));
    }
    if (mediaRole && mediaRole !== 'none') {
      const hasPreviewMedia = Boolean(
        previewContent.heroMediaLabel
        || (previewContent.records || []).some((record) => record.mediaLabel),
      );
      if (!hasPreviewMedia) {
        errors.push(finding(
          'preview-media-missing',
          `screen "${pack.screenId}" declares media role "${mediaRole}" but provides no heroMediaLabel or record mediaLabel for the approval preview`,
        ));
      }
      if (!pack.media.fallback) {
        errors.push(finding(
          'media-without-fallback',
          `screen "${pack.screenId}" declares media but no fallback for records that have none`,
        ));
      }
      if (pack.media.source === 'none') {
        errors.push(finding(
          'media-without-source',
          `screen "${pack.screenId}" declares media role "${mediaRole}" with source "none"`,
        ));
      }
    }

    const productionDecisionEvidence = [
      ...(pack.trustSignals || []),
      ...(pack.decisionSupport || []),
    ].filter((item) => !UNSUPPORTED.has(item.classification));
    if (highRisk && servesCoreJob && productionDecisionEvidence.length === 0) {
      errors.push(finding(
        'high-risk-without-decision-support',
        `decisionRisk is "${experience.decisionRisk.level}" but screen "${pack.screenId}" offers no production-usable trust signal or decision support`,
      ));
    }

    for (const assumption of pack.dataAssumptions || []) {
      if (assumption.productionCritical && UNSUPPORTED.has(assumption.classification) && assumption.approved !== true) {
        errors.push(finding(
          'unsupported-production-assumption',
          `screen "${pack.screenId}" depends on unapproved "${assumption.classification}" data for production behavior: ${assumption.statement}`,
        ));
      }
    }

    for (const action of [...(pack.primaryActions || []), ...(pack.secondaryActions || [])]) {
      if (action.targetScreenId && scope && !(scope.screens || []).some((candidate) => candidate.id === action.targetScreenId)) {
        errors.push(finding(
          'unknown-navigation-target',
          `screen "${pack.screenId}" action "${action.label}" targets screen "${action.targetScreenId}", which is not in the approved scope`,
        ));
      }
    }
  }

  const signatures = new Map();
  for (const pack of packs) {
    const signature = compositionSignature(pack);
    if (!signatures.has(signature)) signatures.set(signature, []);
    signatures.get(signature).push(pack);
  }
  summary.distinctCompositions = signatures.size;

  if (packs.length >= 3 && signatures.size === 1) {
    const justified = packs.every((pack) => pack.composition?.repeatJustification);
    if (!justified) {
      errors.push(finding(
        'uniform-generic-composition',
        `all ${packs.length} screens share one composition signature (${[...signatures.keys()][0]}); a product whose every screen is the same layout was generated, not designed`,
      ));
    }
  } else if (packs.length >= 4) {
    const genericKinds = new Set(packs
      .map((pack) => pack.composition?.kind)
      .filter((kind) => GENERIC_COMPOSITIONS.has(kind)));
    const allGeneric = packs.every((pack) => GENERIC_COMPOSITIONS.has(pack.composition?.kind));
    if (allGeneric && genericKinds.size <= 2) {
      errors.push(finding(
        'uniform-generic-composition',
        `every screen uses one of ${genericKinds.size} generic record compositions (${[...genericKinds].join(', ')}); the approved journey is not represented`,
      ));
    }
  }

  const interactionNames = new Set(packs.map((pack) => pack.signatureInteraction?.name));
  if (packs.length >= 3 && interactionNames.size === 1) {
    warnings.push(finding(
      'repeated-signature-interaction',
      'every screen declares the same signature interaction; confirm each surface earns its own moment',
    ));
  }

  summary.packCount = packs.length;
  summary.screensWithMedia = packs.filter((pack) => pack.media?.role && pack.media.role !== 'none').length;

  return { errors, warnings, summary };
}

/**
 * Deterministic compilation. Screens are ordered by first appearance in the workflow journey,
 * then by scope declaration order, so the same inputs always produce byte-identical output —
 * there are no timestamps, no environment values, and no iteration over unordered sets.
 */
function compileBuildPacks(buildPackContract, { experience, scope, journey }) {
  const journeyOrder = [];
  for (const entry of journey?.journeys || []) {
    for (const step of [...(entry.steps || [])].sort((left, right) => left.order - right.order)) {
      const screenId = step.surface?.screenId;
      if (screenId && !journeyOrder.includes(screenId)) journeyOrder.push(screenId);
    }
  }
  const scopeOrder = (scope?.screens || []).map((screen) => screen.id);
  const rank = (screenId) => {
    const journeyIndex = journeyOrder.indexOf(screenId);
    if (journeyIndex >= 0) return journeyIndex;
    const scopeIndex = scopeOrder.indexOf(screenId);
    return journeyOrder.length + (scopeIndex >= 0 ? scopeIndex : scopeOrder.length);
  };

  const stepsByScreen = new Map();
  for (const entry of journey?.journeys || []) {
    for (const step of entry.steps || []) {
      const screenId = step.surface?.screenId;
      if (!screenId) continue;
      if (!stepsByScreen.has(screenId)) stepsByScreen.set(screenId, []);
      stepsByScreen.get(screenId).push({
        journeyId: entry.id,
        jobId: entry.jobId,
        stepId: step.id,
        order: step.order,
        surfaceKind: step.surface.kind,
        satisfies: step.satisfies || [],
      });
    }
  }

  const screens = [...(buildPackContract.packs || [])]
    .sort((left, right) => rank(left.screenId) - rank(right.screenId) || compareCodePoints(left.screenId, right.screenId))
    .map((pack) => {
      const scopeScreen = (scope?.screens || []).find((candidate) => candidate.id === pack.screenId) || null;
      const route = scopeScreen?.route || pack.route;
      return {
        screenId: pack.screenId,
        ...(route ? { route } : {}),
        title: scopeScreen?.title,
        pattern: scopeScreen?.pattern,
        jobIds: scopeScreen?.jobIds || [],
        journeySteps: (stepsByScreen.get(pack.screenId) || [])
          .sort((left, right) => compareCodePoints(left.journeyId, right.journeyId) || left.order - right.order),
        compositionSignature: compositionSignature(pack),
        pack,
      };
    });

  const compiled = {
    schemaVersion: 1,
    contractType: 'compiled-screen-build-pack',
    experienceRevision: contractRevision(experience),
    scopeRevision: contractRevision(scope),
    journeyRevision: contractRevision(journey),
    buildPackRevision: contractRevision(buildPackContract),
    experienceSignature: experienceSignature(experience),
    experienceDirective: experienceDirective(experience),
    productComplexity: scope.productComplexity,
    screens,
  };
  // Self-hash last so the compiled artifact can be compared without re-running the compiler.
  compiled.compiledRevision = sha256Hex(canonicalJson(compiled));
  return compiled;
}

module.exports = {
  compileBuildPacks,
  compositionSignature,
  validateBuildPackSemantics,
  validateJourneySemantics,
};
