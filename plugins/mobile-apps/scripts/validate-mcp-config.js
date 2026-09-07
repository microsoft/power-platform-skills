#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  AZURE_NAMESPACES,
  AZURE_PACKAGE,
  AZURE_VERSION,
  FIREBASE_ALLOWED_TOOLS,
  FIREBASE_PACKAGE,
  FIREBASE_VERSION,
  GCLOUD_PACKAGE,
  GCLOUD_VERSION,
  MCP_SCHEMA_URL,
  MICROSOFT_LEARN_URL,
  OFFICIAL_SERVER_IDS,
  PLUGIN_ROOT,
  getGcloudAllowlistPath,
  resolvePluginRoot,
} = require('./lib/official-mcp-servers');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateBootstrapEntry(serverId, entry, issues) {
  if (!entry || entry.command !== 'node' || !Array.isArray(entry.args) || entry.args.length < 2) {
    issues.push(`${serverId}: expected a node bootstrap entry with inline launcher args.`);
    return;
  }

  if (entry.args[0] !== '-e') {
    issues.push(`${serverId}: expected node -e bootstrap form.`);
    return;
  }

  const inline = String(entry.args[1]);
  if (!inline.includes("launch-official-mcp.js")) {
    issues.push(`${serverId}: bootstrap does not reference scripts/launch-official-mcp.js.`);
  }
  if (!inline.includes(`launch('${serverId}'`) && !inline.includes(`launch("${serverId}"`)) {
    issues.push(`${serverId}: bootstrap does not dispatch the expected server id.`);
  }
}

function validateMicrosoftLearn(entry, issues) {
  if (!entry || entry.type !== 'http' || entry.url !== MICROSOFT_LEARN_URL) {
    issues.push('microsoft-learn: expected hosted HTTP Learn MCP entry to remain unchanged.');
  }
}

function validateGcloudAllowlist(pluginRoot, issues) {
  const allowlistPath = getGcloudAllowlistPath(pluginRoot);
  if (!fs.existsSync(allowlistPath)) {
    issues.push(`gcloud: missing allowlist file at ${allowlistPath}.`);
    return;
  }

  const allowlist = readJson(allowlistPath);
  if (!allowlist || !Array.isArray(allowlist.allow) || allowlist.allow.length === 0) {
    issues.push('gcloud: allowlist JSON must provide a non-empty allow array.');
  }
  if (Object.prototype.hasOwnProperty.call(allowlist, 'deny')) {
    issues.push('gcloud: deny list should stay unset so the plugin owns a single explicit allowlist.');
  }
  if (Array.isArray(allowlist.allow) && allowlist.allow.some((command) => typeof command !== 'string' || !command.trim())) {
    issues.push('gcloud: every allowlisted command must be a non-empty string prefix.');
  }
}

function validateServerPins(issues) {
  if (FIREBASE_VERSION !== '15.27.0') {
    issues.push(`firebase: expected firebase-tools stable pin 15.27.0, got ${FIREBASE_VERSION}.`);
  }
  if (GCLOUD_VERSION !== '0.5.3') {
    issues.push(`gcloud: expected @google-cloud/gcloud-mcp pin 0.5.3, got ${GCLOUD_VERSION}.`);
  }
  if (AZURE_VERSION !== '2.0.5') {
    issues.push(`azure: expected @azure/mcp GA pin 2.0.5, got ${AZURE_VERSION}.`);
  }
  if (FIREBASE_PACKAGE !== 'firebase-tools') {
    issues.push(`firebase: expected package firebase-tools, got ${FIREBASE_PACKAGE}.`);
  }
  if (GCLOUD_PACKAGE !== '@google-cloud/gcloud-mcp') {
    issues.push(`gcloud: expected package @google-cloud/gcloud-mcp, got ${GCLOUD_PACKAGE}.`);
  }
  if (AZURE_PACKAGE !== '@azure/mcp') {
    issues.push(`azure: expected package @azure/mcp, got ${AZURE_PACKAGE}.`);
  }
}

function validateCapabilities(issues) {
  const expectedFirebaseTools = [
    'firebase_get_environment',
    'firebase_login',
    'firebase_update_environment',
    'firebase_list_projects',
    'firebase_get_project',
    'firebase_create_project',
    'firebase_list_apps',
    'firebase_create_app',
    'firebase_get_sdk_config',
  ];

  if (JSON.stringify(FIREBASE_ALLOWED_TOOLS) !== JSON.stringify(expectedFirebaseTools)) {
    issues.push(`firebase: unexpected tool allowlist ${FIREBASE_ALLOWED_TOOLS.join(',')}.`);
  }

  const expectedAzureNamespaces = [
    'subscription',
    'group',
    'role',
  ];

  if (JSON.stringify(AZURE_NAMESPACES) !== JSON.stringify(expectedAzureNamespaces)) {
    issues.push(`azure: unexpected namespace list ${AZURE_NAMESPACES.join(',')}.`);
  }
}

function validateMcpConfig(pluginRoot = PLUGIN_ROOT) {
  const resolvedRoot = resolvePluginRoot(pluginRoot);
  const configPath = path.join(resolvedRoot, '.mcp.json');
  const config = readJson(configPath);
  const issues = [];

  if (config.$schema !== MCP_SCHEMA_URL) {
    issues.push(`config: expected $schema ${MCP_SCHEMA_URL}.`);
  }

  const servers = config.mcpServers || {};
  for (const serverId of OFFICIAL_SERVER_IDS) {
    validateBootstrapEntry(serverId, servers[serverId], issues);
  }
  validateMicrosoftLearn(servers['microsoft-learn'], issues);
  validateServerPins(issues);
  validateCapabilities(issues);
  validateGcloudAllowlist(resolvedRoot, issues);

  return {
    ok: issues.length === 0,
    configPath,
    issues,
    summary: {
      firebase: {
        package: `${FIREBASE_PACKAGE}@${FIREBASE_VERSION}`,
        tools: FIREBASE_ALLOWED_TOOLS,
      },
      gcloud: {
        package: `${GCLOUD_PACKAGE}@${GCLOUD_VERSION}`,
        allowlistPath: getGcloudAllowlistPath(resolvedRoot),
      },
      azure: {
        package: `${AZURE_PACKAGE}@${AZURE_VERSION}`,
        namespaces: AZURE_NAMESPACES,
      },
      microsoftLearn: MICROSOFT_LEARN_URL,
    },
  };
}

if (require.main === module) {
  const result = validateMcpConfig(process.argv[2] || PLUGIN_ROOT);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

module.exports = { validateMcpConfig };
