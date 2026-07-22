"use strict";

function detectSlashCommand(promptText, { pluginName, trackedSkills } = {}) {
  if (typeof promptText !== "string" || !promptText) return null;
  if (!pluginName || !trackedSkills) return null;

  // Match both the namespaced form (`/power-pages:add-seo`) and the bare form
  // (`/add-seo`). The `pluginName:` prefix is optional because the host tool
  // controls how the slash command is surfaced in the prompt and may emit the
  // bare form without the plugin namespace. Either way the captured skill name
  // is validated against trackedSkills below, so a bare `/foo` only counts when
  // `foo` is a known skill. The trailing boundary lookahead still rejects a
  // different plugin's namespaced command (e.g. `/other-plugin:add-seo`, where
  // `other-plugin` is followed by `:` rather than a word boundary).
  const escapedPlugin = pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    String.raw`^\s*\/(?:` + escapedPlugin + String.raw`:)?([a-z0-9-]+)(?=\s|$|\r|\n)`
  );
  const match = promptText.match(re);
  if (!match) return null;

  const skillName = match[1];
  return Object.prototype.hasOwnProperty.call(trackedSkills, skillName)
    ? skillName
    : null;
}

module.exports = { detectSlashCommand };
