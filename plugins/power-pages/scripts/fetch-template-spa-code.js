#!/usr/bin/env node
'use strict';

const { downloadSpaCodeDirectory, DEFAULT_OWNER, DEFAULT_REPO } = require('./lib/template-catalog');
const { parseTemplateRepoArgs, runBestEffortJsonCli } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --sha <40-char commit sha> --spaCodePath templates/spa/<id>/variants/<framework>/spa-code
//   [--owner microsoft] [--repo power-pages-samples] [--cacheRoot /tmp/cache]
function parseArgs(argv) {
  const parsed = parseTemplateRepoArgs(argv, '--spaCodePath');
  const { artifactPath: spaCodePath, ...repoArgs } = parsed;
  return {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    ...repoArgs,
    spaCodePath,
  };
}

function run(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (!args.sha || !args.spaCodePath) {
    return { ok: false, error: 'Usage: fetch-template-spa-code.js --sha <sha> --spaCodePath <path>' };
  }
  return downloadSpaCodeDirectory(args, deps);
}

if (require.main === module) {
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run };
