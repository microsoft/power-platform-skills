#!/usr/bin/env node

/**
 * Validate the repository's Codex packaging layer.
 *
 * The Claude/Open Plugins manifests intentionally remain separate because two
 * legacy package names do not match their folder names. Codex requires the
 * `.codex-plugin/plugin.json` name to match the package folder, so this validator
 * checks the Codex contract directly instead of treating it as another mirror.
 */

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const pluginsRoot = path.join(repoRoot, "plugins");
const marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
const errors = [];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${path.relative(repoRoot, filePath)}: ${error.message}`);
    return null;
  }
}

function requireString(value, field, filePath) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path.relative(repoRoot, filePath)}: ${field} must be a non-empty string`);
  }
}

const pluginFolders = fs
  .readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const marketplace = readJson(marketplacePath);
const marketplaceEntries = new Map();

if (marketplace) {
  requireString(marketplace.name, "name", marketplacePath);
  if (!Array.isArray(marketplace.plugins)) {
    errors.push(`${path.relative(repoRoot, marketplacePath)}: plugins must be an array`);
  } else {
    for (const entry of marketplace.plugins) {
      if (!entry || typeof entry !== "object" || typeof entry.name !== "string") {
        errors.push(`${path.relative(repoRoot, marketplacePath)}: every plugin entry needs a name`);
        continue;
      }
      marketplaceEntries.set(entry.name, entry);
    }
  }
}

for (const folderName of pluginFolders) {
  const pluginRoot = path.join(pluginsRoot, folderName);
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifest = readJson(manifestPath);

  if (!manifest) {
    continue;
  }

  if (manifest.name !== folderName) {
    errors.push(
      `${path.relative(repoRoot, manifestPath)}: name must match folder '${folderName}'`
    );
  }
  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    errors.push(`${path.relative(repoRoot, manifestPath)}: version must use semantic versioning`);
  }
  requireString(manifest.description, "description", manifestPath);
  requireString(manifest.author?.name, "author.name", manifestPath);

  if (manifest.skills !== "./skills/" || !fs.existsSync(path.join(pluginRoot, "skills"))) {
    errors.push(
      `${path.relative(repoRoot, manifestPath)}: skills must point to the existing './skills/' folder`
    );
  }

  if (typeof manifest.mcpServers === "string") {
    const mcpPath = path.resolve(pluginRoot, manifest.mcpServers);
    if (!fs.existsSync(mcpPath)) {
      errors.push(`${path.relative(repoRoot, manifestPath)}: mcpServers path does not exist`);
    }
  }

  const requiredInterfaceFields = [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
    "defaultPrompt",
  ];
  for (const field of requiredInterfaceFields) {
    requireString(manifest.interface?.[field], `interface.${field}`, manifestPath);
  }
  if (!Array.isArray(manifest.interface?.capabilities)) {
    errors.push(`${path.relative(repoRoot, manifestPath)}: interface.capabilities must be an array`);
  }

  const marketplaceEntry = marketplaceEntries.get(folderName);
  if (!marketplaceEntry) {
    errors.push(`${path.relative(repoRoot, marketplacePath)}: missing '${folderName}' entry`);
    continue;
  }
  const expectedSource = `./plugins/${folderName}`;
  if (
    marketplaceEntry.source?.source !== "local" ||
    marketplaceEntry.source?.path !== expectedSource
  ) {
    errors.push(
      `${path.relative(repoRoot, marketplacePath)}: '${folderName}' must use local source '${expectedSource}'`
    );
  }
  if (
    marketplaceEntry.policy?.installation !== "AVAILABLE" ||
    marketplaceEntry.policy?.authentication !== "ON_INSTALL"
  ) {
    errors.push(
      `${path.relative(repoRoot, marketplacePath)}: '${folderName}' has invalid default policy`
    );
  }
  requireString(marketplaceEntry.category, `${folderName}.category`, marketplacePath);
}

for (const entryName of marketplaceEntries.keys()) {
  if (!pluginFolders.includes(entryName)) {
    errors.push(
      `${path.relative(repoRoot, marketplacePath)}: entry '${entryName}' has no matching plugin folder`
    );
  }
}

if (errors.length > 0) {
  console.error("Codex plugin validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Codex plugin validation passed for ${pluginFolders.length} plugins.`);
