#!/usr/bin/env node

// Creates a table permission YAML file for Power Pages code sites.
// Generates UUID, validates inputs, writes correctly-formatted YAML in code site git format.
//
// Usage:
//   node create-table-permission.js --projectRoot <path> --permissionName <string> --tableName <string>
//     --webRoleIds <csv> --scope <string> [--read] [--create] [--write] [--delete] [--append] [--appendto]
//     [--parentPermissionId <uuid>] [--parentRelationshipName <string>]
//
// Scope accepts friendly names (Global, Contact, Account, Parent, Self) or numeric codes (756150000-756150004).
//
// Output (JSON to stdout):
//   { "id": "<uuid>", "filePath": "<path>" }
//
// Exits with code 1 on validation errors (messages to stderr).

const fs = require('fs');
const path = require('path');
const generateUuid = require('./generate-uuid');

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
const permissionName = getArg('permissionName');
const tableName = getArg('tableName');
const webRoleIdsRaw = getArg('webRoleIds');
const scopeRaw = getArg('scope');
const parentPermissionId = getArg('parentPermissionId');
const parentRelationshipName = getArg('parentRelationshipName');

// --- Constants ---

const SCOPE_MAP = {
  'global': 756150000,
  'contact': 756150001,
  'account': 756150002,
  'parent': 756150003,
  'self': 756150004,
};

const VALID_SCOPE_CODES = new Set(Object.values(SCOPE_MAP));

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Validation ---

if (!projectRoot || !permissionName || !tableName || !webRoleIdsRaw || !scopeRaw) {
  console.error('Usage: node create-table-permission.js --projectRoot <path> --permissionName <string> --tableName <string> --webRoleIds <csv> --scope <string> [--read] [--create] [--write] [--delete] [--append] [--appendto] [--parentPermissionId <uuid>] [--parentRelationshipName <string>]');
  process.exit(1);
}

// Parse and validate web role IDs
const webRoleIds = webRoleIdsRaw.split(',').map(id => id.trim()).filter(Boolean);
for (const roleId of webRoleIds) {
  if (!UUID_REGEX.test(roleId)) {
    console.error(`Error: Invalid UUID in --webRoleIds: "${roleId}"`);
    process.exit(1);
  }
}
if (webRoleIds.length === 0) {
  console.error('Error: --webRoleIds must contain at least one UUID');
  process.exit(1);
}

// Parse and validate scope
let scopeCode;
const scopeLower = scopeRaw.toLowerCase();
if (SCOPE_MAP[scopeLower] !== undefined) {
  scopeCode = SCOPE_MAP[scopeLower];
} else {
  const parsed = parseInt(scopeRaw, 10);
  if (isNaN(parsed) || !VALID_SCOPE_CODES.has(parsed)) {
    console.error(`Error: Invalid --scope "${scopeRaw}". Use: Global, Contact, Account, Parent, Self, or numeric code (756150000-756150004)`);
    process.exit(1);
  }
  scopeCode = parsed;
}

// Validate parent scope requirements
if (scopeCode === 756150003) {
  if (!parentPermissionId) {
    console.error('Error: --parentPermissionId is required when scope is Parent (756150003)');
    process.exit(1);
  }
  if (!UUID_REGEX.test(parentPermissionId)) {
    console.error(`Error: Invalid UUID in --parentPermissionId: "${parentPermissionId}"`);
    process.exit(1);
  }
  if (!parentRelationshipName) {
    console.error('Error: --parentRelationshipName is required when scope is Parent (756150003)');
    process.exit(1);
  }
}

// Validate target directory
const tablePermissionsDir = path.join(projectRoot, '.powerpages-site', 'table-permissions');
if (!fs.existsSync(tablePermissionsDir)) {
  console.error(`Error: Table permissions directory not found at ${tablePermissionsDir}`);
  console.error('The site must be deployed at least once before table permissions can be created.');
  process.exit(1);
}

// --- Build YAML ---

const uuid = generateUuid();

// Build fields object (alphabetically sorted keys)
const fields = {};
fields['adx_entitypermission_webrole'] = null; // special array handling
fields['append'] = hasFlag('append');
fields['appendto'] = hasFlag('appendto');
fields['create'] = hasFlag('create');
fields['delete'] = hasFlag('delete');
fields['entitylogicalname'] = tableName;
fields['entityname'] = permissionName;
fields['id'] = uuid;

if (scopeCode === 756150003) {
  fields['parententitypermission'] = parentPermissionId;
  fields['parentrelationshipname'] = parentRelationshipName;
}

fields['read'] = hasFlag('read');
fields['scope'] = scopeCode;
fields['write'] = hasFlag('write');

// Write YAML with alphabetically sorted keys
// Special handling for adx_entitypermission_webrole (array with - prefix items)
function writeTablePermissionYaml(fields, webRoleIds) {
  const lines = [];
  const keys = Object.keys(fields).sort();
  for (const key of keys) {
    if (key === 'adx_entitypermission_webrole') {
      lines.push('adx_entitypermission_webrole:');
      for (const roleId of webRoleIds) {
        lines.push(`- ${roleId}`);
      }
    } else {
      lines.push(`${key}: ${fields[key]}`);
    }
  }
  return lines.join('\n') + '\n';
}

const yamlContent = writeTablePermissionYaml(fields, webRoleIds);

// File name: collapse spaces and hyphens into single hyphens
// "Product - Anonymous Read" → "Product-Anonymous-Read.tablepermission.yml"
const fileName = `${permissionName.replace(/[\s-]+/g, '-')}.tablepermission.yml`;
const filePath = path.join(tablePermissionsDir, fileName);

fs.writeFileSync(filePath, yamlContent, 'utf8');

const result = { id: uuid, filePath: filePath };
process.stdout.write(JSON.stringify(result));
