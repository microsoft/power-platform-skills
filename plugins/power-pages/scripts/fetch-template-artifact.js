#!/usr/bin/env node
'use strict';

const { pathToFileURL } = require('url');
const { downloadArtifact, DEFAULT_OWNER, DEFAULT_REPO } = require('./lib/template-catalog');
const { parseTemplateRepoArgs, runBestEffortJsonCli } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --sha <40-char commit sha> --artifactPath templates/spa/<id>/previews/home.png
//   [--owner microsoft] [--repo power-pages-samples] [--cacheRoot /tmp/cache]
// The script is best-effort: it prints `{ ok:false }` instead of throwing so
// create-site can keep the template browser usable even when a preview image is missing.
function parseArgs(argv) {
  return {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    ...parseTemplateRepoArgs(argv, '--artifactPath'),
  };
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.sha || !args.artifactPath) {
    return { ok: false, error: 'Usage: fetch-template-artifact.js --sha <sha> --artifactPath <path>' };
  }
  try {
    const result = await downloadArtifact(args);
    return { ok: true, ...result, localUrl: pathToFileURL(result.localPath).href };
  } catch (err) {
    return { ok: false, artifactPath: args.artifactPath, error: err.message };
  }
}

if (require.main === module) {
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run };
