#!/usr/bin/env node
'use strict';

const { downloadTemplateVariant, DEFAULT_OWNER, DEFAULT_REPO } = require('./lib/template-catalog');
const { parseTemplateRepoArgs, runBestEffortJsonCli } = require('./lib/template-cli-args');

function parseArgs(argv) {
  const repoArgs = parseTemplateRepoArgs(argv);
  const kindIndex = argv.indexOf('--kind');
  const templateIdIndex = argv.indexOf('--templateId');
  const variantIndex = argv.indexOf('--variant');
  const solutionSettingsIndex = argv.indexOf('--solutionSettingsJson');
  let solutionSettings = [];
  let solutionSettingsError;
  if (solutionSettingsIndex >= 0) {
    try {
      solutionSettings = JSON.parse(argv[solutionSettingsIndex + 1]);
    } catch {
      solutionSettings = null;
      solutionSettingsError = '--solutionSettingsJson must be valid JSON';
    }
  }
  return {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    ...repoArgs,
    kind: kindIndex >= 0 ? argv[kindIndex + 1] : undefined,
    templateId: templateIdIndex >= 0 ? argv[templateIdIndex + 1] : undefined,
    variant: variantIndex >= 0 ? argv[variantIndex + 1] : undefined,
    solutionSettings,
    ...(solutionSettingsError ? { solutionSettingsError } : {}),
  };
}

function run(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const validSolutionSettings = Array.isArray(args.solutionSettings) &&
    args.solutionSettings.every(solution =>
      solution &&
      typeof solution === 'object' &&
      !Array.isArray(solution) &&
      typeof solution.uniqueName === 'string' &&
      typeof solution.publishChanges === 'boolean'
    );
  if (!args.sha || !args.kind || !args.templateId || !args.variant || !validSolutionSettings) {
    return {
      ok: false,
      error: args.solutionSettingsError ||
        'Usage: fetch-template-variant.js --sha <sha> --kind <spa|traditional> --templateId <id> --variant <name> [--solutionSettingsJson <json-array>]',
    };
  }
  return downloadTemplateVariant(args, deps);
}

if (require.main === module) {
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run };
