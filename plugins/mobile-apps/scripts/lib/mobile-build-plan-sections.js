'use strict';

const { renderUsageTraceability } = require('./mobile-build-plan-data-model');
const { escapeHtml, statusLabel } = require('./mobile-build-plan-html');

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

function renderProjection(value, emptyText) {
  return value
    ? `<pre class="plan-copy">${escapeHtml(value)}</pre>`
    : `<div class="empty compact"><strong>${escapeHtml(emptyText)}</strong></div>`;
}

function decisionName(value) {
  if (typeof value === 'string') return value;
  return value?.name || value?.displayName || value?.capability || value?.connector || value?.id || '';
}

function renderNamedDecisions(items, status, emptyText) {
  if (items.length > 0) {
    return `<ul class="plain-list">${items.map((item) => `<li>${escapeHtml(decisionName(item))}</li>`).join('')}</ul>`;
  }
  return `<p class="muted-copy">${escapeHtml(status === 'approved'
    ? `${emptyText} See Technical details for the approved reference section.`
    : emptyText)}</p>`;
}

function renderMakerSummary(model) {
  const summary = model.makerSummary;
  const destinations = summary.navigation?.durableDestinations || [];
  const owners = summary.dataOwnership || [];
  const assumptions = summary.assumptions || [];
  const deferred = summary.deferredItems || [];
  return `<section class="maker-summary" aria-labelledby="maker-summary-title">
    <div class="section-head"><span><h2 id="maker-summary-title">What we are building</h2><p>The current product intent from approved planning contracts.</p></span></div>
    <div class="summary-grid">
      <article class="summary-lead"><small>Product</small><h3>${escapeHtml(summary.product || model.projectName)}</h3><p>${escapeHtml(summary.primaryGoal || 'The primary goal is being resolved.')}</p><dl><div><dt>Primary users</dt><dd>${escapeHtml(summary.primaryUsers.join(', ') || 'Pending')}</dd></div><div><dt>Key journey</dt><dd>${escapeHtml(summary.keyJourney?.name || 'Pending')}</dd></div>${summary.keyJourney?.outcome ? `<div><dt>Successful outcome</dt><dd>${escapeHtml(summary.keyJourney.outcome)}</dd></div>` : ''}</dl></article>
      <article class="summary-block"><small>Navigation</small><h3>${escapeHtml(statusLabel(summary.navigation?.pattern || 'Pending'))}</h3><p>${escapeHtml(summary.userFacingScreenCount)} planned user-facing ${summary.userFacingScreenCount === 1 ? 'screen' : 'screens'}</p>${destinations.length ? `<ul class="plain-list">${destinations.map((item, index) => `<li><strong>${escapeHtml(item.title)}</strong><span>${index === 0 ? 'Primary destination' : item.visible ? 'Visible destination' : 'Durable destination'}</span></li>`).join('')}</ul>` : '<p class="muted-copy">Durable destinations are being resolved.</p>'}${summary.navigation?.returnHomeMechanism ? `<p class="summary-note"><strong>Return path:</strong> ${escapeHtml(summary.navigation.returnHomeMechanism)}</p>` : ''}</article>
      <article class="summary-block"><small>Data ownership</small><h3>${escapeHtml(summary.persistenceMode ? statusLabel(summary.persistenceMode) : 'Prototype and real data')}</h3>${owners.length ? `<ul class="plain-list">${owners.map((item) => `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.owner ? statusLabel(item.owner) : `${statusLabel(item.role)} · ${statusLabel(item.realization)}`)}</span>${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}</li>`).join('')}</ul>` : '<p class="muted-copy">Data ownership is being resolved.</p>'}</article>
      <article class="summary-block"><small>Capabilities</small><h3>Native capabilities</h3>${renderNamedDecisions(summary.nativeCapabilities, summary.nativeCapabilitiesStatus, 'No structured native capability decision is available yet.')}<h3 class="subhead">External connectors</h3>${renderNamedDecisions(summary.connectors, summary.connectorsStatus, 'No structured connector decision is available yet.')}</article>
      <article class="summary-block"><small>Review</small><h3>Assumptions</h3>${assumptions.length ? `<ul class="plain-list">${assumptions.map((item) => `<li><strong>${escapeHtml(item.statement)}</strong><span>${escapeHtml(statusLabel(item.classification))}${item.approved === true ? ' · approved' : ''}</span></li>`).join('')}</ul>` : '<p class="muted-copy">No assumptions are recorded.</p>'}<h3 class="subhead">Explicitly deferred</h3>${deferred.length ? `<ul class="plain-list">${deferred.map((item) => `<li><strong>${escapeHtml(item.statement)}</strong><span>${escapeHtml(item.reason || 'Deferred')}</span></li>`).join('')}</ul>` : '<p class="muted-copy">No items are explicitly deferred.</p>'}</article>
    </div>
  </section>`;
}

function renderScopeHealth(model) {
  const health = model.scopeHealth;
  if (!health) {
    return '<section class="scope-health"><div class="empty"><strong>Scope health is pending</strong><span>Evidence appears after Product Scope is authored.</span></div></section>';
  }
  const summary = health.summary || {};
  const requirements = model.scope.requirements || [];
  const findings = [...(health.errors || []), ...(health.warnings || [])];
  const healthState = health.ok && health.warnings.length === 0 ? 'Healthy'
    : health.ok ? 'Review warnings' : 'Needs attention';
  return `<section class="scope-health" aria-labelledby="scope-health-title">
    <div class="section-head"><span><h2 id="scope-health-title">Scope health</h2><p>Evidence from the Product Scope validator. Warnings require review; they do not remove functionality.</p></span><strong class="health-state health-${health.ok ? 'ok' : 'attention'}">${escapeHtml(healthState)}</strong></div>
    <div class="health-grid">
      <div><small>Shipping requirements covered</small><strong>${escapeHtml(summary.coveredShippingRequirementCount ?? 0)} / ${escapeHtml(summary.shippingRequirementCount ?? 0)}</strong></div>
      <div><small>Core jobs covered</small><strong>${escapeHtml(summary.coveredCoreJobCount ?? 0)} / ${escapeHtml(summary.coreJobCount ?? 0)}</strong></div>
      <div><small>Supporting jobs covered</small><strong>${escapeHtml(summary.coveredSupportingJobCount ?? 0)} / ${escapeHtml(summary.supportingJobCount ?? 0)}</strong></div>
      <div><small>User-facing screens</small><strong>${escapeHtml(summary.userFacingScreenCount ?? 0)} / ${escapeHtml(summary.declaredScreenReviewCeiling ?? 'pending')}</strong></div>
      <div><small>New tables</small><strong>${escapeHtml(summary.newTableCount ?? 0)} / ${escapeHtml(summary.declaredTableReviewCeiling ?? 'pending')}</strong></div>
      <div><small>Navigation</small><strong>${summary.navigationValid ? 'Valid' : 'Needs attention'}</strong><span>${escapeHtml(summary.durableDestinationCount ?? 0)} durable · ${escapeHtml(summary.visibleTabCount ?? 0)} visible</span></div>
      <div><small>Orphan or duplicate findings</small><strong>${escapeHtml(summary.orphanOrDuplicateFindingCount ?? 0)}</strong></div>
      <div><small>Deferred requirements</small><strong>${escapeHtml(summary.deferredRequirementCount ?? 0)}</strong></div>
    </div>
    ${requirements.length ? `<details class="evidence-details"><summary>Requirement coverage</summary><ul class="evidence-list">${requirements.map((requirement) => `<li><span><strong>${escapeHtml(requirement.statement)}</strong><small>${escapeHtml(requirement.id)} · ${escapeHtml(statusLabel(requirement.disposition))}</small></span><b>${escapeHtml((model.scope.requirementCoverage || []).filter((row) => row.requirementId === requirement.id).length)} ${requirement.disposition === 'shipping' ? 'coverage links' : 'deferred'}</b></li>`).join('')}</ul></details>` : ''}
    ${findings.length ? `<div class="finding-list" aria-label="Unresolved scope findings">${findings.map((finding) => `<article class="finding ${health.errors.includes(finding) ? 'finding-error' : 'finding-warning'}"><strong>${escapeHtml(statusLabel(finding.code))}</strong><p>${escapeHtml(finding.message)}</p></article>`).join('')}</div>` : '<p class="healthy-copy">No unresolved Product Scope findings.</p>'}
  </section>`;
}

function renderTechnicalDetails(model) {
  const sectionRows = Object.entries(model.planSections).map(([name, value]) => `<details class="technical-section"><summary>${escapeHtml(name)}</summary>${renderProjection(value, `${name} is pending`)}</details>`).join('');
  return `<details class="technical-details">
    <summary>Technical details</summary>
    <div class="technical-grid">
      <div><small>Build Plan revision</small><code>${escapeHtml(model.revision)}</code></div>
      <div><small>Data model revision</small><code>${escapeHtml(model.dataModelRevision || 'pending')}</code></div>
      <div><small>Active execution time</small><strong>${escapeHtml(formatDuration(model.timings?.totalExecutionMs))}</strong></div>
      <div><small>Approval wait</small><strong>${escapeHtml(formatDuration(model.timings?.userApprovalWaitingMs))}</strong></div>
      <div><small>Planning estimate</small><strong>${escapeHtml(formatDuration(model.eta?.p50Ms))}</strong></div>
      <div><small>Metadata operations</small><strong>${escapeHtml(model.dataverse.operationCount)}</strong></div>
    </div>
    <div class="technical-sections">${sectionRows || '<p class="muted-copy">Reference sections are pending.</p>'}</div>
  </details>`;
}

function renderPhaseRows(model) {
  return model.progress.phases.map((phase) => `
    <li class="phase phase-${escapeHtml(phase.status)}">
      <span class="phase-mark" aria-hidden="true"></span>
      <span><strong>${escapeHtml(phase.label)}</strong><small>${escapeHtml(phase.detail || statusLabel(phase.status))}</small></span>
    </li>`).join('');
}

function renderPlanSection(model) {
  const scope = model.scope || {};
  const jobCards = [...(scope.coreJobs || []), ...(scope.supportingJobs || [])].map((job) => `<article class="job-row"><span>${escapeHtml(job.criticality || 'supporting')}</span><strong>${escapeHtml(job.statement)}</strong><small>${escapeHtml(job.outcome)}</small></article>`).join('') || '<div class="empty compact"><strong>Jobs are being defined</strong></div>';
  const journeyCards = (model.journey?.journeys || []).map((journey) => `<article class="journey"><header><span>${escapeHtml(journey.name)}</span><strong>${escapeHtml(journey.successOutcome)}</strong></header><ol>${[...(journey.steps || [])].sort((left, right) => left.order - right.order).map((step) => `<li><b>${escapeHtml(step.order)}</b><span><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.userAction)}</small></span></li>`).join('')}</ol></article>`).join('') || '<div class="empty compact"><strong>Journeys are being composed</strong></div>';
  return `<section class="panel" id="panel-plan" role="tabpanel" aria-labelledby="tab-plan">${renderMakerSummary(model)}${renderScopeHealth(model)}<section class="plan-grid"><section class="work-panel"><h3>Shipping jobs</h3>${jobCards}</section><aside class="work-panel"><h3>Primary journey</h3>${journeyCards}</aside></section>${renderTechnicalDetails(model)}</section>`;
}

function renderProgressSection(model) {
  const approvalRows = model.approvals.length > 0 ? model.approvals.map((approval) => `<li><span>${escapeHtml(approval.label)}</span><strong>${escapeHtml(statusLabel(approval.status))}</strong></li>`).join('') : '<li><span>Planning approvals</span><strong>pending</strong></li>';
  const metricCards = [
    ['Phase', `${model.makerProgress.phase} of ${model.makerProgress.phaseCount}`],
    ['State', model.makerProgress.state],
    ['Tables', model.tables.length],
    ['Screens', model.screens.length],
    ...(model.makerProgress.estimatedRemainingMs
      ? [['Estimated remaining', formatDuration(model.makerProgress.estimatedRemainingMs)]]
      : []),
  ].map(([label, value]) => `<div class="metric"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`).join('');
  const eventRows = (model.progress.events || []).slice(-8).reverse().map((event) => `<li><time>${escapeHtml(formatEventTime(event.at))}</time><span><strong>${escapeHtml(statusLabel(event.phase))}</strong><small>${escapeHtml(event.detail || statusLabel(event.status))}</small></span></li>`).join('') || '<li class="muted-row">Build events will appear here.</li>';
  return `<section class="panel" id="panel-progress" role="tabpanel" aria-labelledby="tab-progress" hidden><div class="section-head"><span><h2>Build progress</h2><p>${escapeHtml(model.makerProgress.state)} · Updated ${escapeHtml(model.progress.updatedAt)}</p></span></div><div class="metric-strip">${metricCards}</div><div class="workspace-grid"><section class="work-panel"><h3>Recent activity</h3><ol class="event-list">${eventRows}</ol></section><aside class="work-panel"><h3>Approvals</h3><ul class="approval-list">${approvalRows}</ul></aside></div></section>`;
}

function renderArchitectureSection(model) {
  const owners = model.makerSummary.dataOwnership || [];
  const entityRows = owners.map((entity) => `<li><span><strong>${escapeHtml(entity.name)}</strong><small>${escapeHtml(entity.note || entity.role)}</small></span><b>${escapeHtml(statusLabel(entity.owner || entity.realization))}</b></li>`).join('') || '<li class="muted-row">Persistence ownership is pending.</li>';
  const offline = model.offlineIntegration;
  const offlineSection = offline?.selected
    ? `<section class="work-panel" style="margin-top:16px"><h3>Offline integration</h3><p><strong>${escapeHtml(statusLabel(offline.adapter || 'Pending adapter'))}</strong></p><p class="summary-note"><strong>Owner:</strong> ${escapeHtml(statusLabel(offline.owner || 'Pending'))}</p><ul class="plain-list">${offline.runtimeStates.map((state) => `<li>${escapeHtml(statusLabel(state))}</li>`).join('')}</ul><p class="summary-note">${escapeHtml(offline.mediaBindingCount)} media binding${offline.mediaBindingCount === 1 ? '' : 's'} delegated to the package cache</p><p class="summary-note">${offline.profileRequired ? 'Mobile Offline Profile required' : 'No Mobile Offline Profile required'}</p></section>`
    : '';
  return `<section class="panel" id="panel-architecture" role="tabpanel" aria-labelledby="tab-architecture" hidden><div class="section-head"><span><h2>Capabilities & data</h2><p>Persistence ownership, native behavior, connector decisions, and selected package integrations.</p></span></div><div class="architecture-grid"><div><section class="work-panel"><h3>Persistence ownership</h3><ul class="entity-list">${entityRows}</ul></section><div style="margin-top:16px">${renderUsageTraceability(model.dataModelUsage, 'capabilities-usage-traceability')}</div></div><aside><section class="work-panel"><h3>Native capabilities</h3>${renderProjection(model.planSections['Native Capabilities'], 'No native capabilities planned yet')}</section><section class="work-panel" style="margin-top:16px"><h3>Connectors</h3>${renderProjection(model.planSections.Connectors, 'No connectors planned yet')}</section>${offlineSection}</aside></div></section>`;
}

function renderValidationSection(model) {
  const retryCount = Object.values(model.timings?.retries || {}).reduce(
    (total, count) => total + Number(count || 0),
    0,
  );
  const validationRows = [
    ['Pipeline checkpoint', model.pipeline?.completedStep ? `Step ${model.pipeline.completedStep}` : 'Pending'],
    ['Tracked artifacts', model.pipeline?.trackedArtifacts?.length || 0],
    ['Usage artifact', model.dataModelUsage.present && model.dataModelUsage.validLooking ? 'Present' : 'Pending'],
    ['Usage bindings', model.dataModelUsage.bound ? 'Present' : 'Pending'],
    ['Requirements owned', `${model.dataModelUsage.ownedRequirementCount} / ${model.dataModelUsage.persistableRequirementCount} persistable / ${model.dataModelUsage.totalRequirementCount} total`],
    ['Usage schema members', `${model.dataModelUsage.tableCount} tables · ${model.dataModelUsage.fieldCount} fields · ${model.dataModelUsage.relationshipCount} relationships`],
    ['Usage consumer links', model.dataModelUsage.consumerLinkCount],
    ['Scenario artifact', model.scenarioFacts.present && model.scenarioFacts.validLooking ? 'Present' : 'Pending'],
    ['Scenario bindings', model.scenarioFacts.bound ? 'Present' : 'Pending'],
    ['Scenario facts', `${model.scenarioFacts.recordCount} records · ${model.scenarioFacts.scenarioCount} scenarios · ${model.scenarioFacts.screenBindingCount} screens`],
    ['Scenario media & invariants', `${model.scenarioFacts.mediaCount} media · ${model.scenarioFacts.invariantCount} invariants`],
    ['Dataverse manifest', model.dataverse.manifestReady ? 'Ready' : 'Pending'],
    ['Metadata operations', model.dataverse.operationCount],
    ['Completed operations', model.dataverse.completedOperationCount],
    ['Retries', retryCount],
  ].map(([label, value]) => `<div class="validation-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  return `<section class="panel" id="panel-validation" role="tabpanel" aria-labelledby="tab-validation" hidden><div class="section-head"><span><h2>Validation</h2><p>Current checkpoints, operation counts, and recovery signals.</p></span></div><div class="validation-board">${validationRows}</div></section>`;
}

module.exports = {
  renderArchitectureSection,
  renderPhaseRows,
  renderPlanSection,
  renderProgressSection,
  renderValidationSection,
};