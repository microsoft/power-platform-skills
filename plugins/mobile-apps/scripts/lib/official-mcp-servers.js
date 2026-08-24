'use strict';

const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const MCP_SCHEMA_URL = 'https://modelcontextprotocol.io/schema/mcp-server.json';
const MICROSOFT_LEARN_URL = 'https://learn.microsoft.com/api/mcp';

// Live npm metadata on 2026-08-24 shows firebase-tools 15.28.1 exists only on
// GitHub main/unpublished; latest stable semver on npm is 15.27.0, so the MCP
// bootstrap must pin 15.27.0.
const FIREBASE_PACKAGE = 'firebase-tools';
const FIREBASE_VERSION = '15.27.0';
const FIREBASE_ALLOWED_TOOLS = Object.freeze([
  'firebase_get_environment',
  'firebase_login',
  'firebase_update_environment',
  'firebase_list_projects',
  'firebase_get_project',
  'firebase_create_project',
  'firebase_list_apps',
  'firebase_create_app',
  'firebase_get_sdk_config',
]);

const GCLOUD_PACKAGE = '@google-cloud/gcloud-mcp';
const GCLOUD_VERSION = '0.5.3';
const GCLOUD_ALLOWLIST_RELATIVE_PATH = path.join('shared', 'mcp', 'gcloud-allowlist.json');

// npm metadata snapshot on 2026-08-24:
// - npm view @azure/mcp dist-tags.latest => 3.0.0-beta.37
// - latest non-prerelease / GA tagable version => 2.0.5
const AZURE_PACKAGE = '@azure/mcp';
const AZURE_VERSION = '2.0.5';
const AZURE_NAMESPACES = Object.freeze([
  'subscription',
  'group',
  'role',
  'appservice',
  'functionapp',
]);

const OFFICIAL_SERVER_IDS = Object.freeze(['firebase', 'gcloud', 'azure']);

function resolvePluginRoot(candidate = PLUGIN_ROOT) {
  return path.resolve(candidate);
}

function getNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function getGcloudAllowlistPath(pluginRoot = PLUGIN_ROOT) {
  return path.resolve(resolvePluginRoot(pluginRoot), GCLOUD_ALLOWLIST_RELATIVE_PATH);
}

function buildFirebaseInvocation() {
  return {
    command: getNpxCommand(),
    args: [
      '-y',
      `${FIREBASE_PACKAGE}@${FIREBASE_VERSION}`,
      'mcp',
      '--mode',
      'stdio',
      '--tools',
      FIREBASE_ALLOWED_TOOLS.join(','),
    ],
  };
}

function buildGcloudInvocation(pluginRoot = PLUGIN_ROOT) {
  return {
    command: getNpxCommand(),
    args: [
      '-y',
      `${GCLOUD_PACKAGE}@${GCLOUD_VERSION}`,
      '--config',
      getGcloudAllowlistPath(pluginRoot),
    ],
  };
}

function buildAzureInvocation() {
  return {
    command: getNpxCommand(),
    args: [
      '-y',
      '-p',
      `${AZURE_PACKAGE}@${AZURE_VERSION}`,
      'azmcp',
      'server',
      'start',
      '--transport',
      'stdio',
      '--mode',
      'namespace',
      ...AZURE_NAMESPACES.flatMap((namespace) => ['--namespace', namespace]),
    ],
  };
}

function buildOfficialMcpInvocation(serverId, pluginRoot = PLUGIN_ROOT) {
  switch (serverId) {
    case 'firebase':
      return buildFirebaseInvocation();
    case 'gcloud':
      return buildGcloudInvocation(pluginRoot);
    case 'azure':
      return buildAzureInvocation();
    default:
      throw new Error(`Unsupported official MCP server '${serverId}'.`);
  }
}

module.exports = {
  AZURE_NAMESPACES,
  AZURE_PACKAGE,
  AZURE_VERSION,
  FIREBASE_ALLOWED_TOOLS,
  FIREBASE_PACKAGE,
  FIREBASE_VERSION,
  GCLOUD_ALLOWLIST_RELATIVE_PATH,
  GCLOUD_PACKAGE,
  GCLOUD_VERSION,
  MCP_SCHEMA_URL,
  MICROSOFT_LEARN_URL,
  OFFICIAL_SERVER_IDS,
  PLUGIN_ROOT,
  buildOfficialMcpInvocation,
  getGcloudAllowlistPath,
  getNpxCommand,
  resolvePluginRoot,
};
