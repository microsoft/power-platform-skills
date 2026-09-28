#!/usr/bin/env node
'use strict';

const { downloadTemplateVariant, DEFAULT_OWNER, DEFAULT_REPO } = require('./lib/template-catalog');
const { parseTemplateRepoArgs, runBestEffortJsonCli } = require('./lib/template-cli-args');

function parseArgs(argv) {
  const repoArgs = parseTemplateRepoArgs(argv);
  const kindIndex = argv.indexOf('--kind');
  const templateIdIndex = argv.indexOf('--templateId');
  const variantIndex = argv.indexOf('--variant');
  return {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    ...repoArgs,
    kind: kindIndex >= 0 ? argv[kindIndex + 1] : undefined,
    templateId: templateIdIndex >= 0 ? argv[templateIdIndex + 1] : undefined,
    variant: variantIndex >= 0 ? argv[variantIndex + 1] : undefined,
  };
}

function run(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (!args.sha || !args.kind || !args.templateId || !args.variant) {
    return {
      ok: false,
      error: 'Usage: fetch-template-variant.js --sha <sha> --kind <spa|traditional> --templateId <id> --variant <name>',
    };
  }
  return downloadTemplateVariant(args, deps);
}

if (require.main === module) {
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run };
