#!/usr/bin/env node

/**
 * PostToolUse hook: enforce connector-first rule.
 *
 * Blocks writes to .ts / .tsx / .js / .jsx files that bypass the generated
 * connector services by calling Microsoft Graph, Azure REST, or arbitrary
 * https endpoints directly.
 *
 * Forbidden:
 *   - import 'axios' / require('axios')
 *   - fetch("https://graph.microsoft.com/...")
 *   - fetch("https://management.azure.com/...")
 *   - fetch("https://login.microsoftonline.com/...")  (auth handled by template)
 *   - fetch("https://*.crm.dynamics.com/...")  (use Dataverse generated service)
 *
 * Allowed: any code that imports from `src/generated/` or local relative paths.
 *
 * Exit codes: 0 pass, 2 block.
 */

const fs = require('fs');
const path = require('path');

const WATCHED_EXT = /\.(tsx|ts|jsx|js)$/i;

// Regex → human reason
const VIOLATIONS = [
  {
    rx: /from\s*['"]axios['"]/,
    reason: '`axios` is forbidden. Use generated connector services from `src/generated/`.',
  },
  {
    rx: /require\(\s*['"]axios['"]\s*\)/,
    reason: '`require("axios")` is forbidden. Use generated connector services from `src/generated/`.',
  },
  {
    rx: /fetch\(\s*['"`]https:\/\/graph\.microsoft\.com\b/i,
    reason: 'Direct Microsoft Graph fetch is forbidden. Use the Office 365 / Graph connector via `npx power-apps add-data-source` and import from `src/generated/`.',
  },
  {
    rx: /fetch\(\s*['"`]https:\/\/management\.azure\.com\b/i,
    reason: 'Direct Azure Management REST fetch is forbidden. Use the Azure connector or a custom connector.',
  },
  {
    rx: /fetch\(\s*['"`]https:\/\/login\.microsoftonline\.com\b/i,
    reason: 'Direct AAD login fetch is forbidden. Auth is handled by the template (`expo-msal-intune` / `expo-auth-session`).',
  },
  {
    rx: /fetch\(\s*['"`]https:\/\/[^'"`]+\.crm(?:\d+)?\.dynamics\.com\b/i,
    reason: 'Direct Dataverse REST fetch is forbidden. Use the Dataverse generated service via `npx power-apps add-data-source --api-id dataverse --org-url <env-url> --resource-name <table-logical-name>` from the app root.',
  },
];

function isWriteTool(t) {
  return t === 'Write' || t === 'Edit' || t === 'MultiEdit';
}
function isWatched(fp) {
  if (typeof fp !== 'string' || !WATCHED_EXT.test(fp)) return false;

  const resolved = path.resolve(fp);
  const pluginRootValue = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
  const pluginRoot = pluginRootValue ? path.resolve(pluginRootValue) : null;
  if (pluginRoot && (resolved === pluginRoot || resolved.startsWith(pluginRoot + path.sep))) return false;

  const norm = fp.replace(/\\/g, '/');
  if (/\/node_modules\//.test(norm)) return false;
  if (/\/src\/generated\//.test(norm)) return false;
  if (/\/shared\/samples\//.test(norm)) return false;
  if (/\/\.expo\//.test(norm) || /\/dist\//.test(norm) || /\/build\//.test(norm)) return false;

  return /\/app\//.test(norm) || /\/src\//.test(norm);
}

function getContent(toolName, toolInput) {
  if (toolName === 'Write' && typeof toolInput.content === 'string') return toolInput.content;
  if (toolName === 'Edit' && typeof toolInput.new_string === 'string') return toolInput.new_string;
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits.map((e) => (e && e.new_string) || '').join('\n');
  }
  const fp = toolInput.file_path || toolInput.filePath;
  if (typeof fp === 'string' && fs.existsSync(fp)) {
    try {
      return fs.readFileSync(fp, 'utf8');
    } catch {
      return '';
    }
  }
  return '';
}

let buf = '';
process.stdin.on('data', (c) => (buf += c));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(buf || '{}');
  } catch {
    process.exit(0);
  }
  const toolName = input.tool_name || input.toolName;
  const toolInput = input.tool_input || input.toolInput || {};
  if (!isWriteTool(toolName)) process.exit(0);
  const fp = toolInput.file_path || toolInput.filePath;
  if (!isWatched(fp)) process.exit(0);
  const content = getContent(toolName, toolInput);
  if (!content) process.exit(0);

  const hits = [];
  for (const { rx, reason } of VIOLATIONS) {
    if (rx.test(content)) hits.push(reason);
  }
  if (hits.length === 0) process.exit(0);

  const rel = path.relative(process.cwd(), fp) || fp;
  const lines = [`BLOCKED: connector-first rule violated in ${rel}`, ''];
  for (const h of hits) lines.push(`  - ${h}`);
  lines.push('');
  lines.push('Power Platform data MUST go through generated connector services in `src/generated/`. Add the connector via `npx power-apps add-data-source`, then import the typed client.');
  process.stderr.write(lines.join('\n') + '\n');
  process.exit(2);
});
