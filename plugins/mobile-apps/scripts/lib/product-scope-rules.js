'use strict';

// Semantic rules for the product-scope contract.
//
// The failure this guards against is scope inflation by template: an app that "supports" ten
// nouns by generating a list, a detail, and a form for each of them, plus a table per noun.
// Every rule below asks the same question — what job of the user does this surface or table
// exist to complete? — and never asks what industry the product is in.

const {
  GENERIC_RECORD_PATTERNS,
  SCREEN_BUDGETS,
  SCREEN_CONSOLIDATION_THRESHOLD,
  TABLE_BUDGETS,
  finding,
} = require('./product-experience-contracts');

const GENERIC_PATTERNS = new Set(GENERIC_RECORD_PATTERNS);
const EDITOR_PATTERNS = new Set(['create', 'edit', 'form']);

function indexById(items) {
  const map = new Map();
  for (const item of items || []) map.set(item.id, item);
  return map;
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function jobKey(jobIds) {
  return [...jobIds].sort().join('+');
}

function userFacingScreens(contract) {
  // Auth redirects, OAuth callbacks, layouts, and other plumbing routes are real files but not
  // product surfaces, so they never consume screen budget.
  return (contract.screens || []).filter((screen) => screen.userFacing && screen.pattern !== 'infrastructure');
}

function validateIdentity(contract, errors) {
  const screenIds = (contract.screens || []).map((screen) => screen.id);
  for (const id of duplicates(screenIds)) {
    errors.push(finding('duplicate-screen-id', `screen id "${id}" is declared more than once`));
  }

  const allJobs = [...(contract.coreJobs || []), ...(contract.supportingJobs || []), ...(contract.deferredJobs || [])];
  for (const id of duplicates(allJobs.map((job) => job.id))) {
    errors.push(finding('duplicate-job-id', `job id "${id}" is declared more than once across core/supporting/deferred jobs`));
  }

  for (const id of duplicates((contract.dataEntities || []).map((entity) => entity.name))) {
    errors.push(finding('duplicate-entity', `data entity "${id}" is declared more than once`));
  }
  for (const id of duplicates((contract.newTables || []).map((table) => table.name))) {
    errors.push(finding('duplicate-new-table', `new table "${id}" is declared more than once`));
  }
}

function validateCoverage(contract, errors, warnings, summary) {
  const screens = indexById(contract.screens || []);
  const shippingJobs = [...(contract.coreJobs || []), ...(contract.supportingJobs || [])];
  const shippingJobIds = new Set(shippingJobs.map((job) => job.id));
  const coveredCoreJobIds = new Set();
  const coveredSupportingJobIds = new Set();

  for (const job of shippingJobs) {
    const isCore = (contract.coreJobs || []).includes(job);
    const surface = job.surface || {};
    const screen = screens.get(surface.screenId);
    if (!screen) {
      // A job whose surface points nowhere is an uncovered job, whatever the surface kind was.
      errors.push(finding(
        isCore && job.criticality === 'critical' ? 'missing-critical-job-coverage' : 'missing-job-coverage',
        `job "${job.id}" is served by surface screen "${surface.screenId}", which is not declared in screens[]`,
      ));
      continue;
    }
    if (!screen.userFacing || screen.pattern === 'infrastructure') {
      errors.push(finding(
        isCore && job.criticality === 'critical' ? 'missing-critical-job-coverage' : 'missing-job-coverage',
        `job "${job.id}" is served by "${screen.id}", which is not a user-facing product surface`,
      ));
      continue;
    }
    // A job may live in a section, sheet, modal, flow step, or contextual action; only when the
    // planner claims the WHOLE screen exists for the job must the screen agree.
    if (surface.kind === 'screen' && !(screen.jobIds || []).includes(job.id)) {
      errors.push(finding(
        'job-surface-mismatch',
        `job "${job.id}" claims screen "${screen.id}" as a whole-screen surface, but that screen does not list the job`,
      ));
      continue;
    }
    ((contract.coreJobs || []).includes(job) ? coveredCoreJobIds : coveredSupportingJobIds)
      .add(job.id);
  }

  for (const screen of contract.screens || []) {
    for (const jobId of screen.jobIds || []) {
      if (!shippingJobIds.has(jobId)) {
        errors.push(finding(
          'screen-without-known-job',
          `screen "${screen.id}" references job "${jobId}", which is not a core or supporting job in this release`,
        ));
      }
    }
  }

  const deferredIds = new Set((contract.deferredJobs || []).map((job) => job.id));
  for (const screen of contract.screens || []) {
    for (const jobId of screen.jobIds || []) {
      if (deferredIds.has(jobId)) {
        errors.push(finding(
          'screen-serves-deferred-job',
          `screen "${screen.id}" serves deferred job "${jobId}"; deferred jobs do not ship surfaces`,
        ));
      }
    }
  }

  const coveredCoreJobs = new Set();
  for (const screen of contract.screens || []) for (const jobId of screen.jobIds || []) coveredCoreJobs.add(jobId);
  for (const job of contract.supportingJobs || []) {
    if (!coveredCoreJobs.has(job.id) && job.surface?.kind === 'screen') {
      warnings.push(finding(
        'supporting-job-owns-screen',
        `supporting job "${job.id}" owns a whole screen; confirm it is not a section of a core job's surface`,
      ));
    }
  }
  summary.coveredCoreJobCount = coveredCoreJobIds.size;
  summary.coveredSupportingJobCount = coveredSupportingJobIds.size;
}

function validateRequirementCoverage(contract, errors, summary) {
  const hasRequirements = Object.prototype.hasOwnProperty.call(contract, 'requirements');
  const hasCoverage = Object.prototype.hasOwnProperty.call(contract, 'requirementCoverage');
  if (hasRequirements !== hasCoverage) {
    errors.push(finding(
      'partial-requirement-contract',
      'requirements and requirementCoverage must be supplied together; a partial set cannot prove explicit functionality was preserved',
    ));
    return;
  }
  if (!hasRequirements) return;

  const requirements = contract.requirements || [];
  const coverage = contract.requirementCoverage || [];
  const requirementById = indexById(requirements);
  const screenById = indexById(contract.screens || []);
  const coreJobById = indexById(contract.coreJobs || []);
  const shippingJobIds = new Set([
    ...(contract.coreJobs || []).map((job) => job.id),
    ...(contract.supportingJobs || []).map((job) => job.id),
  ]);
  const deferredJobIds = new Set((contract.deferredJobs || []).map((job) => job.id));
  const coveredShippingRequirementIds = new Set();

  for (const id of duplicates(requirements.map((requirement) => requirement.id))) {
    errors.push(finding('duplicate-requirement-id', `requirement id "${id}" is declared more than once`));
  }
  for (const key of duplicates(coverage.map((row) => (
    [row.requirementId, row.screenId, row.mechanism, row.target].join('|')
  )))) {
    errors.push(finding('duplicate-requirement-coverage', `requirement coverage "${key}" is declared more than once`));
  }

  const coverageByRequirement = new Map();
  for (const row of coverage) {
    if (!coverageByRequirement.has(row.requirementId)) coverageByRequirement.set(row.requirementId, []);
    coverageByRequirement.get(row.requirementId).push(row);

    const requirement = requirementById.get(row.requirementId);
    if (!requirement) {
      errors.push(finding(
        'unknown-requirement-coverage',
        `coverage references requirement "${row.requirementId}", which is not declared`,
      ));
      continue;
    }
    if (requirement.disposition === 'deferred') {
      errors.push(finding(
        'deferred-requirement-covered',
        `deferred requirement "${requirement.id}" has shipping coverage on screen "${row.screenId}"`,
      ));
    }
    const screen = screenById.get(row.screenId);
    if (!screen || !screen.userFacing || screen.pattern === 'infrastructure') {
      errors.push(finding(
        'requirement-coverage-screen-missing',
        `requirement "${row.requirementId}" maps to "${row.screenId}", which is not a user-facing product screen`,
      ));
    } else if (requirement.disposition === 'shipping') {
      coveredShippingRequirementIds.add(requirement.id);
    }
  }

  for (const requirement of requirements) {
    const rows = coverageByRequirement.get(requirement.id) || [];
    if (requirement.disposition === 'shipping') {
      if (!shippingJobIds.has(requirement.jobId)) {
        errors.push(finding(
          'shipping-requirement-without-job',
          `shipping requirement "${requirement.id}" references job "${requirement.jobId}", which is not a core or supporting job`,
        ));
      }
      if (rows.length === 0) {
        errors.push(finding(
          'uncovered-requirement',
          `shipping requirement "${requirement.id}" has no concrete action, state, or domain-operation coverage`,
        ));
      }
      const coreJob = coreJobById.get(requirement.jobId);
      if (coreJob && !(coreJob.criticalSteps || []).includes(requirement.id)) {
        errors.push(finding(
          'core-requirement-not-locked',
          `requirement "${requirement.id}" belongs to core job "${requirement.jobId}" but is absent from its criticalSteps`,
        ));
      }
    } else if (!deferredJobIds.has(requirement.jobId)) {
      errors.push(finding(
        'deferred-requirement-without-job',
        `deferred requirement "${requirement.id}" references job "${requirement.jobId}", which is not declared in deferredJobs`,
      ));
    }
  }

  if (requirements.length > 0) {
    const requirementIds = new Set(requirements.map((requirement) => requirement.id));
    for (const coreJob of contract.coreJobs || []) {
      for (const criticalStep of coreJob.criticalSteps || []) {
        if (!requirementIds.has(criticalStep)) {
          errors.push(finding(
            'critical-step-without-requirement',
            `core job "${coreJob.id}" critical step "${criticalStep}" is not present in the locked requirements`,
          ));
        }
      }
    }
  }

  summary.requirementCount = requirements.length;
  summary.shippingRequirementCount = requirements.filter((item) => item.disposition === 'shipping').length;
  summary.deferredRequirementCount = requirements.filter((item) => item.disposition === 'deferred').length;
  summary.requirementCoverageCount = coverage.length;
  summary.coveredShippingRequirementCount = coveredShippingRequirementIds.size;
}

function validateScreenBudget(contract, errors, warnings, summary) {
  const complexity = contract.productComplexity;
  const band = SCREEN_BUDGETS[complexity];
  const facing = userFacingScreens(contract);
  const count = facing.length;
  summary.userFacingScreenCount = count;
  summary.screenBand = band;

  for (const screen of contract.screens || []) {
    if (screen.pattern === 'infrastructure' && screen.userFacing) {
      errors.push(finding(
        'infrastructure-marked-user-facing',
        `screen "${screen.id}" uses the infrastructure pattern but is marked user-facing`,
      ));
    }
  }

  const declared = contract.screenBudget || {};
  summary.declaredScreenReviewCeiling = declared.max ?? null;
  if (declared.target > declared.max) {
    errors.push(finding('invalid-screen-budget', 'screenBudget.target exceeds screenBudget.max'));
  }
  if (band.max !== null && declared.max > band.max) {
    warnings.push(finding(
      'screen-review-ceiling-raised',
      `screenBudget.max ${declared.max} exceeds the ${complexity} review ceiling of ${band.max}; consolidate before retaining the larger graph`,
    ));
  }
  if (count > declared.max) {
    warnings.push(finding(
      'screen-count-above-review-ceiling',
      `${count} user-facing screens exceed the declared review ceiling of ${declared.max}; explicit functionality must remain while the graph is consolidated`,
    ));
  }
  if (band.max !== null && count > band.max) {
    warnings.push(finding(
      'screen-count-above-complexity-review-ceiling',
      `${count} user-facing screens exceed the ${complexity} review ceiling of ${band.max}; review composition without removing covered jobs`,
    ));
  }
  if (count > SCREEN_CONSOLIDATION_THRESHOLD) {
    for (const screen of facing) {
      if (!screen.cannotMergeBecause) {
        errors.push(finding(
          'screen-consolidation-evidence-required',
          `screen "${screen.id}" needs cannotMergeBecause evidence because the graph retains ${count} user-facing screens after consolidation`,
        ));
      }
    }
    if (facing.every((screen) => screen.cannotMergeBecause)) {
      warnings.push(finding(
        'screen-count-above-consolidation-threshold',
        `${count} screens remain after consolidation with per-screen evidence; require explicit review but preserve covered functionality`,
      ));
    }
  }
}

function validateNavigation(contract, errors, warnings, summary) {
  const initialErrorCount = errors.length;
  const navigation = contract.navigation;
  const screens = indexById(contract.screens || []);
  const facing = userFacingScreens(contract);
  const actualDurableIds = facing
    .filter((screen) => screen.classification === 'durable-destination')
    .map((screen) => screen.id)
    .sort();
  const declaredDurableIds = [...(navigation.durableDestinationIds || [])].sort();
  summary.durableDestinationCount = actualDurableIds.length;
  summary.visibleTabCount = (navigation.visibleTabIds || []).length;

  if (JSON.stringify(actualDurableIds) !== JSON.stringify(declaredDurableIds)) {
    errors.push(finding(
      'durable-destination-mismatch',
      `navigation durableDestinationIds must exactly match screens classified durable-destination (${actualDurableIds.join(', ') || 'none'})`,
    ));
  }
  for (const tabId of navigation.visibleTabIds || []) {
    const screen = screens.get(tabId);
    if (!screen || !screen.userFacing) {
      errors.push(finding(
        'visible-tab-screen-missing',
        `visible tab "${tabId}" does not reference a user-facing screen`,
      ));
    } else if (screen.classification !== 'durable-destination') {
      errors.push(finding(
        'visible-tab-not-durable',
        `visible tab "${tabId}" is ${screen.classification}; only durable destinations may own tabs`,
      ));
    }
  }
  if ((navigation.visibleTabIds || []).length > 5) {
    errors.push(finding('too-many-visible-tabs', 'navigation may expose at most five visible tabs'));
  }

  if (navigation.pattern === 'tabs-plus-stacks') {
    if (actualDurableIds.length < 3 || actualDurableIds.length > 5) {
      errors.push(finding(
        'tabs-require-three-to-five-destinations',
        `tabs-plus-stacks requires 3-5 durable destinations; found ${actualDurableIds.length}`,
      ));
    }
    if ((navigation.visibleTabIds || []).length < 3) {
      errors.push(finding('tabs-require-visible-destinations', 'tabs-plus-stacks requires at least three visible durable tabs'));
    }
  }
  if (navigation.pattern === 'stack-only') {
    if (!navigation.stackOnlyReason || !navigation.returnHomeMechanism) {
      errors.push(finding(
        'stack-only-contract-incomplete',
        'stack-only navigation requires stackOnlyReason and returnHomeMechanism',
      ));
    }
    if (actualDurableIds.length > 1) {
      errors.push(finding(
        'stack-only-with-multiple-destinations',
        `stack-only cannot hide ${actualDurableIds.length} independently revisited durable destinations`,
      ));
    }
  }
  if (navigation.pattern === 'drawer'
    && actualDurableIds.length <= 5
    && !navigation.drawerReason) {
    errors.push(finding(
      'drawer-without-hierarchy-reason',
      'drawer navigation with five or fewer durable destinations requires a real hierarchy reason',
    ));
  }

  if (navigation.authenticated) {
    const profile = navigation.profileScreenId && screens.get(navigation.profileScreenId);
    if (!profile || !profile.userFacing || navigation.profileAccess === 'not-applicable') {
      errors.push(finding(
        'authenticated-profile-unreachable',
        'authenticated apps require a reachable user-facing Profile/account screen and sign-out owner',
      ));
    } else if (navigation.profileAccess === 'tab'
      && !(navigation.visibleTabIds || []).includes(profile.id)) {
      errors.push(finding('profile-tab-missing', `profileAccess is tab but "${profile.id}" is not a visible tab`));
    } else if (navigation.profileAccess !== 'tab'
      && (navigation.visibleTabIds || []).includes(profile.id)) {
      errors.push(finding('profile-tab-not-durable', `Profile "${profile.id}" is a tab without durable account work`));
    }
  } else if (navigation.profileAccess !== 'not-applicable') {
    warnings.push(finding('unused-profile-access', 'profileAccess is set for a contract that is not authenticated'));
  }

  for (const screen of facing) {
    if (screen.classification === 'nested-detail' && !screen.parentScreenId) {
      errors.push(finding('nested-detail-parent-required', `nested detail "${screen.id}" requires parentScreenId`));
    }
    if (screen.hideTabs && !screen.tabVisibilityReason) {
      errors.push(finding('hidden-tabs-without-reason', `screen "${screen.id}" hides tabs without tabVisibilityReason`));
    }
  }
  summary.navigationValid = errors.length === initialErrorCount;
}

function validateTableBudget(contract, errors, warnings, summary) {
  const complexity = contract.productComplexity;
  const band = TABLE_BUDGETS[complexity];
  const newTables = contract.newTables || [];
  summary.newTableCount = newTables.length;
  summary.tableBand = band;

  const declared = contract.newTableBudget || {};
  summary.declaredTableReviewCeiling = declared.max ?? null;
  if (declared.target > declared.max) {
    errors.push(finding('invalid-table-budget', 'newTableBudget.target exceeds newTableBudget.max'));
  }
  if (band.max !== null && declared.max > band.max) {
    errors.push(finding(
      'table-budget-exceeds-band',
      `newTableBudget.max ${declared.max} exceeds the ${complexity} band maximum of ${band.max}`,
    ));
  }

  const shippingJobIds = new Set([
    ...(contract.coreJobs || []).map((job) => job.id),
    ...(contract.supportingJobs || []).map((job) => job.id),
  ]);
  const unjustified = [];
  for (const table of newTables) {
    const reasons = table.lifecycleJustification?.reasons || [];
    if (reasons.length === 0) unjustified.push(table.name);
    for (const jobId of table.jobIds || []) {
      if (!shippingJobIds.has(jobId)) {
        errors.push(finding(
          'new-table-without-job',
          `new table "${table.name}" references job "${jobId}", which is not a core or supporting job`,
        ));
      }
    }
  }

  if (newTables.length > declared.max) {
    // Over budget is allowed only when every table carries a lifecycle reason AND the planner
    // wrote down why the budget itself is wrong for this product.
    if (unjustified.length || !declared.rationale) {
      errors.push(finding(
        'new-table-count-over-budget',
        `${newTables.length} new tables exceed the declared budget max of ${declared.max} without lifecycle justification`
        + (unjustified.length ? ` (unjustified: ${unjustified.join(', ')})` : ' (newTableBudget.rationale is required to exceed the budget)'),
      ));
    } else {
      warnings.push(finding(
        'new-table-count-over-budget-justified',
        `${newTables.length} new tables exceed the declared budget max of ${declared.max}; every table carries a lifecycle reason, so this needs explicit user approval`,
      ));
    }
  }

  const entityByName = new Map((contract.dataEntities || []).map((entity) => [entity.name, entity]));
  for (const table of newTables) {
    const entity = entityByName.get(table.name);
    if (!entity) {
      errors.push(finding(
        'new-table-entity-mismatch',
        `new table "${table.name}" has no matching dataEntities entry describing how it is used`,
      ));
      continue;
    }
    if (entity.realization !== 'new-table') {
      errors.push(finding(
        'new-table-entity-mismatch',
        `data entity "${entity.name}" is realized as "${entity.realization}" but also appears in newTables`,
      ));
    }
    if (entity.role === 'reference') {
      warnings.push(finding(
        'reference-entity-as-new-table',
        `reference entity "${entity.name}" is being created as a new table; confirm a Choice column or configuration cannot carry it`,
      ));
    }
  }
  for (const entity of contract.dataEntities || []) {
    if (entity.realization === 'new-table' && !newTables.some((table) => table.name === entity.name)) {
      errors.push(finding(
        'new-table-entity-mismatch',
        `data entity "${entity.name}" is realized as a new table but is missing from newTables[]`,
      ));
    }
  }
}

function validateCompositionEconomy(contract, errors, warnings, summary) {
  const screens = indexById(contract.screens || []);
  const coreJobIds = new Set((contract.coreJobs || []).map((job) => job.id));
  const facing = userFacingScreens(contract);

  const byInteractionSignature = new Map();
  for (const screen of facing) {
    if (screen.parameterizedBy && !screen.interactionSignature) {
      errors.push(finding(
        'parameterized-screen-without-signature',
        `screen "${screen.id}" declares parameterizedBy without an interactionSignature`,
      ));
    }
    if (!screen.interactionSignature) continue;
    if (!byInteractionSignature.has(screen.interactionSignature)) {
      byInteractionSignature.set(screen.interactionSignature, []);
    }
    byInteractionSignature.get(screen.interactionSignature).push(screen);
  }
  for (const [signature, equivalentScreens] of byInteractionSignature) {
    if (equivalentScreens.length < 2) continue;
    const withoutEvidence = equivalentScreens.filter((screen) => !screen.cannotMergeBecause);
    if (withoutEvidence.length) {
      errors.push(finding(
        'equivalent-interaction-not-consolidated',
        `interaction signature "${signature}" remains on ${equivalentScreens.length} screens without separation evidence (${withoutEvidence.map((screen) => screen.id).join(', ')})`,
      ));
    }
  }
  summary.parameterizedScreenCount = facing.filter((screen) => screen.parameterizedBy).length;

  for (const screen of facing) {
    if (screen.entity && !(contract.dataEntities || []).some((entity) => entity.name === screen.entity)) {
      errors.push(finding(
        'screen-entity-not-declared',
        `screen "${screen.id}" targets entity "${screen.entity}", which is not declared in dataEntities[]`,
      ));
    }
  }

  const byEntity = new Map();
  for (const screen of facing) {
    if (!screen.entity || !GENERIC_PATTERNS.has(screen.pattern)) continue;
    if (!byEntity.has(screen.entity)) byEntity.set(screen.entity, []);
    byEntity.get(screen.entity).push(screen);
  }

  let fullTripletEntities = 0;
  for (const [entity, entityScreens] of byEntity) {
    const seenJobKeys = new Map();
    for (const screen of entityScreens) {
      const key = jobKey(screen.jobIds || []);
      if (seenJobKeys.has(key)) {
        errors.push(finding(
          'entity-crud-multiplication',
          `screens "${seenJobKeys.get(key)}" and "${screen.id}" both exist for entity "${entity}" and serve exactly the same job set; a second surface needs a second job`,
        ));
      } else {
        seenJobKeys.set(key, screen.id);
      }
    }

    const servesCoreJob = entityScreens.some((screen) => (screen.jobIds || []).some((id) => coreJobIds.has(id)));
    if (entityScreens.length >= 3 && !servesCoreJob) {
      errors.push(finding(
        'entity-crud-multiplication',
        `entity "${entity}" has ${entityScreens.length} generic record screens but serves no core job; supporting data does not need its own destinations`,
      ));
    }

    const patterns = new Set(entityScreens.map((screen) => screen.pattern));
    const hasTriplet = patterns.has('list') && patterns.has('detail')
      && [...EDITOR_PATTERNS].some((pattern) => patterns.has(pattern));
    if (hasTriplet) fullTripletEntities += 1;
  }
  summary.entitiesWithFullCrudTriplet = fullTripletEntities;

  const primaryEntities = (contract.dataEntities || []).filter((entity) => entity.role === 'primary');
  const everyPrimaryEntityTripled = primaryEntities.length >= 2 && fullTripletEntities === primaryEntities.length;
  if (fullTripletEntities >= 3 || everyPrimaryEntityTripled) {
    errors.push(finding(
      'entity-crud-template-expansion',
      `${fullTripletEntities} entities each receive a list + detail + editor triplet; screens must follow from jobs, not be generated per entity`,
    ));
  }

  for (const entity of contract.dataEntities || []) {
    if (entity.role === 'primary') continue;
    for (const screenId of entity.screenIds || []) {
      const screen = screens.get(screenId);
      if (!screen) {
        errors.push(finding(
          'entity-screen-not-declared',
          `data entity "${entity.name}" references screen "${screenId}", which is not declared in screens[]`,
        ));
        continue;
      }
      if (!GENERIC_PATTERNS.has(screen.pattern)) continue;
      const servesCoreJob = (screen.jobIds || []).some((id) => coreJobIds.has(id));
      if (!servesCoreJob) {
        errors.push(finding(
          'reference-entity-dedicated-screen',
          `${entity.role} entity "${entity.name}" has dedicated screen "${screenId}" that serves no core job; supporting and reference entities normally have zero screens`,
        ));
      }
    }
  }

  const entitiesWithoutScreens = (contract.dataEntities || [])
    .filter((entity) => !(entity.screenIds || []).length)
    .map((entity) => entity.name);
  // Recorded, never flagged: zero dedicated screens is the expected outcome for supporting and
  // reference data.
  summary.entitiesWithoutScreens = entitiesWithoutScreens;

  for (const entity of contract.dataEntities || []) {
    for (const screenId of entity.screenIds || []) {
      const screen = screens.get(screenId);
      if (screen && screen.entity && screen.entity !== entity.name) {
        warnings.push(finding(
          'entity-screen-cross-reference',
          `data entity "${entity.name}" claims screen "${screenId}", which targets entity "${screen.entity}"`,
        ));
      }
    }
  }
}

function validateScopeSemantics(contract) {
  const errors = [];
  const warnings = [];
  const summary = {};

  validateIdentity(contract, errors);
  validateCoverage(contract, errors, warnings, summary);
  validateRequirementCoverage(contract, errors, summary);
  validateScreenBudget(contract, errors, warnings, summary);
  validateNavigation(contract, errors, warnings, summary);
  validateTableBudget(contract, errors, warnings, summary);
  validateCompositionEconomy(contract, errors, warnings, summary);

  summary.coreJobCount = (contract.coreJobs || []).length;
  summary.supportingJobCount = (contract.supportingJobs || []).length;
  summary.deferredJobCount = (contract.deferredJobs || []).length;
  const scopeIntegrityCodes = new Set([
    'duplicate-screen-id',
    'duplicate-entity',
    'duplicate-new-table',
    'screen-without-known-job',
    'new-table-without-job',
    'new-table-entity-mismatch',
    'entity-screen-not-declared',
  ]);
  summary.orphanOrDuplicateFindingCount = errors.filter(
    (item) => scopeIntegrityCodes.has(item.code),
  ).length;

  return { errors, warnings, summary };
}

module.exports = { userFacingScreens, validateScopeSemantics };
