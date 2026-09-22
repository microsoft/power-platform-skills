#!/usr/bin/env node
'use strict';

const { downloadSeedDataDirectory, DEFAULT_OWNER, DEFAULT_REPO } = require('./lib/template-catalog');
const { parseTemplateRepoArgs, runBestEffortJsonCli } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --sha <40-char commit sha> --seedDataPath templates/spa/<id>/seed/data.json
//   [--owner microsoft] [--repo power-pages-samples] [--cacheRoot /tmp/cache]
// The seed JSON file is downloaded directly from the pinned SHA. Any attachment
// files referenced by `__files` are downloaded from paths relative to that seed
// JSON file, avoiding GitHub REST tree API rate limits.
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
