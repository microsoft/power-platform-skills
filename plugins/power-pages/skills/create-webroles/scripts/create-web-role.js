#!/usr/bin/env node

// Creates a web role YAML file for Power Pages SPA or non-SPA sites.
// Generates UUID, validates inputs, writes correctly-formatted YAML.
//
// Usage:
//   node create-web-role.js --projectRoot <path> --name <string> [--anonymous] [--authenticated]
//
// Output (JSON to stdout):
//   { "id": "<uuid>", "filePath": "<path>" }
//
// Exits with code 1 on validation errors (messages to stderr).

const fs = require('fs');
const path = require('path');
const generateUuid = require(path.join(__dirname, '..', '..', '..', 'scripts', 'generate-uuid'));
const { parseSimpleYaml } = require(path.join(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'lib',
  'powerpages-config'
));
const {
  appendAggregateRecord,
  detectMetadataLayout,
  loadAggregateRecords,
  normalizeWebRole,
} = require(path.join(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'lib',
  'non-spa-metadata'
));

// --- CLI arg parsing ---

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

const projectRoot = getArg('projectRoot');
const roleName = getArg('name');
const isAnonymous = hasFlag('anonymous');
const isAuthenticated = hasFlag('authenticated');

// --- Validation ---

if (!projectRoot || !roleName) {
  console.error('Usage: node create-web-role.js --projectRoot <path> --name <string> [--anonymous] [--authenticated]');
  process.exit(1);
}

let layout;
try {
  layout = detectMetadataLayout(projectRoot);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

// --- Helpers ---

function writeYaml(fields) {
  const keys = Object.keys(fields).sort();
  return keys.map(k => `${k}: ${fields[k]}`).join('\n') + '\n';
}

function loadPerRecordRoles(filePaths) {
  return filePaths.map(filePath => normalizeWebRole(
    parseSimpleYaml(fs.readFileSync(filePath, 'utf8'), filePath)
  ));
}

// --- Create web role ---

if (layout.roles.mode === 'mixed') {
  console.error(
    `Error: Mixed web-role serialization detected under ${layout.siteRoot}. ` +
    'Resolve webrole.yml versus web-roles/*.webrole.yml before creating a role.'
  );
  process.exit(1);
}
if (layout.roles.mode === 'missing') {
  try {
    fs.mkdirSync(layout.roles.directory, { recursive: true });
    layout.roles.mode = 'per-record';
    layout.roles.files = [];
  } catch (error) {
    console.error(
      `Error: Failed to initialize per-record web-role storage at ${layout.roles.directory}. ` +
      error.message
    );
    process.exit(1);
  }
}

let existingRoles;
try {
  existingRoles = layout.roles.mode === 'aggregate'
    ? loadAggregateRecords(layout.roles.aggregateFile).map(normalizeWebRole)
    : loadPerRecordRoles(layout.roles.files);
} catch (error) {
  console.error(`Error: Failed to read existing web roles. ${error.message}`);
  process.exit(1);
}

const duplicate = existingRoles.find(
  role => typeof role.name === 'string' && role.name.toLowerCase() === roleName.toLowerCase()
);
if (duplicate) {
  console.error(`Error: A web role named "${roleName}" already exists (ID: ${duplicate.id}).`);
  process.exit(1);
}
if (isAnonymous && existingRoles.some(role => role.anonymoususersrole === true)) {
  console.error('Error: A web role already has anonymous-users status. Only one anonymous role is allowed.');
  process.exit(1);
}
if (isAuthenticated && existingRoles.some(role => role.authenticatedusersrole === true)) {
  console.error('Error: A web role already has authenticated-users status. Only one authenticated role is allowed.');
  process.exit(1);
}

const uuid = generateUuid();

if (layout.roles.mode === 'aggregate') {
  const fields = {
    adx_anonymoususersrole: isAnonymous,
    adx_authenticatedusersrole: isAuthenticated,
    adx_name: roleName,
    adx_webroleid: uuid,
  };
  try {
    appendAggregateRecord(
      layout.roles.aggregateFile,
      fields,
      [
        'adx_anonymoususersrole',
        'adx_authenticatedusersrole',
        'adx_name',
        'adx_webroleid',
      ]
    );
  } catch (error) {
    console.error(`Error: Failed to append web role to ${layout.roles.aggregateFile}. ${error.message}`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    id: uuid,
    filePath: layout.roles.aggregateFile,
    storage: 'aggregate',
  }));
  process.exit(0);
}

const fields = {
  anonymoususersrole: isAnonymous,
  authenticatedusersrole: isAuthenticated,
  id: uuid,
  name: roleName,
};

const yamlContent = writeYaml(fields);

// File name: kebab-case with .yml extension (matching create-webroles skill convention)
const fileName = `${roleName.toLowerCase().replace(/\s+/g, '-')}.webrole.yml`;
const filePath = path.join(layout.roles.directory, fileName);

fs.writeFileSync(filePath, yamlContent, 'utf8');

const result = { id: uuid, filePath: filePath, storage: 'per-record' };
process.stdout.write(JSON.stringify(result));
