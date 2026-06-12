const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

// Skills that must never emit usage telemetry about themselves. The telemetry
// control skill is excluded so checking/toggling telemetry does not self-emit.
const EXCLUDED_FROM_TRACKING = new Set(['telemetry']);

function discoverValidatorScript(skillName) {
  const scriptsDir = path.join(SKILLS_DIR, skillName, 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    return null;
  }

  const validators = fs
    .readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^validate.*\.js$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (validators.length === 0) {
    return null;
  }

  return path.posix.join('skills', skillName, 'scripts', validators[0]);
}

function discoverTrackedSkills() {
  // Null-prototype map: membership is tested via bracket access (TRACKED_SKILLS[name]),
  // so a plain {} would make inherited keys like "toString"/"constructor"/"__proto__"
  // test truthy and emit bogus skill names. A null-proto object has no such keys.
  const trackedSkills = Object.create(null);

  const entries = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const skillName = entry.name;
    if (EXCLUDED_FROM_TRACKING.has(skillName)) {
      continue;
    }
    if (!fs.existsSync(path.join(SKILLS_DIR, skillName, 'SKILL.md'))) {
      continue;
    }

    const validatorScript = discoverValidatorScript(skillName);
    trackedSkills[skillName] = validatorScript ? { validatorScript } : {};
  }

  return trackedSkills;
}

const TRACKED_SKILLS = discoverTrackedSkills();

function detectTrackedSkill(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (TRACKED_SKILLS[trimmed]) {
    return trimmed;
  }

  // Strip leading slash and optional plugin prefix: /create-site, /power-pages:create-site
  const normalized = trimmed.replace(/^\/?(?:power-pages:)?/, '').toLowerCase();
  if (TRACKED_SKILLS[normalized]) {
    return normalized;
  }

  // Fall back to searching for power-pages:<skill> anywhere in the string
  const commandMatch = trimmed.match(/power-pages:([a-z0-9-]+)/i);
  if (!commandMatch) {
    return null;
  }

  const skillName = commandMatch[1].toLowerCase();
  return TRACKED_SKILLS[skillName] ? skillName : null;
}

function getTrackedSkillFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') {
    return null;
  }

  for (const field of ['skill', 'skill_name', 'skillName', 'name', 'commandName', 'command']) {
    const skillName = detectTrackedSkill(toolInput[field]);
    if (skillName) {
      return skillName;
    }
  }

  try {
    return detectTrackedSkill(JSON.stringify(toolInput));
  } catch {
    return null;
  }
}

function getValidatorScript(skillName) {
  return TRACKED_SKILLS[skillName]?.validatorScript ?? null;
}

module.exports = {
  TRACKED_SKILLS,
  detectTrackedSkill,
  getTrackedSkillFromToolInput,
  getValidatorScript,
};
