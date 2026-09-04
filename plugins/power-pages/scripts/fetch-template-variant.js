#!/usr/bin/env node
'use strict';

const { downloadTemplateVariant, DEFAULT_OWNER, DEFAULT_REPO } = require('./lib/template-catalog');
const { parseTemplateRepoArgs, runBestEffortJsonCli } = require('./lib/template-cli-args');

function parseArgs(argv) {
  const solutionArgs = parseTemplateRepoArgs(argv, '--solutionPath');
  const spaCodeArgs = parseTemplateRepoArgs(argv, '--spaCodePath');
  const { artifactPath: solutionPath, ...repoArgs } = solutionArgs;
  return {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    ...repoArgs,
    solutionPath,
    spaCodePath: spaCodeArgs.artifactPath,
  };
}

function run(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (!args.sha || !args.solutionPath || !args.spaCodePath) {
    return {
      ok: false,
      error: 'Usage: fetch-template-variant.js --sha <sha> --solutionPath <path> --spaCodePath <path>',
    };
  }
  return downloadTemplateVariant(args, deps);
}

if (require.main === module) {
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run };
