#!/usr/bin/env node
'use strict';

const { downloadSolutionArtifact, DEFAULT_OWNER, DEFAULT_REPO } = require('./lib/template-catalog');
const { parseTemplateRepoArgs, runBestEffortJsonCli } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --sha <40-char commit sha> --solutionPath templates/spa/<id>/solution/<zip>
//   [--owner microsoft] [--repo power-pages-samples] [--cacheRoot /tmp/cache]
// `solutionPath` is mapped to the shared helper's `artifactPath` name because
// later template artifact downloads can reuse the same cache mechanics.
function parseArgs(argv) {
  return {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    ...parseTemplateRepoArgs(argv, '--solutionPath'),
  };
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.sha || !args.artifactPath) {
    return { ok: false, error: 'Usage: fetch-template-solution.js --sha <sha> --solutionPath <path>' };
  }
  return downloadSolutionArtifact(args);
}

if (require.main === module) {
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run };
