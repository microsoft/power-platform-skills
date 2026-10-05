const fs = require("fs");
const path = require("path");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");

// Skills that must never emit usage telemetry about themselves. The telemetry
// control skill is excluded so checking/toggling telemetry does not self-emit.
const EXCLUDED_FROM_TRACKING = new Set(["telemetry"]);

function discoverTrackedSkills() {
  // Null-prototype map so inherited keys (toString/constructor/__proto__) don't
  // test truthy via bracket access.
  const trackedSkills = Object.create(null);
  let entries = [];
  try {
    entries = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return trackedSkills;
  }
  for (const entry of entries) {
    const skillName = entry.name;
    if (EXCLUDED_FROM_TRACKING.has(skillName)) continue;
    if (!fs.existsSync(path.join(SKILLS_DIR, skillName, "SKILL.md"))) continue;
    trackedSkills[skillName] = {};
  }
  return trackedSkills;
}

const TRACKED_SKILLS = discoverTrackedSkills();

function detectTrackedSkill(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (TRACKED_SKILLS[trimmed]) return trimmed;

  // Strip leading slash and optional plugin prefix: /create-flow, /power-automate:create-flow
  const normalized = trimmed.replace(/^\/?(?:power-automate:)?/, "").toLowerCase();
  if (TRACKED_SKILLS[normalized]) return normalized;

  // Fall back to searching for power-automate:<skill> anywhere in the string
  const commandMatch = trimmed.match(/power-automate:([a-z0-9-]+)/i);
  if (!commandMatch) return null;
  const skillName = commandMatch[1].toLowerCase();
  return TRACKED_SKILLS[skillName] ? skillName : null;
}

function getTrackedSkillFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  for (const field of ["skill", "skill_name", "skillName", "name", "commandName", "command"]) {
    const skillName = detectTrackedSkill(toolInput[field]);
    if (skillName) return skillName;
  }
  try {
    return detectTrackedSkill(JSON.stringify(toolInput));
  } catch {
    return null;
  }
}

module.exports = {
  TRACKED_SKILLS,
  detectTrackedSkill,
  getTrackedSkillFromToolInput,
};
