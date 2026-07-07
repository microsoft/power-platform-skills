/**
 * Registry of skills that have a PostToolUse validator.
 *
 * Add an entry when you ship a new validator script under the skill's
 * directory. The hook (hooks/run-skill-posttool-validation.js) reads this
 * file to decide whether to run anything after a Skill tool call.
 *
 * Validators are plain Node scripts that:
 *   - read JSON-encoded tool_input on stdin
 *   - run their checks (file existence, schema validation, type-check, etc.)
 *   - print human-readable output to stdout / stderr
 *   - exit 0 on success, non-zero to fail the calling skill
 *
 * v0 ships with no validators yet. Add them as the skills mature.
 */

const TRACKED_SKILLS = {
  'create-mobile-app': {},
  'setup-auth': {},
  'add-dataverse': {},
  'setup-datamodel': {},
  'add-connector': {},
  'add-native': {},
  'list-connections': {},
  'edit-app': {},
  'deploy': {},
  'report-issue': {},
};

function detectTrackedSkill(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (TRACKED_SKILLS[trimmed]) return trimmed;

  // Strip leading slash and optional plugin prefix: /add-dataverse, /mobile-app:add-dataverse
  const normalized = trimmed.replace(/^\/?(?:mobile-app:)?/, '').toLowerCase();
  if (TRACKED_SKILLS[normalized]) return normalized;

  // Fall back to searching for mobile-app:<skill> anywhere in the string
  const commandMatch = trimmed.match(/mobile-app:([a-z0-9-]+)/i);
  if (!commandMatch) return null;

  const skillName = commandMatch[1].toLowerCase();
  return TRACKED_SKILLS[skillName] ? skillName : null;
}

function getTrackedSkillFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;

  for (const field of ['skill', 'skill_name', 'skillName', 'name', 'commandName', 'command']) {
    const skillName = detectTrackedSkill(toolInput[field]);
    if (skillName) return skillName;
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
