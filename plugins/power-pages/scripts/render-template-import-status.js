#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const { renderTemplate, escapeHtml } = require('./lib/render-template');
const { openInDefaultBrowser } = require('./lib/default-browser');

function parseArgs(argv) {
  const args = { open: false, previewImages: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--templateName') args.templateName = argv[++i];
    else if (argv[i] === '--statusPath') args.statusPath = argv[++i];
    else if (argv[i] === '--outputPath') args.outputPath = argv[++i];
    else if (argv[i] === '--previewImagesJson') args.previewImages = JSON.parse(argv[++i] || '[]');
    else if (argv[i] === '--open') args.open = true;
  }
  return args;
}

function previewImageUrl(input, index, outputDir) {
  if (typeof input !== 'string' || !input.trim()) return null;
  if (/^https?:\/\//i.test(input)) return input;
  const sourcePath = input.startsWith('file://') ? fileURLToPath(input) : path.resolve(input);
  if (!fs.existsSync(sourcePath)) return input;
  const ext = path.extname(sourcePath) || '.png';
  const previewsDir = path.join(outputDir, 'preview-images');
  const destName = `preview-${String(index + 1).padStart(2, '0')}${ext}`;
  const destPath = path.join(previewsDir, destName);
  fs.mkdirSync(previewsDir, { recursive: true });
  // The status page is served over localhost so it can poll status.json. Browsers
  // do not reliably load file:// or absolute filesystem image paths from that
  // HTTP origin, so copy local preview assets beside the page and reference them
  // by relative URL instead.
  fs.copyFileSync(sourcePath, destPath);
  return `preview-images/${destName}`;
}

function localizePreviewImages(previewImages, outputPath) {
  const outputDir = path.dirname(path.resolve(outputPath));
  return previewImages
    .map((image, index) => previewImageUrl(image, index, outputDir))
    .filter(Boolean);
}

function renderTemplateImportStatus({ templateName, statusPath, outputPath, previewImages = [], open = false }, deps = {}) {
  if (!templateName || !statusPath || !outputPath) {
    throw new Error('Usage: render-template-import-status.js --templateName <name> --statusPath <path> --outputPath <path> [--previewImagesJson <json>] [--open]');
  }
  const templatePath = path.join(__dirname, '..', 'skills', 'create-site', 'assets', 'template-import-status.html');
  const statusUrl = path.dirname(path.resolve(statusPath)) === path.dirname(path.resolve(outputPath))
    ? path.basename(statusPath)
    : pathToFileURL(path.resolve(statusPath)).href;
  renderTemplate({
    templatePath,
    outputPath,
    dataObject: {
      TEMPLATE_NAME: escapeHtml(templateName),
      STATUS_URL_JSON: JSON.stringify(statusUrl),
      PREVIEW_IMAGES_JSON: localizePreviewImages(previewImages, outputPath),
    },
    requiredKeys: ['TEMPLATE_NAME', 'STATUS_URL_JSON', 'PREVIEW_IMAGES_JSON'],
  });
  if (open) {
    try {
      (deps.openInDefaultBrowser || openInDefaultBrowser)(outputPath, deps);
    } catch {}
  }
  return { status: 'ok', output: outputPath, statusPath };
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(renderTemplateImportStatus(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { localizePreviewImages, parseArgs, renderTemplateImportStatus };
