#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { renderTemplate, escapeHtml } = require('./lib/render-template');
const { openInDefaultBrowser } = require('./lib/default-browser');

// Accepted argv shape:
//   --templatesJsonPath /tmp/templates.json --outputPath /tmp/browser.html [--open]
// `--open` is a boolean switch; the JSON file must contain
// `{ "TEMPLATES_JSON": [ ...manifest entries with absolute preview image URLs... ] }`.
function parseArgs(argv) {
  const args = { open: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--templatesJsonPath') args.templatesJsonPath = argv[++i];
    else if (arg === '--outputPath') args.outputPath = argv[++i];
    else if (arg === '--open') args.open = true;
  }
  return args;
}

function openFileInDefaultBrowser(filePath, deps = {}) {
  openInDefaultBrowser(filePath, deps);
}

function renderKeywordChips(keywords) {
  const items = Array.isArray(keywords) ? keywords : [];
  if (items.length === 0) return '<span class="muted">No keywords listed</span>';
  return items.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join('');
}

function renderPreviewImages(template) {
  const images = Array.isArray(template.previewImages) ? template.previewImages : [];
  if (images.length === 0) {
    return '<div class="preview-empty">No preview image yet</div>';
  }
  return images.map((image, imageIndex) => `
    <figure class="preview-boundary">
      <figcaption>Preview ${imageIndex + 1}</figcaption>
      <img class="preview-image" src="${escapeHtml(image)}" alt="Preview ${imageIndex + 1} of ${escapeHtml(template.displayName)}" loading="lazy" />
    </figure>
  `).join('');
}

function frameworkLabel(framework) {
  if (!framework) return '';
  return String(framework).slice(0, 1).toUpperCase() + String(framework).slice(1);
}

// The catalog manifest defines `variants` as an object map keyed by framework
// (e.g. { "react": { ... } }), but some inputs may already pass an array of
// { framework, ... } entries. Normalize both shapes to a single array so the
// hero label and the chip row stay in sync.
// See templates/manifest.json (variants object) in microsoft/power-pages-samples.
function normalizeVariants(template) {
  if (Array.isArray(template.variants)) return template.variants;
  return Object.entries(template.variants || {}).map(([framework, variant]) => ({ framework, ...variant }));
}

function frameworkSummaryLabel(template) {
  const frameworks = normalizeVariants(template)
    .map((variant) => variant.framework)
    .filter(Boolean);
  if (frameworks.length > 1) return `${frameworks.length} frameworks`;
  if (frameworks.length === 1) return frameworkLabel(frameworks[0]);
  // Fall back to a legacy top-level `framework` field when no variants exist.
  return frameworkLabel(template.framework);
}

function renderFrameworkVariants(template) {
  const variants = normalizeVariants(template);
  const frameworks = variants.length > 0 ? variants.map((variant) => variant.framework) : [template.framework].filter(Boolean);
  if (frameworks.length === 0) return '';
  return `
    <div class="template-meta">
      <div class="field-label">Available frameworks</div>
      <div class="chip-row">${frameworks.map((framework) => `<span class="chip chip-framework">${escapeHtml(frameworkLabel(framework))}</span>`).join('')}</div>
    </div>
  `;
}

function templateTabId(index) {
  return `template-${index + 1}`;
}

function renderTemplateTabsHtml(templates) {
  if (!Array.isArray(templates) || templates.length === 0) {
    return '<div class="nav-btn active"><span class="nav-icon">&#9673;</span> No templates</div>';
  }
  return templates.map((template, index) => `
    <button class="nav-btn${index === 0 ? ' active' : ''}" type="button" data-tab="${templateTabId(index)}">
      <span class="nav-icon">&#9673;</span>
      ${escapeHtml(template.displayName)}
    </button>
  `).join('');
}

function renderTemplateSectionsHtml(templates) {
  if (!Array.isArray(templates) || templates.length === 0) {
    return '<div class="empty-note">No templates are available right now.</div>';
  }
  return templates.map((template, index) => `
    <section class="template-section${index === 0 ? ' active' : ''}" id="${templateTabId(index)}">
      <div class="template-hero">
        <h2>${escapeHtml(template.displayName)}</h2>
        <div class="template-framework">${escapeHtml(frameworkSummaryLabel(template))}</div>
      </div>
      ${renderFrameworkVariants(template)}
      <div class="template-meta">
        <div class="field-label">Keywords</div>
        <div class="chip-row">${renderKeywordChips(template.keywords)}</div>
      </div>
      <p class="template-desc">${escapeHtml(template.description)}</p>
      <div class="field-label previews-label">Previews</div>
      <div class="preview-stack">
        ${renderPreviewImages(template)}
      </div>
    </section>
  `).join('');
}

function expectedFrameworks(template) {
  const variants = normalizeVariants(template);
  const frameworks = variants.length > 0 ? variants.map((variant) => variant.framework) : [template.framework].filter(Boolean);
  return frameworks.map(frameworkLabel).filter(Boolean);
}

function validateRenderedTemplateBrowser({ templates, html }) {
  const errors = [];
  const items = Array.isArray(templates) ? templates : [];
  if (items.length === 0) {
    errors.push('TEMPLATES_JSON must contain at least one template family before opening the browser preview');
  }
  if (/No templates are available right now/i.test(html || '')) {
    errors.push('Rendered template browser contains the empty-state message');
  }
  items.forEach((template, index) => {
    const displayName = escapeHtml(template.displayName);
    if (!displayName || !html.includes(displayName)) {
      errors.push(`Rendered template browser is missing template ${index + 1} displayName`);
    }
    for (const framework of expectedFrameworks(template)) {
      if (!html.includes(escapeHtml(framework))) {
        errors.push(`Rendered template browser is missing framework ${framework} for ${template.displayName || `template ${index + 1}`}`);
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

function renderTemplateBrowser({ templatesJsonPath, outputPath, open = false }, deps = {}) {
  if (!templatesJsonPath || !outputPath) {
    throw new Error('Usage: render-template-browser.js --templatesJsonPath <path> --outputPath <path> [--open]');
  }
  const fsImpl = deps.fs || fs;
  const templatePath = path.join(__dirname, '..', 'skills', 'create-site', 'assets', 'template-browser.html');
  const data = JSON.parse(fsImpl.readFileSync(templatesJsonPath, 'utf8'));
  const templates = Array.isArray(data.TEMPLATES_JSON) ? data.TEMPLATES_JSON : [];
  renderTemplate({
    templatePath,
    outputPath,
    dataObject: {
      TEMPLATE_COUNT: String(templates.length),
      TEMPLATE_TABS_HTML: renderTemplateTabsHtml(templates),
      TEMPLATE_SECTIONS_HTML: renderTemplateSectionsHtml(templates),
    },
    requiredKeys: ['TEMPLATE_COUNT', 'TEMPLATE_TABS_HTML', 'TEMPLATE_SECTIONS_HTML'],
  });
  const validation = validateRenderedTemplateBrowser({ templates, html: fsImpl.readFileSync(outputPath, 'utf8') });
  if (!validation.ok) {
    return { status: 'invalid', output: outputPath, opened: false, validation };
  }
  let openError = null;
  if (open) {
    try {
      openFileInDefaultBrowser(outputPath, deps);
    } catch (err) {
      openError = err.message;
    }
  }
  return { status: 'ok', output: outputPath, opened: Boolean(open && !openError), ...(openError ? { openError } : {}) };
}

function main() {
  try {
    const result = renderTemplateBrowser(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  openFileInDefaultBrowser,
  renderTemplateBrowser,
  renderTemplateTabsHtml,
  renderTemplateSectionsHtml,
  validateRenderedTemplateBrowser,
};
