// Resolves the Playwright library the browser review scripts use, without installing anything
// into a project.
//
// There is exactly one source: the Playwright inside the exact @playwright/mcp version the
// plugin's MCP launcher runs (scripts/lib/playwright-mcp-package.js), kept in npm's own cache.
// A project's node_modules is never loaded: requiring a module from it runs that project's
// code, which a design review of someone else's site must not do, and the version pin is what
// the runtime-dependency rule in AGENTS.md requires.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { PLAYWRIGHT_MCP_PACKAGE, resolveNpxCli } = require('./playwright-mcp-package');
const { createPrivateTempDir, removeDir } = require('./private-temp-dir');

const NPM_WORKDIR_PREFIX = 'power-pages-npm-';

// `npm exec --package=<spec> -c <command>` installs the pinned package into npm's npx cache
// (the same install the MCP launcher uses) and runs <command> with that install's
// node_modules/.bin first on PATH. Printing PATH reveals the install directory:
//   /Users/me/.npm/_npx/a5b920f00216d246/node_modules/.bin:/usr/local/bin:...
//   C:\Users\me\AppData\Local\npm-cache\_npx\a5b920f00216d246\node_modules\.bin;C:\Windows\...
// npm runs -c through its own shell (sh or cmd), so the command is a fixed string that needs
// no quoting on either. Lifecycle scripts stay disabled, as in the launcher.
//
// npm runs in a fresh, empty private directory that is also its --prefix. Run from the agent's
// working directory - often the project being reviewed - npm would read that project's
// .npmrc (which can replace the shell, the registry, or the package), put its
// node_modules/.bin on PATH, and on Windows let cmd.exe find a `node` in that folder first.
function findPinnedNodeModules({
  spawnSyncFn = spawnSync,
  resolveNpxCliFn = resolveNpxCli,
  delimiter = path.delimiter,
  makeWorkDir = () => createPrivateTempDir(NPM_WORKDIR_PREFIX),
  removeWorkDir = removeDir,
} = {}) {
  const workDir = makeWorkDir();
  let result;
  try {
    result = spawnSyncFn(
      process.execPath,
      [resolveNpxCliFn(), '--yes', '--ignore-scripts', `--prefix=${workDir}`, `--package=${PLAYWRIGHT_MCP_PACKAGE}`, '-c', 'node -p process.env.PATH'],
      { cwd: workDir, encoding: 'utf8', shell: false, timeout: 180000 },
    );
  } finally {
    removeWorkDir(workDir);
  }
  if (!result || result.status !== 0 || !result.stdout) {
    return null;
  }
  const bin = result.stdout
    .trim()
    .split(delimiter)
    .map((entry) => entry.trim())
    .find((entry) => /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]\.bin$/.test(entry));
  return bin ? bin.replace(/[\\/]\.bin$/, '') : null;
}

function loadPlaywright({ requireFn = require, ...options } = {}) {
  let nodeModules;
  try {
    nodeModules = findPinnedNodeModules(options);
  } catch {
    return null;
  }
  if (!nodeModules) {
    return null;
  }
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return requireFn(path.join(nodeModules, name));
    } catch {
      // Try the next package.
    }
  }
  return null;
}

module.exports = {
  NPM_WORKDIR_PREFIX,
  findPinnedNodeModules,
  loadPlaywright,
};
