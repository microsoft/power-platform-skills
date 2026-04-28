#!/usr/bin/env node
/**
 * Power Platform Skills — Installation Script
 *
 * Registers the marketplace and installs plugins for Claude Code and
 * GitHub Copilot, and generates filesystem-based skill/agent wrappers
 * for OpenCode.
 *
 * Usage:
 *   node scripts/install.js                                              (from local clone)
 *   curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js | node
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// ── Config ────────────────────────────────────────────────────
const REPO = "microsoft/power-platform-skills";
const REPO_URL = `https://github.com/${REPO}.git`;
const MARKETPLACE_NAME = "power-platform-skills";
const GITHUB_RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const HOME = os.homedir();
const OPENCODE_CONFIG_ROOT = path.join(HOME, ".config", "opencode");
const OPENCODE_INSTALL_ROOT = path.join(OPENCODE_CONFIG_ROOT, MARKETPLACE_NAME);
const OPENCODE_INSTALL_MANIFEST = path.join(
  OPENCODE_CONFIG_ROOT,
  `${MARKETPLACE_NAME}-install-manifest.json`
);

// ── Colors (disabled when output is piped) ────────────────────
const tty = process.stdout.isTTY;
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);

const ok = (msg) => console.log(`  ${green("✓")} ${msg}`);
const warn = (msg) => console.log(`  ${yellow("!")} ${msg}`);
const fail = (msg) => console.log(`  ${red("✗")} ${msg}`);
const header = (msg) => console.log(`\n${bold(msg)}`);
const info = (msg) => console.log(`  ${msg}`);

// ── Helpers ───────────────────────────────────────────────────
function hasCommand(cmd) {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    execSync(`${which} ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, opts = {}) {
  try {
    const output = execSync(cmd, {
      stdio: "pipe",
      timeout: 120_000,
      cwd: opts.cwd,
      shell: true,
    });
    return { ok: true, output: output.toString().trim() };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
    return { ok: false, output: stderr };
  }
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = (target) => {
      https
        .get(target, { headers: { "User-Agent": "power-platform-skills-installer" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return request(res.headers.location);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} from ${target}`));
          }
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        })
        .on("error", reject);
    };
    request(url);
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function toPortablePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function copyDir(source, target) {
  ensureDir(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else {
      ensureDir(path.dirname(targetPath));
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function replaceFrontmatterName(content, nextName) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return content;

  const frontmatter = frontmatterMatch[1];
  const updatedFrontmatter = frontmatter.match(/^name:\s*.+$/m)
    ? frontmatter.replace(/^name:\s*.+$/m, `name: ${nextName}`)
    : `name: ${nextName}\n${frontmatter}`;

  return `${content.slice(0, frontmatterMatch.index)}---\n${updatedFrontmatter}\n---${content.slice(
    frontmatterMatch.index + frontmatterMatch[0].length
  )}`;
}

function readFrontmatterName(content) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return null;
  const nameMatch = frontmatterMatch[1].match(/^name:\s*(.+)$/m);
  return nameMatch ? nameMatch[1].trim() : null;
}

function mapOpenCodeAgentColor(color) {
  const normalized = color.trim().toLowerCase();
  const supported = new Set([
    "primary",
    "secondary",
    "accent",
    "success",
    "warning",
    "error",
    "info",
  ]);

  if (supported.has(normalized) || /^#[0-9a-f]{6}$/i.test(color.trim())) {
    return color.trim();
  }

  const aliases = {
    blue: "info",
    cyan: "info",
    green: "success",
    yellow: "warning",
    orange: "warning",
    red: "error",
    purple: "accent",
  };

  return aliases[normalized] || null;
}

function sanitizeOpenCodeAgentFrontmatter(content) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) {
    return `---\ndescription: Generated Power Platform Skills agent for OpenCode\nmode: subagent\n---\n\n${content}`;
  }

  const lines = frontmatterMatch[1].split(/\r?\n/);
  const sanitized = [];
  let skippingTools = false;
  let hasMode = false;

  for (const line of lines) {
    if (skippingTools) {
      if (/^\s+-\s+/.test(line)) {
        continue;
      }
      skippingTools = false;
    }

    if (/^tools:\s*$/.test(line)) {
      skippingTools = true;
      continue;
    }

    if (/^name:\s*/.test(line) || /^model:\s*/.test(line)) {
      continue;
    }

    const colorMatch = line.match(/^color:\s*(.+)$/);
    if (colorMatch) {
      const mapped = mapOpenCodeAgentColor(colorMatch[1]);
      if (mapped) {
        sanitized.push(`color: ${mapped}`);
      }
      continue;
    }

    if (/^mode:\s*/.test(line)) {
      hasMode = true;
    }

    sanitized.push(line);
  }

  if (!hasMode) {
    sanitized.push("mode: subagent");
  }

  const body = content.slice(frontmatterMatch.index + frontmatterMatch[0].length).replace(/^\r?\n/, "");
  return `---\n${sanitized.join("\n")}\n---\n\n${body}`;
}

function resolveScriptRepoRoot() {
  const candidates = [];
  if (process.argv[1]) {
    const scriptDir = path.dirname(path.resolve(process.argv[1]));
    candidates.push(path.resolve(scriptDir, ".."));
  }
  candidates.push(process.cwd());

  for (const candidate of candidates) {
    if (exists(path.join(candidate, ".claude-plugin", "marketplace.json"))) {
      return candidate;
    }
  }

  return null;
}

function resolveMarketplaceSource(source) {
  return source.replace(/^\.\//, "");
}

function getOpenCodeCompatibilitySkillRoots() {
  return [
    path.join(HOME, ".claude", "skills"),
    path.join(HOME, ".agents", "skills"),
    path.join(OPENCODE_CONFIG_ROOT, "skills"),
  ];
}

function collectSkillNamesFromRoots(roots) {
  const skills = new Map();

  for (const root of roots) {
    if (!exists(root)) continue;

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const skillPath = path.join(root, entry.name, "SKILL.md");
      if (!exists(skillPath)) continue;

      const content = fs.readFileSync(skillPath, "utf8");
      const skillName = readFrontmatterName(content) || entry.name;
      if (!skills.has(skillName)) {
        skills.set(skillName, skillPath);
      }
    }
  }

  return skills;
}

function getOpenCodePrefix(pluginName) {
  return pluginName === "code-apps-preview" ? "code-apps" : pluginName;
}

function cleanupOpenCodeInstall() {
  if (!exists(OPENCODE_INSTALL_MANIFEST)) return;

  try {
    const manifest = JSON.parse(fs.readFileSync(OPENCODE_INSTALL_MANIFEST, "utf8"));
    for (const skillDir of manifest.skills || []) {
      removePath(path.join(OPENCODE_CONFIG_ROOT, "skills", skillDir));
    }
    for (const agentFile of manifest.agents || []) {
      removePath(path.join(OPENCODE_CONFIG_ROOT, "agents", agentFile));
    }
  } catch {
    warn("Could not clean up previous OpenCode wrappers");
  }
}

function writeOpenCodeInstallManifest(manifest) {
  ensureDir(path.dirname(OPENCODE_INSTALL_MANIFEST));
  fs.writeFileSync(OPENCODE_INSTALL_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
}

function syncLocalRepoForOpenCode(sourceRoot, plugins) {
  removePath(OPENCODE_INSTALL_ROOT);
  ensureDir(path.join(OPENCODE_INSTALL_ROOT, "plugins"));

  for (const entry of [".claude-plugin", "shared"]) {
    const sourcePath = path.join(sourceRoot, entry);
    if (exists(sourcePath)) {
      copyDir(sourcePath, path.join(OPENCODE_INSTALL_ROOT, entry));
    }
  }

  for (const plugin of plugins) {
    const relativeSource = resolveMarketplaceSource(plugin.source);
    copyDir(path.join(sourceRoot, relativeSource), path.join(OPENCODE_INSTALL_ROOT, relativeSource));
  }
}

function prepareOpenCodeSource(plugins) {
  ensureDir(OPENCODE_CONFIG_ROOT);
  const localRepoRoot = resolveScriptRepoRoot();

  if (localRepoRoot) {
    info("Syncing repository files for OpenCode...");
    syncLocalRepoForOpenCode(localRepoRoot, plugins);
    ok(`Repository synced to ${OPENCODE_INSTALL_ROOT}`);
    return OPENCODE_INSTALL_ROOT;
  }

  if (!hasCommand("git")) {
    fail("git not found — cannot fetch repository sources for OpenCode");
    info(`Install git, or run this script from a local clone of ${REPO}`);
    return null;
  }

  if (exists(path.join(OPENCODE_INSTALL_ROOT, ".git"))) {
    info("Updating cached repository for OpenCode...");
    const pullResult = run(`git -C "${OPENCODE_INSTALL_ROOT}" pull --ff-only`);
    if (pullResult.ok) {
      ok("Cached repository updated");
      return OPENCODE_INSTALL_ROOT;
    }

    warn(`Could not update cached repository: ${pullResult.output}`);
    removePath(OPENCODE_INSTALL_ROOT);
  } else if (exists(OPENCODE_INSTALL_ROOT)) {
    removePath(OPENCODE_INSTALL_ROOT);
  }

  info("Cloning repository for OpenCode...");
  const cloneResult = run(`git clone --depth 1 "${REPO_URL}" "${OPENCODE_INSTALL_ROOT}"`);
  if (cloneResult.ok) {
    ok("Repository cloned for OpenCode");
    return OPENCODE_INSTALL_ROOT;
  }

  fail(`Failed to clone repository: ${cloneResult.output}`);
  return null;
}

function collectOpenCodeEntries(repoRoot, plugins) {
  const entries = [];

  for (const plugin of plugins) {
    const pluginName = plugin.name;
    const pluginRoot = path.join(repoRoot, resolveMarketplaceSource(plugin.source));
    const prefix = getOpenCodePrefix(pluginName);
    const skillMap = {};

    const skillsRoot = path.join(pluginRoot, "skills");
    if (exists(skillsRoot)) {
      for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sourcePath = path.join(skillsRoot, entry.name, "SKILL.md");
        if (!exists(sourcePath)) continue;
        const content = fs.readFileSync(sourcePath, "utf8");
        const originalName = readFrontmatterName(content) || entry.name;
        skillMap[originalName] = `${prefix}-${originalName}`;
      }
    }

    entries.push({ pluginName, pluginRoot, prefix, skillMap });
  }

  return entries;
}

function rewriteOpenCodeContent(content, pluginRoot, skillMap) {
  let updated = content.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, toPortablePath(pluginRoot));

  for (const [originalName, installedName] of Object.entries(skillMap)) {
    const pattern = new RegExp(`/${escapeRegex(originalName)}(?=[^A-Za-z0-9-]|$)`, "g");
    updated = updated.replace(pattern, `/${installedName}`);
  }

  return updated;
}

function installOpenCode(plugins) {
  header("OpenCode");
  const repoRoot = prepareOpenCodeSource(plugins);
  if (!repoRoot) return;

  const descriptors = collectOpenCodeEntries(repoRoot, plugins);
  const installedSkills = [];
  const installedAgents = [];
  const skippedSkills = [];

  cleanupOpenCodeInstall();
  ensureDir(path.join(OPENCODE_CONFIG_ROOT, "skills"));
  ensureDir(path.join(OPENCODE_CONFIG_ROOT, "agents"));

  const existingSkills = collectSkillNamesFromRoots(getOpenCodeCompatibilitySkillRoots());

  info("Generating OpenCode skill wrappers...");
  for (const descriptor of descriptors) {
    const skillsRoot = path.join(descriptor.pluginRoot, "skills");
    if (!exists(skillsRoot)) continue;

    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourcePath = path.join(skillsRoot, entry.name, "SKILL.md");
      if (!exists(sourcePath)) continue;

      const content = fs.readFileSync(sourcePath, "utf8");
      const originalName = readFrontmatterName(content) || entry.name;
      const installedName = descriptor.skillMap[originalName];
      const targetDir = path.join(OPENCODE_CONFIG_ROOT, "skills", installedName);
      const targetPath = path.join(targetDir, "SKILL.md");

      if (existingSkills.has(installedName)) {
        skippedSkills.push({
          name: installedName,
          existingPath: existingSkills.get(installedName),
        });
        continue;
      }

      let updated = rewriteOpenCodeContent(content, descriptor.pluginRoot, descriptor.skillMap);
      updated = replaceFrontmatterName(updated, installedName);

      ensureDir(targetDir);
      fs.writeFileSync(targetPath, updated);
      installedSkills.push(installedName);
      existingSkills.set(installedName, targetPath);
    }
  }
  ok(`Installed ${installedSkills.length} OpenCode skills`);
  if (skippedSkills.length > 0) {
    info(
      `Skipped ${skippedSkills.length} duplicate OpenCode skills already available via compatibility paths`
    );
  }

  info("Generating OpenCode agent wrappers...");
  for (const descriptor of descriptors) {
    const agentsRoot = path.join(descriptor.pluginRoot, "agents");
    if (!exists(agentsRoot)) continue;

    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const sourcePath = path.join(agentsRoot, entry.name);
      const content = fs.readFileSync(sourcePath, "utf8");
      const originalName = readFrontmatterName(content) || path.basename(entry.name, ".md");
      const installedName = `${descriptor.prefix}-${originalName}`;
      const targetFile = `${installedName}.md`;
      const targetPath = path.join(OPENCODE_CONFIG_ROOT, "agents", targetFile);

      let updated = rewriteOpenCodeContent(content, descriptor.pluginRoot, descriptor.skillMap);
      updated = sanitizeOpenCodeAgentFrontmatter(updated);

      fs.writeFileSync(targetPath, updated);
      installedAgents.push(targetFile);
    }
  }
  ok(`Installed ${installedAgents.length} OpenCode agents`);

  writeOpenCodeInstallManifest({
    installedAt: new Date().toISOString(),
    repoRoot: OPENCODE_INSTALL_ROOT,
    skills: installedSkills,
    agents: installedAgents,
  });

  const verifiedSkills = installedSkills.filter((skill) =>
    exists(path.join(OPENCODE_CONFIG_ROOT, "skills", skill, "SKILL.md"))
  );
  const verifiedAgents = installedAgents.filter((agent) =>
    exists(path.join(OPENCODE_CONFIG_ROOT, "agents", agent))
  );

  ok(`Verified: ${verifiedSkills.length} skills, ${verifiedAgents.length} agents`);
  info(`Config root: ${OPENCODE_CONFIG_ROOT}`);
  info(`Repository cache: ${OPENCODE_INSTALL_ROOT}`);
}

// ── Auto-update ──────────────────────────────────────────────
// The CLI's `marketplace add` does not set autoUpdate — patch it manually.
// `getMarketplaces` extracts the marketplaces object from the config root.
function enableAutoUpdate(configFile, getMarketplaces) {
  try {
    const data = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const marketplaces = getMarketplaces(data);
    if (marketplaces?.[MARKETPLACE_NAME] && !marketplaces[MARKETPLACE_NAME].autoUpdate) {
      marketplaces[MARKETPLACE_NAME].autoUpdate = true;
      fs.writeFileSync(configFile, JSON.stringify(data, null, 2) + "\n");
      ok("Auto-update enabled");
      return;
    }
    if (marketplaces?.[MARKETPLACE_NAME]?.autoUpdate) {
      ok("Auto-update already enabled");
      return;
    }
    warn("Marketplace entry not found — auto-update not set");
  } catch {
    warn("Could not enable auto-update (config file not found)");
  }
}

// ── Marketplace loader ────────────────────────────────────────
async function loadMarketplace() {
  const localRepoRoot = resolveScriptRepoRoot();
  if (localRepoRoot) {
    return JSON.parse(
      fs.readFileSync(path.join(localRepoRoot, ".claude-plugin", "marketplace.json"), "utf8")
    );
  }

  info("Fetching marketplace manifest from GitHub...");
  const raw = await httpsGet(`${GITHUB_RAW}/.claude-plugin/marketplace.json`);
  return JSON.parse(raw);
}

// ── Claude Code installation ──────────────────────────────────
function installClaude(plugins) {
  header("Claude Code");

  info("Registering marketplace...");
  const addResult = run(`claude plugin marketplace add "${REPO}"`);
  if (addResult.ok) {
    ok("Marketplace registered");
  } else if (addResult.output.includes("already")) {
    ok("Marketplace already registered");
  } else {
    fail(`Failed to register marketplace: ${addResult.output}`);
    return;
  }

  info("Updating marketplace...");
  const updateResult = run(`claude plugin marketplace update "${MARKETPLACE_NAME}"`);
  if (updateResult.ok) {
    ok("Marketplace updated");
  } else {
    warn(`Marketplace update: ${updateResult.output}`);
  }

  const knownPath = path.join(HOME, ".claude", "plugins", "known_marketplaces.json");
  enableAutoUpdate(knownPath, (data) => data);

  for (const plugin of plugins) {
    info(`Installing ${plugin}...`);
    const installResult = run(
      `claude plugin install "${plugin}@${MARKETPLACE_NAME}" --scope user`
    );
    if (installResult.ok) {
      ok(`${plugin} installed`);
    } else if (installResult.output.includes("already installed")) {
      ok(`${plugin} already installed`);
    } else {
      fail(`Failed to install ${plugin}: ${installResult.output}`);
    }
  }

  info("Verifying installation...");
  const listResult = run("claude plugin list");
  if (listResult.ok) {
    const installed = plugins.filter((plugin) => listResult.output.includes(plugin));
    if (installed.length > 0) {
      ok(`Verified: ${installed.join(", ")}`);
    } else {
      warn("Plugins not found in plugin list output");
    }
  }
}

// ── GitHub Copilot installation ───────────────────────────────
function installCopilot(plugins) {
  header("GitHub Copilot");

  info("Registering marketplace...");
  const addResult = run(`copilot plugin marketplace add "${REPO}"`);
  if (addResult.ok) {
    ok("Marketplace registered");
  } else if (addResult.output.includes("already")) {
    ok("Marketplace already registered");
  } else {
    fail(`Failed to register marketplace: ${addResult.output}`);
    return;
  }

  const configPath = path.join(HOME, ".copilot", "config.json");
  enableAutoUpdate(configPath, (data) => data.marketplaces);

  for (const plugin of plugins) {
    info(`Installing ${plugin}...`);
    const installResult = run(`copilot plugin install "${plugin}@${MARKETPLACE_NAME}"`);
    if (installResult.ok) {
      ok(`${plugin} installed`);
    } else if (installResult.output.includes("already installed")) {
      ok(`${plugin} already installed`);
    } else {
      fail(`Failed to install ${plugin}: ${installResult.output}`);
    }
  }

  info("Verifying installation...");
  const listResult = run("copilot plugin list");
  if (listResult.ok) {
    const installed = plugins.filter((plugin) => listResult.output.includes(plugin));
    if (installed.length > 0) {
      ok(`Verified: ${installed.join(", ")}`);
    } else {
      warn("Plugins not found in plugin list output");
    }
  }
}

function printGetStarted(tool) {
  if (tool === "opencode") {
    console.log("    opencode session -> /power-pages-create-site");
    console.log("    opencode session -> /model-apps-genpage");
    console.log("    opencode session -> /mcp-apps-generate-mcp-app-ui");
    console.log("    opencode session -> /code-apps-create-code-app");
    console.log("    opencode session -> /canvas-apps-generate-canvas-app");
    return;
  }

  console.log(`    ${tool} session  ->  /power-pages:create-site`);
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log("");
  console.log(bold("Power Platform Skills — Installer"));
  console.log("──────────────────────────────────");

  header("Checking prerequisites");
  ok(`Node.js ${process.version}`);

  const tools = [];

  if (hasCommand("claude")) {
    const version = run("claude --version");
    tools.push("claude");
    ok(`Claude Code ${version.ok ? version.output : "(version unknown)"}`);
  }
  if (hasCommand("copilot")) {
    const version = run("copilot --version");
    tools.push("copilot");
    ok(`GitHub Copilot CLI ${version.ok ? version.output : "(version unknown)"}`);
  }
  if (hasCommand("opencode")) {
    const version = run("opencode --version");
    tools.push("opencode");
    ok(`OpenCode ${version.ok ? version.output : "(version unknown)"}`);
  }

  if (tools.length === 0) {
    fail("No supported host CLI found in PATH.");
    console.log("");
    console.log("  Install at least one and ensure it is on your PATH:");
    console.log("    Claude Code     https://docs.anthropic.com/en/docs/claude-code");
    console.log("    GitHub Copilot  https://docs.github.com/en/copilot");
    console.log("    OpenCode        https://opencode.ai");
    process.exit(1);
  }

  header("Power Platform CLI (pac)");

  if (hasCommand("pac")) {
    const ver = run("pac help");
    const versionMatch = ver.ok && ver.output.match(/Version:\s*(.+)/i);
    ok(`PAC CLI ${versionMatch ? versionMatch[1].trim() : "(installed)"}`);

    if (hasCommand("dotnet")) {
      const localVersion = versionMatch ? versionMatch[1].trim().split("+")[0] : null;
      let latestVersion = null;
      try {
        const nugetJson = await httpsGet(
          "https://api.nuget.org/v3-flatcontainer/microsoft.powerapps.cli.tool/index.json"
        );
        const versions = JSON.parse(nugetJson).versions;
        latestVersion = versions[versions.length - 1];
      } catch {
        warn("Could not check NuGet for latest version");
      }

      if (latestVersion && localVersion && latestVersion === localVersion) {
        ok("Already on latest version");
      } else if (latestVersion) {
        info(`Newer version available: ${latestVersion} (installed: ${localVersion || "unknown"})`);
        info("Updating PAC CLI...");
        const updateResult = run("dotnet tool update --global Microsoft.PowerApps.CLI.Tool");
        if (updateResult.ok) {
          ok(`Updated to ${latestVersion}`);
        } else {
          warn(`Could not update: ${updateResult.output}`);
        }
      }
    }
  } else {
    warn("PAC CLI not found in PATH");

    if (hasCommand("dotnet")) {
      info("Installing PAC CLI via dotnet tool...");
      const installResult = run("dotnet tool install --global Microsoft.PowerApps.CLI.Tool");
      if (installResult.ok) {
        ok("PAC CLI installed");
        info("You may need to restart your terminal for the 'pac' command to be available.");
      } else if (installResult.output.includes("already installed")) {
        ok("PAC CLI already installed (not on PATH — restart your terminal)");
      } else {
        fail(`Failed to install PAC CLI: ${installResult.output}`);
        info("Install manually: https://aka.ms/PowerPlatformCLI");
      }
    } else {
      fail("dotnet SDK not found — cannot auto-install PAC CLI");
      console.log("");
      console.log("  Install the PAC CLI manually using one of these methods:");
      console.log("    .NET Tool (cross-platform)  https://aka.ms/PowerPlatformCLI");
      console.log("    VS Code Extension           https://aka.ms/PowerPlatformCLI");
      console.log("    Windows MSI                 https://aka.ms/PowerPlatformCLI");
    }
  }

  header("Azure CLI (az)");

  if (hasCommand("az")) {
    const ver = run("az version -o tsv");
    const versionLine = ver.ok && ver.output.split("\n")[0];
    const azVersion = versionLine ? versionLine.split("\t")[0] : null;
    ok(`Azure CLI ${azVersion || "(installed)"}`);
  } else {
    warn("Azure CLI not found in PATH");

    let installed = false;
    if (process.platform === "win32" && hasCommand("winget")) {
      info("Installing Azure CLI via winget...");
      const installResult = run(
        "winget install -e --id Microsoft.AzureCLI --accept-source-agreements --accept-package-agreements"
      );
      if (installResult.ok) {
        ok("Azure CLI installed");
        info("You may need to restart your terminal for the 'az' command to be available.");
        installed = true;
      } else {
        fail(`Failed to install via winget: ${installResult.output}`);
      }
    } else if (process.platform === "darwin" && hasCommand("brew")) {
      info("Installing Azure CLI via Homebrew...");
      const installResult = run("brew install azure-cli");
      if (installResult.ok) {
        ok("Azure CLI installed");
        installed = true;
      } else {
        fail(`Failed to install via Homebrew: ${installResult.output}`);
      }
    }

    if (!installed) {
      fail("Could not auto-install Azure CLI");
      console.log("");
      console.log("  Install manually using one of these methods:");
      console.log("    Windows (winget)  winget install -e --id Microsoft.AzureCLI");
      console.log("    macOS (Homebrew)  brew install azure-cli");
      console.log("    Linux (curl)      curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash");
      console.log("    Docs              https://aka.ms/InstallAzureCLI");
    }
  }

  header("Reading marketplace");

  const manifest = await loadMarketplace();
  const plugins = manifest.plugins.map((plugin) => plugin.name);
  const openCodePlugins = manifest.plugins.map((plugin) => ({
    name: plugin.name,
    source: plugin.source,
  }));

  console.log(`  Marketplace : ${manifest.name}`);
  console.log("  Plugins     :");
  for (const plugin of plugins) console.log(`    - ${plugin}`);

  if (plugins.length === 0) {
    warn("No plugins found in the marketplace.");
    process.exit(0);
  }

  if (tools.includes("claude")) installClaude(plugins);
  if (tools.includes("copilot")) installCopilot(plugins);
  if (tools.includes("opencode")) installOpenCode(openCodePlugins);

  header("Done!");
  console.log("");
  console.log("  Run this script again anytime to re-install or update.");
  console.log("  Claude Code and GitHub Copilot stay current via marketplace auto-update.");
  console.log("  OpenCode is refreshed by re-running this installer.");
  console.log("");
  console.log("  Get started:");
  for (const tool of tools) {
    printGetStarted(tool);
  }
  console.log("");
}

module.exports = {
  collectSkillNamesFromRoots,
  collectOpenCodeEntries,
  getOpenCodeCompatibilitySkillRoots,
  installOpenCode,
  loadMarketplace,
  prepareOpenCodeSource,
  replaceFrontmatterName,
  resolveScriptRepoRoot,
  rewriteOpenCodeContent,
  sanitizeOpenCodeAgentFrontmatter,
};

if (require.main === module) {
  main().catch((err) => {
    fail(`Installation failed: ${err.message}`);
    process.exit(1);
  });
}
