const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  OUTPUT_DIR_PREFIX,
  PLAYWRIGHT_MCP_PACKAGE,
  buildMcpArgs,
  createOutputDir,
  launch,
  removeOutputDir,
  resolveNpxCli,
  sweepStaleOutputDirs,
} = require('../launch-playwright-mcp');

// launch() registers host-signal handlers and sweeps the real temp directory; tests use a
// stand-in process and a no-op sweep so neither leaks into the test runner.
function launchForTest(options) {
  return launch({ processRef: new EventEmitter(), sweepStaleOutputDirsFn() {}, ...options });
}

function outputDirArg(args) {
  const index = args.indexOf('--output-dir');
  return index === -1 ? null : args[index + 1];
}

test('buildMcpArgs launches the exact reviewed Playwright MCP version', () => {
  const expectedConfigPath = path.join(__dirname, '..', 'playwright-mcp-fullscreen.config.json');
  const args = buildMcpArgs('chrome');
  const configIndex = args.indexOf('--config');

  assert.equal(PLAYWRIGHT_MCP_PACKAGE, '@playwright/mcp@0.0.78');
  assert.deepEqual(
    args.slice(0, 6),
    [
      '--yes',
      '--ignore-scripts',
      '--package=@playwright/mcp@0.0.78',
      'playwright-mcp',
      '--browser',
      'chrome',
    ],
  );
  assert.equal(args.some((arg) => /@(latest|next|\^|~|\*)$/.test(arg)), false);
  assert.equal(args.includes('--viewport-size'), false);
  assert.notEqual(configIndex, -1);
  assert.equal(args[configIndex + 1], expectedConfigPath);
});

test('buildMcpArgs preserves config paths with spaces and shell metacharacters as raw argv', () => {
  const configPath = '/tmp/Power Pages $(echo unsafe); & [preview]/config\'s "quoted" path.json';
  const args = buildMcpArgs('chrome', { configPath });
  const configIndex = args.indexOf('--config');

  assert.equal(args[configIndex + 1], configPath);
});

test('buildMcpArgs preserves Windows config paths without shell quoting', () => {
  const configPath = 'C:\\Users\\Power User & Team\\Power Pages (Preview)\\playwright-mcp.config.json';
  const args = buildMcpArgs('msedge', { configPath });
  const configIndex = args.indexOf('--config');

  assert.equal(args[configIndex + 1], configPath);
});

test('resolveNpxCli finds the Windows npm JavaScript entrypoint', () => {
  const expected = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js';
  const checked = [];

  const resolved = resolveNpxCli({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
    existsSync(candidate) {
      checked.push(candidate);
      return candidate === expected;
    },
  });

  assert.equal(resolved, expected);
  assert.deepEqual(checked, [
    'C:\\Program Files\\lib\\node_modules\\npm\\bin\\npx-cli.js',
    expected,
  ]);
});

test('fullscreen config maximizes the browser and uses the real viewport size', () => {
  const configPath = path.join(__dirname, '..', 'playwright-mcp-fullscreen.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  assert.deepEqual(config.browser.launchOptions.args, ['--start-maximized', '--start-fullscreen']);
  assert.equal(config.browser.contextOptions.viewport, null);
});

test('launch preserves an explicit npx CLI path and uses raw argv without a shell', () => {
  let spawnCall;
  const child = new EventEmitter();

  launchForTest({
    browser: 'msedge',
    npxCliPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
    resolveNpxCliFn() {
      assert.fail('explicit npxCliPath must bypass default resolution');
    },
    spawnFn(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
    exitFn(code) {
      spawnCall.exitCode = code;
    },
  });

  assert.equal(spawnCall.command, process.execPath);
  assert.deepEqual(
    spawnCall.args.slice(0, 7),
    [
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
      '--yes',
      '--ignore-scripts',
      '--package=@playwright/mcp@0.0.78',
      'playwright-mcp',
      '--browser',
      'msedge',
    ],
  );
  assert.deepEqual(spawnCall.options, { stdio: 'inherit', shell: false });

  child.emit('exit', 7);
  assert.equal(spawnCall.exitCode, 7);
});

test('launch reports missing npm once and does not spawn', () => {
  const exits = [];
  let spawnCalls = 0;
  let stderr = '';

  const child = launchForTest({
    browser: 'chrome',
    resolveNpxCliFn() {
      throw new Error('Could not locate npm/bin/npx-cli.js');
    },
    spawnFn() {
      spawnCalls += 1;
      return new EventEmitter();
    },
    exitFn(code) {
      exits.push(code);
    },
    writeError(message) {
      stderr += message;
    },
  });

  assert.equal(child, null);
  assert.equal(spawnCalls, 0);
  assert.deepEqual(exits, [1]);
  assert.equal(
    stderr,
    'Failed to start Playwright MCP: Could not locate npm/bin/npx-cli.js\n',
  );
});

test('launch reports spawn errors and exits with failure', () => {
  const child = new EventEmitter();
  const exits = [];
  let stderr = '';

  launchForTest({
    browser: 'chrome',
    npxCliPath: '/trusted/npm/bin/npx-cli.js',
    spawnFn() {
      return child;
    },
    exitFn(code) {
      exits.push(code);
    },
    writeError(message) {
      stderr += message;
    },
  });

  child.emit('error', new Error('spawn ENOENT'));

  assert.deepEqual(exits, [1]);
  assert.match(stderr, /^Failed to start Playwright MCP: spawn ENOENT\n$/);
});

test('launch treats signal-only child exits as failures', () => {
  const child = new EventEmitter();
  let exitCode;

  launchForTest({
    browser: 'chrome',
    npxCliPath: '/trusted/npm/bin/npx-cli.js',
    spawnFn() {
      return child;
    },
    exitFn(code) {
      exitCode = code;
    },
  });

  child.emit('exit', null, 'SIGTERM');

  assert.equal(exitCode, 1);
});

test('buildMcpArgs appends --output-dir only when an output directory is given', () => {
  assert.equal(outputDirArg(buildMcpArgs('chrome')), null);

  const outputDir = 'C:\\Users\\Power User\\AppData\\Local\\Temp\\power-pages-playwright-mcp-a1B2c3';
  const args = buildMcpArgs('msedge', { outputDir });
  assert.equal(outputDirArg(args), outputDir);
  assert.equal(args.indexOf('--output-dir'), args.length - 2);
});

test('createOutputDir makes a private per-launch directory under the OS temp dir', () => {
  const outputDir = createOutputDir({ env: {} });
  try {
    assert.equal(path.dirname(outputDir), os.tmpdir());
    assert.ok(path.basename(outputDir).startsWith(OUTPUT_DIR_PREFIX));
    assert.ok(fs.statSync(outputDir).isDirectory());
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(outputDir).mode & 0o777, 0o700);
    }
  } finally {
    removeOutputDir(outputDir);
  }
  assert.equal(fs.existsSync(outputDir), false);
});

test('createOutputDir defers to an explicit PLAYWRIGHT_MCP_OUTPUT_DIR', () => {
  const outputDir = createOutputDir({
    env: { PLAYWRIGHT_MCP_OUTPUT_DIR: '/srv/playwright-output' },
    mkdtempSync() {
      assert.fail('an explicit output dir must not create a temp directory');
    },
  });

  assert.equal(outputDir, null);
});

test('removeOutputDir ignores a missing directory and swallows cleanup errors', () => {
  assert.doesNotThrow(() => removeOutputDir(null));
  assert.doesNotThrow(() => removeOutputDir(path.join(os.tmpdir(), `${OUTPUT_DIR_PREFIX}does-not-exist`)));
  assert.doesNotThrow(() => removeOutputDir('/locked', {
    rmSync() {
      throw new Error('EBUSY');
    },
  }));
});

test('launch passes the temp output dir to the server and removes it when the server exits', () => {
  const child = new EventEmitter();
  const removed = [];
  let spawnArgs;
  let exitCode;

  launchForTest({
    browser: 'chrome',
    npxCliPath: '/trusted/npm/bin/npx-cli.js',
    createOutputDirFn: () => '/tmp/power-pages-playwright-mcp-abc123',
    removeOutputDirFn: (dir) => removed.push(dir),
    spawnFn(command, args) {
      spawnArgs = args;
      return child;
    },
    exitFn(code) {
      exitCode = code;
    },
  });

  assert.equal(outputDirArg(spawnArgs), '/tmp/power-pages-playwright-mcp-abc123');
  assert.deepEqual(removed, []);

  child.emit('exit', 0);
  assert.deepEqual(removed, ['/tmp/power-pages-playwright-mcp-abc123']);
  assert.equal(exitCode, 0);
});

test('launch removes the temp output dir when the server fails to spawn', () => {
  const child = new EventEmitter();
  const removed = [];

  launchForTest({
    browser: 'chrome',
    npxCliPath: '/trusted/npm/bin/npx-cli.js',
    createOutputDirFn: () => '/tmp/power-pages-playwright-mcp-def456',
    removeOutputDirFn: (dir) => removed.push(dir),
    spawnFn: () => child,
    exitFn() {},
    writeError() {},
  });

  child.emit('error', new Error('spawn ENOENT'));
  assert.deepEqual(removed, ['/tmp/power-pages-playwright-mcp-def456']);
});

test('launch fails closed instead of writing into the project when no private output dir exists', () => {
  let spawned = 0;
  const exits = [];
  let stderr = '';

  const child = launchForTest({
    browser: 'chrome',
    npxCliPath: '/trusted/npm/bin/npx-cli.js',
    createOutputDirFn() {
      throw new Error('/tmp: ENOSPC; /home/me/.cache/power-pages: EACCES');
    },
    spawnFn() {
      spawned += 1;
      return new EventEmitter();
    },
    exitFn(code) {
      exits.push(code);
    },
    writeError(message) {
      stderr += message;
    },
  });

  assert.equal(child, null);
  assert.equal(spawned, 0, 'the server must not start without a private output directory');
  assert.deepEqual(exits, [1]);
  assert.match(stderr, /ENOSPC.*EACCES/);
  assert.match(stderr, /PLAYWRIGHT_MCP_OUTPUT_DIR/);
});

test('createOutputDir falls back to a private cache directory in the home folder', () => {
  const made = [];
  const dir = createOutputDir({
    env: {},
    tmpdir: () => '/full-tmp',
    homedir: () => '/home/me',
    mkdirSync: (root) => made.push(root),
    mkdtempSync(prefix) {
      if (prefix.startsWith('/full-tmp')) throw new Error('ENOSPC');
      return `${prefix}xyz`;
    },
  });
  assert.equal(dir, path.join('/home/me', '.cache', 'power-pages', `${OUTPUT_DIR_PREFIX}xyz`));
  assert.deepEqual(made, ['/full-tmp', path.join('/home/me', '.cache', 'power-pages')]);

  assert.throws(() => createOutputDir({
    env: {}, tmpdir: () => '/a', homedir: () => '/b', mkdirSync() {}, mkdtempSync() { throw new Error('EROFS'); },
  }), /EROFS.*EROFS/);
});

test('launch creates no temp output dir when npm cannot be located', () => {
  let created = 0;

  launchForTest({
    browser: 'chrome',
    resolveNpxCliFn() {
      throw new Error('Could not locate npm/bin/npx-cli.js');
    },
    createOutputDirFn() {
      created += 1;
      return '/tmp/unused';
    },
    spawnFn: () => new EventEmitter(),
    exitFn() {},
    writeError() {},
  });

  assert.equal(created, 0);
});

test('launch cleans up on a host termination signal and forwards it to the server', () => {
  const processRef = new EventEmitter();
  const child = new EventEmitter();
  const killed = [];
  child.kill = (signal) => killed.push(signal);
  const removed = [];
  let exitCode;

  launch({
    browser: 'chrome',
    npxCliPath: '/trusted/npm/bin/npx-cli.js',
    processRef,
    sweepStaleOutputDirsFn() {},
    createOutputDirFn: () => '/tmp/power-pages-playwright-mcp-sig123',
    removeOutputDirFn: (dir) => removed.push(dir),
    spawnFn: () => child,
    exitFn(code) {
      exitCode = code;
    },
  });

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    assert.equal(processRef.listenerCount(signal), 1, `${signal} must be forwarded`);
  }

  processRef.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(killed, ['SIGTERM']);
  assert.deepEqual(removed, ['/tmp/power-pages-playwright-mcp-sig123'], 'hosts may kill the launcher before the server exits, so cleanup runs on the signal');

  child.emit('exit', null, 'SIGTERM');
  assert.deepEqual(removed, ['/tmp/power-pages-playwright-mcp-sig123'], 'cleanup runs once');
  assert.equal(exitCode, 1);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    assert.equal(processRef.listenerCount(signal), 0, `${signal} handler must be removed`);
  }
});

test('launch sweeps stale output dirs before creating its own', () => {
  const calls = [];

  launch({
    browser: 'chrome',
    npxCliPath: '/trusted/npm/bin/npx-cli.js',
    processRef: new EventEmitter(),
    sweepStaleOutputDirsFn: () => calls.push('sweep'),
    createOutputDirFn: () => {
      calls.push('create');
      return '/tmp/power-pages-playwright-mcp-new';
    },
    spawnFn: () => new EventEmitter(),
    exitFn() {},
  });

  assert.deepEqual(calls, ['sweep', 'create']);
});

test('sweepStaleOutputDirs removes only this user\'s hour-old launcher directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-root-'));
  const hourAndAMinute = 61 * 60;
  const old = Date.now() / 1000 - hourAndAMinute;
  try {
    const stale = path.join(root, `${OUTPUT_DIR_PREFIX}stale`);
    const fresh = path.join(root, `${OUTPUT_DIR_PREFIX}fresh`);
    const unrelated = path.join(root, 'other-tool-stale');
    const target = path.join(root, 'precious');
    const planted = path.join(root, `${OUTPUT_DIR_PREFIX}planted`);
    for (const dir of [stale, fresh, unrelated, target]) {
      fs.mkdirSync(dir);
    }
    fs.writeFileSync(path.join(stale, 'page.png'), 'x');
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
    fs.symlinkSync(target, planted, process.platform === 'win32' ? 'junction' : 'dir');
    for (const dir of [stale, unrelated, target]) {
      fs.utimesSync(dir, old, old);
    }
    fs.lutimesSync(planted, old, old);

    sweepStaleOutputDirs({ tmpdir: () => root, homedir: () => path.join(root, 'no-home') });

    assert.equal(fs.existsSync(stale), false, 'an hour-old launcher dir is removed');
    assert.equal(fs.existsSync(fresh), true, 'a live session dir is kept');
    assert.equal(fs.existsSync(unrelated), true, 'other tools\' dirs are ignored');
    assert.equal(fs.existsSync(path.join(target, 'keep.txt')), true, 'a planted symlink is never followed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweepStaleOutputDirs leaves other users\' directories and tolerates errors', () => {
  const removed = [];
  const old = { isDirectory: () => true, mtimeMs: 0 };

  sweepStaleOutputDirs({
    tmpdir: () => '/shared/tmp',
    homedir: () => '/home/me',
    readdirSync: (root) => (root === '/shared/tmp' ? [`${OUTPUT_DIR_PREFIX}mine`, `${OUTPUT_DIR_PREFIX}theirs`, `${OUTPUT_DIR_PREFIX}racing`] : []),
    lstatSync(dir) {
      if (dir.endsWith('racing')) throw new Error('ENOENT');
      return { ...old, uid: dir.endsWith('mine') ? 501 : 777 };
    },
    rmSync: (dir) => removed.push(dir),
    now: () => 10 * 24 * 60 * 60 * 1000,
    uid: 501,
  });
  assert.deepEqual(removed, [path.join('/shared/tmp', `${OUTPUT_DIR_PREFIX}mine`)]);

  assert.doesNotThrow(() => sweepStaleOutputDirs({
    readdirSync() {
      throw new Error('EACCES');
    },
  }));
});
