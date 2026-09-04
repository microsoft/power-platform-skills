#!/usr/bin/env node
'use strict';

const { fetchCatalog, DEFAULT_OWNER, DEFAULT_REPO, DEFAULT_REF, DEFAULT_CATALOG_PATH } = require('./lib/template-catalog');
const { parseTemplateRepoArgs, runBestEffortJsonCli } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --owner microsoft --repo power-pages-samples --ref latest-release
//   --catalogPath templates/manifest.json --cacheRoot /tmp/powerpages-templates
// `--ref` defaults to `latest-release`, which resolves GitHub's latest Release
// tag and then pins that tag to an immutable commit SHA for the run.
// All flags are optional; unknown flags are ignored so future callers can add
// wrapper-only options without breaking the best-effort catalog fetch.
function parseArgs(argv) {
  return {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    ref: DEFAULT_REF,
    catalogPath: DEFAULT_CATALOG_PATH,
    ...parseTemplateRepoArgs(argv),
  };
}

async function run(argv = process.argv.slice(2)) {
  return fetchCatalog(parseArgs(argv));
}

if (require.main === module) {
  // Fetching templates is additive. Return process success even when the repo is
  // unavailable so create-site can inspect `{ ok:false }` and fall back to the
  // from-scratch path without treating the whole skill invocation as failed.
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run };
