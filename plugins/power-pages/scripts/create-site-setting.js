#!/usr/bin/env node

// Creates a site setting YAML file for Power Pages code sites.
// Generates UUID, validates inputs, writes correctly-formatted YAML.
//
// Usage:
//   node create-site-setting.js --projectRoot <path> --name <string> --value <string> --description <string> [--type <boolean|string>]
//   node create-site-setting.js --projectRoot <path> --name <string> --envVarSchema <string>
//
// Output (JSON to stdout):
//   { "id": "<uuid>", "filePath": "<path>" }
//
// Exits with code 1 on validation errors (messages to stderr).

const fs = require('fs');
const path = require('path');
const generateUuid = require('./generate-uuid');
const { loadSiteSettings, SITE_SETTING_FILE_SUFFIX } = require('./lib/powerpages-config');

// --- CLI arg parsing (same pattern as update-skill-tracking.js) ---

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const projectRoot = getArg('projectRoot');
const settingName = getArg('name');
const settingValue = getArg('value');
const description = getArg('description');
const valueType = getArg('type') || 'string';
const envVarSchema = getArg('envVarSchema');
const usesEnvironmentVariable = envVarSchema !== null;

// --- Validation ---

if (!projectRoot || !settingName) {
  console.error('Usage: node create-site-setting.js --projectRoot <path> --name <string> --value <string> --description <string> [--type <boolean|string>]');
  console.error('   or: node create-site-setting.js --projectRoot <path> --name <string> --envVarSchema <string>');
  process.exit(1);
}

if (usesEnvironmentVariable && (settingValue !== null || description !== null)) {
  console.error('Error: --envVarSchema cannot be combined with --value or --description.');
  process.exit(1);
}

if (usesEnvironmentVariable && String(envVarSchema).trim() === '') {
  console.error('Error: --envVarSchema must be a non-empty string.');
  process.exit(1);
}

if (!usesEnvironmentVariable && (settingValue === null || settingValue === undefined || !description)) {
  console.error('Usage: node create-site-setting.js --projectRoot <path> --name <string> --value <string> --description <string> [--type <boolean|string>]');
  console.error('   or: node create-site-setting.js --projectRoot <path> --name <string> --envVarSchema <string>');
  process.exit(1);
}

if (!usesEnvironmentVariable && valueType !== 'boolean' && valueType !== 'string') {
  console.error(`Error: --type must be "boolean" or "string", got "${valueType}"`);
  process.exit(1);
}

if (!usesEnvironmentVariable && valueType === 'boolean' && settingValue !== 'true' && settingValue !== 'false') {
  console.error(`Error: --value must be "true" or "false" when --type is "boolean", got "${settingValue}"`);
  process.exit(1);
}

const siteSettingsDir = path.join(projectRoot, '.powerpages-site', 'site-settings');
if (!fs.existsSync(siteSettingsDir)) {
  console.error(`Error: Site settings directory not found at ${siteSettingsDir}`);
  console.error('The site must be deployed at least once before site settings can be created.');
  process.exit(1);
}

let existingSiteSettings;
try {
  existingSiteSettings = loadSiteSettings(siteSettingsDir);
} catch (error) {
  console.error(`Error: Failed to read existing site settings. ${error.message}`);
  process.exit(1);
}

// --- Helpers ---

function needsQuoting(value) {
  if (typeof value !== 'string') return false;
  // Quote strings containing YAML-special characters: : # { } [ ] , & * ? | - < > = ! % @ ` or leading/trailing whitespace
  return /[:#{}[\],&*?|<>=!%@`]/.test(value) || value !== value.trim() || value === '' || value === 'true' || value === 'false' || value === 'null';
}

function yamlValue(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (needsQuoting(value)) return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return String(value);
}

function writeYaml(fields) {
  const keys = Object.keys(fields).sort();
  return keys.map(k => `${k}: ${yamlValue(fields[k])}`).join('\n') + '\n';
}

// --- Create site setting ---

const uuid = generateUuid();
const fileName = `${settingName.replace(/\//g, '-')}${SITE_SETTING_FILE_SUFFIX}`;

const existingSettingByName = existingSiteSettings.find(
  setting => typeof setting.name === 'string' && setting.name.toLowerCase() === settingName.toLowerCase()
);
if (existingSettingByName) {
  console.error(`Error: A site setting named "${settingName}" already exists (ID: ${existingSettingByName.id}) in ${existingSettingByName.filePath}.`);
  process.exit(1);
}

const existingSettingByFileName = existingSiteSettings.find(
  setting => path.basename(setting.filePath).toLowerCase() === fileName.toLowerCase()
);
if (existingSettingByFileName) {
  console.error(`Error: Site setting file "${fileName}" would collide with existing setting "${existingSettingByFileName.name}" in ${existingSettingByFileName.filePath}.`);
  process.exit(1);
}

const fields = usesEnvironmentVariable
  ? {
    envvar_schema: envVarSchema,
    id: uuid,
    name: settingName,
    source: 1,
  }
  : {
    description: description,
    id: uuid,
    name: settingName,
    value: valueType === 'boolean' ? (settingValue === 'true') : settingValue,
  };

const yamlContent = writeYaml(fields);

// File name: replace / with - (e.g., "Webapi/cra5b_product/enabled" → "Webapi-cra5b_product-enabled.sitesetting.yml")
const filePath = path.join(siteSettingsDir, fileName);

fs.writeFileSync(filePath, yamlContent, 'utf8');

const result = { id: uuid, filePath: filePath };
process.stdout.write(JSON.stringify(result));
