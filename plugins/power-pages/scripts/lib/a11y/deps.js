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
const { randomUUID } = require('node:crypto');
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

// The files the audit actually loads: loadPlaywright() resolves the playwright-core
// package entry ("main": "index.js") and loadAxeSource() reads axe-core/axe.min.js.
const ENTRY_FILES = Object.freeze({ 'playwright-core': 'index.js', 'axe-core': 'axe.min.js' });

// Matching package.json versions alone are not proof of a usable install: an
// interrupted `npm ci`, or antivirus quarantining a file, can leave the manifest in
// place with the entry file missing. installDeps() would then skip the reinstall and
// every audit would fail with "not found". Check both.
function isInstalled(depsDir, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  return Object.entries(PINNED).every(([name, version]) => installedVersion(depsDir, name, { readFile }) === version
    && (!ENTRY_FILES[name] || exists(path.join(depsDir, 'node_modules', name, ENTRY_FILES[name]))));
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

// The version-keyed cache is shared by every session on the machine, and `npm ci`
// deletes node_modules before it installs. Two first-time audits running at once would
// each wipe the other's half-finished install. A lock directory beside the deps folder
// serializes them: mkdir is atomic and fails with EEXIST if another process holds it.
//
// The holder writes owner.json ({ pid, host, token }) into the lock right after
// creating it. A lock's age alone doesn't prove its owner died (npm ci has no timeout
// and can be slow on a poor network), so a waiter reclaims a lock only when:
// - the owner is on this host and its PID no longer exists, or
// - owner.json never appeared and the lock is older than LOCK_STALE_MS (the process
//   died between mkdir and the write, which a live holder finishes in milliseconds).
// A lock from another host (a deps folder on a network share) is never reclaimed; the
// timeout message tells the user how to clear it. PID reuse after a crash can make a
// dead owner look alive, which only costs a wait until the timeout.
// Release removes the lock only while owner.json still carries this holder's token, so
// a holder can never delete a lock that another process now owns.
const INSTALL_LOCK_SUFFIX = '.install-lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_TIMEOUT_MS = 30 * 60 * 1000;
const LOCK_POLL_MS = 500;

// installDeps is synchronous (install-a11y-deps.js is a one-shot CLI), so wait with
// Atomics.wait rather than a busy loop.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// process.kill(pid, 0) sends no signal; it only checks the process exists. EPERM means
// it exists but belongs to another user, so it is alive.
// See: https://nodejs.org/api/process.html#processkillpid-signal
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLockOwner(lockPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, LOCK_OWNER_FILE), 'utf8'));
    return owner && typeof owner.token === 'string' ? owner : null;
  } catch {
    return null;
  }
}

// Returns the owner snapshot the decision was based on, so the reclaim compares against
// exactly that owner instead of re-reading owner.json (which may have changed since).
function checkAbandonedLock(lockPath, { now, staleMs, isAlive, host }) {
  const owner = readLockOwner(lockPath);
  if (owner) {
    return { abandoned: owner.host === host && Number.isInteger(owner.pid) && !isAlive(owner.pid), token: owner.token };
  }
  return { abandoned: now() - fs.statSync(lockPath).mtimeMs > staleMs, token: undefined };
}

// Reclaiming is rename-then-check, not a plain delete: two waiters can both decide the
// same dead lock is abandoned, and the slower one must not delete the lock the faster
// one has just created. rename is atomic, so only one waiter moves a given lock aside;
// if what it moved isn't the lock it judged dead, it puts it back.
// Returns true when the slot is free to retry now (reclaimed, or already gone), and
// false when the lock turned out not to be the dead one, so the caller waits instead
// of spinning.
function reclaimLock(lockPath, deadToken, token) {
  const aside = `${lockPath}.stale-${token}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  // An ownerless lock reads as null, so normalize to undefined to match deadToken.
  const moved = readLockOwner(aside);
  if ((moved ? moved.token : undefined) !== deadToken) {
    try {
      fs.renameSync(aside, lockPath);
      return false;
    } catch {
      // A new holder took the slot in between; leave the moved lock aside. Its owner's
      // release only removes lockPath while it carries that owner's token.
      return false;
    }
  }
  fs.rmSync(aside, { recursive: true, force: true });
  return true;
}

function acquireInstallLock(depsDir, {
  now = Date.now, sleep = sleepSync, timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS,
  isAlive = isPidAlive, host = os.hostname(), pid = process.pid,
  token = randomUUID(),
} = {}) {
  const lockPath = `${path.resolve(depsDir)}${INSTALL_LOCK_SUFFIX}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = now() + timeoutMs;
  for (;;) {
    let created = false;
    try {
      fs.mkdirSync(lockPath);
      created = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (created) {
      try {
        fs.writeFileSync(path.join(lockPath, LOCK_OWNER_FILE), JSON.stringify({ pid, host, token }));
      } catch (err) {
        // A waiter moved the still-ownerless lock aside in the instant before this
        // write. Start over rather than fail the install.
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      return () => {
        const owner = readLockOwner(lockPath);
        if (owner && owner.token === token) fs.rmSync(lockPath, { recursive: true, force: true });
      };
    }
    try {
      const check = checkAbandonedLock(lockPath, { now, staleMs, isAlive, host });
      if (check.abandoned && reclaimLock(lockPath, check.token, token)) continue;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (now() >= deadline) {
      throw new Error(`Timed out waiting for another install of the audit tools to finish. If none is running, delete ${lockPath} and try again.`);
    }
    sleep(LOCK_POLL_MS);
  }
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
  exists = fs.existsSync,
  lock = acquireInstallLock,
} = {}) {
  if (isInstalled(depsDir, { readFile, exists })) return { depsDir, installed: false, versions: { ...PINNED } };

  assertManagedDepsDir(depsDir, { env, readdir });
  const release = lock(depsDir);
  try {
    // Another session may have finished the install while this one waited for the lock.
    if (isInstalled(depsDir, { readFile, exists })) return { depsDir, installed: false, versions: { ...PINNED } };
    return runInstall({ depsDir, npmCliPath, spawnSyncFn, mkdir, copyFile, readFile, writeFile, exists });
  } finally {
    release();
  }
}

function runInstall({ depsDir, npmCliPath, spawnSyncFn, mkdir, copyFile, readFile, writeFile, exists }) {
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
  if (!isInstalled(depsDir, { readFile, exists })) {
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
  INSTALL_LOCK_SUFFIX,
  MANAGED_MARKER,
  MissingDependencyError,
  PINNED,
  RUNTIME_DIR,
  UnmanagedDepsDirError,
  acquireInstallLock,
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
