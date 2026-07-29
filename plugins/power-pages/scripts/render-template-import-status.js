#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
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
      PREVIEW_IMAGES_JSON: previewImages,
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

module.exports = { parseArgs, renderTemplateImportStatus };
