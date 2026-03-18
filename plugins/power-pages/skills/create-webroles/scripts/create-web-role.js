#!/usr/bin/env node

// Creates a web role YAML file for Power Pages code sites.
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

const webRolesDir = path.join(projectRoot, '.powerpages-site', 'web-roles');
if (!fs.existsSync(webRolesDir)) {
  console.error(`Error: Web roles directory not found at ${webRolesDir}`);
  console.error('The site must be deployed at least once before web roles can be created.');
  process.exit(1);
}

// --- Helpers ---

function writeYaml(fields) {
  const keys = Object.keys(fields).sort();
  return keys.map(k => `${k}: ${fields[k]}`).join('\n') + '\n';
}

// --- Create web role ---

const uuid = generateUuid();

const fields = {
  anonymoususersrole: isAnonymous,
  authenticatedusersrole: isAuthenticated,
  id: uuid,
  name: roleName,
};

const yamlContent = writeYaml(fields);

// File name: kebab-case with .yml extension (matching create-webroles skill convention)
const fileName = `${roleName.toLowerCase().replace(/\s+/g, '-')}.webrole.yml`;
const filePath = path.join(webRolesDir, fileName);

fs.writeFileSync(filePath, yamlContent, 'utf8');

const result = { id: uuid, filePath: filePath };
process.stdout.write(JSON.stringify(result));
