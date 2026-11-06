#!/usr/bin/env node

// Creates a site setting YAML file for Power Pages SPA or non-SPA sites.
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
const {
  appendAggregateRecord,
  detectMetadataLayout,
  loadAggregateRecords,
  normalizeSiteSetting,
} = require('./lib/non-spa-metadata');

// --- CLI arg parsing (same pattern as update-skill-tracking.js) ---

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const projectRoot = getArg('projectRoot');
const settingNameArg = getArg('name');
const settingName = settingNameArg === null ? null : settingNameArg.trim();
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

const isWebApiFieldsSetting = /^Webapi\/[^/]+\/fields$/i.test(settingName);
const hasWildcardField = !usesEnvironmentVariable
  && settingValue.split(',').some(column => column.trim() === '*');
if (isWebApiFieldsSetting && hasWildcardField) {
  // Power Pages stops supporting wildcard Web API field access on September 14, 2026.
  // Reject it here so generated site settings remain deployable after that cutoff.
  console.error('Error: Webapi/<table>/fields requires an explicit comma-separated column list. Use LogicalNames for ordinary columns, _<LogicalName>_value for lookup reads, and the exact Navigation Property before @odata.bind for lookup writes; wildcard field access is unsupported beginning September 14, 2026.');
  process.exit(1);
}

let layout;
try {
  layout = detectMetadataLayout(projectRoot);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
if (layout.settings.mode === 'mixed') {
  console.error(
    `Error: Mixed site-setting serialization detected under ${layout.siteRoot}. ` +
    'Resolve sitesetting.yml versus site-settings/*.sitesetting.yml before creating a setting.'
  );
  process.exit(1);
}
if (layout.settings.mode === 'missing') {
  console.error(`Error: No site-setting metadata storage was found under ${layout.siteRoot}.`);
  console.error('Download the site again with the explicit PAC model before creating settings.');
  process.exit(1);
}

let existingSiteSettings;
try {
  existingSiteSettings = layout.settings.mode === 'aggregate'
    ? loadAggregateRecords(layout.settings.aggregateFile).map(normalizeSiteSetting)
    : loadSiteSettings(layout.settings.directory);
} catch (error) {
  console.error(`Error: Failed to read existing site settings. ${error.message}`);
  process.exit(1);
}

// --- Helpers ---

function needsQuoting(value) {
  if (typeof value !== 'string') return false;

  // Empty string and the bareword-reserved values that YAML 1.2 reads as
  // booleans / null instead of as strings.
  if (value === '' || value === 'true' || value === 'false' || value === 'null') return true;

  // Leading/trailing whitespace (a leading tab would also be caught by the
  // leading-char check below — keeping this for clarity).
  if (value !== value.trim()) return true;

  // YAML-special characters anywhere in the value. Without quoting, these can
  // start comments (#), terminate scalars (:), open flow collections ([ { , ]),
  // start anchors/aliases/tags/directives (& * ! %), or be reserved/unsupported
  // (` @ < > = ?). Pipe and gt are block-scalar indicators.
  if (/[:#{}[\],&*?|<>=!%@`]/.test(value)) return true;

  // Leading characters that change parser semantics even when no other special
  // character appears in the value. These cases were missed by the
  // character-class check above:
  //   "-foo"  → ambiguous: parsers may interpret a leading "-" as a block
  //             sequence indicator or a numeric sign, depending on context.
  //   "'foo"  → leading single quote opens a quoted scalar that never closes.
  //   '"foo'  → leading double quote opens a quoted scalar that never closes.
  //   "\tfoo" → leading tab is not allowed by YAML 1.2 in plain scalars.
  // Quoting the entire value sidesteps every one of these.
  const first = value.charAt(0);
  if (first === '-' || first === "'" || first === '"' || first === '\t') return true;

  return false;
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
  setting => setting.filePath
    && path.basename(setting.filePath).toLowerCase() === fileName.toLowerCase()
);
if (existingSettingByFileName) {
  console.error(`Error: Site setting file "${fileName}" would collide with existing setting "${existingSettingByFileName.name}" in ${existingSettingByFileName.filePath}.`);
  process.exit(1);
}

if (layout.settings.mode === 'aggregate') {
  if (usesEnvironmentVariable) {
    console.error(
      'Error: Environment-variable-backed aggregate site settings are not yet verified. ' +
      'Create this setting through Power Pages Management and download the site again.'
    );
    process.exit(1);
  }

  const aggregateFields = {};
  if (description) {
    aggregateFields.adx_description = description;
  }
  aggregateFields.adx_name = settingName;
  aggregateFields.adx_sitesettingid = uuid;
  if (loadAggregateRecords(layout.settings.aggregateFile)
    .some(setting => Object.prototype.hasOwnProperty.call(setting, 'adx_source'))) {
    aggregateFields.adx_source = 0;
  }
  aggregateFields.adx_value = valueType === 'boolean' ? (settingValue === 'true') : settingValue;

  try {
    appendAggregateRecord(
      layout.settings.aggregateFile,
      aggregateFields,
      ['adx_description', 'adx_name', 'adx_sitesettingid', 'adx_source', 'adx_value']
    );
  } catch (error) {
    console.error(
      `Error: Failed to append site setting to ${layout.settings.aggregateFile}. ${error.message}`
    );
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({
    id: uuid,
    filePath: layout.settings.aggregateFile,
    storage: 'aggregate',
  }));
  process.exit(0);
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
const filePath = path.join(layout.settings.directory, fileName);

fs.writeFileSync(filePath, yamlContent, 'utf8');

const result = { id: uuid, filePath: filePath, storage: 'per-record' };
process.stdout.write(JSON.stringify(result));
