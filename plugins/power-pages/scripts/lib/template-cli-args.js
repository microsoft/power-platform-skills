'use strict';

function parseTemplateRepoArgs(argv, pathFlagName) {
  // Shared parser for argv arrays shaped like:
  //   ['--owner','microsoft','--repo','power-pages-samples','--ref','main',
  //    '--sha','<40-char sha>','--cacheRoot','/tmp/cache',
  //    '--solutionPath','templates/spa/<id>/solution']
  // `pathFlagName` lets callers map a domain-specific path flag (for example
  // `--solutionPath`) to the shared `artifactPath` option used by the cache.
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--owner') args.owner = argv[++i];
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--ref') args.ref = argv[++i];
    else if (arg === '--sha') args.sha = argv[++i];
    else if (arg === '--cacheRoot') args.cacheRoot = argv[++i];
    else if (arg === pathFlagName) args.artifactPath = argv[++i];
    else if (arg === '--catalogPath') args.catalogPath = argv[++i];
  }
  return args;
}

function formatJsonResult(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

async function runBestEffortJsonCli(handler, deps = {}) {
  const proc = deps.process || process;
  const stdout = deps.stdout || process.stdout;
  try {
    stdout.write(formatJsonResult(await handler()));
  } catch (err) {
    stdout.write(formatJsonResult({ ok: false, error: err.message }));
  }
  proc.exit(0);
}

module.exports = { parseTemplateRepoArgs, formatJsonResult, runBestEffortJsonCli };
