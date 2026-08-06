const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  PLAYWRIGHT_MCP_PACKAGE,
  buildMcpArgs,
  launch,
  resolveNpxCli,
} = require('../launch-playwright-mcp');

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

test('launch uses Node and raw argv without a shell', () => {
  let spawnCall;
  const child = new EventEmitter();

  launch({
    browser: 'msedge',
    npxCliPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
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

test('launch reports spawn errors and exits with failure', () => {
  const child = new EventEmitter();
  const exits = [];
  let stderr = '';

  launch({
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

  launch({
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
