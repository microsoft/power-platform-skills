'use strict';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function evidenceValue(screen, role) {
  return screen.scenarioEvidence.find((entry) => entry.role.includes(role))?.value || screen.title;
}

function requiredScreenMarkup(screen, composition) {
  return `<article id="preview-screen-${screen.screenId}" data-preview-screen-id="${screen.screenId}" data-pack-revision="${screen.packRevision}">
    <header class="screen-heading"><span>${escapeHtml(screen.classification)}</span><h2>${escapeHtml(screen.title)}</h2></header>
    ${composition}
    <section class="signature" data-signature-intent="${screen.screenId}">
      <strong>${escapeHtml(screen.signatureIntent.name)}</strong>
      <p>${escapeHtml(screen.signatureIntent.description)}</p>
    </section>
    <div class="primary-actions">${screen.primaryActions.map((action) => (
    `<button type="button" data-primary-action="${action.markerId}"${action.targetScreenId ? ` data-target-screen-id="${action.targetScreenId}"` : ''}>${escapeHtml(action.label)}</button>`
  )).join('')}</div>
    <section class="state-drawer" aria-label="${escapeHtml(screen.title)} states">${screen.states.map((state) => (
    `<div data-preview-state="${screen.screenId}:${state.name}"><strong>${escapeHtml(state.name)}</strong><span>${escapeHtml(state.copy)}</span></div>`
  )).join('')}</section>
    <div class="media-evidence">${screen.media.map((asset) => (
    `<figure data-media-asset-key="${asset.key}"><span>${escapeHtml(asset.fallback)}</span></figure>`
  )).join('')}</div>
    <div class="scenario-evidence">${screen.scenarioEvidence.map((evidence) => (
    `<span data-scenario-evidence-id="${evidence.id}">${escapeHtml(evidence.value)}</span>`
  )).join('')}</div>
  </article>`;
}

function documentShell(contract, options) {
  const navigation = contract.navigation.durableDestinations.map((destination) => (
    `<a href="#preview-screen-${destination.rootScreenId}" data-navigation-destination="${destination.destinationId}" data-navigation-target-path="${destination.targetPath}">${escapeHtml(destination.label)}</a>`
  )).join('');
  const screens = contract.screens.map((screen, index) => (
    requiredScreenMarkup(screen, options.composition(screen, index))
  )).join('');
  const allScreens = contract.allScreenIds.map(
    (screenId) => `<span data-all-screen-id="${screenId}">${escapeHtml(screenId)}</span>`,
  ).join('');
  const requirements = contract.requirements.map((requirement) => (
    `<p data-requirement-id="${requirement.requirementId}">${escapeHtml(requirement.statement)}</p>`
  )).join('');
  const manifest = JSON.stringify(contract).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style id="product-experience-token-contract">${contract.designTokens.css}</style>
  <style>${options.css}</style>
</head>
<body data-preview-mode="final" data-preview-authorship="design-system-model" data-composition-id="${options.compositionId}">
  <nav id="preview-navigation">${navigation}</nav>
  <main id="preview-storyboard">${screens}</main>
  <section id="preview-all-screens"><h2>All screens</h2>${allScreens}<div class="requirement-index">${requirements}</div></section>
  <script id="product-experience-preview-contract" type="application/json">${manifest}</script>
</body>
</html>\n`;
}

function flightPreview(contract) {
  return documentShell(contract, {
    title: 'Cabin Cart experience',
    compositionId: 'editorial-merchandise-runway',
    css: `body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-heading-family),serif}#preview-navigation{display:flex;gap:2rem;padding:1.25rem 5vw;border-bottom:1px solid var(--color-border)}#preview-storyboard{display:grid;grid-template-columns:1.45fr .9fr .9fr;gap:1.5rem;padding:2rem 5vw}.merchandise-runway{display:grid;grid-template-rows:minmax(14rem,1fr) auto;gap:1rem}.product-stage{min-height:14rem;background:var(--color-accent);display:flex;align-items:end;padding:1.5rem}.cabin-context{display:flex;justify-content:space-between;border-top:3px solid var(--color-primary);padding-top:.75rem}.editorial-price{font-size:2rem}.signature{border-left:4px solid var(--color-primary);padding-left:1rem}.state-drawer,.scenario-evidence,.media-evidence{display:grid;gap:.4rem;margin-top:1rem}.primary-actions button{min-height:3rem;background:var(--color-primary);color:var(--color-surface);border:0;padding:0 1rem}@media(max-width:850px){#preview-storyboard{grid-template-columns:85vw;overflow-x:auto}}`,
    composition: (screen) => `<section class="merchandise-runway">
      <div class="product-stage"><div><span>Cabin collection</span><h3>${escapeHtml(evidenceValue(screen, 'headline'))}</h3></div></div>
      <div class="cabin-context"><span>Seat-aware availability</span><strong class="editorial-price">${escapeHtml(evidenceValue(screen, 'meta'))}</strong></div>
    </section>`,
  });
}

function gymPreview(contract) {
  return documentShell(contract, {
    title: 'Gym maintenance experience',
    compositionId: 'equipment-command-surface',
    css: `body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-heading-family),sans-serif}#preview-navigation{display:grid;grid-template-columns:1fr auto;min-height:4rem;align-items:center;padding:0 4vw;background:var(--color-text);color:var(--color-surface)}#preview-storyboard{display:grid;gap:0;border-top:1px solid var(--color-border)}#preview-storyboard>article{display:grid;grid-template-columns:18rem minmax(0,1fr) 18rem;gap:1rem;padding:1.25rem 4vw;border-bottom:1px solid var(--color-border)}.equipment-identity{border-left:6px solid var(--color-primary);padding:1rem;background:var(--color-surface)}.scan-deck{display:grid;place-items:center;min-height:10rem;border:2px dashed var(--color-primary);background:var(--color-accent)}.safety-rail{display:grid;align-content:start;gap:.75rem;padding:1rem;background:var(--color-statusWarning)}.signature{grid-column:1/3}.primary-actions{grid-column:3}.state-drawer,.media-evidence,.scenario-evidence{grid-column:1/-1;display:flex;gap:.75rem;overflow:auto}.scenario-evidence span{white-space:nowrap;padding:.4rem;background:var(--color-surface)}@media(max-width:850px){#preview-storyboard>article{grid-template-columns:1fr}.signature,.primary-actions,.state-drawer,.media-evidence,.scenario-evidence{grid-column:1}}`,
    composition: (screen) => `<section class="equipment-console">
      <aside class="equipment-identity"><span>Equipment identity</span><h3>${escapeHtml(evidenceValue(screen, 'headline'))}</h3></aside>
      <div class="scan-deck"><strong>Scan to record</strong><span>${escapeHtml(evidenceValue(screen, 'record-0-title'))}</span></div>
      <aside class="safety-rail"><strong>Maintenance and safety</strong><span>${escapeHtml(evidenceValue(screen, 'badge'))}</span></aside>
    </section>`,
  });
}

function receivingPreview(contract) {
  return documentShell(contract, {
    title: 'Relief receiving experience',
    compositionId: 'dense-receiving-ledger',
    css: `body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-heading-family),sans-serif;font-size:.9rem}#preview-navigation{display:flex;gap:1px;background:var(--color-border);position:sticky;top:0}#preview-navigation a{background:var(--color-surface);padding:.9rem 1.2rem}#preview-storyboard{display:grid;grid-template-columns:repeat(3,minmax(20rem,1fr));gap:1px;background:var(--color-border)}#preview-storyboard>article{background:var(--color-surface);padding:1rem}.receiving-ledger{display:grid;gap:.6rem}.queue-column{border:1px solid var(--color-border)}.queue-column h3,.handoff-band h3{margin:0;padding:.7rem;background:var(--color-primary);color:var(--color-surface)}.quantity-matrix{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--color-border)}.quantity-matrix>*{padding:.65rem;border-right:1px solid var(--color-border)}.handoff-band{border-left:5px solid var(--color-statusWarning);padding-left:.75rem}.signature{margin-top:1rem;border-top:3px solid var(--color-primary)}.state-drawer,.scenario-evidence,.media-evidence{display:grid;grid-template-columns:1fr 1fr;gap:.35rem;margin-top:.75rem}.scenario-evidence span{border-bottom:1px solid var(--color-border);padding:.25rem}@media(max-width:900px){#preview-storyboard{grid-template-columns:88vw;overflow-x:auto}}`,
    composition: (screen) => `<section class="receiving-ledger">
      <div class="queue-column"><h3>Receiving queue</h3><p>${escapeHtml(evidenceValue(screen, 'headline'))}</p></div>
      <div class="quantity-matrix"><strong>Shipment quantity</strong><span>${escapeHtml(evidenceValue(screen, 'value'))}</span><span>${escapeHtml(evidenceValue(screen, 'record-0-meta'))}</span></div>
      <div class="handoff-band"><h3>Inspection and handoff</h3><p>${escapeHtml(evidenceValue(screen, 'supporting-text'))}</p></div>
    </section>`,
  });
}

module.exports = {
  flightPreview,
  gymPreview,
  receivingPreview,
};