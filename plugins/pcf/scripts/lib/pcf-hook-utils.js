'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readUtf8Stream } = require('./utf8-stream.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

function discoverTrackedSkills() {
  // A null prototype prevents inherited names such as constructor/__proto__
  // from masquerading as installed skills during bracket-based membership tests.
  const tracked = Object.create(null);
  if (!fs.existsSync(SKILLS_DIR)) return tracked;
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    // Checking or changing telemetry must never emit telemetry about itself.
    if (entry.isDirectory() && entry.name !== 'telemetry'
      && fs.existsSync(path.join(SKILLS_DIR, entry.name, 'SKILL.md'))) {
      tracked[entry.name] = {};
    }
  }
  return tracked;
}

const TRACKED_SKILLS = discoverTrackedSkills();

function detectTrackedSkill(value) {
  if (typeof value !== 'string') return null;
  // Hosts surface pcf, /pcf, pcf:pcf or /pcf:pcf. Other plugin namespaces
  // remain intact and therefore cannot match this plugin's discovered skills.
  const skill = value.trim().replace(/^\/?(?:pcf:)?/i, '').toLowerCase();
  return TRACKED_SKILLS[skill] ? skill : null;
}

function getTrackedSkillFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  for (const field of ['skill', 'skill_name', 'skillName', 'name', 'commandName', 'command']) {
    const skill = detectTrackedSkill(toolInput[field]);
    if (skill) return skill;
  }
  return null;
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : 'unknown';
  } catch {
    // Optional enrichment must never block a hook if an install is incomplete.
    return 'unknown';
  }
}

module.exports = { TRACKED_SKILLS, detectTrackedSkill, getTrackedSkillFromToolInput, readPluginVersion, readUtf8Stream };
