#!/usr/bin/env node
'use strict';

const { downloadSeedDataDirectory, DEFAULT_OWNER, DEFAULT_REPO } = require('./lib/template-catalog');
const { parseTemplateRepoArgs, runBestEffortJsonCli } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --sha <40-char commit sha> --seedDataPath templates/spa/<id>/seed-data
//   [--owner microsoft] [--repo power-pages-samples] [--cacheRoot /tmp/cache]
// The directory is discovered from the pinned Git tree and each JSON seed file
// is downloaded into the same SHA-keyed cache used by other template artifacts.
function parseArgs(argv) {
  const args = {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    ...parseTemplateRepoArgs(argv),
  };
  const idx = argv.indexOf('--seedDataPath');
  if (idx !== -1) args.seedDataPath = argv[idx + 1];
  return args;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.sha || !args.seedDataPath) {
    return { ok: false, error: 'Usage: fetch-template-seed-data.js --sha <sha> --seedDataPath <path>' };
  }
  return downloadSeedDataDirectory(args);
}

if (require.main === module) {
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run };
