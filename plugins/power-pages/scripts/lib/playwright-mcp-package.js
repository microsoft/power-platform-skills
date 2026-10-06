// The one reviewed @playwright/mcp version this plugin runs, and how to invoke npx without
// a shell. Shared by the MCP launcher and by browser scripts that borrow the same pinned
// Playwright when a site project has none of its own.

const fs = require('node:fs');
const path = require('node:path');

const PLAYWRIGHT_MCP_VERSION = '0.0.78';
const PLAYWRIGHT_MCP_PACKAGE = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;

function resolveNpxCli({
  execPath = process.execPath,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  // Windows exposes npx as a .cmd shim that cannot run with shell:false. Invoking
  // npm's JavaScript entrypoint through Node preserves raw argv on every platform.
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const nodeDir = pathApi.dirname(execPath);
  const candidates = [
    pathApi.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    pathApi.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));

  if (!match) {
    throw new Error(
      'Could not locate npm/bin/npx-cli.js beside the current Node installation. Install Node.js with npm before starting the Playwright MCP server.',
    );
  }

  return match;
}

// npm's own entry point sits beside npx-cli.js in every npm layout resolveNpxCli accepts.
function resolveNpmCli({ existsSync = fs.existsSync, ...options } = {}) {
  const npmCli = path.join(path.dirname(resolveNpxCli({ existsSync, ...options })), 'npm-cli.js');
  if (!existsSync(npmCli)) {
    throw new Error(`Could not locate npm-cli.js beside ${path.dirname(npmCli)}. Install Node.js with npm.`);
  }
  return npmCli;
}

module.exports = {
  PLAYWRIGHT_MCP_PACKAGE,
  PLAYWRIGHT_MCP_VERSION,
  resolveNpmCli,
  resolveNpxCli,
};
