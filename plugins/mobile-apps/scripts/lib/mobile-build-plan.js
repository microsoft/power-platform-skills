'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { estimate } = require('../planning-eta');
const { summarizePlanningTimings } = require('../planning-timings');

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
  };
  const next = {
    schemaVersion: BUILD_PLAN_SCHEMA_VERSION,
    revision: event.sequence,
    status: update.overallStatus || current.status || 'active',
    currentPhase: update.phase,
    updatedAt: now,
    phases,
    events: [...(current.events || []), event].slice(-MAX_EVENTS),
  };
  return next;
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
  // Prompt excerpts are planner evidence, not product-plan content. The Build Plan renders
  // the resulting decisions and classified assumptions without moving raw prompts into a
  // browser process.
  delete summary.promptEvidence;
  return redactBrowserValue(summary);
}

function deriveBuildPlanModel(projectRoot, options = {}) {
  const artifacts = Object.fromEntries(
    Object.entries(ARTIFACTS).map(([key, relativePath]) => [key, readJson(projectRoot, relativePath)]),
  );
  const progress = redactBrowserValue(normalizeProgress(artifacts.progress));
  const dataModel = artifacts.dataModel || { tables: [] };
  const scope = redactBrowserValue(artifacts.scope || {});
  const screens = redactBrowserValue(artifacts.screens?.screens || []);
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
  })));
  const model = {
    schemaVersion: BUILD_PLAN_SCHEMA_VERSION,
    generatedAt: options.now || new Date().toISOString(),
    projectName: redactBrowserText(
      artifacts.experience?.productName || path.basename(path.resolve(projectRoot)),
    ),
    progress,
    approvals: approvalEntries(artifacts.approvals),
    publisherPrefix: dataModel.publisherPrefix || null,
    experience: browserExperience(artifacts.experience),
    scope,
    journey: redactBrowserValue(artifacts.journey),
    screens,
    tables,
    dataModelRevision: artifacts.dataModel
      ? revisionOf(editableContractContent(artifacts.dataModel))
      : null,
    dataModelEditable: Boolean(artifacts.dataModel) && !hasExecutionStarted(projectRoot),
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

function statusLabel(value) {
  return String(value || 'pending').replace(/[-_]/g, ' ');
}

function formatDuration(milliseconds) {
  const value = Number(milliseconds || 0);
  if (!Number.isFinite(value) || value <= 0) return 'Not measured';
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatEventTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(
    date.getUTCMinutes(),
  ).padStart(2, '0')} UTC`;
}

function renderErDiagram(tables) {
  if (tables.length === 0) {
    return '<div class="empty"><strong>No entities to map</strong><span>The diagram will appear after the data model is authored.</span></div>';
  }
  const columns = Math.min(3, Math.max(1, tables.length));
  const cardWidth = 300;
  const cardHeight = 184;
  const gapX = 72;
  const gapY = 70;
  const width = columns * cardWidth + (columns - 1) * gapX + 48;
  const rows = Math.ceil(tables.length / columns);
  const height = rows * cardHeight + (rows - 1) * gapY + 48;
  const positions = new Map(tables.map((table, index) => [table.logicalName, {
    x: 24 + (index % columns) * (cardWidth + gapX),
    y: 24 + Math.floor(index / columns) * (cardHeight + gapY),
  }]));
  const relationshipLines = tables.flatMap((owner) => owner.relationships.map((relationship) => {
    const sourceName = relationship.kind === 'many-to-one'
      ? relationship.childTable || owner.logicalName
      : relationship.entity1;
    const targetName = relationship.kind === 'many-to-one'
      ? relationship.parentTable
      : relationship.entity2;
    const source = positions.get(sourceName);
    const target = positions.get(targetName);
    if (!source || !target) return '';
    const startX = source.x + cardWidth / 2;
    const startY = source.y + cardHeight / 2;
    const endX = target.x + cardWidth / 2;
    const endY = target.y + cardHeight / 2;
    return `<g class="er-edge"><line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" marker-end="url(#arrow)"></line><title>${escapeHtml(relationship.schemaName)}</title></g>`;
  })).join('');
  const tableNodes = tables.map((table) => {
    const position = positions.get(table.logicalName);
    const visibleColumns = table.columns.slice(0, 5);
    return `<g class="er-node decision-${escapeHtml(table.decision)}" transform="translate(${position.x} ${position.y})">
      <rect width="${cardWidth}" height="${cardHeight}" rx="6"></rect>
      <rect class="er-node-head" width="${cardWidth}" height="48" rx="6"></rect>
      <text class="er-node-title" x="16" y="23">${escapeHtml(table.displayName)}</text>
      <text class="er-node-name" x="16" y="39">${escapeHtml(table.logicalName)}</text>
      ${visibleColumns.map((column, index) => `<text class="er-column" x="16" y="${70 + index * 20}">${escapeHtml(column.primaryName ? 'PK  ' : column.type === 'lookup' ? 'FK  ' : '    ')}${escapeHtml(column.displayName || column.logicalName)} · ${escapeHtml(statusLabel(column.type))}</text>`).join('')}
      ${table.columns.length > visibleColumns.length ? `<text class="er-more" x="16" y="170">+ ${table.columns.length - visibleColumns.length} more columns</text>` : ''}
    </g>`;
  }).join('');
  return `<div class="er-canvas" id="er-canvas"><div class="er-controls"><button type="button" id="er-zoom-in" title="Zoom in" aria-label="Zoom in">+</button><span id="er-zoom-level">100%</span><button type="button" id="er-zoom-out" title="Zoom out" aria-label="Zoom out">−</button><button type="button" id="er-reset" title="Reset view" aria-label="Reset view">↺</button></div><svg id="er-stage" viewBox="0 0 ${width} ${height}" role="img" aria-label="Entity relationship diagram"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>${relationshipLines}${tableNodes}</svg></div>`;
}

function renderProjection(value, emptyText) {
  return value
    ? `<pre class="plan-copy">${escapeHtml(value)}</pre>`
    : `<div class="empty compact"><strong>${escapeHtml(emptyText)}</strong></div>`;
}

function renderBuildPlanHtml(model, options = {}) {
  const token = options.token || '';
  const canEdit = Boolean(token) && model.dataModelEditable;
  const editDisabled = canEdit
    ? ''
    : ' disabled aria-disabled="true" title="Editing is available while the live planning server is running before Dataverse execution"';
  const serializedModel = JSON.stringify(model).replace(/</g, '\\u003c');
  const phaseRows = model.progress.phases.map((phase) => `
    <li class="phase phase-${escapeHtml(phase.status)}">
      <span class="phase-mark" aria-hidden="true"></span>
      <span><strong>${escapeHtml(phase.label)}</strong><small>${escapeHtml(phase.detail || statusLabel(phase.status))}</small></span>
    </li>`).join('');
  const tableCards = model.tables.length > 0 ? model.tables.map((table) => `
    <details class="table-card" data-table="${escapeHtml(table.logicalName)}">
      <summary><span><strong>${escapeHtml(table.displayName)}</strong><small>${escapeHtml(table.logicalName)} · Tier ${escapeHtml(table.dependencyTier ?? 0)}</small></span><em>${escapeHtml(table.decision)}</em></summary>
      <div class="table-body">
        <div class="column-head"><span>Column</span><span>Type</span><span>Decision</span><span></span></div>
        ${table.columns.map((column) => `<div class="column-row"><span><strong>${escapeHtml(column.displayName || column.schemaName || column.logicalName)}</strong><small>${escapeHtml(column.logicalName)}</small></span><span>${escapeHtml(statusLabel(column.type))}</span><span>${escapeHtml(column.plannedDecision || 'unverified')}</span><button class="row-action" type="button" data-edit-column="${escapeHtml(column.logicalName)}" data-table="${escapeHtml(table.logicalName)}"${editDisabled}>Edit</button></div>`).join('')}
        ${table.relationships.length > 0 ? `<div class="relationship-list"><h4>Relationships</h4>${table.relationships.map((relationship) => `<button class="relationship-row" type="button" data-edit-relationship="${escapeHtml(relationship.schemaName)}" data-table="${escapeHtml(table.logicalName)}"${editDisabled}><span>${escapeHtml(relationship.schemaName)}</span><small>${escapeHtml(relationship.kind === 'many-to-one' ? `${relationship.childTable || table.logicalName} → ${relationship.parentTable}` : `${relationship.entity1} ↔ ${relationship.entity2}`)}</small></button>`).join('')}</div>` : ''}
        <div class="card-actions"><button type="button" data-edit-table="${escapeHtml(table.logicalName)}"${editDisabled}>Edit table</button><button type="button" data-add-column="${escapeHtml(table.logicalName)}"${editDisabled}>Add column</button><button type="button" data-add-relationship="${escapeHtml(table.logicalName)}"${editDisabled}>Add relationship</button></div>
      </div>
    </details>`).join('') : '<div class="empty"><strong>Data model not authored yet</strong><span>Tables and columns will appear here as planning progresses.</span></div>';
  const screenCards = model.screens.length > 0 ? model.screens.map((screen) => `
    <article class="screen-row"><span>${escapeHtml(screen.pack?.classification || 'screen')}</span><strong>${escapeHtml(screen.title || screen.screenId)}</strong><small>${escapeHtml(screen.pack?.purpose || '')}</small><dl><div><dt>Primary action</dt><dd>${escapeHtml(screen.pack?.firstViewport?.primaryAction || 'Pending')}</dd></div><div><dt>Signature</dt><dd>${escapeHtml(screen.pack?.signatureInteraction?.name || 'Pending')}</dd></div></dl><div class="state-tags">${Object.keys(screen.pack?.states || {}).map((state) => `<b>${escapeHtml(state)}</b>`).join('')}</div></article>`).join('') : '<div class="empty"><strong>Screens not compiled yet</strong><span>The approved screen graph will appear here.</span></div>';
  const approvalRows = model.approvals.length > 0 ? model.approvals.map((approval) => `<li><span>${escapeHtml(approval.label)}</span><strong>${escapeHtml(statusLabel(approval.status))}</strong></li>`).join('') : '<li><span>Planning approvals</span><strong>pending</strong></li>';
  const currentPhase = model.progress.phases.find(
    (phase) => phase.id === model.progress.currentPhase,
  ) || model.progress.phases[0];
  const completedPhases = model.progress.phases.filter((phase) => phase.status === 'complete').length;
  const progressPercent = Math.round((completedPhases / model.progress.phases.length) * 100);
  const retryCount = Object.values(model.timings?.retries || {}).reduce(
    (total, count) => total + Number(count || 0),
    0,
  );
  const metricCards = [
    ['Completion', `${progressPercent}%`],
    ['Active time', formatDuration(model.timings?.totalExecutionMs)],
    ['Approval wait', formatDuration(model.timings?.userApprovalWaitingMs)],
    ['Planning estimate', formatDuration(model.eta?.p50Ms)],
    ['Tables', model.tables.length],
    ['Screens', model.screens.length],
  ].map(([label, value]) => `<div class="metric"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`).join('');
  const eventRows = (model.progress.events || []).slice(-8).reverse().map((event) => `<li><time>${escapeHtml(formatEventTime(event.at))}</time><span><strong>${escapeHtml(statusLabel(event.phase))}</strong><small>${escapeHtml(event.detail || statusLabel(event.status))}</small></span></li>`).join('') || '<li class="muted-row">Build events will appear here.</li>';
  const experience = model.experience || {};
  const scope = model.scope || {};
  const jobCards = [...(scope.coreJobs || []), ...(scope.supportingJobs || [])].map((job) => `<article class="job-row"><span>${escapeHtml(job.criticality || 'supporting')}</span><strong>${escapeHtml(job.statement)}</strong><small>${escapeHtml(job.outcome)}</small></article>`).join('') || '<div class="empty compact"><strong>Jobs are being defined</strong></div>';
  const journeyCards = (model.journey?.journeys || []).map((journey) => `<article class="journey"><header><span>${escapeHtml(journey.name)}</span><strong>${escapeHtml(journey.successOutcome)}</strong></header><ol>${[...(journey.steps || [])].sort((left, right) => left.order - right.order).map((step) => `<li><b>${escapeHtml(step.order)}</b><span><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.userAction)}</small></span></li>`).join('')}</ol></article>`).join('') || '<div class="empty compact"><strong>Journeys are being composed</strong></div>';
  const entityRows = (scope.dataEntities || []).map((entity) => `<li><span><strong>${escapeHtml(entity.name)}</strong><small>${escapeHtml(entity.role)}</small></span><b>${escapeHtml(statusLabel(entity.realization))}</b></li>`).join('') || '<li class="muted-row">Persistence ownership is pending.</li>';
  const tableOptions = model.tables.map((table) => `<option value="${escapeHtml(table.logicalName)}">${escapeHtml(table.displayName)} (${escapeHtml(table.logicalName)})</option>`).join('');
  const jobOptions = [...(scope.coreJobs || []), ...(scope.supportingJobs || [])].map((job) => `<label class="check-row"><input type="checkbox" name="scope-job" value="${escapeHtml(job.id)}"><span>${escapeHtml(job.statement)}</span></label>`).join('') || '<span class="field-help">No Product Scope jobs are available yet.</span>';
  const validationRows = [
    ['Pipeline checkpoint', model.pipeline?.completedStep ? `Step ${model.pipeline.completedStep}` : 'Pending'],
    ['Tracked artifacts', model.pipeline?.trackedArtifacts?.length || 0],
    ['Dataverse manifest', model.dataverse.manifestReady ? 'Ready' : 'Pending'],
    ['Metadata operations', model.dataverse.operationCount],
    ['Completed operations', model.dataverse.completedOperationCount],
    ['Retries', retryCount],
  ].map(([label, value]) => `<div class="validation-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'">
<title>${escapeHtml(model.projectName)} · Build Plan</title>
<style>
:root{--ink:#17202a;--muted:#61707d;--line:#d9e0e7;--paper:#fff;--wash:#f3f6f8;--blue:#0f6cbd;--blue-soft:#e5f1fb;--green:#16805b;--amber:#a15c00;--red:#c4314b;--radius:6px;--shadow:0 14px 40px rgba(32,48,64,.09)}
*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font-family:"Avenir Next",Avenir,"Segoe UI",sans-serif;letter-spacing:0}button{font:inherit}button:focus-visible,[role=tab]:focus-visible,summary:focus-visible{outline:3px solid #75b6e7;outline-offset:2px}.shell{min-height:100vh;display:grid;grid-template-columns:minmax(238px,292px) 1fr}.rail{position:sticky;top:0;height:100vh;overflow:auto;background:#111b24;color:#f7fafc;padding:30px 24px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:30px}.brand-mark{width:38px;height:38px;display:grid;place-items:center;background:var(--blue);font:700 18px Menlo,monospace}.brand strong{display:block;font-family:"Avenir Next Condensed","Arial Narrow",sans-serif;font-size:20px}.brand small{color:#aab8c3}.phase-list{list-style:none;margin:0;padding:0;position:relative}.phase-list:before{content:"";position:absolute;left:7px;top:12px;bottom:14px;width:1px;background:#40505d}.phase{display:grid;grid-template-columns:15px 1fr;gap:12px;position:relative;padding:0 0 18px}.phase-mark{width:15px;height:15px;border:2px solid #72818d;background:#111b24;margin-top:2px;z-index:1}.phase strong,.phase small{display:block}.phase strong{font-size:13px}.phase small{font-size:11px;color:#94a5b2;margin-top:2px;text-transform:capitalize}.phase-active .phase-mark{border-color:#62b0e8;background:#62b0e8;box-shadow:0 0 0 5px rgba(98,176,232,.16)}.phase-complete .phase-mark{border-color:#57b894;background:#57b894}.phase-waiting .phase-mark,.phase-warning .phase-mark{border-color:#f0b35a;background:#f0b35a}.phase-failed .phase-mark{border-color:#e8677c;background:#e8677c}.main{min-width:0}.topbar{min-height:82px;background:var(--paper);border-bottom:1px solid var(--line);padding:18px clamp(20px,4vw,54px);display:flex;align-items:center;justify-content:space-between;gap:20px}.topbar h1{font-family:"Avenir Next Condensed","Arial Narrow",sans-serif;font-size:28px;margin:0}.topbar p{color:var(--muted);margin:2px 0 0;font-size:13px}.live{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:var(--green)}.live:before{content:"";width:9px;height:9px;background:currentColor;border-radius:50%;box-shadow:0 0 0 5px rgba(22,128,91,.1)}.tabs{display:flex;gap:2px;overflow:auto;padding:0 clamp(20px,4vw,54px);background:var(--paper);border-bottom:1px solid var(--line)}[role=tab]{border:0;background:transparent;padding:15px 13px 13px;color:var(--muted);font-weight:700;font-size:12px;border-bottom:3px solid transparent;white-space:nowrap}[role=tab][aria-selected=true]{color:var(--blue);border-color:var(--blue)}.content{padding:30px clamp(20px,4vw,54px) 60px;max-width:1380px}.panel[hidden]{display:none}.section-head{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:18px}.section-head h2{font-family:"Avenir Next Condensed","Arial Narrow",sans-serif;font-size:24px;margin:0}.section-head p{margin:4px 0 0;color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}.block{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}.progress-block{grid-column:span 8}.approval-block{grid-column:span 4}.block h3{font-size:13px;text-transform:uppercase;margin:0 0 16px;color:var(--muted)}.approval-list{list-style:none;padding:0;margin:0}.approval-list li{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-top:1px solid var(--line);font-size:13px}.approval-list li:first-child{border-top:0}.approval-list strong{text-transform:capitalize}.table-actions{display:flex;justify-content:flex-end;margin-bottom:12px}.primary,.card-actions button{border:1px solid var(--blue);border-radius:4px;background:var(--paper);color:var(--blue);padding:8px 11px;font-size:12px;font-weight:700}.primary{background:var(--blue);color:#fff}.table-card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);margin:0 0 10px;overflow:hidden}.table-card summary{list-style:none;cursor:pointer;padding:15px 17px;display:flex;align-items:center;justify-content:space-between;gap:16px}.table-card summary::-webkit-details-marker{display:none}.table-card summary span strong,.table-card summary span small{display:block}.table-card summary small,.column-row small{color:var(--muted);font:11px Menlo,monospace;margin-top:3px}.table-card summary em{font-style:normal;color:var(--blue);background:var(--blue-soft);padding:4px 7px;border-radius:3px;font-size:11px}.table-body{border-top:1px solid var(--line);padding:10px 17px 16px}.column-head,.column-row{display:grid;grid-template-columns:minmax(180px,2fr) minmax(100px,1fr) minmax(100px,1fr);gap:12px;align-items:center}.column-head{color:var(--muted);font-size:10px;text-transform:uppercase;padding:5px 0}.column-row{padding:9px 0;border-top:1px solid #edf0f3;font-size:12px}.column-row strong,.column-row small{display:block}.card-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.screen-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.screen-row{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:16px;min-height:130px}.screen-row span{color:var(--blue);font-size:10px;text-transform:uppercase;font-weight:700}.screen-row strong,.screen-row small{display:block}.screen-row strong{margin-top:10px}.screen-row small{margin-top:6px;color:var(--muted);line-height:1.45}.empty{border:1px dashed #afbbc5;padding:30px;background:rgba(255,255,255,.55);display:grid;gap:5px;text-align:center}.empty span{font-size:12px;color:var(--muted)}.json-view{white-space:pre-wrap;overflow-wrap:anywhere;background:#111b24;color:#dfeaf2;padding:18px;border-radius:var(--radius);font:11px/1.6 Menlo,monospace;max-height:520px;overflow:auto}
@media(max-width:820px){.shell{display:block}.rail{position:relative;height:auto;padding:20px}.phase-list{display:grid;grid-template-columns:repeat(5,minmax(125px,1fr));overflow:auto}.phase-list:before{display:none}.phase{padding:0 14px 8px 0}.topbar{align-items:flex-start}.progress-block,.approval-block{grid-column:1/-1}}@media(max-width:520px){.topbar{display:block}.live{margin-top:12px}.content{padding-top:20px}.section-head{align-items:flex-start;flex-direction:column}.column-head,.column-row{grid-template-columns:minmax(130px,1.5fr) 1fr}.column-head span:last-child,.column-row span:last-child{display:none}}@media(prefers-reduced-motion:no-preference){.live:before{animation:pulse 2s ease-out infinite}@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(22,128,91,.25)}70%{box-shadow:0 0 0 8px rgba(22,128,91,0)}100%{box-shadow:0 0 0 0 rgba(22,128,91,0)}}}
</style>
<style>
.live.snapshot{color:var(--muted)}.live.waiting{color:var(--amber)}.metric-strip{display:grid;grid-template-columns:repeat(6,minmax(112px,1fr));background:var(--paper);border:1px solid var(--line);margin-bottom:18px;overflow:auto}.metric{padding:15px 17px;border-left:1px solid var(--line);min-width:112px}.metric:first-child{border-left:0}.metric small,.metric strong{display:block}.metric small{font-size:10px;color:var(--muted);text-transform:uppercase}.metric strong{font:700 19px "Avenir Next Condensed","Arial Narrow",sans-serif;margin-top:4px}.workspace-grid,.plan-grid,.architecture-grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(250px,.75fr);gap:16px}.work-panel{background:var(--paper);border:1px solid var(--line);padding:20px}.work-panel h3{font-size:12px;text-transform:uppercase;color:var(--muted);margin:0 0 15px}.event-list{list-style:none;padding:0;margin:0}.event-list li{display:grid;grid-template-columns:72px 1fr;gap:14px;padding:10px 0;border-top:1px solid var(--line)}.event-list li:first-child{border-top:0}.event-list time{font:11px Menlo,monospace;color:var(--muted)}.event-list strong,.event-list small{display:block}.event-list small{color:var(--muted);font-size:12px;margin-top:2px}.muted-row{color:var(--muted);font-size:12px}.plan-hero{background:#111b24;color:white;padding:26px;margin-bottom:16px;border-left:5px solid #62b0e8}.plan-hero span{color:#8fc9f0;font-size:11px;text-transform:uppercase;font-weight:700}.plan-hero h2{font-family:"Avenir Next Condensed","Arial Narrow",sans-serif;font-size:30px;margin:7px 0}.plan-hero p{max-width:780px;color:#c7d3dc;margin:0;line-height:1.55}.fact-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:16px}.fact{background:var(--paper);padding:14px}.fact small,.fact strong{display:block}.fact small{color:var(--muted);font-size:10px;text-transform:uppercase}.fact strong{font-size:13px;margin-top:4px}.job-row{padding:13px 0;border-top:1px solid var(--line)}.job-row:first-of-type{border-top:0}.job-row>span{color:var(--blue);font-size:10px;font-weight:700;text-transform:uppercase}.job-row strong,.job-row small{display:block}.job-row strong{font-size:13px;margin-top:4px}.job-row small{font-size:12px;color:var(--muted);margin-top:3px}.journey{background:var(--paper);border:1px solid var(--line);margin-top:16px}.journey header{padding:16px;border-bottom:1px solid var(--line)}.journey header span,.journey header strong{display:block}.journey header span{font-size:11px;color:var(--blue);text-transform:uppercase;font-weight:700}.journey header strong{margin-top:5px}.journey ol{list-style:none;margin:0;padding:12px 16px}.journey li{display:grid;grid-template-columns:26px 1fr;gap:10px;padding:7px 0}.journey li>b{width:24px;height:24px;display:grid;place-items:center;background:var(--blue-soft);color:var(--blue);font:11px Menlo,monospace}.journey li strong,.journey li small{display:block}.journey li small{color:var(--muted);font-size:11px;margin-top:2px}.plan-copy{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:12px/1.65 "Avenir Next",Avenir,sans-serif;color:var(--ink)}.view-switch{display:inline-flex;border:1px solid var(--line);background:var(--paper);margin-bottom:14px}.view-switch button{border:0;border-left:1px solid var(--line);background:transparent;padding:8px 12px;color:var(--muted);font-size:12px;font-weight:700}.view-switch button:first-child{border-left:0}.view-switch button.active{background:var(--blue-soft);color:var(--blue)}.data-view[hidden]{display:none}.column-head,.column-row{grid-template-columns:minmax(180px,2fr) minmax(100px,1fr) minmax(100px,1fr) 56px}.row-action{border:0;background:transparent;color:var(--blue);font-size:11px;font-weight:700;padding:5px}.relationship-list{border-top:1px solid var(--line);margin-top:10px;padding-top:10px}.relationship-list h4{font-size:10px;text-transform:uppercase;color:var(--muted);margin:0 0 5px}.relationship-row{width:100%;display:flex;justify-content:space-between;gap:12px;text-align:left;border:0;background:transparent;padding:7px 5px;color:var(--ink)}.relationship-row:hover{background:var(--wash)}.relationship-row span{font:11px Menlo,monospace}.relationship-row small{color:var(--muted)}button:disabled{opacity:.45;cursor:not-allowed}.er-canvas{height:clamp(440px,65vh,760px);background-color:#eef2f5;background-image:linear-gradient(#dfe5ea 1px,transparent 1px),linear-gradient(90deg,#dfe5ea 1px,transparent 1px);background-size:24px 24px;border:1px solid var(--line);overflow:hidden;position:relative;touch-action:none;cursor:grab}.er-canvas.panning{cursor:grabbing}.er-controls{position:absolute;top:12px;right:12px;z-index:2;display:flex;align-items:center;background:var(--paper);border:1px solid var(--line);box-shadow:var(--shadow)}.er-controls button{width:34px;height:34px;border:0;border-left:1px solid var(--line);background:var(--paper);font:700 16px Menlo,monospace}.er-controls button:first-child{border-left:0}.er-controls span{min-width:52px;text-align:center;font:10px Menlo,monospace;color:var(--muted)}#er-stage{width:100%;height:100%;transform-origin:0 0;transition:transform .12s ease}.er-edge line{stroke:#738493;stroke-width:2;fill:none}.er-edge path,#arrow path{fill:#738493}.er-node rect{fill:#fff;stroke:#aebbc5;stroke-width:1.5}.er-node .er-node-head{fill:#e9f3fb;stroke:#0f6cbd}.er-node.decision-reuse .er-node-head{fill:#e7f5ef;stroke:#16805b}.er-node.decision-defer .er-node-head,.er-node.decision-unverified .er-node-head{fill:#fff3df;stroke:#a15c00}.er-node-title{font:700 14px "Avenir Next",Avenir,sans-serif;fill:#17202a}.er-node-name,.er-column,.er-more{font:10px Menlo,monospace;fill:#61707d}.er-node-name{font-size:9px}.er-more{fill:#0f6cbd}.screen-row{min-height:250px}.screen-row dl{margin:14px 0 0;border-top:1px solid var(--line)}.screen-row dl div{padding:8px 0;border-bottom:1px solid var(--line)}.screen-row dt{font-size:9px;text-transform:uppercase;color:var(--muted)}.screen-row dd{font-size:11px;margin:3px 0 0}.state-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:12px}.state-tags b{background:var(--wash);border:1px solid var(--line);padding:3px 5px;font-size:9px;text-transform:uppercase}.entity-list{list-style:none;margin:0;padding:0}.entity-list li{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-top:1px solid var(--line)}.entity-list li:first-child{border-top:0}.entity-list strong,.entity-list small{display:block}.entity-list small{font-size:10px;color:var(--muted);text-transform:uppercase}.entity-list b{font-size:10px;color:var(--blue);text-transform:uppercase}.validation-board{background:var(--paper);border:1px solid var(--line)}.validation-row{display:flex;justify-content:space-between;gap:18px;padding:14px 17px;border-top:1px solid var(--line)}.validation-row:first-child{border-top:0}.validation-row span{color:var(--muted);font-size:12px}.validation-row strong{font-size:12px}.empty.compact{padding:16px}.notice{padding:11px 13px;border-left:3px solid var(--amber);background:#fff7e8;color:#704100;font-size:12px;margin-bottom:14px}dialog{width:min(720px,calc(100vw - 28px));max-height:calc(100vh - 40px);border:1px solid var(--line);padding:0;border-radius:6px;box-shadow:0 30px 80px rgba(0,0,0,.25);color:var(--ink)}dialog::backdrop{background:rgba(17,27,36,.62)}.editor-form>header{position:sticky;top:0;z-index:2;background:var(--paper);border-bottom:1px solid var(--line);padding:17px 20px;display:flex;justify-content:space-between;gap:16px}.editor-form h2{font:700 22px "Avenir Next Condensed","Arial Narrow",sans-serif;margin:0}.icon-button{width:34px;height:34px;border:1px solid var(--line);background:var(--paper);font-size:20px}.editor-body{padding:20px}.editor-section{border:0;padding:0;margin:0}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.field{display:grid;gap:5px}.field.wide{grid-column:1/-1}.field>span,.group-label{font-size:10px;text-transform:uppercase;color:var(--muted);font-weight:700}.field input,.field select,.field textarea{width:100%;border:1px solid #aab6c0;border-radius:4px;background:white;color:var(--ink);padding:9px 10px;font:13px "Avenir Next",Avenir,sans-serif;letter-spacing:0}.field textarea{min-height:84px;resize:vertical}.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--blue);outline:2px solid var(--blue-soft)}.check-row{display:flex;gap:8px;align-items:flex-start;font-size:12px;padding:6px 0}.check-row input{margin-top:2px}.field-help{font-size:11px;color:var(--muted)}.subform{grid-column:1/-1;border-top:1px solid var(--line);padding-top:14px;margin-top:2px}.subform legend{font-size:11px;font-weight:700;padding:0 7px;color:var(--ink)}.option-row{display:grid;grid-template-columns:minmax(0,1fr) 110px 34px;gap:8px;margin-top:7px}.option-row input{border:1px solid #aab6c0;padding:8px}.option-row button{border:1px solid var(--line);background:white}.editor-error{color:var(--red);background:#fff0f2;border-left:3px solid var(--red);padding:10px 12px;font-size:12px;margin-bottom:14px}.editor-error:empty{display:none}.editor-actions{position:sticky;bottom:0;background:var(--paper);border-top:1px solid var(--line);padding:14px 20px;display:flex;justify-content:flex-end;gap:9px}.secondary{border:1px solid var(--line);background:var(--paper);padding:8px 13px;border-radius:4px}.footer-note{text-align:center;padding:18px;color:var(--muted);font-size:10px}.pending-refresh{position:fixed;right:18px;bottom:18px;background:#111b24;color:white;padding:12px 15px;box-shadow:var(--shadow);font-size:12px;z-index:10}
@media(max-width:980px){.metric-strip{grid-template-columns:repeat(3,minmax(112px,1fr))}.workspace-grid,.plan-grid,.architecture-grid{grid-template-columns:1fr}}@media(max-width:620px){.form-grid,.fact-grid{grid-template-columns:1fr}.field.wide{grid-column:auto}.metric-strip{grid-template-columns:repeat(2,minmax(112px,1fr))}.column-head,.column-row{grid-template-columns:minmax(130px,1.5fr) 1fr 48px}.column-head span:nth-child(3),.column-row span:nth-child(3){display:none}.relationship-row{display:block}.relationship-row small{display:block;margin-top:3px}.editor-body{padding:16px}}
@media(max-width:820px){.rail .phase-list{grid-template-columns:repeat(3,minmax(0,1fr));gap:0 14px;overflow:visible}.rail .phase{min-width:0}.rail .phase small{overflow-wrap:anywhere}}@media(max-width:520px){.rail .phase-list{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
</head>
<body>
<div class="shell">
  <aside class="rail"><div class="brand"><span class="brand-mark">BP</span><span><strong>Build Plan</strong><small>${escapeHtml(model.projectName)}</small></span></div><ol class="phase-list">${phaseRows}</ol></aside>
  <main class="main">
    <header class="topbar"><span><h1>${escapeHtml(model.projectName)}</h1><p>Current phase: ${escapeHtml(currentPhase.label)} · ${escapeHtml(statusLabel(currentPhase.status))}</p></span><span class="live" id="connection-state">Live build</span></header>
    <nav class="tabs" role="tablist" aria-label="Build plan sections">
      ${[['progress','Progress'],['plan','Plan'],['data','Data model'],['screens','Screens'],['architecture','Capabilities & data'],['validation','Validation']].map(([id,label], index) => `<button role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${index === 0}">${label}</button>`).join('')}
    </nav>
    <div class="content">
      <section class="panel" id="panel-progress" role="tabpanel" aria-labelledby="tab-progress"><div class="section-head"><span><h2>Build progress</h2><p>Revision ${escapeHtml(model.progress.revision)} · Updated ${escapeHtml(model.progress.updatedAt)}</p></span></div><div class="metric-strip">${metricCards}</div><div class="workspace-grid"><section class="work-panel"><h3>Recent activity</h3><ol class="event-list">${eventRows}</ol></section><aside class="work-panel"><h3>Approvals</h3><ul class="approval-list">${approvalRows}</ul></aside></div></section>
      <section class="panel" id="panel-plan" role="tabpanel" aria-labelledby="tab-plan" hidden><div class="plan-hero"><span>${escapeHtml(statusLabel(experience.primaryIntent || 'Product plan'))}</span><h2>${escapeHtml(experience.primaryGoal || model.projectName)}</h2><p>${escapeHtml(experience.signatureExperience?.description || 'Product experience and scope are being resolved.')}</p></div><div class="fact-grid"><div class="fact"><small>Primary user</small><strong>${escapeHtml(experience.primaryUser?.role || 'Pending')}</strong></div><div class="fact"><small>Workflow</small><strong>${escapeHtml(statusLabel(experience.workflowShape || 'Pending'))}</strong></div><div class="fact"><small>Operating context</small><strong>${escapeHtml(statusLabel(experience.operatingContext?.environment || 'Pending'))}</strong></div><div class="fact"><small>Navigation</small><strong>${escapeHtml(statusLabel(scope.navigation?.pattern || 'Pending'))}</strong></div></div><div class="plan-grid"><section class="work-panel"><h3>Shipping jobs</h3>${jobCards}</section><aside class="work-panel"><h3>Requirements</h3>${renderProjection(model.planSections['App Requirements'], 'Requirements are being confirmed')}</aside></div>${journeyCards}</section>
      <section class="panel" id="panel-data" role="tabpanel" aria-labelledby="tab-data" hidden><div class="section-head"><span><h2>Data model</h2><p>${model.tables.length} planned ${model.tables.length === 1 ? 'table' : 'tables'} · Publisher ${escapeHtml(model.publisherPrefix || 'pending')}</p></span><button class="primary" type="button" data-add-table${editDisabled}>+ Add table</button></div>${!canEdit ? `<div class="notice">${model.dataModelEditable ? 'Open the live Build Plan URL to edit the model.' : 'Dataverse execution has started. Continue schema changes through /edit-app.'}</div>` : ''}<div class="view-switch" aria-label="Data model view"><button type="button" class="active" data-data-view="tables">Tables</button><button type="button" data-data-view="diagram">ER diagram</button></div><div class="data-view" id="data-view-tables"><div class="table-list">${tableCards}</div></div><div class="data-view" id="data-view-diagram" hidden>${renderErDiagram(model.tables)}</div></section>
      <section class="panel" id="panel-screens" role="tabpanel" aria-labelledby="tab-screens" hidden><div class="section-head"><span><h2>Screen map</h2><p>${model.screens.length} compiled ${model.screens.length === 1 ? 'screen' : 'screens'} · ${escapeHtml(statusLabel(scope.navigation?.pattern || 'navigation pending'))}</p></span></div><div class="screen-list">${screenCards}</div></section>
      <section class="panel" id="panel-architecture" role="tabpanel" aria-labelledby="tab-architecture" hidden><div class="section-head"><span><h2>Capabilities & data</h2><p>Persistence ownership, native behavior, and connector decisions.</p></span></div><div class="architecture-grid"><section class="work-panel"><h3>Persistence ownership</h3><ul class="entity-list">${entityRows}</ul></section><aside><section class="work-panel"><h3>Native capabilities</h3>${renderProjection(model.planSections['Native Capabilities'], 'No native capabilities planned yet')}</section><section class="work-panel" style="margin-top:16px"><h3>Connectors</h3>${renderProjection(model.planSections.Connectors, 'No connectors planned yet')}</section></aside></div></section>
      <section class="panel" id="panel-validation" role="tabpanel" aria-labelledby="tab-validation" hidden><div class="section-head"><span><h2>Validation</h2><p>Current checkpoints, operation counts, and recovery signals.</p></span></div><div class="validation-board">${validationRows}</div></section>
    </div>
  </main>
</div>
<dialog id="edit-dialog" aria-labelledby="editor-title">
  <form class="editor-form" id="editor-form">
    <header><span><h2 id="editor-title">Edit data model</h2><small id="editor-subtitle"></small></span><button class="icon-button" id="editor-close" type="button" title="Close" aria-label="Close">×</button></header>
    <div class="editor-body"><div class="editor-error" id="editor-error" role="alert"></div>
      <fieldset class="editor-section" data-editor-section="table"><div class="form-grid">
        <label class="field wide"><span>Display name</span><input name="table-display" required maxlength="80"></label>
        <label class="field"><span>Logical name</span><input name="table-logical" pattern="[A-Za-z][A-Za-z0-9_]*" required></label>
        <label class="field"><span>Collection name</span><input name="table-collection" required maxlength="100"></label>
        <label class="field"><span>Plan decision</span><select name="table-decision"><option value="create">Create</option><option value="reuse">Reuse</option><option value="extend">Extend</option><option value="adapt">Adapt</option><option value="defer">Defer</option><option value="unverified">Unverified</option></select></label>
        <label class="field"><span>Dependency tier</span><input name="table-tier" type="number" min="0" max="20" value="0" required></label>
        <label class="check-row wide"><input name="table-service" type="checkbox" checked><span>Generate a Dataverse service for this table</span></label>
        <fieldset class="subform" id="table-create-fields"><legend>Primary name column</legend><div class="form-grid"><label class="field"><span>Logical name</span><input name="primary-logical" pattern="[A-Za-z][A-Za-z0-9_]*" required></label><label class="field"><span>Display name</span><input name="primary-display" value="Name" required></label></div></fieldset>
        <fieldset class="subform" id="scope-fields"><legend>Product Scope mapping</legend><div class="form-grid"><label class="field"><span>Entity role</span><select name="scope-role"><option value="primary">Primary</option><option value="supporting" selected>Supporting</option><option value="reference">Reference</option></select></label><label class="field"><span>Lifecycle reason</span><select name="scope-lifecycle"><option value="independent-lifecycle">Independent lifecycle</option><option value="independent-ownership-or-security">Independent ownership or security</option><option value="repeated-child-records">Repeated child records</option><option value="independent-querying-or-reporting">Independent querying or reporting</option><option value="offline-synchronization-boundary">Offline synchronization boundary</option><option value="explicit-history-or-audit">Explicit history or audit</option><option value="many-to-many-relationship">Many-to-many relationship</option></select></label><div class="field wide"><span>Owning jobs</span>${jobOptions}</div><label class="field wide"><span>Lifecycle justification</span><textarea name="scope-statement" minlength="15" maxlength="300" required></textarea></label></div></fieldset>
      </div></fieldset>
      <fieldset class="editor-section" data-editor-section="column"><div class="form-grid">
        <label class="field"><span>Display name</span><input name="column-display" required maxlength="80"></label><label class="field"><span>Logical name</span><input name="column-logical" pattern="[A-Za-z][A-Za-z0-9_]*" required></label>
        <label class="field"><span>Column type</span><select name="column-type"><option value="string">Text</option><option value="memo">Multiline text</option><option value="integer">Whole number</option><option value="bigint">Big integer</option><option value="decimal">Decimal</option><option value="double">Floating point</option><option value="money">Currency</option><option value="datetime">Date and time</option><option value="boolean">Yes/No</option><option value="choice">Choice</option><option value="multiselectchoice">Multi-select choice</option><option value="file">File</option><option value="image">Image</option></select></label>
        <label class="field"><span>Plan decision</span><select name="column-decision"><option value="create">Create</option><option value="reuse">Reuse</option><option value="extend">Extend</option><option value="adapt">Adapt</option><option value="defer">Defer</option><option value="unverified">Unverified</option></select></label>
        <label class="field"><span>Required level</span><select name="column-required"><option value="None">Optional</option><option value="Recommended">Recommended</option><option value="ApplicationRequired">Required</option></select></label><label class="field" data-column-constraint="length"><span>Maximum length</span><input name="column-length" type="number" min="1" max="1048576" value="200"></label>
        <label class="field" data-column-constraint="minimum"><span>Minimum value</span><input name="column-min" type="number"></label><label class="field" data-column-constraint="maximum"><span>Maximum value</span><input name="column-max" type="number"></label><label class="field" data-column-constraint="precision"><span>Precision</span><input name="column-precision" type="number" min="0" max="10" value="2"></label>
        <fieldset class="subform" id="choice-fields"><legend>Choice options</legend><div id="option-rows"></div><button class="secondary" id="add-option" type="button">+ Add option</button></fieldset>
      </div></fieldset>
      <fieldset class="editor-section" data-editor-section="relationship"><div class="form-grid">
        <label class="field"><span>Relationship type</span><select name="relationship-kind"><option value="many-to-one">Many to one</option><option value="many-to-many">Many to many</option></select></label><label class="field"><span>Schema name</span><input name="relationship-schema" pattern="[A-Za-z][A-Za-z0-9_]*" required></label><label class="field"><span>Plan decision</span><select name="relationship-decision"><option value="create">Create</option><option value="reuse">Reuse</option><option value="adapt">Adapt</option><option value="defer">Defer</option><option value="unverified">Unverified</option></select></label>
        <fieldset class="subform" id="many-to-one-fields"><legend>Many-to-one endpoints</legend><div class="form-grid"><label class="field"><span>Parent table</span><select name="relationship-parent">${tableOptions}</select></label><label class="field"><span>Child table</span><select name="relationship-child">${tableOptions}</select></label><label class="field"><span>Lookup logical name</span><input name="relationship-lookup" pattern="[A-Za-z][A-Za-z0-9_]*" required></label><label class="field"><span>Lookup display name</span><input name="relationship-lookup-display" required></label><label class="field"><span>Lookup requirement</span><select name="relationship-required"><option value="None">Optional</option><option value="Recommended">Recommended</option><option value="ApplicationRequired">Required</option></select></label></div></fieldset>
        <fieldset class="subform" id="many-to-many-fields"><legend>Many-to-many endpoints</legend><div class="form-grid"><label class="field"><span>First table</span><select name="relationship-entity1">${tableOptions}</select></label><label class="field"><span>Second table</span><select name="relationship-entity2">${tableOptions}</select></label><label class="field wide"><span>Intersect table</span><input name="relationship-intersect" pattern="[A-Za-z][A-Za-z0-9_]*" required></label></div></fieldset>
      </div></fieldset>
    </div>
    <footer class="editor-actions"><button class="secondary" id="editor-cancel" type="button">Cancel</button><button class="primary" id="editor-save" type="submit">Save changes</button></footer>
  </form>
</dialog>
<template id="option-row-template"><div class="option-row"><input data-option-label aria-label="Choice label" placeholder="Label"><input data-option-value type="number" aria-label="Choice value" placeholder="Value"><button type="button" data-remove-option title="Remove option" aria-label="Remove option">×</button></div></template>
<div class="pending-refresh" id="pending-refresh" hidden>Build updated. Close the editor to refresh.</div>
<footer class="footer-note">AI-generated content may be incorrect</footer>
<script id="build-plan-model" type="application/json">${serializedModel}</script>
<script>
const BUILD_PLAN_TOKEN=${JSON.stringify(token)};
const BUILD_PLAN_MODEL=JSON.parse(document.getElementById('build-plan-model').textContent);
const editor=document.getElementById('edit-dialog');
const editorForm=document.getElementById('editor-form');
const editorError=document.getElementById('editor-error');
let editorMode='';
let editorTarget={};
let refreshPending=false;
function field(name){return editorForm.elements.namedItem(name)}
function activateTab(id){for(const item of document.querySelectorAll('.tabs [role=tab]')){const selected=item.id==='tab-'+id;item.setAttribute('aria-selected',String(selected));document.getElementById(item.getAttribute('aria-controls')).hidden=!selected}history.replaceState(null,'','#'+id)}
for(const tab of document.querySelectorAll('.tabs [role=tab]'))tab.addEventListener('click',()=>activateTab(tab.id.slice(4)));
const initialTab=location.hash.slice(1);if(document.getElementById('tab-'+initialTab))activateTab(initialTab);
for(const button of document.querySelectorAll('[data-data-view]'))button.addEventListener('click',()=>{for(const candidate of document.querySelectorAll('[data-data-view]'))candidate.classList.toggle('active',candidate===button);document.getElementById('data-view-tables').hidden=button.dataset.dataView!=='tables';document.getElementById('data-view-diagram').hidden=button.dataset.dataView!=='diagram';if(button.dataset.dataView==='diagram')resetEr()});
function setSection(name,active){const section=document.querySelector('[data-editor-section="'+name+'"]');section.hidden=!active;for(const control of section.querySelectorAll('input,select,textarea,button'))control.disabled=!active}
function setGroup(group,active){group.hidden=!active;for(const control of group.querySelectorAll('input,select,textarea,button'))control.disabled=!active}
function setValue(name,value){const control=field(name);if(control)control.value=value==null?'':value}
function tableByName(name){return BUILD_PLAN_MODEL.tables.find(item=>item.logicalName===name)}
function addOption(option){const row=document.getElementById('option-row-template').content.firstElementChild.cloneNode(true);row.querySelector('[data-option-label]').value=option&&option.label||'';row.querySelector('[data-option-value]').value=option&&option.value!=null?option.value:'';row.querySelector('[data-remove-option]').addEventListener('click',()=>row.remove());document.getElementById('option-rows').appendChild(row)}
function configureColumn(){const type=field('column-type').value;const length=['string','memo'].includes(type);const numeric=['integer','bigint','decimal','double','money'].includes(type);for(const item of document.querySelectorAll('[data-column-constraint="length"]'))item.hidden=!length;for(const item of document.querySelectorAll('[data-column-constraint="minimum"],[data-column-constraint="maximum"]'))item.hidden=!numeric;for(const item of document.querySelectorAll('[data-column-constraint="precision"]'))item.hidden=!['decimal','double','money'].includes(type);setGroup(document.getElementById('choice-fields'),['boolean','choice','multiselectchoice'].includes(type))}
function configureRelationship(){const manyToOne=field('relationship-kind').value==='many-to-one';setGroup(document.getElementById('many-to-one-fields'),manyToOne);setGroup(document.getElementById('many-to-many-fields'),!manyToOne)}
function openEditor(mode,target){editorMode=mode;editorTarget=target||{};editorForm.reset();editorError.textContent='';document.getElementById('option-rows').replaceChildren();setSection('table',mode==='add-table'||mode==='update-table');setSection('column',mode==='add-column'||mode==='update-column');setSection('relationship',mode==='add-relationship'||mode==='update-relationship');const editing=mode.startsWith('update-');document.getElementById('editor-title').textContent=(editing?'Edit ':'Add ')+(mode.includes('table')?'table':mode.includes('column')?'column':'relationship');document.getElementById('editor-subtitle').textContent=target&&target.table||'';
  if(mode==='add-table'||mode==='update-table'){const table=mode==='update-table'?tableByName(target.table):null;setValue('table-display',table&&table.displayName);setValue('table-logical',table&&table.logicalName||((BUILD_PLAN_MODEL.publisherPrefix||'new')+'_'));field('table-logical').readOnly=Boolean(table);setValue('table-collection',table&&table.displayCollectionName);setValue('table-decision',table&&table.decision||'create');setValue('table-tier',table&&table.dependencyTier||0);field('table-service').checked=table?table.serviceRequired!==false:true;setValue('primary-logical',(BUILD_PLAN_MODEL.publisherPrefix||'new')+'_name');setValue('primary-display','Name');setGroup(document.getElementById('table-create-fields'),!table);setGroup(document.getElementById('scope-fields'),!table&&Boolean(BUILD_PLAN_MODEL.scope&&BUILD_PLAN_MODEL.scope.contractType))}
  if(mode==='add-column'||mode==='update-column'){const table=tableByName(target.table);const column=mode==='update-column'?table.columns.find(item=>item.logicalName===target.column):null;setValue('column-display',column&&column.displayName);setValue('column-logical',column&&column.logicalName||((BUILD_PLAN_MODEL.publisherPrefix||'new')+'_'));field('column-logical').readOnly=Boolean(column);setValue('column-type',column&&String(column.type).toLowerCase()||'string');setValue('column-decision',column&&column.plannedDecision||'create');setValue('column-required',column&&column.requiredLevel||'None');setValue('column-length',column&&(column.maxLength||column.maxSizeInKB)||200);setValue('column-min',column&&column.minValue);setValue('column-max',column&&column.maxValue);setValue('column-precision',column&&column.precision||2);for(const option of column&&column.options||[])addOption(option);configureColumn()}
  if(mode==='add-relationship'||mode==='update-relationship'){const table=tableByName(target.table);const relationship=mode==='update-relationship'?table.relationships.find(item=>item.schemaName===target.relationship):null;setValue('relationship-kind',relationship&&relationship.kind||'many-to-one');setValue('relationship-schema',relationship&&relationship.schemaName||'');setValue('relationship-decision',relationship&&relationship.plannedDecision||'create');setValue('relationship-parent',relationship&&relationship.parentTable||'');setValue('relationship-child',relationship&&relationship.childTable||target.table||'');setValue('relationship-lookup',relationship&&relationship.lookup&&relationship.lookup.logicalName||((BUILD_PLAN_MODEL.publisherPrefix||'new')+'_'));setValue('relationship-lookup-display',relationship&&relationship.lookup&&relationship.lookup.displayName||'');setValue('relationship-required',relationship&&relationship.lookup&&relationship.lookup.requiredLevel||'None');setValue('relationship-entity1',relationship&&relationship.entity1||target.table||'');setValue('relationship-entity2',relationship&&relationship.entity2||'');setValue('relationship-intersect',relationship&&relationship.intersectTable||((BUILD_PLAN_MODEL.publisherPrefix||'new')+'_'));configureRelationship()}
  editor.showModal();const first=editor.querySelector('.editor-section:not([hidden]) input:not([disabled]),.editor-section:not([hidden]) select:not([disabled])');if(first)first.focus()}
document.addEventListener('click',event=>{const button=event.target.closest('[data-add-table],[data-edit-table],[data-add-column],[data-edit-column],[data-add-relationship],[data-edit-relationship]');if(!button||button.disabled)return;if(button.hasAttribute('data-add-table'))openEditor('add-table',{});else if(button.dataset.editTable)openEditor('update-table',{table:button.dataset.editTable});else if(button.dataset.addColumn)openEditor('add-column',{table:button.dataset.addColumn});else if(button.dataset.editColumn)openEditor('update-column',{table:button.dataset.table,column:button.dataset.editColumn});else if(button.dataset.addRelationship)openEditor('add-relationship',{table:button.dataset.addRelationship});else openEditor('update-relationship',{table:button.dataset.table,relationship:button.dataset.editRelationship})});
document.getElementById('add-option').addEventListener('click',()=>addOption());field('column-type').addEventListener('change',configureColumn);field('relationship-kind').addEventListener('change',configureRelationship);
function closeEditor(){editor.close();if(refreshPending)location.reload()}
document.getElementById('editor-close').addEventListener('click',closeEditor);document.getElementById('editor-cancel').addEventListener('click',closeEditor);
function numberValue(name,fallback){const value=field(name).value;return value===''?fallback:Number(value)}
function columnPayload(){const type=field('column-type').value;const column={logicalName:field('column-logical').value,displayName:field('column-display').value,type:type,plannedDecision:field('column-decision').value,requiredLevel:field('column-required').value};if(type==='string'){column.maxLength=numberValue('column-length',200);column.formatName='Text'}else if(type==='memo'){column.maxLength=numberValue('column-length',10000);column.format='TextArea'}else if(type==='integer'){column.minValue=numberValue('column-min',-2147483648);column.maxValue=numberValue('column-max',2147483647);column.format='None'}else if(type==='bigint'){column.minValue=numberValue('column-min',-9007199254740991);column.maxValue=numberValue('column-max',9007199254740991)}else if(['decimal','double'].includes(type)){column.minValue=numberValue('column-min',-100000000000);column.maxValue=numberValue('column-max',100000000000);column.precision=numberValue('column-precision',2)}else if(type==='money'){column.minValue=numberValue('column-min',-922337203685477);column.maxValue=numberValue('column-max',922337203685477);column.precision=numberValue('column-precision',2);column.precisionSource=2}else if(type==='datetime'){column.format='DateAndTime';column.dateTimeBehavior='UserLocal'}else if(type==='file'){column.maxSizeInKB=numberValue('column-length',32768)}else if(type==='image'){column.maxHeight=1440;column.maxWidth=1440}if(['boolean','choice','multiselectchoice'].includes(type)){column.options=[...document.querySelectorAll('.option-row')].map(row=>({label:row.querySelector('[data-option-label]').value.trim(),value:Number(row.querySelector('[data-option-value]').value)})).filter(option=>option.label&&Number.isInteger(option.value));if(type==='boolean'&&column.options.length===0)column.options=[{label:'No',value:0},{label:'Yes',value:1}];if(column.options.length===0)throw new Error('Add at least one labeled choice option.')}return column}
function relationshipPayload(){const kind=field('relationship-kind').value;const relationship={kind:kind,schemaName:field('relationship-schema').value,plannedDecision:field('relationship-decision').value};if(kind==='many-to-one'){relationship.parentTable=field('relationship-parent').value;relationship.childTable=field('relationship-child').value;relationship.lookup={logicalName:field('relationship-lookup').value,displayName:field('relationship-lookup-display').value,requiredLevel:field('relationship-required').value}}else{relationship.entity1=field('relationship-entity1').value;relationship.entity2=field('relationship-entity2').value;relationship.intersectTable=field('relationship-intersect').value}return relationship}
function editCommand(){const base={expectedRevision:BUILD_PLAN_MODEL.dataModelRevision};if(editorMode==='add-table'){const jobs=[...document.querySelectorAll('[name="scope-job"]:checked')].map(item=>item.value);const command={...base,type:editorMode,logicalName:field('table-logical').value,table:{displayName:field('table-display').value,displayCollectionName:field('table-collection').value,plannedDecision:field('table-decision').value,dependencyTier:Number(field('table-tier').value),serviceRequired:field('table-service').checked,ownershipType:'UserOwned'},primaryColumn:{logicalName:field('primary-logical').value,displayName:field('primary-display').value,type:'string',plannedDecision:'create',requiredLevel:'ApplicationRequired',primaryName:true,maxLength:200,formatName:'Text'}};if(BUILD_PLAN_MODEL.scope&&BUILD_PLAN_MODEL.scope.contractType){if(jobs.length===0)throw new Error('Select at least one owning Product Scope job.');command.scope={role:field('scope-role').value,screenIds:[],jobIds:jobs,lifecycleJustification:{reasons:[field('scope-lifecycle').value],statement:field('scope-statement').value}}}return command}if(editorMode==='update-table')return {...base,type:editorMode,tableLogicalName:editorTarget.table,table:{displayName:field('table-display').value,displayCollectionName:field('table-collection').value,plannedDecision:field('table-decision').value,dependencyTier:Number(field('table-tier').value),serviceRequired:field('table-service').checked}};if(editorMode==='add-column')return {...base,type:editorMode,tableLogicalName:editorTarget.table,column:columnPayload()};if(editorMode==='update-column')return {...base,type:editorMode,tableLogicalName:editorTarget.table,columnLogicalName:editorTarget.column,column:columnPayload()};if(editorMode==='add-relationship')return {...base,type:editorMode,relationship:relationshipPayload()};return {...base,type:editorMode,tableLogicalName:editorTarget.table,relationshipSchemaName:editorTarget.relationship,relationship:relationshipPayload()}}
editorForm.addEventListener('submit',async event=>{event.preventDefault();editorError.textContent='';const save=document.getElementById('editor-save');save.disabled=true;try{const response=await fetch('/api/data-model',{method:'POST',headers:{'content-type':'application/json','x-build-plan-token':BUILD_PLAN_TOKEN},body:JSON.stringify(editCommand())});const result=await response.json();if(!response.ok)throw new Error(result.error||'The data model change was rejected.');location.reload()}catch(error){editorError.textContent=error.message;save.disabled=false}});
if(BUILD_PLAN_TOKEN){const stream=new EventSource('/events?token='+encodeURIComponent(BUILD_PLAN_TOKEN));stream.addEventListener('ready',()=>{document.getElementById('connection-state').textContent='Live build'});stream.addEventListener('refresh',()=>{if(editor.open){refreshPending=true;document.getElementById('pending-refresh').hidden=false}else location.reload()});stream.addEventListener('warning',event=>{document.getElementById('connection-state').textContent='Refresh warning';document.getElementById('connection-state').classList.add('waiting')});stream.onerror=()=>{document.getElementById('connection-state').textContent='Reconnecting';document.getElementById('connection-state').classList.add('waiting')}}else{document.getElementById('connection-state').textContent='Saved snapshot';document.getElementById('connection-state').classList.add('snapshot')}
let erScale=1,erX=0,erY=0,erDragging=false,erStartX=0,erStartY=0;const erCanvas=document.getElementById('er-canvas');const erStage=document.getElementById('er-stage');function applyEr(){if(!erStage)return;erStage.style.transform='translate('+erX+'px,'+erY+'px) scale('+erScale+')';document.getElementById('er-zoom-level').textContent=Math.round(erScale*100)+'%'}function zoomEr(delta){erScale=Math.min(2.5,Math.max(.35,erScale+delta));applyEr()}function resetEr(){erScale=1;erX=0;erY=0;applyEr()}if(erCanvas&&erStage){document.getElementById('er-zoom-in').addEventListener('click',()=>zoomEr(.15));document.getElementById('er-zoom-out').addEventListener('click',()=>zoomEr(-.15));document.getElementById('er-reset').addEventListener('click',resetEr);erCanvas.addEventListener('wheel',event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();zoomEr(event.deltaY>0?-.1:.1)},{passive:false});erCanvas.addEventListener('pointerdown',event=>{if(event.target.closest('.er-controls'))return;erDragging=true;erStartX=event.clientX-erX;erStartY=event.clientY-erY;erCanvas.classList.add('panning');erCanvas.setPointerCapture(event.pointerId)});erCanvas.addEventListener('pointermove',event=>{if(!erDragging)return;erX=event.clientX-erStartX;erY=event.clientY-erStartY;applyEr()});erCanvas.addEventListener('pointerup',()=>{erDragging=false;erCanvas.classList.remove('panning')})}
</script>
</body>
</html>`;
}

function writeBuildPlan(projectRoot, options = {}) {
  const model = deriveBuildPlanModel(projectRoot, options);
  const output = resolveInsideProject(projectRoot, options.output || BUILD_PLAN_OUTPUT);
  fs.writeFileSync(output, renderBuildPlanHtml(model, options), 'utf8');
  return { output, model };
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
  escapeHtml,
  hasExecutionStarted,
  nextProgressState,
  renderBuildPlanHtml,
  resolveInsideProject,
  revisionOf,
  updateProgress,
  writeBuildPlan,
};