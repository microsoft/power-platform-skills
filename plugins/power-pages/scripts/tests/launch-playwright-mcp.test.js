const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  buildConfig,
  buildMcpArgs,
  writeTempConfig,
  launch,
  CHROME_VERTICAL_OFFSET,
} = require('../launch-playwright-mcp');

test('buildConfig sizes window and viewport from detected screen', () => {
  const config = buildConfig({ width: 1920, height: 1080 });

  assert.deepEqual(config.browser.launchOptions.args, [
    '--window-position=0,0',
    '--window-size=1920,1080',
    '--test-type',
  ]);
  assert.deepEqual(config.browser.contextOptions.viewport, {
    width: 1920,
    height: 1080 - CHROME_VERTICAL_OFFSET,
  });
  assert.equal(config.browser.contextOptions.colorScheme, 'light');
});

test('buildConfig keeps a minimum viewport height for tiny screens', () => {
  const config = buildConfig({ width: 800, height: 600 });
  // 600 - 120 = 480, but we floor at 600 to avoid degenerate viewports
  assert.equal(config.browser.contextOptions.viewport.height >= 600, true);
});

test('buildMcpArgs passes the generated config path to MCP', () => {
  const args = buildMcpArgs('chrome', '/tmp/some-config.json');
  assert.deepEqual(args, [
    '@playwright/mcp@latest',
    '--browser',
    'chrome',
    '--config',
    '/tmp/some-config.json',
  ]);
});

test('writeTempConfig writes JSON to tmpdir and returns its path', () => {
  let written;
  const fakeTmp = path.join(path.sep, 'tmp', 'fake');
  const file = writeTempConfig(
    { browser: { launchOptions: { args: [] }, contextOptions: { viewport: null } } },
    {
      tmpdir: fakeTmp,
      writeFn: (p, content) => {
        written = { p, content };
      },
    },
  );

  assert.equal(path.dirname(file), fakeTmp);
  assert.match(path.basename(file), /^powerpages-playwright-mcp-\d+-\d+\.json$/);
  assert.equal(written.p, file);
  // Content should be parseable JSON containing the config we passed.
  const parsed = JSON.parse(written.content);
  assert.equal(parsed.browser.contextOptions.viewport, null);
});

test('launch wires spawn, screen detection, and config cleanup on exit', () => {
  let spawnCall;
  let unlinkPath;
  const writes = [];
  const child = new EventEmitter();
  const fakeTmp = path.join(path.sep, 'tmp', 'fake');

  launch({
    browser: 'msedge',
    screen: { width: 1366, height: 768 },
    tmpdir: fakeTmp,
    writeFn: (p, content) => {
      writes.push({ p, content });
    },
    unlinkFn: (p) => {
      unlinkPath = p;
    },
    spawnFn(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
    onExit(code) {
      spawnCall.exitCode = code;
    },
  });

  assert.equal(spawnCall.command, 'npx');
  assert.deepEqual(spawnCall.args.slice(0, 3), ['@playwright/mcp@latest', '--browser', 'msedge']);
  assert.equal(spawnCall.args[3], '--config');
  assert.equal(path.dirname(spawnCall.args[4]), fakeTmp);
  assert.deepEqual(spawnCall.options, { stdio: 'inherit', shell: true });

  // Config was written before spawning.
  assert.equal(writes.length, 1);
  const cfg = JSON.parse(writes[0].content);
  assert.deepEqual(cfg.browser.launchOptions.args, [
    '--window-position=0,0',
    '--window-size=1366,768',
    '--test-type',
  ]);
  assert.equal(cfg.browser.contextOptions.viewport.width, 1366);

  child.emit('exit', 0);
  assert.equal(unlinkPath, spawnCall.args[4]);
  assert.equal(spawnCall.exitCode, 0);
});

test('launch still calls onExit and attempts cleanup when child exits non-zero', () => {
  let unlinkAttempted = false;
  const child = new EventEmitter();
  let exitCode;

  launch({
    browser: 'chrome',
    screen: { width: 1440, height: 900 },
    tmpdir: path.join(path.sep, 'tmp', 'fake'),
    writeFn: () => {},
    unlinkFn: () => {
      unlinkAttempted = true;
      throw new Error('file already gone');
    },
    spawnFn: () => child,
    onExit: (code) => {
      exitCode = code;
    },
  });

  child.emit('exit', 7);
  assert.equal(unlinkAttempted, true);
  assert.equal(exitCode, 7);
});

