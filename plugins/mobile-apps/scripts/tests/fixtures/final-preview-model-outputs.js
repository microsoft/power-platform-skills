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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style id="product-experience-token-contract">${contract.designTokens.css}</style>
  <style>${options.css}</style>
</head>
<body data-preview-mode="final" data-preview-authorship="design-system-model" data-preview-contract-revision="${contract.contractRevision}" data-composition-id="${options.compositionId}">
  <nav id="preview-navigation">${navigation}</nav>
  <main id="preview-storyboard">${screens}</main>
  <section id="preview-all-screens"><h2>All screens</h2>${allScreens}<div class="requirement-index">${requirements}</div></section>
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

function reviewMarkup(contract, visibleEvidenceCount) {
  const screens = contract.screens.map((screen) => `<section class="review-screen">
    <h3>${escapeHtml(screen.title)}</h3>
    <div data-signature-intent="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><p>${escapeHtml(screen.signatureIntent.description)}</p></div>
    <div class="review-states">${screen.states.map((state) => `<div data-preview-state="${screen.screenId}:${state.name}"><strong>${escapeHtml(state.name)}</strong><span>${escapeHtml(state.copy)}</span></div>`).join('')}</div>
    <div class="review-evidence">${screen.scenarioEvidence.slice(visibleEvidenceCount).map((evidence) => `<span data-scenario-evidence-id="${evidence.id}">${escapeHtml(evidence.value)}</span>`).join('')}</div>
  </section>`).join('');
  const allScreens = contract.allScreenIds.map(
    (screenId) => `<span data-all-screen-id="${screenId}">${escapeHtml(screenId)}</span>`,
  ).join('');
  const requirements = contract.requirements.map((requirement) => (
    `<p data-requirement-id="${requirement.requirementId}">${escapeHtml(requirement.statement)}</p>`
  )).join('');
  return `<section id="preview-all-screens"><details><summary>Review complete experience</summary><div data-screen-index>${allScreens}</div>${screens}<section class="requirement-index"><h3>Requirement coverage</h3>${requirements}</section></details></section>`;
}

function qualityDocument(contract, options) {
  const visibleEvidenceCount = 4;
  const navigation = contract.navigation.durableDestinations.map((destination) => (
    `<a href="#preview-screen-${destination.rootScreenId}" data-navigation-destination="${destination.destinationId}" data-navigation-target-path="${destination.targetPath}">${escapeHtml(destination.label)}</a>`
  )).join('');
  const screens = contract.screens.map((screen, index) => `<article id="preview-screen-${screen.screenId}" data-preview-screen-id="${screen.screenId}" data-pack-revision="${screen.packRevision}">
    <section class="phone-shell" data-mobile-frame="${screen.screenId}">
      <div data-first-viewport="${screen.screenId}">
        <header data-viewport-region="context"><span>${escapeHtml(options.productLabel)}</span><h2>${escapeHtml(screen.title)}</h2></header>
        <div data-viewport-region="focal-content">${options.composition(screen, index)}<div data-product-component="decision-facts-${index}">${screen.scenarioEvidence.slice(0, visibleEvidenceCount).map((evidence) => `<span data-scenario-evidence-id="${evidence.id}">${escapeHtml(evidence.value)}</span>`).join('')}</div>${screen.media.map((asset) => `<figure data-media-asset-key="${asset.key}"><span>${escapeHtml(asset.fallback)}</span></figure>`).join('')}</div>
        <div data-viewport-region="primary-action">${screen.primaryActions.map((action, actionIndex) => `<button type="button" data-primary-action="${action.markerId}"${actionIndex === 0 ? ` data-primary-emphasis="${action.markerId}"` : ''}${action.targetScreenId ? ` data-target-screen-id="${action.targetScreenId}"` : ''}>${escapeHtml(action.label)}</button>`).join('')}</div>
      </div>
    </section>
  </article>`).join('');
  const commonCss = `*{box-sizing:border-box}body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-heading-family),sans-serif}#preview-navigation{display:flex;justify-content:center;gap:.5rem;padding:1rem;background:var(--color-text)}[data-navigation-destination]{padding:.65rem 1rem;border:1px solid var(--color-border);border-radius:4px;color:var(--color-surface);text-decoration:none}#preview-storyboard{display:grid;grid-template-columns:repeat(3,minmax(0,390px));justify-content:center;gap:1.25rem;padding:1.5rem}.phone-shell{width:min(100%,390px);height:844px;overflow-x:hidden;overflow-y:auto;padding:1rem;background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.12)}[data-first-viewport]{height:780px;display:flex;flex-direction:column;gap:1rem}[data-viewport-region="focal-content"]{display:grid;gap:.75rem;flex:1;min-height:0;overflow-y:auto}[data-viewport-region="primary-action"]{margin-top:auto}[data-product-component]{display:grid;gap:.45rem;padding:.85rem;border:1px solid var(--color-border);background:var(--color-bg)}[data-primary-action]{width:100%;min-height:48px;border:0;border-radius:4px;background:var(--color-primary);color:var(--color-surface);font:inherit;font-weight:700}[data-screen-index]{display:flex;flex-wrap:wrap;gap:.4rem;padding:.75rem;border:1px solid var(--color-border);background:var(--color-bg)}#preview-all-screens{padding:0 1.5rem 2rem}#preview-all-screens details{max-width:70rem;margin:auto;border:1px solid var(--color-border);background:var(--color-surface)}#preview-all-screens summary{padding:1rem;font-weight:700}.review-screen,.requirement-index{padding:1rem;border-top:1px solid var(--color-border)}.review-states,.review-evidence{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.4rem}${options.css}@media(max-width:1100px){#preview-storyboard{grid-template-columns:minmax(0,390px);overflow-x:auto}.review-states,.review-evidence{grid-template-columns:1fr}}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(options.title)}</title><style id="product-experience-token-contract">${contract.designTokens.css}</style><style>${commonCss}</style></head><body data-preview-mode="final" data-preview-authorship="design-system-model" data-preview-contract-revision="${contract.contractRevision}" data-composition-id="${options.compositionId}"><nav id="preview-navigation">${navigation}</nav><main id="preview-storyboard">${screens}</main>${reviewMarkup(contract, visibleEvidenceCount)}</body></html>\n`;
}

function repairedFlightPreview(contract) {
  return qualityDocument(contract, {
    title: 'Cabin Cart experience',
    productLabel: 'Cabin Cart',
    compositionId: 'repaired-editorial-merchandise-runway',
    css: '[data-viewport-region="context"]{padding-bottom:.75rem;border-bottom:1px solid var(--color-border)}[data-focal-point]{background:var(--color-accent)}.merch-grid{grid-template-columns:repeat(2,1fr)}.product-focus{min-height:14rem}.checkout-sheet{border-top:5px solid var(--color-primary)}',
    composition(screen, index) {
      if (index === 0) return `<ul class="merch-grid" data-product-component="merchandise-grid" data-focal-point="${screen.screenId}"><li>${escapeHtml(evidenceValue(screen, 'headline'))}</li><li>${escapeHtml(evidenceValue(screen, 'record-0-title'))}</li></ul><aside data-product-component="cabin-context" data-signature-component="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><span>Seat delivery</span></aside>`;
      if (index === 1) return `<figure class="product-focus" data-product-component="product-stage" data-focal-point="${screen.screenId}"><figcaption>${escapeHtml(evidenceValue(screen, 'headline'))}</figcaption><strong>${escapeHtml(evidenceValue(screen, 'meta'))}</strong></figure><section data-product-component="availability-band" data-signature-component="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><span>Cabin availability</span></section>`;
      return `<form class="checkout-sheet" data-product-component="checkout-sheet" data-focal-point="${screen.screenId}"><label>Order total <output>${escapeHtml(evidenceValue(screen, 'value'))}</output></label><label>Delivery <span>${escapeHtml(evidenceValue(screen, 'supporting-text'))}</span></label></form><aside data-product-component="trust-band" data-signature-component="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><span>Payment and seat confirmation</span></aside>`;
    },
  });
}

function repairedGymPreview(contract) {
  return qualityDocument(contract, {
    title: 'Gym maintenance experience',
    productLabel: 'Gym Floor Care',
    compositionId: 'repaired-equipment-command-surface',
    css: '[data-viewport-region="context"]{padding-bottom:.75rem;border-bottom:4px solid var(--color-primary)}[data-focal-point]{border-left:6px solid var(--color-primary);background:var(--color-accent)}.work-queue{list-style:none;padding:0}.safety-checklist{counter-reset:item}.defect-capture{min-height:13rem}',
    composition(screen, index) {
      if (index === 0) return `<ol class="work-queue" data-product-component="shift-work-queue" data-focal-point="${screen.screenId}"><li><strong>${escapeHtml(evidenceValue(screen, 'headline'))}</strong></li><li>${escapeHtml(evidenceValue(screen, 'record-0-title'))}</li></ol><aside data-product-component="scan-entry" data-signature-component="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><span>Scan-first entry</span></aside>`;
      if (index === 1) return `<ul class="safety-checklist" data-product-component="safety-checklist" data-focal-point="${screen.screenId}"><li>${escapeHtml(evidenceValue(screen, 'headline'))}</li><li>${escapeHtml(evidenceValue(screen, 'badge'))}</li></ul><section data-product-component="failure-summary" data-signature-component="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><span>Failed checks first</span></section>`;
      return `<figure class="defect-capture" data-product-component="defect-capture" data-focal-point="${screen.screenId}"><figcaption>${escapeHtml(evidenceValue(screen, 'headline'))}</figcaption><strong>${escapeHtml(evidenceValue(screen, 'record-0-title'))}</strong></figure><aside data-product-component="severity-control" data-signature-component="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><span>${escapeHtml(evidenceValue(screen, 'badge'))}</span></aside>`;
    },
  });
}

function receivingComposition(screen, index) {
  const first = evidenceValue(screen, 'headline');
  const second = evidenceValue(screen, 'record-0-title');
  const third = evidenceValue(screen, 'value');
  if (index === 0) {
    return `<section data-product-component="shipment-queue" data-focal-point="${screen.screenId}"><span>Receiving queue</span><h3>${escapeHtml(first)}</h3></section><section data-product-component="quantity-progress" data-signature-component="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><span>${escapeHtml(third)}</span></section>`;
  }
  if (index === 1) {
    return `<ol data-product-component="condition-sweep" data-focal-point="${screen.screenId}"><li>Condition check</li><li><strong>${escapeHtml(second)}</strong></li></ol><section data-product-component="batch-expiry" data-signature-component="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><span>${escapeHtml(third)}</span></section>`;
  }
  return `<figure data-product-component="capture-stage" data-focal-point="${screen.screenId}"><figcaption>Evidence capture</figcaption><strong>${escapeHtml(first)}</strong></figure><aside data-product-component="identifier-lock" data-signature-component="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><span>${escapeHtml(second)}</span></aside>`;
}

function receivingPreview(contract) {
  const visibleEvidenceCount = 4;
  const navigation = contract.navigation.durableDestinations.map((destination) => (
    `<a href="#preview-screen-${destination.rootScreenId}" data-navigation-destination="${destination.destinationId}" data-navigation-target-path="${destination.targetPath}">${escapeHtml(destination.label)}</a>`
  )).join('');
  const screens = contract.screens.map((screen, index) => `<article id="preview-screen-${screen.screenId}" data-preview-screen-id="${screen.screenId}" data-pack-revision="${screen.packRevision}">
    <section class="phone-shell" data-mobile-frame="${screen.screenId}">
      <div data-first-viewport="${screen.screenId}">
        <header data-viewport-region="context"><span>Relief Receive</span><h2>${escapeHtml(screen.title)}</h2></header>
        <div data-viewport-region="focal-content">${receivingComposition(screen, index)}<div data-product-component="decision-facts-${index}">${screen.scenarioEvidence.slice(0, visibleEvidenceCount).map((evidence) => `<span data-scenario-evidence-id="${evidence.id}">${escapeHtml(evidence.value)}</span>`).join('')}</div>${screen.media.map((asset) => `<figure data-media-asset-key="${asset.key}"><span>${escapeHtml(asset.fallback)}</span></figure>`).join('')}</div>
        <div data-viewport-region="primary-action">${screen.primaryActions.map((action, actionIndex) => `<button type="button" data-primary-action="${action.markerId}"${actionIndex === 0 ? ` data-primary-emphasis="${action.markerId}"` : ''}${action.targetScreenId ? ` data-target-screen-id="${action.targetScreenId}"` : ''}>${escapeHtml(action.label)}</button>`).join('')}</div>
      </div>
    </section>
  </article>`).join('');
  const css = `*{box-sizing:border-box}body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-heading-family),sans-serif;font-size:.9rem}#preview-navigation{display:flex;justify-content:center;gap:.5rem;padding:1rem;background:var(--color-text)}[data-navigation-destination]{padding:.65rem 1rem;border:1px solid var(--color-border);border-radius:4px;color:var(--color-surface);text-decoration:none}#preview-storyboard{display:grid;grid-template-columns:repeat(3,minmax(0,390px));justify-content:center;gap:1.25rem;padding:1.5rem}.phone-shell{width:min(100%,390px);height:844px;overflow-x:hidden;overflow-y:auto;padding:1rem;background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.12)}[data-first-viewport]{height:780px;display:flex;flex-direction:column;gap:1rem}[data-viewport-region="context"]{border-bottom:3px solid var(--color-primary);padding-bottom:.75rem}[data-viewport-region="focal-content"]{display:grid;gap:.75rem;flex:1;min-height:0;overflow-y:auto}[data-viewport-region="primary-action"]{margin-top:auto}[data-product-component]{display:grid;gap:.45rem;padding:.85rem;border:1px solid var(--color-border);background:var(--color-bg)}[data-focal-point]{border-left:6px solid var(--color-primary);background:var(--color-accent)}[data-primary-action]{width:100%;min-height:48px;border:0;border-radius:4px;background:var(--color-primary);color:var(--color-surface);font:inherit;font-weight:700}[data-screen-index]{display:flex;flex-wrap:wrap;gap:.4rem;padding:.75rem;border:1px solid var(--color-border);background:var(--color-bg)}#preview-all-screens{padding:0 1.5rem 2rem}#preview-all-screens details{max-width:70rem;margin:auto;border:1px solid var(--color-border);background:var(--color-surface)}#preview-all-screens summary{padding:1rem;font-weight:700}.review-screen,.requirement-index{padding:1rem;border-top:1px solid var(--color-border)}.review-states,.review-evidence{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.4rem}@media(max-width:1100px){#preview-storyboard{grid-template-columns:minmax(0,390px);overflow-x:auto}.review-states,.review-evidence{grid-template-columns:1fr}}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Relief receiving experience</title><style id="product-experience-token-contract">${contract.designTokens.css}</style><style>${css}</style></head>
<body data-preview-mode="final" data-preview-authorship="design-system-model" data-preview-contract-revision="${contract.contractRevision}" data-composition-id="dense-receiving-ledger"><nav id="preview-navigation">${navigation}</nav><main id="preview-storyboard">${screens}</main>${reviewMarkup(contract, visibleEvidenceCount)}</body></html>\n`;
}

module.exports = {
  flightPreview,
  gymPreview,
  repairedFlightPreview,
  repairedGymPreview,
  receivingPreview,
};