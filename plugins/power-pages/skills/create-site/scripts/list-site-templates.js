#!/usr/bin/env node

// Discovers non-SPA Create Website templates from the release-pinned public
// samples catalog. The environment EDM toggle remains administrator-confirmed
// because Microsoft does not publish a supported API for reading it.

const {
  BOOTSTRAP_5_DOCUMENTATION_URL,
  BOOTSTRAP_5_TEMPLATE_NAMES,
  normalizeBootstrapVersion,
  parseBootstrapVersionArgs,
  normalizeNonSpaModelVersion,
} = require('../../../scripts/lib/site-templates');
const {
  fetchCatalog,
  isCreateWebsiteApiTemplate,
} = require('../../../scripts/lib/template-catalog');
const {
  normalizeNonSpaTemplate,
} = require('../../../scripts/lib/non-spa-template-catalog');

function parseArgs(argv) {
  const values = new Set(argv);
  const modelIndex = argv.findIndex(
    (value) => value === '--modelVersion' || value === '--model-version'
  );
  return {
    administratorConfirmed:
      values.has('--administratorConfirmed') || values.has('--administrator-confirmed'),
    modelVersion: modelIndex >= 0 ? argv[modelIndex + 1] : null,
    bootstrapVersion: parseBootstrapVersionArgs(argv) ?? null,
  };
}

function buildResult({
  administratorConfirmed = false,
  modelVersion,
  bootstrapVersion = null,
  catalogResult,
} = {}) {
  const selectedModel = normalizeNonSpaModelVersion(modelVersion);
  const selectedBootstrap = bootstrapVersion === null ? null : normalizeBootstrapVersion(bootstrapVersion);
  if (selectedModel !== 'Enhanced' || selectedBootstrap !== 5) {
    throw new Error(
      'New non-SPA site creation supports only --modelVersion Enhanced with --bootstrapVersion 5',
    );
  }
  if (!catalogResult?.ok) {
    throw new Error(`Non-SPA template catalog unavailable: ${catalogResult?.error || 'unknown error'}`);
  }
  const requiredToggleState = 'enabled';
  const discoveredTemplates = catalogResult.catalog.templates
    .filter(isCreateWebsiteApiTemplate)
    .map((template) => normalizeNonSpaTemplate(template, catalogResult));
  const templates = selectedBootstrap === 5
    ? discoveredTemplates.filter((template) => BOOTSTRAP_5_TEMPLATE_NAMES.includes(template.name))
    : discoveredTemplates;
  if (templates.length === 0) {
    throw new Error('Non-SPA template catalog contains no templates for the selected creation path');
  }
  return {
    modelVersion: selectedModel,
    bootstrapVersion: selectedBootstrap,
    capability: administratorConfirmed
      ? {
          status: 'confirmed',
          source: 'administrator-confirmation',
          requiredToggleState,
          reason:
            `An environment administrator confirmed that Switch to enhanced data model is ` +
            `${requiredToggleState} for ${selectedModel} site creation.`,
        }
      : {
          status: 'indeterminate',
          source: 'public-api-unavailable',
          requiredToggleState,
          reason:
            'No documented public API reads the environment-level EDM creation toggle. ' +
            `An environment administrator must verify it is ${requiredToggleState} for ` +
            `${selectedModel} site creation.`,
        },
    catalog: {
      source: 'power-pages-samples',
      environmentSpecific: false,
      owner: catalogResult.owner,
      repo: catalogResult.repo,
      requestedRef: catalogResult.ref,
      resolvedRef: catalogResult.resolvedRef,
      commitSha: catalogResult.sha,
      releaseName: catalogResult.releaseName || null,
      releaseUrl: catalogResult.releaseUrl || null,
      templates: templates.map((template) => ({ ...template })),
      ...(selectedBootstrap === 5 ? {
        bootstrapCompatibility: {
          source: BOOTSTRAP_5_DOCUMENTATION_URL,
          omittedTemplateNames: discoveredTemplates
            .filter((template) => !BOOTSTRAP_5_TEMPLATE_NAMES.includes(template.name))
            .map((template) => template.name),
          reason:
            'Only existing catalog entries in documented new Bootstrap 5 template families are included. ' +
            'Administrator confirmation covers the Enhanced data model toggle, not the downloaded ' +
            'Bootstrap assets; validate their version after download.',
        },
      } : {}),
    },
  };
}

async function run(argv = process.argv.slice(2), deps = {}) {
  const catalogResult = await (deps.fetchCatalog || fetchCatalog)();
  return buildResult({ ...parseArgs(argv), catalogResult });
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await run(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  normalizeModelVersion: normalizeNonSpaModelVersion,
  normalizeNonSpaTemplate,
  buildResult,
  run,
};
