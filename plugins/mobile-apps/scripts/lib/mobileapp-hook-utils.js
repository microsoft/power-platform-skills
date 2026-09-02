'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

function readInvocationMetadata(skillFile) {
  let text;
  try {
    text = fs.readFileSync(skillFile, 'utf8');
  } catch {
    return null;
  }

  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return null;

  const values = Object.create(null);
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^([a-z][a-z0-9-]*):\s*(true|false)\s*(?:#.*)?$/i);
    if (match) values[match[1].toLowerCase()] = match[2].toLowerCase() === 'true';
  }

  return {
    userInvocable: values['user-invocable'],
    disableModelInvocation: values['disable-model-invocation'],
  };
}

function isInvocable(metadata) {
  if (!metadata) return false;
  return metadata.userInvocable === true ||
    (metadata.userInvocable === false && metadata.disableModelInvocation !== true);
}

function discoverTrackedSkills() {
  const tracked = new Set();
  let entries;
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return tracked;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (isInvocable(readInvocationMetadata(skillFile))) tracked.add(entry.name);
  }
  return tracked;
}

const TRACKED_SKILLS = discoverTrackedSkills();
const TRACKED_SKILL_NAMES = Object.freeze([...TRACKED_SKILLS]);

// A Set lookup also keeps inherited names such as `toString` from matching.
function trackedName(name) {
  const normalized = String(name || '').toLowerCase();
  return TRACKED_SKILLS.has(normalized) ? normalized : null;
}

function detectTrackedSkill(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();

  const namespaced = trimmed.match(/(?:^|\s)\/?mobile-app:([a-z0-9-]+)(?=\s|$)/i);
  if (namespaced) return trackedName(namespaced[1]);

  const bare = trimmed.match(/^\/?([a-z0-9-]+)(?=\s|$)/i);
  return bare ? trackedName(bare[1]) : null;
}

function getTrackedSkillFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  for (const field of ['skill', 'skill_name', 'skillName', 'name', 'commandName', 'command']) {
    const skillName = detectTrackedSkill(toolInput[field]);
    if (skillName) return skillName;
  }

  try {
    const namespaced = JSON.stringify(toolInput).match(/\/?mobile-app:([a-z0-9-]+)/i);
    return namespaced ? trackedName(namespaced[1]) : null;
  } catch {
    return null;
  }
}

function getTrackedSkillFromPrompt(prompt) {
  if (typeof prompt !== 'string') return null;

  // Copilot CLI expands a manual slash command before the hook runs and emits no
  // Skill pre-tool event, so the raw `/mobile-app:<skill>` text never arrives:
  //   <skill-context name="add-connector">\n<instructions>...
  const expanded = prompt.match(/^\s*<skill-context\s+name="(?:mobile-app:)?([a-z0-9-]+)"/i);
  if (expanded) return trackedName(expanded[1]);

  const command = prompt.match(/^\s*(\/(?:mobile-app:)?[a-z0-9-]+)(?=\s|$)/i);
  return command ? detectTrackedSkill(command[1]) : null;
}

module.exports = {
  TRACKED_SKILL_NAMES,
  detectTrackedSkill,
  getTrackedSkillFromPrompt,
  getTrackedSkillFromToolInput,
  isInvocable,
  readInvocationMetadata,
};