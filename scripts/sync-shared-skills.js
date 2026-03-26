#!/usr/bin/env node

/**
 * Syncs shared skills to targeted plugins.
 *
 * Each shared skill in shared/skills/<skill-name>/ has a config.json that
 * specifies which plugins it applies to:
 *   { "plugins": "*" }                           — all plugins (default if no config)
 *   { "plugins": ["power-pages", "code-apps"] }  — only listed plugins
 *
 * For each targeted plugin, copies SKILL.template.md → plugins/<plugin>/skills/<skill-name>/SKILL.md
 * with {{PLUGIN_NAME}} replaced by the plugin's name from plugin.json.
 *
 * Modes:
 *   --check   Report missing wrappers and exit 1 if any are found (CI mode).
 *   (default) Generate missing wrappers in place.
 *
 * Usage:
 *   node scripts/sync-shared-skills.js          # auto-generate missing wrappers
 *   node scripts/sync-shared-skills.js --check  # CI: fail if any are missing
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");
const SHARED_SKILLS_DIR = path.join(ROOT, "shared", "skills");

const checkOnly = process.argv.includes("--check");

function getDirectories(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// Read plugin name from plugin.json
function getPluginName(plugin) {
  const pluginJsonPath = path.join(PLUGINS_DIR, plugin, ".claude-plugin", "plugin.json");
  if (fs.existsSync(pluginJsonPath)) {
    try {
      const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8"));
      return pluginJson.name || plugin;
    } catch {
      return plugin;
    }
  }
  return plugin;
}

// Read config.json for a shared skill to determine target plugins
function getTargetPlugins(skill, allPlugins) {
  const configPath = path.join(SHARED_SKILLS_DIR, skill, "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.plugins === "*") {
        return allPlugins;
      }
      if (Array.isArray(config.plugins)) {
        // Match by plugin directory name or plugin.json name
        return allPlugins.filter((plugin) => {
          const pluginName = getPluginName(plugin);
          return config.plugins.includes(plugin) || config.plugins.includes(pluginName);
        });
      }
    } catch {
      // Fall through to default
    }
  }
  // Default: all plugins
  return allPlugins;
}

const sharedSkills = getDirectories(SHARED_SKILLS_DIR);
if (sharedSkills.length === 0) {
  console.log("No shared skills found in shared/skills/. Nothing to sync.");
  process.exit(0);
}

const allPlugins = getDirectories(PLUGINS_DIR);
if (allPlugins.length === 0) {
  console.log("No plugins found in plugins/. Nothing to sync.");
  process.exit(0);
}

const missing = [];

for (const skill of sharedSkills) {
  const targetPlugins = getTargetPlugins(skill, allPlugins);
  for (const plugin of targetPlugins) {
    const targetPath = path.join(PLUGINS_DIR, plugin, "skills", skill, "SKILL.md");
    if (!fs.existsSync(targetPath)) {
      missing.push({ plugin, skill, targetPath });
    }
  }
}

if (missing.length === 0) {
  console.log(
    `All plugins are in sync for all ${sharedSkills.length} shared skill(s).`
  );
  process.exit(0);
}

if (checkOnly) {
  console.error("Shared skill sync check failed!\n");
  console.error("The following plugins are missing shared skill wrappers:\n");
  for (const { plugin, skill } of missing) {
    console.error(`  - Plugin "${plugin}" is missing shared skill "${skill}"`);
  }
  console.error("\nRun 'node scripts/sync-shared-skills.js' to auto-generate them.");
  process.exit(1);
}

// Generate missing wrappers
for (const { plugin, skill, targetPath } of missing) {
  const templatePath = path.join(SHARED_SKILLS_DIR, skill, "SKILL.template.md");
  if (!fs.existsSync(templatePath)) {
    console.error(
      `  SKIP: No SKILL.template.md found for shared skill "${skill}" — expected at shared/skills/${skill}/SKILL.template.md`
    );
    continue;
  }

  const pluginName = getPluginName(plugin);
  const template = fs.readFileSync(templatePath, "utf-8");
  const content = template.replace(/\{\{PLUGIN_NAME\}\}/g, pluginName);
  const targetDir = path.dirname(targetPath);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, content, "utf-8");
  console.log(`  CREATED: plugins/${plugin}/skills/${skill}/SKILL.md (plugin: ${pluginName})`);
}

console.log(`\nSynced ${missing.length} shared skill wrapper(s).`);
