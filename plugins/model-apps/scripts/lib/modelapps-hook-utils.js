// Shared helpers for the model-apps plugin hooks. Mirrors the power-pages /
// mobile-apps `*-hook-utils.js` pattern: the list of "tracked" skills is derived
// at load time from the skills/*/SKILL.md directories so a new skill is picked up
// automatically without editing a hardcoded list.
//
// Why derive instead of hardcode: the PostToolUse validation hook and the
// telemetry hooks both need to answer "did the Skill tool just run one of OUR
// skills?" Deriving from disk keeps that answer correct as skills are added or
// removed, and keeps a single source of truth shared by every hook.

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

  // First `validate*.js` (sorted) wins. A skill without one is still tracked for
  // telemetry/detection but simply has no post-run validator.
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

  if (!fs.existsSync(SKILLS_DIR)) {
    return trackedSkills;
  }

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

  // Strip leading slash and optional plugin prefix: /genpage, model-apps:genpage,
  // /model-apps:genpage. Claude Code namespaces plugin skills as `plugin:skill`.
  const normalized = trimmed.replace(/^\/?(?:model-apps:)?/, '').toLowerCase();
  if (TRACKED_SKILLS[normalized]) {
    return normalized;
  }

  // Fall back to searching for model-apps:<skill> anywhere in the string.
  const commandMatch = trimmed.match(/model-apps:([a-z0-9-]+)/i);
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

  // The Skill tool surfaces the invoked skill under different keys across host
  // versions; probe the known ones, then fall back to scanning the serialized
  // input for a `model-apps:<skill>` command token.
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

// Ordered list of tracked skill names — used by the UserPromptSubmit telemetry
// hook to match a `/model-apps:<skill>` slash command in raw prompt text.
const TRACKED_SKILL_NAMES = Object.keys(TRACKED_SKILLS);

module.exports = {
  TRACKED_SKILLS,
  TRACKED_SKILL_NAMES,
  detectTrackedSkill,
  getTrackedSkillFromToolInput,
  getValidatorScript,
};
