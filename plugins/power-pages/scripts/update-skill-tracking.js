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
const { randomBytes } = require('crypto');

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

// --- Helpers ---

function generateUuid() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseYaml(content) {
  const fields = {};
  for (const line of content.split('\n')) {
    const sep = line.indexOf(': ');
    if (sep !== -1) {
      fields[line.slice(0, sep)] = line.slice(sep + 2);
    }
  }
  return fields;
}

function writeYaml(fields) {
  const keys = Object.keys(fields).sort();
  return keys.map(k => `${k}: ${fields[k]}`).join('\n') + '\n';
}

// --- Skill counter setting ---

const skillSettingName = `Site/AI/${skillName}`;
const skillFileName = `Site-AI-${skillName}.sitesetting.yml`;
const skillFilePath = path.join(siteSettingsDir, skillFileName);

if (fs.existsSync(skillFilePath)) {
  const existing = parseYaml(fs.readFileSync(skillFilePath, 'utf8'));
  const currentValue = parseInt(existing.value, 10) || 0;
  existing.value = String(currentValue + 1);
  fs.writeFileSync(skillFilePath, writeYaml(existing), 'utf8');
  console.log(`Updated ${skillSettingName} counter to ${existing.value}`);
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

const authoringFileName = 'Site-AI-AuthoringTool.sitesetting.yml';
const authoringFilePath = path.join(siteSettingsDir, authoringFileName);

if (!fs.existsSync(authoringFilePath)) {
  const fields = {
    description: 'Records which AI authoring tool was used',
    id: generateUuid(),
    name: 'Site/AI/AuthoringTool',
    value: normalizedAuthoringTool
  };
  fs.writeFileSync(authoringFilePath, writeYaml(fields), 'utf8');
  console.log(`Created Site/AI/AuthoringTool setting (value: ${normalizedAuthoringTool})`);
} else {
  console.log('Site/AI/AuthoringTool setting already exists — preserved');
}
