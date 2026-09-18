#!/usr/bin/env node

// Returns the curated EDM templates used by the current creation experience.
// Microsoft does not currently publish an environment template-catalog API or
// an API that reads the environment-level EDM creation toggle, so this helper
// labels both limitations explicitly instead of presenting the list as live data.

const {
  EDM_SITE_TEMPLATES,
} = require('../../../scripts/lib/site-templates');

function parseArgs(argv) {
  const values = new Set(argv);
  return {
    administratorConfirmed:
      values.has('--administratorConfirmed') || values.has('--administrator-confirmed'),
  };
}

function buildResult({ administratorConfirmed = false } = {}) {
  return {
    capability: administratorConfirmed
      ? {
          status: 'enabled',
          source: 'administrator-confirmation',
          reason: 'An environment administrator confirmed that EDM site creation is enabled.',
        }
      : {
          status: 'indeterminate',
          source: 'public-api-unavailable',
          reason:
            'No documented public API reads the environment-level EDM creation toggle. ' +
            'An environment administrator must verify it in Power Platform admin center.',
        },
    catalog: {
      source: 'plugin-edm-template-allowlist',
      environmentSpecific: false,
      templates: EDM_SITE_TEMPLATES.map((template) => ({ ...template })),
    },
  };
}

function main() {
  process.stdout.write(`${JSON.stringify(buildResult(parseArgs(process.argv.slice(2))), null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { EDM_SITE_TEMPLATES, parseArgs, buildResult };
