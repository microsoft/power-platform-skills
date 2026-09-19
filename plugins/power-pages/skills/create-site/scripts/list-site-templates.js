#!/usr/bin/env node

// Returns the curated declarative templates used by the current creation experience.
// Microsoft does not currently publish an environment template-catalog API or
// an API that reads the environment-level EDM creation toggle, so this helper
// labels both limitations explicitly instead of presenting the list as live data.

const {
  DECLARATIVE_SITE_TEMPLATES,
  normalizeDeclarativeModelVersion,
} = require('../../../scripts/lib/site-templates');

function parseArgs(argv) {
  const values = new Set(argv);
  const modelIndex = argv.findIndex(
    (value) => value === '--modelVersion' || value === '--model-version'
  );
  return {
    administratorConfirmed:
      values.has('--administratorConfirmed') || values.has('--administrator-confirmed'),
    modelVersion: modelIndex >= 0 ? argv[modelIndex + 1] : null,
  };
}

function buildResult({ administratorConfirmed = false, modelVersion } = {}) {
  const selectedModel = normalizeDeclarativeModelVersion(modelVersion);
  const requiredToggleState = selectedModel === 'Enhanced' ? 'enabled' : 'disabled';
  return {
    modelVersion: selectedModel,
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
      source: 'plugin-declarative-template-allowlist',
      environmentSpecific: false,
      templates: DECLARATIVE_SITE_TEMPLATES.map((template) => ({ ...template })),
    },
  };
}

function main() {
  try {
    process.stdout.write(
      `${JSON.stringify(buildResult(parseArgs(process.argv.slice(2))), null, 2)}\n`
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DECLARATIVE_SITE_TEMPLATES,
  parseArgs,
  normalizeModelVersion: normalizeDeclarativeModelVersion,
  buildResult,
};
