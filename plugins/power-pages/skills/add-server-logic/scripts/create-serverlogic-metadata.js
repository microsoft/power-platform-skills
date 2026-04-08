#!/usr/bin/env node

// Creates a server logic metadata YAML file for Power Pages code sites.
// Generates UUID, validates inputs, and writes correctly-formatted YAML.
//
// Usage:
//   node create-serverlogic-metadata.js --projectRoot <path> --name <string> --displayName <string> --description <string> --webRoleIds <csv>
//
// Output (JSON to stdout):
//   { "id": "<uuid>", "filePath": "<path>" }
//
// Exits with code 1 on validation errors (messages to stderr).

const fs = require('fs');
const path = require('path');
const generateUuid = require(path.join(__dirname, '..', '..', '..', 'scripts', 'generate-uuid'));

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const projectRoot = getArg('projectRoot');
const endpointName = getArg('name')?.trim() || null;
const displayName = getArg('displayName')?.trim() || null;
const description = getArg('description')?.trim() || null;
const webRoleIdsRaw = getArg('webRoleIds');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!projectRoot || !endpointName || !displayName || !description || !webRoleIdsRaw) {
  console.error('Usage: node create-serverlogic-metadata.js --projectRoot <path> --name <string> --displayName <string> --description <string> --webRoleIds <csv>');
  process.exit(1);
}

// Validate endpointName is a safe slug (no path separators or traversal)
if (!/^[a-zA-Z0-9_-]+$/.test(endpointName)) {
  console.error(`Error: --name must be a safe slug (alphanumeric, hyphens, underscores only). Got: "${endpointName}"`);
  process.exit(1);
}

const webRoleIds = webRoleIdsRaw.split(',').map(id => id.trim()).filter(Boolean);
if (webRoleIds.length === 0) {
  console.error('Error: --webRoleIds must contain at least one UUID');
  process.exit(1);
}

for (const roleId of webRoleIds) {
  if (!UUID_REGEX.test(roleId)) {
    console.error(`Error: Invalid UUID in --webRoleIds: "${roleId}"`);
    process.exit(1);
  }
}

const serverLogicDir = path.join(projectRoot, '.powerpages-site', 'server-logic', endpointName);
if (!fs.existsSync(serverLogicDir)) {
  console.error(`Error: Server logic directory not found at ${serverLogicDir}`);
  console.error('Create the server logic folder and JavaScript file before generating metadata.');
  process.exit(1);
}

const serverLogicScriptPath = path.join(serverLogicDir, `${endpointName}.js`);
if (!fs.existsSync(serverLogicScriptPath)) {
  console.error(`Error: Server logic JavaScript file not found at ${serverLogicScriptPath}`);
  console.error('Create the server logic JavaScript file before generating metadata.');
  process.exit(1);
}

const filePath = path.join(serverLogicDir, `${endpointName}.serverlogic.yml`);
if (fs.existsSync(filePath)) {
  console.error(`Error: Server logic metadata file already exists at ${filePath}`);
  process.exit(1);
}

const uuid = generateUuid();

// Serialize a string value safely for YAML: always single-quote, escaping internal single quotes.
// Rejects newlines since single-quoted YAML scalars cannot span lines without breaking structure.
function yamlStr(val) {
  if (/[\r\n]/.test(val)) {
    console.error(`Error: Value contains newline characters which are not supported in single-line YAML fields: "${val.slice(0, 50)}..."`);
    process.exit(1);
  }
  return "'" + val.replace(/'/g, "''") + "'";
}

const yamlContent = [
  'adx_serverlogic_adx_webrole:',
  ...webRoleIds.map(id => `  - ${id}`),
  `description: ${yamlStr(description)}`,
  `display_name: ${yamlStr(displayName)}`,
  `id: ${uuid}`,
  `name: ${endpointName}`,
  '',
].join('\n');

fs.writeFileSync(filePath, yamlContent, 'utf8');
process.stdout.write(JSON.stringify({ id: uuid, filePath }));
