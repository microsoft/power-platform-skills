const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  buildMcpArgs,
  launch,
} = require('../launch-playwright-mcp');
const { invocation } = require('../lib/process-runner');

test('buildMcpArgs launches Playwright MCP with fullscreen config', () => {
  const expectedConfigPath = path.join(__dirname, '..', 'playwright-mcp-fullscreen.config.json');
  const args = buildMcpArgs('chrome');
  const configIndex = args.indexOf('--config');

  assert.deepEqual(args.slice(0, 4), ['-y', '@playwright/mcp@latest', '--browser', 'chrome']);
  assert.equal(args.includes('--viewport-size'), false);
  assert.notEqual(configIndex, -1);
  assert.equal(args[configIndex + 1], expectedConfigPath, 'the path is passed as-is; the process runner quotes it where needed');
});

test('a Windows config path containing spaces reaches the npx shim as one quoted argument', () => {
  const configPath = 'C:\\Users\\Power User\\.claude\\plugins\\model-apps\\scripts\\playwright-mcp-fullscreen.config.json';
  const inv = invocation('npx', buildMcpArgs('msedge', { configPath }), {
    platform: 'win32',
    env: { Path: 'C:\\nodejs', PATHEXT: '.EXE;.CMD', SystemRoot: 'C:\\Windows' },
    exists: (p) => p === 'C:\\nodejs\\npx.cmd',
  });
  assert.equal(inv.options.shell, false);
  assert.ok(inv.args[4].endsWith(`--config "${configPath}""`), inv.args[4]);
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
    spawnFn(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
    onExit(code) {
      spawnCall.exitCode = code;
    },
  });

  assert.equal(spawnCall.command, 'npx');
  assert.deepEqual(spawnCall.args.slice(0, 4), ['-y', '@playwright/mcp@latest', '--browser', 'msedge']);
  assert.deepEqual(spawnCall.options, { stdio: 'inherit' }, 'no shell: the process runner decides how npx starts');

  child.emit('exit', 7);
  assert.equal(spawnCall.exitCode, 7);
});

test('launch handles the child error event (npx fails to spawn)', () => {
  const child = new EventEmitter();
  let handled;
  launch({
    browser: 'chrome',
    spawnFn: () => child,
    onError: (err) => { handled = err.message; },
  });
  child.emit('error', new Error('spawn npx ENOENT'));
  assert.equal(handled, 'spawn npx ENOENT');
});

test('launch reports a launch that cannot start (npx not on PATH) through onError', () => {
  let handled;
  const child = launch({
    browser: 'chrome',
    spawnFn: () => { const e = new Error('spawn npx ENOENT: not found on PATH'); e.code = 'ENOENT'; throw e; },
    onError: (err) => { handled = err.code; },
  });
  assert.equal(handled, 'ENOENT');
  assert.equal(child, null);
});
// --- #588.7: a signal termination is a failure, not a clean shutdown -----------------------------
// Node calls the exit handler with (code, signal); on a SIGNAL death `code` is null and `signal`
// carries the name. `process.exit(code || 0)` therefore reported every crash and every kill as exit
// 0, so an MCP host saw a server that had DIED as one that had shut down cleanly.
test('a signal-terminated child exits non-zero and names the signal', () => {
  const exits = [];
  const errs = [];
  const realExit = process.exit;
  const realWrite = process.stderr.write.bind(process.stderr);
  process.exit = (c) => { exits.push(c); };
  process.stderr.write = (chunk) => { errs.push(String(chunk)); return true; };
  try {
    const handlers = {};
    const child = { on: (evt, fn) => { handlers[evt] = fn; } };
    launch({ spawnFn: () => child });
    handlers.exit(null, 'SIGTERM');
  } finally {
    process.exit = realExit;
    process.stderr.write = realWrite;
  }
  assert.strictEqual(exits.length, 1);
  assert.notStrictEqual(exits[0], 0, `a signal death must not report success; got ${exits[0]}`);
  assert.ok(exits[0] > 128, `the shell convention is 128 + signum; got ${exits[0]}`);
  assert.ok(errs.join('').includes('SIGTERM'), `the signal must be named; got ${JSON.stringify(errs)}`);
});

test('an ordinary clean exit is still reported as success', () => {
  const exits = [];
  const realExit = process.exit;
  process.exit = (c) => { exits.push(c); };
  try {
    const handlers = {};
    const child = { on: (evt, fn) => { handlers[evt] = fn; } };
    launch({ spawnFn: () => child });
    handlers.exit(0, null);
  } finally { process.exit = realExit; }
  assert.deepStrictEqual(exits, [0], 'a clean shutdown must stay exit 0');
});

test('a non-zero child exit code is passed through unchanged', () => {
  const exits = [];
  const realExit = process.exit;
  process.exit = (c) => { exits.push(c); };
  try {
    const handlers = {};
    const child = { on: (evt, fn) => { handlers[evt] = fn; } };
    launch({ spawnFn: () => child });
    handlers.exit(3, null);
  } finally { process.exit = realExit; }
  assert.deepStrictEqual(exits, [3]);
});
