const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

function createFakeNpx(dir) {
  const commandPath = path.join(dir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const script = process.platform === 'win32'
    ? '@echo off\r\necho fake-npx %*\r\n'
    : '#!/bin/sh\necho "fake-npx $*"\n';

  fs.writeFileSync(commandPath, script, { mode: 0o755 });
  return commandPath;
}

test('playwright MCP bootstrap resolves the plugin root without host-provided env vars', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'power-pages-mcp-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  createFakeNpx(tempDir);

  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const server = config.mcpServers.playwright;
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const result = spawnSync(server.command, server.args, {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: {
      HOME: process.env.HOME,
      PATH: `${tempDir}${pathSeparator}${process.env.PATH || ''}`,
      USERPROFILE: process.env.USERPROFILE,
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fake-npx/);
  assert.doesNotMatch(result.stderr, /PLUGIN_ROOT is not set/);
});
