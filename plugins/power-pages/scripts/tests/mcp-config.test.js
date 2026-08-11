const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
const server = config.mcpServers.playwright;

function createFakeNpx(dir) {
  const commandPath = path.join(dir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const script = process.platform === 'win32'
    ? '@echo off\r\necho fake-npx %*\r\n'
    : '#!/bin/sh\necho "fake-npx $*"\n';

  fs.writeFileSync(commandPath, script, { mode: 0o755 });
  return commandPath;
}

function runBootstrap({
  cwd,
  pluginRoot: pluginRootValue,
  claudePluginRoot,
  pathPrefix,
  statFailure,
} = {}) {
  const env = { ...process.env };
  const args = [...server.args];
  delete env.PLUGIN_ROOT;
  delete env.CLAUDE_PLUGIN_ROOT;

  if (pluginRootValue !== undefined) {
    env.PLUGIN_ROOT = pluginRootValue;
  }
  if (claudePluginRoot !== undefined) {
    env.CLAUDE_PLUGIN_ROOT = claudePluginRoot;
  }
  if (pathPrefix) {
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    env.PATH = `${pathPrefix}${pathSeparator}${env.PATH || ''}`;
  }
  if (statFailure) {
    // Patch the child process's fs module so access errors are deterministic across platforms.
    const bootstrapIndex = args.indexOf('-e') + 1;
    const prelude = [
      "const injectedFs=require('node:fs');",
      'const originalStatSync=injectedFs.statSync;',
      `const injectedStatTarget=${JSON.stringify(path.resolve(statFailure.target))};`,
      `const injectedStatCode=${JSON.stringify(statFailure.code)};`,
      "injectedFs.statSync=function(target,...options){if(require('node:path').resolve(String(target))===injectedStatTarget){const error=new Error('injected statSync failure');error.code=injectedStatCode;throw error;}return originalStatSync.call(this,target,...options);};",
    ].join(' ');
    args[bootstrapIndex] = `${prelude} ${args[bootstrapIndex]}`;
  }

  return spawnSync(server.command, args, {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 5_000,
  });
}

test('playwright MCP bootstrap wraps root stat errors with a clear diagnostic', () => {
  const root = fs.realpathSync(pluginRoot);
  const result = runBootstrap({
    cwd: pluginRoot,
    pluginRoot,
    statFailure: { target: root, code: 'EACCES' },
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /\[Power Pages Playwright MCP\] Could not inspect declared plugin root: .+ \(EACCES\)\./,
  );
});

test('playwright MCP bootstrap wraps launcher stat errors with a clear diagnostic', () => {
  const launcher = fs.realpathSync(path.join(pluginRoot, 'scripts', 'launch-playwright-mcp.js'));
  const result = runBootstrap({
    cwd: pluginRoot,
    pluginRoot,
    statFailure: { target: launcher, code: 'EPERM' },
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /\[Power Pages Playwright MCP\] Could not inspect resolved launcher: .+ \(EPERM\)\./,
  );
});

test('playwright MCP bootstrap requires a host-provided plugin root', () => {
  const result = runBootstrap({ cwd: pluginRoot });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT must be set/);
  assert.match(result.stderr, /refusing to resolve the launcher from the current working directory/);
});

test('playwright MCP bootstrap does not execute a launcher from a malicious cwd', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'power-pages-mcp-malicious-cwd-'));
  const scriptsDir = path.join(tempDir, 'scripts');
  const markerPath = path.join(tempDir, 'cwd-launcher-executed');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.mkdirSync(scriptsDir);
  fs.writeFileSync(
    path.join(scriptsDir, 'launch-playwright-mcp.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'executed'); module.exports = { launch() {} };\n`,
  );

  const result = runBootstrap({ cwd: tempDir });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT must be set/);
  assert.equal(fs.existsSync(markerPath), false);
});

test('playwright MCP bootstrap rejects malformed plugin roots', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'power-pages-mcp-invalid-root-'));
  const fileRoot = path.join(tempDir, 'not-a-directory');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(fileRoot, 'not a plugin root');

  await t.test('nonexistent root', () => {
    const result = runBootstrap({
      cwd: tempDir,
      pluginRoot: path.join(tempDir, 'missing'),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Declared plugin root is invalid/);
  });

  await t.test('file root', () => {
    const result = runBootstrap({ cwd: tempDir, pluginRoot: fileRoot });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Declared plugin root is not a directory/);
  });

  await t.test('relative root', () => {
    const result = runBootstrap({ cwd: tempDir, pluginRoot: '.' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Declared plugin root must be an absolute path/);
  });
});

test('playwright MCP bootstrap rejects a launcher that resolves outside the plugin root', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'power-pages-mcp-escape-'));
  const declaredRoot = path.join(tempDir, 'plugin');
  const outsideScripts = path.join(tempDir, 'outside-scripts');
  const markerPath = path.join(tempDir, 'escaped-launcher-executed');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.mkdirSync(declaredRoot);
  fs.mkdirSync(outsideScripts);
  fs.writeFileSync(
    path.join(outsideScripts, 'launch-playwright-mcp.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'executed'); module.exports = { launch() {} };\n`,
  );

  try {
    fs.symlinkSync(
      outsideScripts,
      path.join(declaredRoot, 'scripts'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = runBootstrap({ cwd: tempDir, pluginRoot: declaredRoot });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Resolved launcher escapes the declared plugin root/);
  assert.equal(fs.existsSync(markerPath), false);
});

test('playwright MCP bootstrap supports installed-plugin root environment conventions', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'power-pages-mcp-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  createFakeNpx(tempDir);

  await t.test('PLUGIN_ROOT', () => {
    const result = runBootstrap({
      cwd: tempDir,
      pluginRoot,
      pathPrefix: tempDir,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fake-npx/);
  });

  await t.test('CLAUDE_PLUGIN_ROOT', () => {
    const result = runBootstrap({
      cwd: tempDir,
      claudePluginRoot: pluginRoot,
      pathPrefix: tempDir,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fake-npx/);
  });
});
