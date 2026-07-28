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
        <div class="template-framework">${escapeHtml(template.framework)}</div>
      </div>
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
  if (open) {
    openFileInDefaultBrowser(outputPath, deps);
  }
  return { status: 'ok', output: outputPath, opened: Boolean(open) };
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
};
