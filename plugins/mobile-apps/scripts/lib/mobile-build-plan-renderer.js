'use strict';

const { renderClientBehavior } = require('./mobile-build-plan-client');
const { renderDataModel } = require('./mobile-build-plan-data-model');
const { renderEditorControls } = require('./mobile-build-plan-editor-controls');
const { escapeHtml } = require('./mobile-build-plan-html');
const { renderScreenGraph } = require('./mobile-build-plan-screen-graph');
const {
  renderArchitectureSection,
  renderPhaseRows,
  renderPlanSection,
  renderProgressSection,
  renderValidationSection,
} = require('./mobile-build-plan-sections');
const { renderStyles } = require('./mobile-build-plan-styles');

function renderBuildPlanHtml(model, options = {}) {
  const live = options.live === true;
  const canEdit = live && model.dataModelEditable;
  const editDisabled = canEdit
    ? ''
    : ' disabled aria-disabled="true" title="Editing is available while the live planning server is running before Dataverse execution"';
  const serializedModel = JSON.stringify(model).replace(/</g, '\\u003c');
  const tabs = [
    ['plan', 'Plan'],
    ['progress', 'Progress'],
    ['data', 'Data model'],
    ['screens', 'Screens'],
    ['architecture', 'Capabilities & data'],
    ['validation', 'Validation'],
  ].map(([id, label], index) => `<button role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}</button>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'">
<title>${escapeHtml(model.projectName)} · Build Plan</title>
${renderStyles()}
</head>
<body>
<div class="shell">
  <aside class="rail"><div class="brand"><span class="brand-mark">BP</span><span><strong>Build Plan</strong><small>${escapeHtml(model.projectName)}</small></span></div><ol class="phase-list">${renderPhaseRows(model)}</ol></aside>
  <main class="main">
    <header class="topbar"><span><h1>${escapeHtml(model.projectName)}</h1><p>Phase ${escapeHtml(model.makerProgress.phase)} of ${escapeHtml(model.makerProgress.phaseCount)} · ${escapeHtml(model.makerProgress.phaseLabel)} · ${escapeHtml(model.makerProgress.state)}</p></span><span class="live" id="connection-state" role="status" aria-live="polite">Live build</span></header>
    <nav class="tabs" role="tablist" aria-label="Build plan sections">
      ${tabs}
    </nav>
    <div class="content">
      ${renderPlanSection(model)}
      ${renderProgressSection(model)}
      ${renderDataModel(model, { canEdit, editDisabled })}
      ${renderScreenGraph(model)}
      ${renderArchitectureSection(model)}
      ${renderValidationSection(model)}
    </div>
  </main>
</div>
${renderEditorControls(model)}
<div class="pending-refresh" id="pending-refresh" role="status" aria-live="polite" hidden>Build updated. Close the editor to refresh.</div>
<div class="sr-only" id="live-announcer" role="status" aria-live="polite" aria-atomic="true"></div>
<footer class="footer-note">AI-generated content may be incorrect</footer>
<script id="build-plan-model" type="application/json">${serializedModel}</script>
${renderClientBehavior(live)}
</body>
</html>`;
}

module.exports = {
  renderBuildPlanHtml,
};