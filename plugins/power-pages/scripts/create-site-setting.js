#!/usr/bin/env node

// Creates a site setting YAML file for Power Pages code sites.
// Generates UUID, validates inputs, writes correctly-formatted YAML.
//
// Usage:
//   node create-site-setting.js --projectRoot <path> --name <string> --value <string> --description <string> [--type <boolean|string>]
//
// Output (JSON to stdout):
//   { "id": "<uuid>", "filePath": "<path>" }
//
// Exits with code 1 on validation errors (messages to stderr).

const fs = require('fs');
const path = require('path');
const generateUuid = require('./generate-uuid');

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

// --- Validation ---

if (!projectRoot || !settingName || settingValue === null || settingValue === undefined || !description) {
  console.error('Usage: node create-site-setting.js --projectRoot <path> --name <string> --value <string> --description <string> [--type <boolean|string>]');
  process.exit(1);
}

if (valueType !== 'boolean' && valueType !== 'string') {
  console.error(`Error: --type must be "boolean" or "string", got "${valueType}"`);
  process.exit(1);
}

if (valueType === 'boolean' && settingValue !== 'true' && settingValue !== 'false') {
  console.error(`Error: --value must be "true" or "false" when --type is "boolean", got "${settingValue}"`);
  process.exit(1);
}

const siteSettingsDir = path.join(projectRoot, '.powerpages-site', 'site-settings');
if (!fs.existsSync(siteSettingsDir)) {
  console.error(`Error: Site settings directory not found at ${siteSettingsDir}`);
  console.error('The site must be deployed at least once before site settings can be created.');
  process.exit(1);
}

// --- Helpers ---

function writeYaml(fields) {
  const keys = Object.keys(fields).sort();
  return keys.map(k => `${k}: ${fields[k]}`).join('\n') + '\n';
}

// --- Create site setting ---

const uuid = generateUuid();

const fields = {
  description: description,
  id: uuid,
  name: settingName,
  value: valueType === 'boolean' ? (settingValue === 'true') : settingValue,
};

const yamlContent = writeYaml(fields);

// File name: replace / with - (e.g., "Webapi/cra5b_product/enabled" → "Webapi-cra5b_product-enabled.sitesetting.yml")
const fileName = `${settingName.replace(/\//g, '-')}.sitesetting.yml`;
const filePath = path.join(siteSettingsDir, fileName);

fs.writeFileSync(filePath, yamlContent, 'utf8');

const result = { id: uuid, filePath: filePath };
process.stdout.write(JSON.stringify(result));
