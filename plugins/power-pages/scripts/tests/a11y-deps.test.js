const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEPS_DIR_ENV, INSTALL_LOCK_SUFFIX, MANAGED_MARKER, MissingDependencyError, PINNED, RUNTIME_DIR, UnmanagedDepsDirError, acquireInstallLock, assertManagedDepsDir, cacheDepsDir,
  candidateRoots, defaultDepsDir, installDeps, isInstalled, launchBrowser, loadAxeSource, loadPlaywright, resolveNpmCli,
} = require('../lib/a11y/deps');
const { main: installMain } = require('../install-a11y-deps');

test('pinned versions are exact and come from the committed runtime manifest', () => {
  assert.deepEqual(PINNED, { 'playwright-core': '1.63.0', 'axe-core': '4.13.0' });
  for (const v of Object.values(PINNED)) assert.match(v, /^\d+\.\d+\.\d+$/);
});

test('the committed lock is the integrity record for every pinned package', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, PINNED);
  const locked = Object.keys(lock.packages).filter((k) => k);
  // Both pinned packages are dependency-free; a new transitive entry means the pin
  // changed shape and the lock needs a deliberate review.
  assert.deepEqual(locked.sort(), Object.keys(PINNED).map((n) => `node_modules/${n}`).sort());
  for (const [name, version] of Object.entries(PINNED)) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry.version, version);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    // Public registry only: never commit a private feed host.
    assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
  }
});

test('defaultDepsDir honors the env override and per-platform caches', () => {
  assert.equal(defaultDepsDir({ env: { [DEPS_DIR_ENV]: 'rel/deps' } }), path.resolve('rel/deps'));
  const key = 'a11y-pw1.63.0-axe4.13.0';
  assert.equal(
    defaultDepsDir({ env: { LOCALAPPDATA: 'C:\\Users\\maker\\AppData\\Local' }, platform: 'win32', homedir: 'C:\\Users\\maker' }),
    path.join('C:\\Users\\maker\\AppData\\Local', 'power-platform-skills', 'power-pages', key),
  );
  assert.equal(
    defaultDepsDir({ env: { XDG_CACHE_HOME: '/xdg' }, platform: 'linux', homedir: '/home/maker' }),
    path.join('/xdg', 'power-platform-skills', 'power-pages', key),
  );
  assert.equal(
    defaultDepsDir({ env: {}, platform: 'darwin', homedir: '/Users/maker' }),
    path.join('/Users/maker', 'Library', 'Caches', 'power-platform-skills', 'power-pages', key),
  );
});

test('candidateRoots orders deps dir then cache, dedupes, and never includes the project', () => {
  const env = { [DEPS_DIR_ENV]: path.resolve('cache') };
  assert.deepEqual(candidateRoots({ depsDir: 'd', projectRoot: 'p', env }), [path.resolve('d'), path.resolve('cache')]);
  assert.deepEqual(candidateRoots({ depsDir: 'cache', env }), [path.resolve('cache')]);
});

function fakeResolver(map) {
  return (request, { paths }) => {
    const hit = map[`${paths[0]}|${request}`];
    if (!hit) throw new Error('MODULE_NOT_FOUND');
    return hit;
  };
}

test('loadPlaywright prefers playwright-core and falls back to playwright', () => {
  const chromium = { launch() {} };
  const pw = loadPlaywright(['a', 'b'], {
    resolveFn: fakeResolver({ 'b|playwright': '/b/playwright/index.js' }),
    requireFn: () => ({ chromium }),
  });
  assert.equal(pw.chromium, chromium);
  assert.equal(pw.packageName, 'playwright');
  assert.equal(pw.source, 'b');
});

test('loadPlaywright and loadAxeSource raise MissingDependencyError with an install hint', () => {
  assert.throws(() => loadPlaywright(['a'], { resolveFn: fakeResolver({}) }), (e) => e instanceof MissingDependencyError && /install-a11y-deps\.js/.test(e.message));
  assert.throws(() => loadAxeSource(['a'], { resolveFn: fakeResolver({}) }), MissingDependencyError);
  const axe = loadAxeSource(['a'], { resolveFn: fakeResolver({ 'a|axe-core/axe.min.js': '/a/axe.min.js' }), readFile: () => 'AXE' });
  assert.deepEqual(axe, { source: 'AXE', from: 'a' });
});

test('installDeps is a no-op when the pinned versions are present', () => {
  let spawned = false;
  const result = installDeps({
    depsDir: '/deps',
    readFile: (p) => JSON.stringify({ version: p.includes('axe-core') ? '4.13.0' : '1.63.0' }),
    exists: () => true,
    spawnSyncFn: () => { spawned = true; },
  });
  assert.equal(result.installed, false);
  assert.equal(spawned, false);
});

test('isInstalled requires the entry files, not just matching package.json versions', () => {
  const readFile = (p) => JSON.stringify({ version: p.includes('axe-core') ? '4.13.0' : '1.63.0' });
  assert.equal(isInstalled('/deps', { readFile, exists: () => true }), true);
  for (const missing of [
    path.join('node_modules', 'playwright-core', 'index.js'),
    path.join('node_modules', 'axe-core', 'axe.min.js'),
  ]) {
    assert.equal(isInstalled('/deps', { readFile, exists: (p) => !p.endsWith(missing) }), false, missing);
  }
});

test('installDeps copies the committed lock and runs npm ci through node with scripts disabled', () => {
  let installedNow = false;
  const copies = [];
  const writes = [];
  let call;
  const result = installDeps({
    depsDir: '/deps',
    npmCliPath: '/node/npm-cli.js',
    mkdir: () => {},
    readdir: () => [],
    writeFile: (p) => writes.push(p),
    copyFile: (from, to) => copies.push([from, to]),
    exists: () => installedNow,
    readFile: (p) => {
      if (!installedNow) throw new Error('ENOENT');
      return JSON.stringify({ version: p.includes('axe-core') ? '4.13.0' : '1.63.0' });
    },
    spawnSyncFn: (exe, args, opts) => { call = { exe, args, opts }; installedNow = true; return { status: 0 }; },
    lock: () => () => {},
  });
  assert.equal(result.installed, true);
  assert.deepEqual(writes, [path.join('/deps', MANAGED_MARKER)], 'marks the directory as managed before writing into it');
  assert.deepEqual(copies, [
    [path.join(RUNTIME_DIR, 'package.json'), path.join('/deps', 'package.json')],
    [path.join(RUNTIME_DIR, 'package-lock.json'), path.join('/deps', 'package-lock.json')],
  ]);
  assert.equal(call.exe, process.execPath);
  assert.equal(call.opts.shell, false);
  assert.deepEqual(call.args.slice(0, 4), ['/node/npm-cli.js', 'ci', '--prefix', '/deps']);
  assert.ok(call.args.includes('--ignore-scripts'));
  assert.ok(!call.args.some((a) => a.includes('@')), 'versions come from the lock, never from argv specs');
});

test('installDeps surfaces npm failures', () => {
  assert.throws(() => installDeps({
    depsDir: '/deps', npmCliPath: 'npm-cli.js', mkdir: () => {}, copyFile: () => {}, readdir: () => [], writeFile: () => {},
    readFile: () => { throw new Error('ENOENT'); },
    spawnSyncFn: () => ({ status: 1, stderr: 'line1\nEINTEGRITY sha512 mismatch' }),
    lock: () => () => {},
  }), /npm ci failed \(exit 1\): line1\nEINTEGRITY sha512 mismatch/);
});

test('installDeps refuses a non-empty directory it did not create', () => {
  const touched = [];
  const record = (name) => (...args) => { touched.push([name, ...args]); };
  assert.throws(() => installDeps({
    depsDir: '/my-project', env: {}, npmCliPath: 'npm-cli.js',
    readFile: () => { throw new Error('ENOENT'); },
    readdir: () => ['package.json', 'package-lock.json', 'node_modules', 'src'],
    mkdir: record('mkdir'), writeFile: record('writeFile'), copyFile: record('copyFile'), spawnSyncFn: record('spawn'),
  }), (e) => e instanceof UnmanagedDepsDirError && /Refusing to install into/.test(e.message));
  assert.deepEqual(touched, [], 'nothing is written, copied, or run');
});

test('assertManagedDepsDir accepts new, empty, marked, and built-in cache directories', () => {
  const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.doesNotThrow(() => assertManagedDepsDir('/new', { env: {}, readdir: enoent }));
  assert.doesNotThrow(() => assertManagedDepsDir('/empty', { env: {}, readdir: () => [] }));
  assert.doesNotThrow(() => assertManagedDepsDir('/prev', { env: {}, readdir: () => [MANAGED_MARKER, 'node_modules'] }));
  const env = { LOCALAPPDATA: path.resolve('/cache-root'), XDG_CACHE_HOME: path.resolve('/cache-root') };
  assert.doesNotThrow(() => assertManagedDepsDir(cacheDepsDir({ env }), { env, readdir: () => ['node_modules'] }),
    'installs from before the marker existed keep working');
  assert.throws(() => assertManagedDepsDir('/proj', { env: {}, readdir: () => ['package.json'] }), UnmanagedDepsDirError);
});

test('resolveNpmCli derives npm-cli.js beside npx-cli.js', () => {
  assert.equal(resolveNpmCli(() => path.join('/node', 'bin', 'npx-cli.js')), path.join('/node', 'bin', 'npm-cli.js'));
});

test('launchBrowser passes the detected channel and maps missing browsers', async () => {
  const opts = [];
  const chromium = { async launch(o) { opts.push(o); return 'browser'; } };
  assert.equal(await launchBrowser(chromium, { headless: true, detect: () => 'msedge' }), 'browser');
  assert.deepEqual(opts[0], { channel: 'msedge', headless: true });
  await launchBrowser(chromium, { headless: false, detect: () => 'chromium' });
  assert.deepEqual(opts[1], { headless: false });

  const failing = { async launch() { throw new Error("browserType.launch: Executable doesn't exist at /x"); } };
  await assert.rejects(launchBrowser(failing, { detect: () => 'chromium' }), (e) => e instanceof MissingDependencyError && /Edge or Google Chrome/.test(e.message));
});

test('install-a11y-deps main prints JSON and maps failures', () => {
  const out = [];
  const err = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  assert.equal(installMain(['--deps-dir', 'x'], { ...io, install: ({ depsDir }) => ({ depsDir, installed: true }) }), 0);
  assert.equal(JSON.parse(out[0]).depsDir, 'x');
  assert.equal(installMain(['--bogus'], io), 2);
  assert.equal(installMain([], { ...io, install: () => { throw new Error('offline'); } }), 1);
  assert.match(err.join(''), /offline/);
  assert.equal(installMain(['--deps-dir', 'proj'], { ...io, install: () => { throw new UnmanagedDepsDirError('Refusing to install into proj'); } }), 2);
  assert.match(err.join(''), /Refusing to install into proj/);
});

test('installDeps holds the install lock and reuses an install finished while it waited', () => {
  let released = 0;
  let checks = 0;
  let spawned = false;
  const result = installDeps({
    depsDir: '/deps', npmCliPath: 'npm-cli.js', readdir: () => [],
    // Not installed on the first check; another session finishes before the lock is granted.
    exists: () => checks > 0,
    readFile: (p) => {
      if (checks === 0) { checks++; throw new Error('ENOENT'); }
      return JSON.stringify({ version: p.includes('axe-core') ? '4.13.0' : '1.63.0' });
    },
    lock: () => () => { released++; },
    spawnSyncFn: () => { spawned = true; return { status: 0 }; },
  });
  assert.equal(result.installed, false);
  assert.equal(spawned, false, 'npm ci is not run again');
  assert.equal(released, 1, 'the lock is released');
});

test('acquireInstallLock serializes installs and never takes a live owner\'s lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-lock-'));
  const depsDir = path.join(dir, 'deps');
  const lockPath = depsDir + INSTALL_LOCK_SUFFIX;
  try {
    const release = acquireInstallLock(depsDir);
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    // Hours later the owner is still alive (a slow npm ci): a waiter must not reclaim it.
    const muchLater = Date.now() + 5 * 60 * 60 * 1000;
    assert.throws(
      () => acquireInstallLock(depsDir, { now: () => muchLater, timeoutMs: 0, sleep: () => {} }),
      /Timed out waiting for another install/
    );
    release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireInstallLock takes over a dead owner\'s lock in place, without ever removing it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-lock-'));
  const depsDir = path.join(dir, 'deps');
  const lockPath = depsDir + INSTALL_LOCK_SUFFIX;
  const isAlive = (pid) => pid !== 999999;
  try {
    acquireInstallLock(depsDir, { pid: 999999, token: 'dead' });
    // A file in the lock survives the takeover only if the lock is never deleted or renamed.
    fs.writeFileSync(path.join(lockPath, 'sentinel'), '');
    const release = acquireInstallLock(depsDir, { isAlive, sleep: () => {}, token: 'me' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token, 'me');
    assert.equal(fs.existsSync(path.join(lockPath, 'sentinel')), true, 'the lock was taken over in place');
    assert.deepEqual(fs.readdirSync(dir), ['deps.install-lock'], 'nothing was moved aside');
    // A second waiter that also judged 'dead' abandoned loses the exclusive marker and waits.
    assert.throws(() => acquireInstallLock(depsDir, { isAlive, timeoutMs: 0, sleep: () => {} }), /Timed out/, 'a live new owner is never taken over');
    release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only one waiter can claim a given dead owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-lock-'));
  const depsDir = path.join(dir, 'deps');
  const lockPath = depsDir + INSTALL_LOCK_SUFFIX;
  try {
    acquireInstallLock(depsDir, { pid: 999999, token: 'dead' });
    // Another waiter won the race for this dead ownership but hasn't written owner.json yet.
    fs.mkdirSync(path.join(lockPath, 'takeover-dead'));
    assert.throws(() => acquireInstallLock(depsDir, { isAlive: () => false, timeoutMs: 0, sleep: () => {} }), /Timed out/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token, 'dead');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireInstallLock does not take over another host\'s lock, and takes over an ownerless one only when old', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-lock-'));
  const depsDir = path.join(dir, 'deps');
  const lockPath = depsDir + INSTALL_LOCK_SUFFIX;
  const noWait = { timeoutMs: 0, sleep: () => {}, isAlive: () => false };
  try {
    acquireInstallLock(depsDir, { host: 'other-machine', token: 'remote' });
    assert.throws(() => acquireInstallLock(depsDir, noWait), /Timed out/);
    fs.rmSync(lockPath, { recursive: true });

    // A process that died between mkdir and writing owner.json.
    fs.mkdirSync(lockPath);
    assert.throws(() => acquireInstallLock(depsDir, noWait), /Timed out/, 'a fresh ownerless lock may be mid-acquire');
    const later = Date.now() + 11 * 60 * 1000;
    // A takeover winner that died before writing owner.json left its marker behind. The
    // marker refreshed the lock's mtime, so the next takeover gets a new marker name.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);
    fs.mkdirSync(path.join(lockPath, `takeover-ownerless-${Math.trunc(fs.statSync(lockPath).mtimeMs)}`));
    const release = acquireInstallLock(depsDir, { ...noWait, now: () => later, token: 'heir' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token, 'heir');
    release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an install lock release never removes a lock another process now holds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-lock-'));
  const depsDir = path.join(dir, 'deps');
  const lockPath = depsDir + INSTALL_LOCK_SUFFIX;
  try {
    const release = acquireInstallLock(depsDir, { token: 'first' });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 1, host: 'h', token: 'second' }));
    release();
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
