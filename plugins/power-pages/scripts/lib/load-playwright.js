// Resolves a Playwright library for browser scripts, without installing anything into the project.
//
// The plugin ships no node_modules (marketplace installs copy only the plugin directory).
// Scripts first borrow the site project's own `playwright` dev dependency. When there is
// no project, or it has none - a design review of a live URL, or a folder the plugin must
// not modify - they borrow the Playwright inside the exact @playwright/mcp version the
// plugin's MCP launcher already runs, so no new or unpinned package is ever fetched. That
// package lives in npm's own cache (not the project); when the MCP server has never run on
// this machine, npm downloads it there on first use, exactly as the launcher would.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { PLAYWRIGHT_MCP_PACKAGE, resolveNpxCli } = require('./playwright-mcp-package');

function loadProjectPlaywright(projectRoot, { requireFn = require } = {}) {
  // require() treats a relative path without a leading "./" as a package name, so a
  // relative --project-root such as "My Site" would never resolve. Anchor it to the cwd.
  const root = path.resolve(projectRoot);
  const candidates = [
    'playwright',
    path.join(root, 'node_modules', 'playwright'),
    'playwright-core',
    path.join(root, 'node_modules', 'playwright-core'),
  ];
  for (const candidate of candidates) {
    try {
      return requireFn(candidate);
    } catch {
      // Try the next location.
    }
  }
  return null;
}

// `npm exec --package=<spec> -c <command>` installs the pinned package into npm's npx cache
// (the same install the MCP launcher uses) and runs <command> with that install's
// node_modules/.bin first on PATH. Printing PATH reveals the install directory:
//   /Users/me/.npm/_npx/a5b920f00216d246/node_modules/.bin:/usr/local/bin:...
//   C:\Users\me\AppData\Local\npm-cache\_npx\a5b920f00216d246\node_modules\.bin;C:\Windows\...
// npm runs -c through its own shell (sh or cmd), so the command is a fixed string that needs
// no quoting on either. Lifecycle scripts stay disabled, as in the launcher.
function findPinnedNodeModules({
  spawnSyncFn = spawnSync,
  resolveNpxCliFn = resolveNpxCli,
  delimiter = path.delimiter,
} = {}) {
  const result = spawnSyncFn(
    process.execPath,
    [resolveNpxCliFn(), '--yes', '--ignore-scripts', `--package=${PLAYWRIGHT_MCP_PACKAGE}`, '-c', 'node -p process.env.PATH'],
    { encoding: 'utf8', shell: false, timeout: 180000 },
  );
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

function loadPinnedPlaywright({ requireFn = require, ...options } = {}) {
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

// Project first, so a site's own Playwright version wins; the pinned package otherwise.
function loadPlaywright(projectRoot, options = {}) {
  return (projectRoot && loadProjectPlaywright(projectRoot, options)) || loadPinnedPlaywright(options);
}

module.exports = {
  findPinnedNodeModules,
  loadPinnedPlaywright,
  loadPlaywright,
  loadProjectPlaywright,
};
