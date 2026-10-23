#!/usr/bin/env node

// Updates skill usage tracking site settings for Power Pages SPA or non-SPA sites.
// Creates/increments a per-skill counter and records the authoring tool.
// Self-contained — no external dependencies required.
//
// Usage:
//   node update-skill-tracking.js --projectRoot <path> --skillName <PascalCase> --authoringTool <value>
//
// Exits silently (code 0) when per-record site-setting storage is not available.

const fs = require('fs');
const path = require('path');
const generateUuid = require('./generate-uuid');
const { loadSiteSettings, SITE_SETTING_FILE_SUFFIX } = require('./lib/powerpages-config');
const {
  detectMetadataLayout,
  loadAggregateRecords,
  normalizeSiteSetting,
  upsertAggregateRecord,
} = require('./lib/non-spa-metadata');
const { resolvePowerPagesSiteRoot } = require('./lib/validation-helpers');

// --- CLI arg parsing ---

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const projectRoot = getArg('projectRoot');
const skillName = getArg('skillName');
const authoringTool = getArg('authoringTool');

if (!projectRoot || !skillName || !authoringTool) {
  console.error('Usage: node update-skill-tracking.js --projectRoot <path> --skillName <PascalCase> --authoringTool <value>');
  process.exit(1);
}

// --- Normalize authoring tool name to PascalCase ---

function normalizeAuthoringTool(raw) {
  const lower = raw.toLowerCase();
  if (lower.includes('claude')) return 'ClaudeCode';
  if (lower.includes('github') || lower.includes('copilot')) return 'GitHubCopilot';
  return raw;
}

const normalizedAuthoringTool = normalizeAuthoringTool(authoringTool);

// --- Resolve site-setting storage ---

const siteRoot = resolvePowerPagesSiteRoot(projectRoot);
if (!siteRoot) {
  // Site metadata is not available yet — nothing to do
  process.exit(0);
}

let layout;
try {
  layout = detectMetadataLayout(projectRoot);
} catch (error) {
  console.error(`Error: Failed to resolve site-setting storage. ${error.message}`);
  process.exit(1);
}

if (layout.settings.mode === 'missing') {
  process.exit(0);
}
if (layout.settings.mode === 'mixed') {
  console.error(
    `Error: Mixed site-setting serialization found at ${layout.siteRoot}; ` +
    'sitesetting.yml and site-settings/*.sitesetting.yml cannot be updated as one source.'
  );
  process.exit(1);
}

const skillSettingName = `Site/AI/Skills/${skillName}`;

if (layout.settings.mode === 'aggregate') {
  try {
    const records = loadAggregateRecords(layout.settings.aggregateFile);
    const settings = records.map(normalizeSiteSetting);
    const existingSkillSetting = settings.find(setting => setting.name === skillSettingName);
    const currentValue = parseInt(existingSkillSetting && existingSkillSetting.value, 10) || 0;
    const nextValue = String(currentValue + 1);

    upsertAggregateRecord(layout.settings.aggregateFile, {
      matchField: 'adx_name',
      matchValue: skillSettingName,
      fields: {
        adx_description: `Tracks usage count of the ${skillName} skill`,
        adx_name: skillSettingName,
        adx_sitesettingid: generateUuid(),
        adx_value: nextValue,
      },
      keyOrder: ['adx_description', 'adx_name', 'adx_sitesettingid', 'adx_value'],
      updates: { adx_value: nextValue },
    });
    console.log(
      existingSkillSetting
        ? `Updated ${skillSettingName} counter to ${nextValue}`
        : `Created ${skillSettingName} counter (value: 1)`
    );

    const authoringSettingName = 'Site/AI/Tools/AuthoringTool';
    const existingAuthoringSetting = settings.find(setting => setting.name === authoringSettingName);
    if (!existingAuthoringSetting) {
      upsertAggregateRecord(layout.settings.aggregateFile, {
        matchField: 'adx_name',
        matchValue: authoringSettingName,
        fields: {
          adx_description: 'Records which AI authoring tool was used',
          adx_name: authoringSettingName,
          adx_sitesettingid: generateUuid(),
          adx_value: normalizedAuthoringTool,
        },
        keyOrder: ['adx_description', 'adx_name', 'adx_sitesettingid', 'adx_value'],
        updates: {},
      });
      console.log(`Created ${authoringSettingName} setting (value: ${normalizedAuthoringTool})`);
    } else {
      console.log('Site/AI/Tools/AuthoringTool setting already exists — preserved');
    }
    process.exit(0);
  } catch (error) {
    console.error(`Error: Failed to update aggregate site settings. ${error.message}`);
    process.exit(1);
  }
}

const siteSettingsDir = layout.settings.directory;
let existingSiteSettings;
try {
  existingSiteSettings = loadSiteSettings(siteSettingsDir);
} catch (error) {
  console.error(`Error: Failed to read existing site settings. ${error.message}`);
  process.exit(1);
}

// --- Helpers ---

function writeYaml(fields) {
  const keys = Object.keys(fields).sort();
  return keys.map(k => `${k}: ${fields[k]}`).join('\n') + '\n';
}

// --- Skill counter setting ---

const skillFileName = `Site-AI-Skills-${skillName}${SITE_SETTING_FILE_SUFFIX}`;
const skillFilePath = path.join(siteSettingsDir, skillFileName);
const existingSkillSetting = existingSiteSettings.find(setting => setting.name === skillSettingName);

if (existingSkillSetting) {
  const currentValue = parseInt(existingSkillSetting.value, 10) || 0;
  const { filePath, ...yamlFields } = existingSkillSetting;
  yamlFields.value = String(currentValue + 1);
  fs.writeFileSync(filePath, writeYaml(yamlFields), 'utf8');
  console.log(`Updated ${skillSettingName} counter to ${yamlFields.value}`);
} else {
  const fields = {
    description: `Tracks usage count of the ${skillName} skill`,
    id: generateUuid(),
    name: skillSettingName,
    value: '1'
  };
  fs.writeFileSync(skillFilePath, writeYaml(fields), 'utf8');
  console.log(`Created ${skillSettingName} counter (value: 1)`);
}

// --- Authoring tool setting ---

const authoringFileName = `Site-AI-Tools-AuthoringTool${SITE_SETTING_FILE_SUFFIX}`;
const authoringFilePath = path.join(siteSettingsDir, authoringFileName);
const existingAuthoringSetting = existingSiteSettings.find(setting => setting.name === 'Site/AI/Tools/AuthoringTool');

if (!existingAuthoringSetting) {
  const fields = {
    description: 'Records which AI authoring tool was used',
    id: generateUuid(),
    name: 'Site/AI/Tools/AuthoringTool',
    value: normalizedAuthoringTool
  };
  fs.writeFileSync(authoringFilePath, writeYaml(fields), 'utf8');
  console.log(`Created Site/AI/Tools/AuthoringTool setting (value: ${normalizedAuthoringTool})`);
} else {
  console.log('Site/AI/Tools/AuthoringTool setting already exists — preserved');
}
