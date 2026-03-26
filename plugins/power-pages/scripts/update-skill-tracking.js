#!/usr/bin/env node

// Updates skill usage tracking site settings for Power Pages code sites.
// Creates/increments a per-skill counter and records the authoring tool.
// Self-contained — no external dependencies required.
//
// Usage:
//   node update-skill-tracking.js --projectRoot <path> --skillName <PascalCase> --authoringTool <value>
//
// Exits silently (code 0) if .powerpages-site/site-settings/ does not exist.

const fs = require('fs');
const path = require('path');
const generateUuid = require('./generate-uuid');
const { loadSiteSettings, SITE_SETTING_FILE_SUFFIX } = require('./lib/powerpages-config');

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

// --- Check for site-settings directory ---

const siteSettingsDir = path.join(projectRoot, '.powerpages-site', 'site-settings');
if (!fs.existsSync(siteSettingsDir)) {
  // Site has not been deployed yet — nothing to do
  process.exit(0);
}

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

const skillSettingName = `Site/AI/Skills/${skillName}`;
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
