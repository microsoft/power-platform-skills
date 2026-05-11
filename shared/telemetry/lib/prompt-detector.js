"use strict";

function detectSlashCommand(promptText, { pluginName, trackedSkills } = {}) {
  if (typeof promptText !== "string" || !promptText) return null;
  if (!pluginName || !trackedSkills) return null;

  const escapedPlugin = pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    String.raw`^\s*\/` + escapedPlugin + String.raw`:([a-z0-9-]+)(?=\s|$|\r|\n)`
  );
  const match = promptText.match(re);
  if (!match) return null;

  const skillName = match[1];
  return Object.prototype.hasOwnProperty.call(trackedSkills, skillName)
    ? skillName
    : null;
}

module.exports = { detectSlashCommand };
