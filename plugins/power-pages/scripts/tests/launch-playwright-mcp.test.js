const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  buildMcpArgs,
  launch,
} = require('../launch-playwright-mcp');

test('buildMcpArgs launches Playwright MCP with fullscreen config', () => {
  const expectedConfigPath = path.join(__dirname, '..', 'playwright-mcp-fullscreen.config.json');
  const args = buildMcpArgs('chrome');
  const configIndex = args.indexOf('--config');

  assert.deepEqual(
    args.slice(0, 5),
    ['--yes', '--ignore-scripts', '--package=@playwright/mcp@0.0.78', 'playwright-mcp', '--browser'],
  );
  assert.equal(args[5], 'chrome');
  assert.equal(args.includes('--viewport-size'), false);
  assert.notEqual(configIndex, -1);
  assert.equal(args[configIndex + 1], expectedConfigPath);
});

test('buildMcpArgs preserves Windows config paths as one argv element', () => {
  const configPath = 'C:\\Users\\Power User\\.claude\\plugins\\power-pages\\scripts\\playwright-mcp-fullscreen.config.json';
  const args = buildMcpArgs('msedge', { configPath, platform: 'win32' });
  const configIndex = args.indexOf('--config');

  assert.equal(args[configIndex + 1], configPath);
});

test('fullscreen config maximizes the browser and uses the real viewport size', () => {
  const configPath = path.join(__dirname, '..', 'playwright-mcp-fullscreen.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  assert.deepEqual(config.browser.launchOptions.args, ['--start-maximized', '--start-fullscreen']);
  assert.equal(config.browser.contextOptions.viewport, null);
});

test('launch wires spawn and process exit handling', () => {
  let spawnCall;
  const child = new EventEmitter();

  launch({
    browser: 'msedge',
    npxCliPath: '/trusted/npm/bin/npx-cli.js',
    spawnFn(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
    onExit(code) {
      spawnCall.exitCode = code;
    },
  });

  assert.equal(spawnCall.command, process.execPath);
  assert.deepEqual(
    spawnCall.args.slice(0, 7),
    [
      '/trusted/npm/bin/npx-cli.js',
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
