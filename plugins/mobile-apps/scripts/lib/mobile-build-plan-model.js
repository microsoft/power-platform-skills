'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { estimate } = require('../planning-eta');
const { summarizePlanningTimings } = require('../planning-timings');
const { validateScopeContract } = require('../validate-product-scope');
const {
  contractApprovalContent,
  validateContract,
} = require('../build-dataverse-operation-manifest');
const { statusLabel } = require('./mobile-build-plan-html');
const { projectScreens } = require('./mobile-build-plan-screen-graph');

const BUILD_PLAN_SCHEMA_VERSION = 1;
const BUILD_PLAN_OUTPUT = '_build_plan.html';
const PROGRESS_ARTIFACT = '.tmp/mobile-build-progress.json';
const EDIT_JOURNAL_ARTIFACT = '.tmp/mobile-build-plan-edits.json';
const MAX_EVENTS = 200;
const PHASES = [
  ['requirements', 'Requirements'],
  ['experience', 'Experience and scope'],
  ['data-model', 'Data model'],
  ['architecture', 'Capabilities and data'],
  ['design', 'Design system'],
  ['scaffold', 'App scaffold'],
  ['dataverse', 'Dataverse'],
  ['navigation', 'Navigation'],
  ['screens', 'Screens'],
  ['validation', 'Validation'],
];
const PHASE_IDS = new Set(PHASES.map(([id]) => id));
const PHASE_STATUSES = new Set(['pending', 'active', 'waiting', 'complete', 'warning', 'failed']);
const SCREEN_STATUSES = new Set(['planned', 'packed', 'building', 'built', 'validated']);

const ARTIFACTS = {
  progress: PROGRESS_ARTIFACT,
  timings: '.tmp/mobile-planning-timings.json',
  timingHistory: '.tmp/mobile-planning-history.json',
  pipeline: '.tmp/pipeline-state.json',
  approvals: '.tmp/mobile-plan-status.json',
  experience: '.tmp/product-experience-contract.json',
  scope: '.tmp/product-scope-contract.json',
  journey: '.tmp/workflow-journey-contract.json',
  screens: '.tmp/compiled-screen-build-pack.json',
  dataModel: '.tmp/dataverse-schema-contract.json',
  dataverseManifest: '.tmp/dataverse-operation-manifest.json',
  dataverseJournal: '.tmp/dataverse-metadata-execution-journal.json',
};

const EXECUTION_EVIDENCE = [
  ARTIFACTS.dataverseJournal,
  '.tmp/dataverse-publish-pending.json',
  '.datamodel-manifest.json',
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function revisionOf(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function editableContractContent(contract) {
  const content = structuredClone(contract);
  delete content.approvedPlanSha256;
  delete content.approvedContractSha256;
  delete content.approvalReceiptSha256;
  return content;
}

function resolveInsideProject(projectRoot, relativePath) {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  return resolved;
}

function readJson(projectRoot, relativePath) {
  const file = resolveInsideProject(projectRoot, relativePath);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWriteJson(projectRoot, relativePath, value) {
  const file = resolveInsideProject(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, stableJson(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function emptyProgress(now = new Date().toISOString()) {
  return {
    schemaVersion: BUILD_PLAN_SCHEMA_VERSION,
    revision: 0,
    status: 'active',
    currentPhase: 'requirements',
    updatedAt: now,
    phases: PHASES.map(([id, label]) => ({ id, label, status: 'pending' })),
    screenStatuses: {},
    events: [],
  };
}

function validateProgressUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    throw new Error('Progress update must be an object');
  }
  if (!PHASE_IDS.has(update.phase)) throw new Error(`Unknown build phase: ${update.phase}`);
  if (!PHASE_STATUSES.has(update.status)) {
    throw new Error(`Unknown build phase status: ${update.status}`);
  }
  if (update.detail !== undefined && (typeof update.detail !== 'string' || update.detail.length > 500)) {
    throw new Error('Progress detail must be a string of at most 500 characters');
  }
  const hasScreenIds = update.screenIds !== undefined;
  const hasScreenStatus = update.screenStatus !== undefined;
  if (hasScreenIds !== hasScreenStatus) {
    throw new Error('screenIds and screenStatus must be supplied together');
  }
  if (hasScreenIds && (!Array.isArray(update.screenIds)
    || update.screenIds.length === 0
    || update.screenIds.some((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)))) {
    throw new Error('screenIds must be a non-empty array of screen IDs');
  }
  if (hasScreenStatus && !SCREEN_STATUSES.has(update.screenStatus)) {
    throw new Error(`Unknown screen status: ${update.screenStatus}`);
  }
}

function nextProgressState(currentValue, update, now = new Date().toISOString()) {
  validateProgressUpdate(update);
  const current = currentValue || emptyProgress(now);
  const phases = PHASES.map(([id, label]) => {
    const existing = (current.phases || []).find((phase) => phase.id === id) || {};
    if (id !== update.phase) return { id, label, status: existing.status || 'pending', ...existing };
    return {
      id,
      label,
      ...existing,
      status: update.status,
      ...(update.detail ? { detail: update.detail } : {}),
      updatedAt: now,
    };
  });
  const event = {
    sequence: Number(current.revision || 0) + 1,
    at: now,
    phase: update.phase,
    status: update.status,
    ...(update.detail ? { detail: update.detail } : {}),
    ...(update.screenIds ? {
      screenIds: [...new Set(update.screenIds)],
      screenStatus: update.screenStatus,
    } : {}),
  };
  const screenStatuses = { ...(current.screenStatuses || {}) };
  for (const screenId of update.screenIds || []) screenStatuses[screenId] = update.screenStatus;
  return {
    schemaVersion: BUILD_PLAN_SCHEMA_VERSION,
    revision: event.sequence,
    status: update.overallStatus || current.status || 'active',
    currentPhase: update.phase,
    updatedAt: now,
    phases,
    screenStatuses,
    events: [...(current.events || []), event].slice(-MAX_EVENTS),
  };
}

function updateProgress(projectRoot, update, now = new Date().toISOString()) {
  const next = nextProgressState(readJson(projectRoot, PROGRESS_ARTIFACT), update, now);
  atomicWriteJson(projectRoot, PROGRESS_ARTIFACT, next);
  return next;
}

function normalizeProgress(progress) {
  const current = progress || emptyProgress();
  const known = new Map((current.phases || []).map((phase) => [phase.id, phase]));
  return {
    ...current,
    phases: PHASES.map(([id, label]) => ({
      id,
      label,
      status: 'pending',
      ...(known.get(id) || {}),
    })),
    screenStatuses: current.screenStatuses || {},
  };
}

function approvalEntries(approvals) {
  if (!approvals || typeof approvals !== 'object') return [];
  const source = approvals.approvals || approvals.gates || approvals.sections || {};
  if (Array.isArray(source)) {
    return source.map((entry, index) => ({
      label: entry.label || entry.name || entry.id || `Gate ${index + 1}`,
      status: entry.status || entry.state || 'pending',
    }));
  }
  return Object.entries(source).map(([label, entry]) => ({
    label,
    status: typeof entry === 'string' ? entry : entry?.status || entry?.state || 'pending',
  }));
}

function hasExecutionStarted(projectRoot) {
  return EXECUTION_EVIDENCE.some((relativePath) => {
    const file = resolveInsideProject(projectRoot, relativePath);
    if (!fs.existsSync(file)) return false;
    const stat = fs.lstatSync(file);
    return stat.isSymbolicLink() || stat.size > 0;
  });
}

function timingSummary(timings) {
  if (!timings?.stages || Array.isArray(timings.stages)) return null;
  try {
    return summarizePlanningTimings(timings);
  } catch {
    return null;
  }
}

function pipelineSummary(pipeline) {
  if (!pipeline || typeof pipeline !== 'object') return null;
  return {
    completedStep: pipeline.completedStep || null,
    recordedAt: pipeline.recordedAt || null,
    trackedArtifacts: Object.keys(pipeline.artifacts || {}).sort(),
  };
}

function dataverseSummary(manifest, journal) {
  const phases = manifest?.execution?.phases || manifest?.phases || {};
  return {
    manifestReady: Boolean(manifest),
    executable: manifest?.executable === true || manifest?.summary?.executable === true,
    operationCount: Number(manifest?.summary?.metadataOperationCount || 0),
    phases: Object.entries(phases).map(([name, phase]) => ({
      name,
      operationCount: Array.isArray(phase?.operations) ? phase.operations.length : 0,
    })),
    journalStarted: Boolean(journal),
    completedOperationCount: Object.keys(journal?.completed || {}).length,
    operationInFlight: Boolean(journal?.inFlight),
    recoveryCount: Array.isArray(journal?.recoveries) ? journal.recoveries.length : 0,
  };
}

function redactBrowserText(value) {
  return String(value || '')
    .replace(/https:\/\/[^\s)]+\.crm(?:\d+)?\.dynamics\.com[^\s)]*/gi, '[environment]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[identifier]')
    .replace(/^.*\b(?:password|client secret|access token|refresh token)\b.*$/gim, '[sensitive value omitted]');
}

function redactBrowserValue(value) {
  if (typeof value === 'string') return redactBrowserText(value);
  if (Array.isArray(value)) return value.map(redactBrowserValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    redactBrowserValue(item),
  ]));
}

function readPlanSections(projectRoot) {
  const file = resolveInsideProject(projectRoot, 'native-app-plan.md');
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return {};
  const sections = {};
  let current = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      if (current !== 'Plan Provenance') sections[current] = [];
    } else if (current && sections[current]) {
      sections[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([name, lines]) => [
    name,
    redactBrowserText(lines.join('\n').trim()).slice(0, 20000),
  ]));
}

function browserExperience(experience) {
  if (!experience || typeof experience !== 'object') return null;
  const summary = structuredClone(experience);
  // Prompt excerpts are planning evidence, so only derived decisions cross into browser output.
  delete summary.promptEvidence;
  return redactBrowserValue(summary);
}

function makerProgress(progress) {
  const currentIndex = Math.max(0, PHASES.findIndex(([id]) => id === progress.currentPhase));
  const current = progress.phases[currentIndex] || progress.phases[0];
  const complete = progress.status === 'complete'
    || progress.phases.every((phase) => phase.status === 'complete');
  const needsAttention = current?.status === 'failed'
    || current?.status === 'warning'
    || progress.phases.some((phase) => phase.status === 'failed');
  return {
    phase: currentIndex + 1,
    phaseCount: PHASES.length,
    phaseId: current?.id || PHASES[0][0],
    phaseLabel: current?.label || PHASES[0][1],
    state: complete
      ? 'Complete'
      : needsAttention
        ? 'Needs attention'
        : current?.status === 'waiting'
          ? 'Waiting for review'
          : 'Building',
    estimatedRemainingMs: null,
  };
}

function scopeHealth(scope, experience) {
  if (!scope || typeof scope !== 'object') return null;
  return redactBrowserValue(validateScopeContract(scope, experience));
}

function makerSummary(experience, scope, journey, screens, health, approvals) {
  const screenById = new Map(screens.map((screen) => [screen.screenId, screen]));
  const primaryUser = experience?.primaryUser || {};
  const approvalSource = approvals?.approvals || {};
  const architectureSummary = approvals?.architectureSummary || {};
  return redactBrowserValue({
    product: experience?.productName || null,
    primaryUsers: [primaryUser.role, ...(primaryUser.secondaryUsers || [])].filter(Boolean),
    primaryGoal: experience?.primaryGoal || null,
    keyJourney: journey?.journeys?.[0]
      ? {
        name: journey.journeys[0].name,
        outcome: journey.journeys[0].successOutcome,
      }
      : null,
    navigation: scope?.navigation
      ? {
        pattern: scope.navigation.pattern,
        durableDestinations: (scope.navigation.durableDestinationIds || []).map((id) => ({
          id,
          title: screenById.get(id)?.title || id,
          visible: (scope.navigation.visibleTabIds || []).includes(id),
        })),
        returnHomeMechanism: scope.navigation.returnHomeMechanism || null,
      }
      : null,
    userFacingScreenCount: health?.summary?.userFacingScreenCount
      ?? screens.filter((screen) => screen.userFacing !== false).length,
    dataOwnership: (scope?.dataEntities || []).map((entity) => ({
      name: entity.name,
      role: entity.role,
      realization: entity.realization,
      note: entity.note || null,
    })),
    nativeCapabilities: architectureSummary.nativeCapabilities || [],
    nativeCapabilitiesStatus: approvalSource.nativeCapabilities?.status
      || approvalSource.nativeCapabilities
      || 'pending',
    connectors: architectureSummary.connectors || [],
    connectorsStatus: approvalSource.connectors?.status
      || approvalSource.connectors
      || 'pending',
    assumptions: experience?.assumptions || [],
    deferredItems: [
      ...(scope?.deferredJobs || []).map((job) => ({
        id: job.id,
        statement: job.statement,
        reason: job.deferralReason,
      })),
      ...(scope?.requirements || []).filter((item) => item.disposition === 'deferred').map(
        (item) => ({ id: item.id, statement: item.statement, reason: 'Deferred requirement' }),
      ),
    ],
  });
}

function deriveBuildPlanModel(projectRoot, options = {}) {
  const artifacts = Object.fromEntries(
    Object.entries(ARTIFACTS).map(([key, relativePath]) => [key, readJson(projectRoot, relativePath)]),
  );
  const progress = redactBrowserValue(normalizeProgress(artifacts.progress));
  const dataModel = artifacts.dataModel || { tables: [] };
  const dataModelValid = artifacts.dataModel
    ? validateContract(artifacts.dataModel).valid
    : false;
  const dataModelRevision = artifacts.dataModel
    ? revisionOf(dataModelValid
      ? contractApprovalContent(artifacts.dataModel)
      : editableContractContent(artifacts.dataModel))
    : null;
  const editJournal = readJson(projectRoot, EDIT_JOURNAL_ARTIFACT);
  const scope = redactBrowserValue(artifacts.scope || {});
  const health = scopeHealth(artifacts.scope, artifacts.experience);
  const screens = redactBrowserValue(projectScreens(
    artifacts.scope,
    artifacts.journey,
    artifacts.screens,
    artifacts.progress?.screenStatuses,
  ));
  const scopeEntities = new Map((artifacts.scope?.dataEntities || []).map(
    (entity) => [entity.name, entity],
  ));
  const scopeTables = new Map((artifacts.scope?.newTables || []).map(
    (table) => [table.name, table],
  ));
  const tables = redactBrowserValue((dataModel.tables || []).map((table) => ({
    logicalName: table.logicalName,
    schemaName: table.schemaName || table.logicalName,
    displayName: table.displayName || table.schemaName || table.logicalName,
    displayCollectionName: table.displayCollectionName || '',
    decision: table.plannedDecision || 'unverified',
    dependencyTier: table.dependencyTier,
    serviceRequired: table.serviceRequired,
    ownershipType: table.ownershipType,
    columns: table.columns || [],
    relationships: table.relationships || [],
    scopeEvidence: {
      entity: scopeEntities.get(table.displayName || table.logicalName)
        || scopeEntities.get(table.schemaName || table.logicalName)
        || null,
      table: scopeTables.get(table.displayName || table.logicalName)
        || scopeTables.get(table.schemaName || table.logicalName)
        || null,
    },
  })));
  const model = {
    schemaVersion: BUILD_PLAN_SCHEMA_VERSION,
    generatedAt: options.now || new Date().toISOString(),
    projectName: redactBrowserText(
      artifacts.experience?.productName || path.basename(path.resolve(projectRoot)),
    ),
    progress,
    makerProgress: makerProgress(progress),
    approvals: approvalEntries(artifacts.approvals),
    publisherPrefix: dataModel.publisherPrefix || null,
    experience: browserExperience(artifacts.experience),
    scope,
    journey: redactBrowserValue(artifacts.journey),
    screens,
    tables,
    scopeHealth: health,
    makerSummary: makerSummary(
      artifacts.experience,
      artifacts.scope,
      artifacts.journey,
      screens,
      health,
      artifacts.approvals,
    ),
    dataModelRevision,
    dataModelEditable: dataModelValid && !hasExecutionStarted(projectRoot),
    undo: editJournal?.undo?.revision === dataModelRevision
      ? { available: true, target: redactBrowserText(editJournal.undo.target) }
      : { available: false, target: null },
    timings: timingSummary(artifacts.timings),
    eta: artifacts.timingHistory?.samples ? estimate(artifacts.timingHistory) : null,
    planSections: readPlanSections(projectRoot),
    pipeline: pipelineSummary(artifacts.pipeline),
    dataverse: dataverseSummary(
      artifacts.dataverseManifest,
      artifacts.dataverseJournal,
    ),
  };
  model.revision = revisionOf({ ...model, generatedAt: undefined });
  return model;
}

module.exports = {
  ARTIFACTS,
  BUILD_PLAN_OUTPUT,
  BUILD_PLAN_SCHEMA_VERSION,
  EDIT_JOURNAL_ARTIFACT,
  PHASES,
  PROGRESS_ARTIFACT,
  deriveBuildPlanModel,
  editableContractContent,
  emptyProgress,
  hasExecutionStarted,
  nextProgressState,
  resolveInsideProject,
  revisionOf,
  updateProgress,
};