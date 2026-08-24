#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const {
  OFFICIAL_SERVER_IDS,
  PLUGIN_ROOT,
  buildOfficialMcpInvocation,
  resolvePluginRoot,
} = require('./lib/official-mcp-servers');

function launch(serverId, options = {}) {
  if (!OFFICIAL_SERVER_IDS.includes(serverId)) {
    throw new Error(
      `Unsupported official MCP server '${serverId}'. Expected one of: ${OFFICIAL_SERVER_IDS.join(', ')}.`,
    );
  }

  const pluginRoot = resolvePluginRoot(options.pluginRoot || PLUGIN_ROOT);
  const invocation = buildOfficialMcpInvocation(serverId, pluginRoot);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  process.exit(1);
}

if (require.main === module) {
  launch(process.argv[2], process.argv[3] ? { pluginRoot: process.argv[3] } : {});
}

module.exports = { launch };
