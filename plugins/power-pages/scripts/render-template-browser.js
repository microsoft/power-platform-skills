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

function renderPreviewCarousel(template, templateIndex) {
  const images = Array.isArray(template.previewImages) ? template.previewImages : [];
  if (images.length === 0) {
    return '<div class="preview-empty">No preview image yet</div>';
  }
  const carouselId = `template-preview-${templateIndex + 1}`;
  const slides = images.map((image, imageIndex) => `
    <figure class="preview-frame" data-slide="${imageIndex}"${imageIndex === 0 ? '' : ' hidden'}>
      <img src="${escapeHtml(image)}" alt="Preview ${imageIndex + 1} of ${escapeHtml(template.displayName)}" loading="lazy" />
    </figure>
  `).join('');
  return `
    <div class="preview-carousel" id="${carouselId}" data-carousel data-current="0">
      <div class="preview-stage">
        ${slides}
      </div>
      <div class="carousel-controls" aria-label="Preview controls for ${escapeHtml(template.displayName)}">
        <button type="button" class="carousel-btn" data-carousel-prev aria-label="Show previous preview for ${escapeHtml(template.displayName)}" ${images.length === 1 ? 'disabled' : ''}>&lsaquo;</button>
        <span class="carousel-count" data-carousel-count>1 of ${images.length}</span>
        <button type="button" class="carousel-btn" data-carousel-next aria-label="Show next preview for ${escapeHtml(template.displayName)}" ${images.length === 1 ? 'disabled' : ''}>&rsaquo;</button>
      </div>
    </div>
  `;
}

function renderTemplateCardsHtml(templates) {
  if (!Array.isArray(templates) || templates.length === 0) {
    return '<div class="empty-note">No templates are available right now.</div>';
  }
  return templates.map((template, index) => `
    <article class="template-card">
      <div class="template-card-head">
        <div>
          <div class="field-label">Template ${index + 1}</div>
          <h3>${escapeHtml(template.displayName)}</h3>
          <p class="template-desc">${escapeHtml(template.description)}</p>
        </div>
        <div class="template-framework">${escapeHtml(template.framework)}</div>
      </div>
      <div class="preview-strip">
        ${renderPreviewCarousel(template, index)}
      </div>
      <div class="template-meta">
        <div class="field-label">Keywords</div>
        <div class="chip-row">${renderKeywordChips(template.keywords)}</div>
      </div>
    </article>
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
      TEMPLATE_CARD_HTML: renderTemplateCardsHtml(templates),
    },
    requiredKeys: ['TEMPLATE_COUNT', 'TEMPLATE_CARD_HTML'],
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
  renderTemplateCardsHtml,
};
