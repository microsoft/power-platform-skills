#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const { renderTemplate } = require('./lib/render-template');
const { openInDefaultBrowser } = require('./lib/default-browser');

const LOCAL_PREVIEW_SIGNATURES = {
  '.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  '.jpg': Buffer.from([0xff, 0xd8, 0xff]),
  '.jpeg': Buffer.from([0xff, 0xd8, 0xff]),
};

function parseArgs(argv) {
  const args = { open: false, previewImages: [], solutionCount: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--templateName') args.templateName = argv[++i];
    else if (argv[i] === '--templateDescription') args.templateDescription = argv[++i];
    else if (argv[i] === '--statusPath') args.statusPath = argv[++i];
    else if (argv[i] === '--outputPath') args.outputPath = argv[++i];
    else if (argv[i] === '--previewImagesJson') args.previewImages = JSON.parse(argv[++i] || '[]');
    else if (argv[i] === '--solutionCount') args.solutionCount = Number(argv[++i]);
    else if (argv[i] === '--open') args.open = true;
  }
  return args;
}

function previewImageUrl(input, index, outputDir) {
  if (typeof input !== 'string' || !input.trim()) return null;
  if (/^https?:\/\//i.test(input)) return input;
  let sourcePath;
  try {
    sourcePath = input.startsWith('file://') ? fileURLToPath(input) : path.resolve(input);
  } catch {
    return input;
  }
  if (!fs.existsSync(sourcePath)) return input;
  const ext = path.extname(sourcePath).toLowerCase();
  const signature = LOCAL_PREVIEW_SIGNATURES[ext];
  let stat;
  let prefix;
  try {
    stat = fs.lstatSync(sourcePath);
    if (!signature || stat.isSymbolicLink() || !stat.isFile()) return null;
    const handle = fs.openSync(sourcePath, 'r');
    try {
      prefix = Buffer.alloc(signature.length);
      const bytesRead = fs.readSync(handle, prefix, 0, prefix.length, 0);
      if (bytesRead !== signature.length || !prefix.equals(signature)) return null;
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
  const previewsDir = path.join(outputDir, 'preview-images');
  const destName = `preview-${String(index + 1).padStart(2, '0')}${ext}`;
  const destPath = path.join(previewsDir, destName);
  fs.mkdirSync(previewsDir, { recursive: true });
  // The status page is served over localhost so it can poll status.json. Browsers
  // cannot reliably load file URLs or absolute paths from that HTTP origin.
  fs.copyFileSync(sourcePath, destPath);
  return `preview-images/${destName}`;
}

function localizePreviewImages(previewImages, outputPath) {
  const outputDir = path.dirname(path.resolve(outputPath));
  return previewImages
    .map((image, index) => previewImageUrl(image, index, outputDir))
    .filter(Boolean);
}

function toDataUrl(filePath) {
  return `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function buildModel({ templateName, templateDescription, statusPath, outputPath, previewImages, solutionCount }) {
  const statusUrl = path.dirname(path.resolve(statusPath)) === path.dirname(path.resolve(outputPath))
    ? path.basename(statusPath)
    : pathToFileURL(path.resolve(statusPath)).href;
  const previews = previewImages.map((image, index) => {
    const url = previewImageUrl(image, index, path.dirname(path.resolve(outputPath)));
    if (!url) return null;
    const sourcePath = /^(?:https?|file):\/\//i.test(image)
      ? decodeURIComponent(new URL(image).pathname)
      : image;
    return {
      name: `preview-${index + 1}`,
      displayName: sourcePath.split(/[\\/]/).pop(),
      desktop: url,
      mobile: url,
    };
  }).filter(Boolean);
  const pluralSolutions = solutionCount > 1;
  const pluginRoot = path.resolve(__dirname, '..');

  return {
    brandIcon: toDataUrl(
      path.join(pluginRoot, 'skills', 'create-site', 'assets', 'shared', 'power-pages-icon.png'),
    ),
    presentation: {
      allowRefreshPause: false,
      showPreviewNotice: false,
      templateEyebrow: 'Your selected SPA template',
      siteEyebrow: 'Creating your SPA site',
      templateCategory: 'SPA',
      statusBadge: 'Live creation status',
      refreshNote: 'This page updates automatically as Power Pages installs, creates, seeds, and activates the SPA template.',
    },
    template: {
      name: templateName,
      displayName: templateName,
      description: templateDescription || 'A packaged Power Pages SPA template with local source and cloud provisioning.',
      capabilities: [
        pluralSolutions ? 'Supporting solutions included' : 'Supporting solution included',
        'Local SPA source',
        'Power Pages code-site upload',
      ],
      requirements: [],
      warning: '',
      previews,
      catalog: {},
    },
    site: {
      name: templateName,
      url: '',
      language: { source: '', name: '', code: '', lcid: '' },
      websiteRecordId: '',
      modelVersion: 'SPA',
    },
    status: {
      key: 'solution',
      step: 0,
      chip: 'Installing',
      title: 'Installing template dependencies',
      message: pluralSolutions ? 'Installing supporting solutions.' : 'Installing the supporting solution.',
      activityState: 'working',
      terminal: false,
      result: null,
      error: false,
      openWebsiteUrl: null,
      footer: null,
      notification: null,
    },
    timeline: [
      [pluralSolutions ? 'Install supporting solutions' : 'Install supporting solution', 'Preparing Dataverse dependencies'],
      ['Create SPA site', 'Cloning, building, and uploading the packaged code site'],
      ['Apply seed data', 'Adding optional template records'],
      ['Activate site', 'Publishing the site address'],
    ],
    refresh: false,
    statusFeed: {
      url: statusUrl,
      intervalMs: 1500,
    },
  };
}

function renderTemplateImportStatus({
  templateName,
  templateDescription,
  statusPath,
  outputPath,
  previewImages = [],
  solutionCount = 1,
  open = false,
}, deps = {}) {
  if (!templateName || !statusPath || !outputPath) {
    throw new Error('Usage: render-template-import-status.js --templateName <name> --statusPath <path> --outputPath <path> [--templateDescription <description>] [--previewImagesJson <json>] [--solutionCount <count>] [--open]');
  }
  if (!Number.isSafeInteger(solutionCount) || solutionCount < 1) {
    throw new Error('solutionCount must be a positive integer');
  }
  const templatePath = path.join(
    __dirname,
    '..',
    'skills',
    'create-site',
    'assets',
    'non-spa-creation-status-template.html',
  );
  const model = buildModel({ templateName, templateDescription, statusPath, outputPath, previewImages, solutionCount });
  // Unlike the standalone non-SPA page, SPA import is served over HTTP and polls
  // a same-origin JSON feed. Allow its local images/feed plus only the explicit
  // remote preview origins, while retaining default-src 'none' and nonce scripts.
  // https://www.w3.org/TR/CSP3/#directive-connect-src
  const imageOrigins = [...new Set(model.template.previews
    .filter(({ desktop }) => /^https?:\/\//i.test(desktop))
    .map(({ desktop }) => new URL(desktop).origin))];
  renderTemplate({
    templatePath,
    outputPath,
    dataObject: {
      MODEL: model,
      CSP_IMAGE_SOURCES: ["'self'", 'data:', ...imageOrigins].join(' '),
      CSP_CONNECT_SOURCES: "'self'",
    },
    requiredKeys: ['MODEL', 'CSP_IMAGE_SOURCES', 'CSP_CONNECT_SOURCES'],
    emitStatus: false,
    copyIcon: false,
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

module.exports = {
  buildModel,
  localizePreviewImages,
  parseArgs,
  renderTemplateImportStatus,
};
