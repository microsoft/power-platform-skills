const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

test('playwright MCP bootstrap resolves only the host-provided plugin root', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'power-pages-mcp-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const scriptsDir = path.join(tempDir, 'scripts');
  fs.mkdirSync(scriptsDir);
  fs.writeFileSync(
    path.join(scriptsDir, 'launch-playwright-mcp.js'),
    'module.exports = { launch() { process.stdout.write("trusted-launcher"); } };\n',
  );

  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const server = config.mcpServers.playwright;
  const result = spawnSync(server.command, server.args, {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUGIN_ROOT: tempDir,
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'trusted-launcher');
});
