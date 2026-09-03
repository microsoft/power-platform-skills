#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { detectBrowserLaunchOptions } = require('./lib/detect-browser');
const {
  MANIFEST_NAME,
  validateLocalizationManifestShape,
} = require('./lib/localization-config');
const {
  runRenderedBidirectionalAudit,
} = require('./lib/rendered-bidirectional-readiness');

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url' && argv[index + 1]) parsed.url = argv[++index];
    else if (arg === '--projectRoot' && argv[index + 1]) {
      parsed.projectRoot = path.resolve(argv[++index]);
    } else if (arg === '--spec' && argv[index + 1]) {
      parsed.specPath = path.resolve(argv[++index]);
    } else if (arg === '--spec-inline' && argv[index + 1]) {
      parsed.specInline = argv[++index];
    } else if (arg === '--evidence-dir' && argv[index + 1]) {
      parsed.evidenceDir = path.resolve(argv[++index]);
    } else if (arg === '--output' && argv[index + 1]) {
      parsed.output = path.resolve(argv[++index]);
    }
  }
  if (!parsed.url || !parsed.projectRoot ||
      (!parsed.specPath && !parsed.specInline) ||
      (parsed.specPath && parsed.specInline)) {
    throw new Error(
      'Usage: audit-rendered-bidirectional-readiness.js --url <base-url> ' +
      '--projectRoot <path> (--spec <json-file> | --spec-inline <json>) ' +
      '[--evidence-dir <path>] [--output <report-json>]'
    );
  }
  return parsed;
}

function loadPlaywright(projectRoot) {
  const modulePaths = [
    'playwright',
    path.join(projectRoot, 'node_modules', 'playwright'),
    'playwright-core',
    path.join(projectRoot, 'node_modules', 'playwright-core'),
  ];
  for (const modulePath of modulePaths) {
    try {
      return require(modulePath);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('playwright not found. Run: npm install --save-dev playwright');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = JSON.parse(
    args.specInline ?? fs.readFileSync(args.specPath, 'utf8')
  );
  const manifestPath = path.join(args.projectRoot, MANIFEST_NAME);
  let localizationContext = null;
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifestErrors = validateLocalizationManifestShape(manifest);
    if (manifestErrors.length > 0) {
      throw new Error(
        `${MANIFEST_NAME} is invalid:\n- ${manifestErrors.join('\n- ')}`
      );
    }
    localizationContext = {
      locales: manifest.locales,
      defaultLocale: manifest.defaultLocale,
      mode: manifest.mode,
      unavailableLocales: Array.isArray(manifest.unavailableLocales)
        ? manifest.unavailableLocales
        : [],
    };
  } else if (spec.runtimeSwitching === true) {
    throw new Error(
      `${MANIFEST_NAME} is required when runtimeSwitching is enabled.`
    );
  }
  const { chromium } = loadPlaywright(args.projectRoot);
  const result = await runRenderedBidirectionalAudit({
    url: args.url,
    spec,
    chromium,
    localizationContext,
    browserLaunchOptions: detectBrowserLaunchOptions(),
    evidenceDir: args.evidenceDir,
  });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, json);
  }
  process.stdout.write(json);
  process.exitCode = result.summary.errors > 0 ? 1 : 0;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  loadPlaywright,
  parseArgs,
};
