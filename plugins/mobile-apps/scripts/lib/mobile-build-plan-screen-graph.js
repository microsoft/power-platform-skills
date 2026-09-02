'use strict';

const { escapeHtml, statusLabel } = require('./mobile-build-plan-html');

function screenStatusLabel(value) {
  const label = statusLabel(value);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function projectScreens(scope, journey, compiledArtifact, screenStatuses = {}) {
  const plannedScreens = Array.isArray(scope?.screens) ? scope.screens : [];
  const compiledScreens = Array.isArray(compiledArtifact?.screens)
    ? compiledArtifact.screens
    : Array.isArray(compiledArtifact?.packs)
      ? compiledArtifact.packs
      : [];
  const compiledById = new Map(compiledScreens.map((screen) => [screen.screenId, screen]));
  const journeyStepsByScreenId = new Map();
  for (const workflow of journey?.journeys || []) {
    for (const step of workflow.steps || []) {
      const screenId = step.surface?.screenId;
      if (!screenId) continue;
      if (!journeyStepsByScreenId.has(screenId)) journeyStepsByScreenId.set(screenId, []);
      journeyStepsByScreenId.get(screenId).push({
        ...step,
        journeyId: workflow.id,
        journeyName: workflow.name,
      });
    }
  }

  if (plannedScreens.length === 0) {
    return compiledScreens.map((screen) => ({
      ...screen,
      status: screenStatusLabel(screenStatuses[screen.screenId] || screen.status || 'packed'),
    }));
  }

  const plannedById = new Map(plannedScreens.map((screen) => [screen.id, screen]));
  const ordered = [];
  const visited = new Set();
  const appendWithChildren = (screen) => {
    if (!screen || visited.has(screen.id)) return;
    visited.add(screen.id);
    ordered.push(screen);
    for (const child of plannedScreens) {
      if (child.parentScreenId === screen.id) appendWithChildren(child);
    }
  };
  for (const screenId of scope.navigation?.durableDestinationIds || []) {
    appendWithChildren(plannedById.get(screenId));
  }
  for (const screen of plannedScreens) appendWithChildren(screen);

  const depthOf = (screen, seen = new Set()) => {
    if (!screen?.parentScreenId || seen.has(screen.id)) return 0;
    const parent = plannedById.get(screen.parentScreenId);
    if (!parent) return 0;
    return 1 + depthOf(parent, new Set([...seen, screen.id]));
  };

  return ordered.map((planned, index) => {
    const compiled = compiledById.get(planned.id);
    const pack = compiled?.pack || compiled || null;
    return {
      screenId: planned.id,
      title: planned.title,
      route: planned.route,
      purpose: planned.purpose,
      jobIds: planned.jobIds || [],
      classification: planned.classification,
      parentScreenId: planned.parentScreenId || null,
      navigationDepth: depthOf(planned),
      hideTabs: planned.hideTabs === true,
      tabVisibilityReason: planned.tabVisibilityReason || null,
      justification: planned.justification,
      cannotMergeBecause: planned.cannotMergeBecause || null,
      isDurableDestination: (scope.navigation?.durableDestinationIds || []).includes(planned.id),
      isVisibleTab: (scope.navigation?.visibleTabIds || []).includes(planned.id),
      isPrimaryDestination: index === 0
        && (scope.navigation?.durableDestinationIds || []).includes(planned.id),
      journeySteps: journeyStepsByScreenId.get(planned.id) || [],
      pack,
      status: screenStatusLabel(
        screenStatuses[planned.id]
          || compiled?.status
          || pack?.status
          || (compiled ? 'packed' : 'planned'),
      ),
    };
  });
}

function renderScreenGraph(model) {
  const scope = model.scope || {};
  const screenTitleById = new Map(
    model.screens.map((screen) => [screen.screenId, screen.title]),
  );
  const screenCards = model.screens.length > 0 ? model.screens.map((screen) => `
    <article class="screen-row screen-${escapeHtml(screen.classification || screen.pack?.classification || 'screen')} screen-depth-${Math.min(Number(screen.navigationDepth || 0), 4)}" data-screen-id="${escapeHtml(screen.screenId)}"${screen.parentScreenId ? ` data-parent-screen-id="${escapeHtml(screen.parentScreenId)}"` : ''}>
      <header><span>${escapeHtml(statusLabel(screen.classification || screen.pack?.classification || 'screen'))}</span><b>${escapeHtml(screen.status || 'Planned')}</b></header>
      <strong>${escapeHtml(screen.title || screen.screenId)}</strong>
      <small>${escapeHtml(screen.purpose || screen.pack?.purpose || '')}</small>
      <dl><div><dt>Navigation role</dt><dd>${escapeHtml(screen.isPrimaryDestination ? 'Primary destination' : screen.isDurableDestination ? 'Durable destination' : screen.parentScreenId ? `Nested under ${screenTitleById.get(screen.parentScreenId) || 'parent screen'}` : 'Supporting flow')}</dd></div><div><dt>Tabs</dt><dd>${escapeHtml(screen.hideTabs ? 'Hidden in this focused flow' : screen.isVisibleTab ? 'Visible destination' : 'Uses parent navigation')}</dd></div><div><dt>Primary action</dt><dd>${escapeHtml(screen.pack?.firstViewport?.primaryAction || 'Pending')}</dd></div><div><dt>Key states</dt><dd>${escapeHtml(Object.keys(screen.pack?.states || screen.journeySteps?.[0]?.states || {}).join(', ') || 'Pending')}</dd></div></dl>
      <details class="screen-evidence"><summary>Why this screen exists</summary><p>${escapeHtml(screen.justification || screen.purpose || 'Product Scope evidence is pending.')}</p>${screen.jobIds?.length ? `<p><strong>Jobs:</strong> ${escapeHtml(screen.jobIds.join(', '))}</p>` : ''}${screen.cannotMergeBecause?.evidence ? `<p><strong>Kept separate:</strong> ${escapeHtml(screen.cannotMergeBecause.evidence)}</p>` : ''}</details>
    </article>`).join('') : '<div class="empty"><strong>Screens are being planned</strong><span>The approved Product Scope screen graph will appear here.</span></div>';

  return `<section class="panel" id="panel-screens" role="tabpanel" aria-labelledby="tab-screens" hidden><div class="section-head"><span><h2>Screen map</h2><p>${model.screens.length} planned ${model.screens.length === 1 ? 'screen' : 'screens'} · ${escapeHtml(statusLabel(scope.navigation?.pattern || 'navigation pending'))}</p></span></div>${scope.navigation ? `<div class="navigation-contract"><span><strong>Durable destinations</strong><small>${escapeHtml((scope.navigation.durableDestinationIds || []).map((id) => screenTitleById.get(id) || id).join(', ') || 'None')}</small></span><span><strong>Return path</strong><small>${escapeHtml(scope.navigation.returnHomeMechanism || 'Uses the active navigation pattern')}</small></span></div>` : ''}<div class="screen-list">${screenCards}</div></section>`;
}

module.exports = {
  projectScreens,
  renderScreenGraph,
};