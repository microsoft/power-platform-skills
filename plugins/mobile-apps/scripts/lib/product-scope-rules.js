'use strict';

// Semantic rules for the product-scope contract.
//
// The failure this guards against is scope inflation by template: an app that "supports" ten
// nouns by generating a list, a detail, and a form for each of them, plus a table per noun.
// Every rule below asks the same question — what job of the user does this surface or table
// exist to complete? — and never asks what industry the product is in.

const {
  ABSOLUTE_SCREEN_CEILING,
  GENERIC_RECORD_PATTERNS,
  SCREEN_BUDGETS,
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

function validateCoverage(contract, errors, warnings) {
  const screens = indexById(contract.screens || []);
  const shippingJobs = [...(contract.coreJobs || []), ...(contract.supportingJobs || [])];
  const shippingJobIds = new Set(shippingJobs.map((job) => job.id));

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
    }
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
  if (declared.target > declared.max) {
    errors.push(finding('invalid-screen-budget', 'screenBudget.target exceeds screenBudget.max'));
  }
  if (band.max !== null && declared.max > band.max) {
    errors.push(finding(
      'screen-budget-exceeds-band',
      `screenBudget.max ${declared.max} exceeds the ${complexity} band maximum of ${band.max}; reclassify productComplexity instead of raising the budget`,
    ));
  }
  if (count > declared.max) {
    errors.push(finding(
      'screen-count-over-budget',
      `${count} user-facing screens exceed the declared budget max of ${declared.max}`,
    ));
  }
  if (band.max !== null && count > band.max) {
    errors.push(finding(
      'screen-count-over-complexity-band',
      `${count} user-facing screens exceed the ${complexity} band of ${band.min}-${band.max}; either compose surfaces or reclassify the product`,
    ));
  }
  if (count < band.min) {
    // Under-target is a conversation, not a defect: a product can be genuinely smaller than
    // its declared complexity band suggests.
    warnings.push(finding(
      'screen-count-under-band',
      `${count} user-facing screens is below the ${complexity} band minimum of ${band.min}; confirm the complexity classification`,
    ));
  }

  if (count > ABSOLUTE_SCREEN_CEILING) {
    const justification = contract.exceptionalJustification;
    if (complexity !== 'exceptional' || !justification) {
      errors.push(finding(
        'screen-ceiling-without-exceptional-justification',
        `${count} user-facing screens exceed the ${ABSOLUTE_SCREEN_CEILING}-screen ceiling; this requires productComplexity "exceptional" plus an exceptionalJustification naming the independent roles and journeys that cannot be composed`,
      ));
    }
  } else if (contract.exceptionalJustification && complexity !== 'exceptional') {
    warnings.push(finding(
      'unused-exceptional-justification',
      'exceptionalJustification is present but the contract is within the screen ceiling',
    ));
  }
}

function validateTableBudget(contract, errors, warnings, summary) {
  const complexity = contract.productComplexity;
  const band = TABLE_BUDGETS[complexity];
  const newTables = contract.newTables || [];
  summary.newTableCount = newTables.length;
  summary.tableBand = band;

  const declared = contract.newTableBudget || {};
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
  validateCoverage(contract, errors, warnings);
  validateScreenBudget(contract, errors, warnings, summary);
  validateTableBudget(contract, errors, warnings, summary);
  validateCompositionEconomy(contract, errors, warnings, summary);

  summary.coreJobCount = (contract.coreJobs || []).length;
  summary.supportingJobCount = (contract.supportingJobs || []).length;
  summary.deferredJobCount = (contract.deferredJobs || []).length;

  return { errors, warnings, summary };
}

module.exports = { userFacingScreens, validateScopeSemantics };
