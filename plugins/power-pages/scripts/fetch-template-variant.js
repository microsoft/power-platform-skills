#!/usr/bin/env node
'use strict';

const { downloadTemplateVariant, DEFAULT_OWNER, DEFAULT_REPO } = require('./lib/template-catalog');
const { parseTemplateRepoArgs, runBestEffortJsonCli } = require('./lib/template-cli-args');

function parseArgs(argv) {
  const solutionArgs = parseTemplateRepoArgs(argv, '--solutionPath');
  const websiteCodeArgs = parseTemplateRepoArgs(argv, '--websiteCodePath');
  const { artifactPath: solutionPath, ...repoArgs } = solutionArgs;
  const kindIndex = argv.indexOf('--kind');
  return {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    ...repoArgs,
    solutionPath,
    websiteCodePath: websiteCodeArgs.artifactPath,
    kind: kindIndex >= 0 ? argv[kindIndex + 1] : undefined,
  };
}

function run(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (!args.sha || !args.solutionPath || !args.websiteCodePath || !args.kind) {
    return {
      ok: false,
      error: 'Usage: fetch-template-variant.js --sha <sha> --kind <spa|traditional> --solutionPath <path> --websiteCodePath <path>',
    };
  }
  return downloadTemplateVariant(args, deps);
}

if (require.main === module) {
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run };
