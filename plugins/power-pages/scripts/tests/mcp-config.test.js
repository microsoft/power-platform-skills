const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

function createSpawnPreload(dir) {
  const preloadPath = path.join(dir, 'intercept-spawn.js');
  fs.writeFileSync(preloadPath, `
const { EventEmitter } = require('node:events');
require('node:child_process').spawn = (command, args, options) => {
  process.stdout.write('fake-spawn ' + JSON.stringify({ command, args, options }) + '\\n');
  const child = new EventEmitter();
  process.nextTick(() => child.emit('exit', 0));
  return child;
};
`);
  return preloadPath;
}

test('playwright MCP bootstrap resolves the plugin root without host-provided env vars', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'power-pages-mcp-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const preloadPath = createSpawnPreload(tempDir);

  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const server = config.mcpServers.playwright;
  const result = spawnSync(server.command, ['--require', preloadPath, ...server.args], {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      USERPROFILE: process.env.USERPROFILE,
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fake-spawn/);
  assert.match(result.stdout, /--package=@playwright\/mcp@0\.0\.78/);
  assert.match(result.stdout, /"shell":false/);
  assert.doesNotMatch(result.stderr, /PLUGIN_ROOT is not set/);
});
