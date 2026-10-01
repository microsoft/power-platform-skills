'use strict';

// Resolves (and optionally installs) the two runtime dependencies of the
// accessibility audit: playwright-core (browser automation) and axe-core (rules).
//
// Why a private dependency directory instead of the site's own package.json:
// - The audit must work against a deployed URL with no local project at all.
// - Installing into a user's project would change their lockfile as a side effect
//   of "just checking accessibility".
// - Marketplace installs copy only the plugin directory and never run `npm install`,
//   so the plugin cannot ship node_modules.
//
// Why playwright-core rather than playwright: it has no postinstall browser download.
// The audit drives the system Edge/Chrome via detect-browser.js (same as the
// Playwright MCP launcher), so the bundled Chromium is never needed.
//
// Why a local axe-core file instead of the CDN used by create-site's axe-audit.js:
// deployed Power Pages sites commonly send a Content-Security-Policy (see
// /manage-headers) that blocks third-party script origins, and offline or locked-down
// networks cannot reach cdnjs at all.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The committed runtime/package.json + package-lock.json are the integrity record for
// these packages (AGENTS.md "Runtime dependencies"): installDeps copies both into the
// cache and runs `npm ci`, which refuses any tarball whose sha512 differs from the lock.
// PINNED is read from that manifest so the version check and the lock cannot drift.
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const RUNTIME_FILES = ['package.json', 'package-lock.json'];
const PINNED = Object.freeze({
  ...JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'package.json'), 'utf8')).dependencies,
});

const DEPS_DIR_ENV = 'POWER_PAGES_A11Y_DEPS_DIR';

class MissingDependencyError extends Error {}

// A per-user cache keyed by the pinned versions, so bumping a pin installs side by
// side instead of mutating a directory another session may be using.
function cacheDepsDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  let base;
  if (platform === 'win32') {
    base = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
  } else if (platform === 'darwin') {
    base = path.join(homedir, 'Library', 'Caches');
  } else {
    base = env.XDG_CACHE_HOME || path.join(homedir, '.cache');
  }
  const key = `a11y-pw${PINNED['playwright-core']}-axe${PINNED['axe-core']}`;
  return path.join(base, 'power-platform-skills', 'power-pages', key);
}

function defaultDepsDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env[DEPS_DIR_ENV]) return path.resolve(env[DEPS_DIR_ENV]);
  return cacheDepsDir({ env, platform, homedir });
}

// Resolution order: explicit --deps-dir, then the locked default cache. The user's
// project node_modules is deliberately NOT a fallback: its Playwright is unlocked from
// the plugin's point of view and may predate APIs the audit relies on (ariaSnapshot
// needs >= 1.49), and plugin code must not resolve dependencies from process.cwd().
function candidateRoots({ depsDir, env = process.env } = {}) {
  const roots = [];
  if (depsDir) roots.push(path.resolve(depsDir));
  roots.push(defaultDepsDir({ env }));
  return [...new Set(roots)];
}

function tryResolve(request, roots, resolveFn) {
  for (const root of roots) {
    try {
      return { resolved: resolveFn(request, { paths: [root] }), root };
    } catch {
      // Not present under this root — try the next one.
    }
  }
  return null;
}

function installHint() {
  const installer = path.resolve(__dirname, '..', '..', 'install-a11y-deps.js');
  return `Run: node "${installer}" (installs pinned playwright-core and axe-core into a private cache)`;
}

function loadPlaywright(roots, { resolveFn = require.resolve, requireFn = require } = {}) {
  // Accept a project's full `playwright` package too; both export the same chromium API.
  for (const name of ['playwright-core', 'playwright']) {
    const hit = tryResolve(name, roots, resolveFn);
    if (hit) {
      const mod = requireFn(hit.resolved);
      if (mod && mod.chromium) return { chromium: mod.chromium, source: hit.root, packageName: name };
    }
  }
  throw new MissingDependencyError(`playwright-core was not found. ${installHint()}`);
}

function loadAxeSource(roots, { resolveFn = require.resolve, readFile = fs.readFileSync } = {}) {
  const hit = tryResolve('axe-core/axe.min.js', roots, resolveFn);
  if (!hit) throw new MissingDependencyError(`axe-core was not found. ${installHint()}`);
  return { source: readFile(hit.resolved, 'utf8'), from: hit.root };
}

function installedVersion(depsDir, name, { readFile = fs.readFileSync } = {}) {
  try {
    return JSON.parse(readFile(path.join(depsDir, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function isInstalled(depsDir, opts) {
  return Object.entries(PINNED).every(([name, version]) => installedVersion(depsDir, name, opts) === version);
}

// npm ships a JS entry point beside npx-cli.js. Reuse the MCP launcher's lookup so
// both scripts agree on where npm lives, then run it through process.execPath: the
// Windows npm.cmd shim cannot be spawned with shell:false.
function resolveNpmCli(resolveNpxCliFn) {
  const resolveNpx = resolveNpxCliFn || require('../../launch-playwright-mcp').resolveNpxCli;
  return path.join(path.dirname(resolveNpx()), 'npm-cli.js');
}

// Written into every directory installDeps prepares. installDeps overwrites
// package.json and package-lock.json and `npm ci` deletes node_modules, so a
// --deps-dir (or POWER_PAGES_A11Y_DEPS_DIR) that points at an existing project would
// lose its package setup. Only directories that are new, empty, the built-in cache,
// or carry this marker are ever written to.
const MANAGED_MARKER = '.power-pages-a11y-deps';

class UnmanagedDepsDirError extends Error {}

function assertManagedDepsDir(depsDir, { env = process.env, readdir = fs.readdirSync } = {}) {
  if (path.resolve(depsDir) === cacheDepsDir({ env })) return;
  let entries;
  try {
    entries = readdir(depsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (entries.length === 0 || entries.includes(MANAGED_MARKER)) return;
  throw new UnmanagedDepsDirError(
    `Refusing to install into ${depsDir}: it isn't empty and wasn't created by install-a11y-deps.js. `
    + 'Choose a new or empty directory, or omit --deps-dir to use the default cache.',
  );
}

function installDeps({
  depsDir = defaultDepsDir(),
  npmCliPath,
  env = process.env,
  spawnSyncFn = spawnSync,
  mkdir = fs.mkdirSync,
  copyFile = fs.copyFileSync,
  readFile = fs.readFileSync,
  readdir = fs.readdirSync,
  writeFile = fs.writeFileSync,
} = {}) {
  if (isInstalled(depsDir, { readFile })) return { depsDir, installed: false, versions: { ...PINNED } };

  assertManagedDepsDir(depsDir, { env, readdir });
  mkdir(depsDir, { recursive: true });
  writeFile(path.join(depsDir, MANAGED_MARKER), 'Created by power-pages install-a11y-deps.js. Safe to delete with this folder.\n');
  // Always overwrite with the committed manifest + lock: `npm ci` installs exactly
  // what the lock says (verifying each sha512) and fails if the two disagree. The
  // private package.json also stops npm walking up into an ancestor project.
  for (const name of RUNTIME_FILES) {
    copyFile(path.join(RUNTIME_DIR, name), path.join(depsDir, name));
  }

  const npmCli = npmCliPath || resolveNpmCli();
  // --ignore-scripts: never run third-party lifecycle scripts on the user's machine.
  // Neither pinned package needs them (playwright-core does not download browsers).
  // Lock URLs point at registry.npmjs.org; npm's default replace-registry-host
  // setting rewrites them to a user's configured mirror, and the integrity check
  // still applies to whatever the mirror returns.
  const result = spawnSyncFn(process.execPath, [
    npmCli, 'ci', '--prefix', depsDir, '--ignore-scripts', '--no-audit', '--no-fund',
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: false });

  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : (result.stderr || '').trim().split('\n').slice(-5).join('\n');
    throw new Error(`npm ci failed (exit ${result.status}): ${detail}`);
  }
  if (!isInstalled(depsDir, { readFile })) {
    throw new Error(`npm ci completed but pinned versions were not found in ${depsDir}`);
  }
  return { depsDir, installed: true, versions: { ...PINNED } };
}

// Uses the system Edge/Chrome (same detection as the Playwright MCP launcher).
// detectBrowser() falls back to 'chromium' when neither is found; playwright-core
// has no bundled Chromium, so turn Playwright's long "Executable doesn't exist"
// message into an actionable one.
async function launchBrowser(chromium, { headless = true, detect } = {}) {
  const channel = (detect || require('../detect-browser').detectBrowser)();
  try {
    return await chromium.launch(channel === 'chromium' ? { headless } : { channel, headless });
  } catch (err) {
    if (channel === 'chromium' || /executable doesn't exist|not found|ENOENT/i.test(err.message)) {
      throw new MissingDependencyError(`No supported browser found (tried "${channel}"). Install Microsoft Edge or Google Chrome and try again.`);
    }
    throw err;
  }
}

module.exports = {
  DEPS_DIR_ENV,
  MANAGED_MARKER,
  MissingDependencyError,
  PINNED,
  RUNTIME_DIR,
  UnmanagedDepsDirError,
  assertManagedDepsDir,
  cacheDepsDir,
  candidateRoots,
  defaultDepsDir,
  installDeps,
  installedVersion,
  isInstalled,
  launchBrowser,
  loadAxeSource,
  loadPlaywright,
  resolveNpmCli,
};
