#!/usr/bin/env node

// Creates a table permission YAML file for Power Pages code sites.
// Generates UUID, validates inputs, writes correctly-formatted YAML in code site git format.
//
// Usage:
//   node create-table-permission.js --projectRoot <path> --permissionName <string> --tableName <string>
//     --webRoleIds <csv> --scope <string> [--read] [--create] [--write] [--delete] [--append] [--appendto]
//     [--contactRelationshipName <string>] [--accountRelationshipName <string>]
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
const { loadTablePermissions, TABLE_PERMISSION_FILE_SUFFIX } = require('./lib/powerpages-config');

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
const permissionName = getArg('permissionName')?.trim() || null;
const tableName = getArg('tableName')?.trim() || null;
const webRoleIdsRaw = getArg('webRoleIds');
const scopeRaw = getArg('scope')?.trim() || null;
const contactRelationshipName = getArg('contactRelationshipName')?.trim() || null;
const accountRelationshipName = getArg('accountRelationshipName')?.trim() || null;
const parentPermissionId = getArg('parentPermissionId')?.trim() || null;
const parentRelationshipName = getArg('parentRelationshipName')?.trim() || null;

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
  console.error('Usage: node create-table-permission.js --projectRoot <path> --permissionName <string> --tableName <string> --webRoleIds <csv> --scope <string> [--read] [--create] [--write] [--delete] [--append] [--appendto] [--contactRelationshipName <string>] [--accountRelationshipName <string>] [--parentPermissionId <uuid>] [--parentRelationshipName <string>]');
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
if (scopeCode === 756150001) {
  if (!contactRelationshipName) {
    console.error(`Error: --contactRelationshipName is required when scope is Contact (756150001). Provide the lookup field from "${tableName}" to contact.`);
    if (tableName.toLowerCase() === 'contact') {
      console.error('For the contact table itself, use Self scope instead of Contact scope.');
    }
    process.exit(1);
  }
  if (tableName.toLowerCase() === 'contact') {
    console.error('Error: Contact scope is not valid for the contact table itself. Use Self scope instead.');
    process.exit(1);
  }
  if (accountRelationshipName || parentPermissionId || parentRelationshipName) {
    console.error('Error: Contact scope only supports --contactRelationshipName. Remove account/parent relationship arguments.');
    process.exit(1);
  }
}

if (scopeCode === 756150002) {
  if (!accountRelationshipName) {
    console.error(`Error: --accountRelationshipName is required when scope is Account (756150002). Provide the lookup field from "${tableName}" to account.`);
    process.exit(1);
  }
  if (contactRelationshipName || parentPermissionId || parentRelationshipName) {
    console.error('Error: Account scope only supports --accountRelationshipName. Remove contact/parent relationship arguments.');
    process.exit(1);
  }
}

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
  if (contactRelationshipName || accountRelationshipName) {
    console.error('Error: Parent scope does not support contact/account relationship arguments.');
    process.exit(1);
  }
}

if ((scopeCode === 756150000 || scopeCode === 756150004) &&
    (contactRelationshipName || accountRelationshipName || parentPermissionId || parentRelationshipName)) {
  console.error('Error: Global and Self scopes do not use relationship arguments.');
  process.exit(1);
}

// Validate target directory
const tablePermissionsDir = path.join(projectRoot, '.powerpages-site', 'table-permissions');
if (!fs.existsSync(tablePermissionsDir)) {
  console.error(`Error: Table permissions directory not found at ${tablePermissionsDir}`);
  console.error('The site must be deployed at least once before table permissions can be created.');
  process.exit(1);
}

let existingPermissions;
try {
  existingPermissions = loadTablePermissions(tablePermissionsDir);
} catch (error) {
  console.error(`Error: Failed to read existing table permissions. ${error.message}`);
  process.exit(1);
}

const existingPermissionByName = existingPermissions.find(
  permission => typeof permission.entityname === 'string' && permission.entityname.toLowerCase() === permissionName.toLowerCase()
);
if (existingPermissionByName) {
  console.error(`Error: A table permission named "${permissionName}" already exists (ID: ${existingPermissionByName.id}) in ${existingPermissionByName.filePath}.`);
  console.error('Use a unique permission name instead of overwriting an existing permission file.');
  process.exit(1);
}

if (scopeCode === 756150003) {
  const parentPermission = existingPermissions.find(permission => permission.id === parentPermissionId);
  if (!parentPermission) {
    console.error(`Error: Parent permission "${parentPermissionId}" was not found in ${tablePermissionsDir}.`);
    process.exit(1);
  }

  const parentRoleIds = new Set(Array.isArray(parentPermission.adx_entitypermission_webrole)
    ? parentPermission.adx_entitypermission_webrole.map(String)
    : []);
  const invalidRoleIds = webRoleIds.filter(roleId => !parentRoleIds.has(roleId));
  if (invalidRoleIds.length > 0) {
    console.error(`Error: Child permission roles must be a subset of the parent permission's roles. Invalid role IDs: ${invalidRoleIds.join(', ')}`);
    process.exit(1);
  }
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
  fields['parentrelationship'] = parentRelationshipName;
}

if (scopeCode === 756150001) {
  fields['contactrelationship'] = contactRelationshipName;
}

if (scopeCode === 756150002) {
  fields['accountrelationship'] = accountRelationshipName;
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
const fileName = `${permissionName.replace(/[\s-]+/g, '-')}${TABLE_PERMISSION_FILE_SUFFIX}`;
const filePath = path.join(tablePermissionsDir, fileName);

fs.writeFileSync(filePath, yamlContent, 'utf8');

const result = { id: uuid, filePath: filePath };
process.stdout.write(JSON.stringify(result));
