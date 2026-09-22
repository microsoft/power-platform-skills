#!/usr/bin/env node
/**
 * Power Platform Skills — Installation Script
 *
 * Clones the marketplace repository and uses CLI commands to register
 * the Open Plugins marketplace and install plugins for Claude Code and GitHub Copilot.
 *
 * Usage:
 *   node scripts/install.js                                              (from local clone)
 *   node scripts/install.js --include-dataverse                          (include official Dataverse plugin)
 *   curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js | node
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// ── Config ────────────────────────────────────────────────────
const REPO = "microsoft/power-platform-skills";
const MARKETPLACE_NAME = "power-platform-skills";
const GITHUB_RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const HOME = os.homedir();
const DATAVERSE_PLUGIN = "dataverse";
const DATAVERSE_INSTALLS = {
  claude: {
    command: `claude plugin install "${DATAVERSE_PLUGIN}@claude-plugins-official" --scope user`,
    listCommand: "claude plugin list",
    label: "Claude Code",
  },
  copilot: {
    command: `copilot plugin install "${DATAVERSE_PLUGIN}@awesome-copilot"`,
    listCommand: "copilot plugin list",
    label: "GitHub Copilot CLI",
  },
  codex: {
    command: `codex plugin add "${DATAVERSE_PLUGIN}@openai-curated"`,
    fallbackCommands: [
      'codex plugin marketplace add "microsoft/Dataverse-skills"',
      `codex plugin add "${DATAVERSE_PLUGIN}@dataverse-skills"`,
    ],
    listCommand: "codex plugin list",
    label: "Codex CLI",
  },
};
const DATAVERSE_GUIDED_INSTALLS = [
  "Cursor: use /add-plugin dataverse in agent chat, or install Microsoft Dataverse from Settings > Plugins",
];

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

function parseMarketplaceManifest(raw) {
  const manifest = JSON.parse(raw);
  if (manifest.name !== MARKETPLACE_NAME) {
    throw new Error(
      `manifest name is '${manifest.name || "(missing)"}', expected '${MARKETPLACE_NAME}'`
    );
  }
  return manifest;
}

function parseInstallerOptions(argv = process.argv.slice(2)) {
  return {
    includeDataverse: argv.includes("--include-dataverse"),
  };
}

function hasInstallTarget(tools, dataverseTools, options) {
  return tools.length > 0 || (options.includeDataverse && dataverseTools.length > 0);
}

function installCanonicalDataverse(tool, runCommand = run) {
  const config = DATAVERSE_INSTALLS[tool];
  if (!config) {
    throw new Error(`Unsupported Dataverse install target: ${tool}`);
  }

  header(`Official Dataverse companion (${config.label})`);
  info("Installing from the canonical Dataverse marketplace...");
  const installResult = runCommand(config.command);
  const installOutput = String(installResult.output || "");
  const alreadyInstalled = installOutput.toLowerCase().includes("already installed");
  if (!installResult.ok && !alreadyInstalled && config.fallbackCommands) {
    warn("Curated Dataverse listing unavailable; trying the canonical repository marketplace...");
    for (const fallbackCommand of config.fallbackCommands) {
      const fallbackResult = runCommand(fallbackCommand);
      const fallbackOutput = String(fallbackResult.output || "");
      if (!fallbackResult.ok && !fallbackOutput.toLowerCase().includes("already")) {
        fail(`Dataverse fallback installation failed: ${fallbackOutput || "Unknown error"}`);
        return false;
      }
    }
  } else if (!installResult.ok && !alreadyInstalled) {
    fail(`Dataverse installation failed: ${installOutput || "Unknown error"}`);
    return false;
  }

  ok(installResult.ok ? "Dataverse installed" : "Dataverse installation completed");
  const listResult = runCommand(config.listCommand);
  const listOutput = String(listResult.output || "");
  if (!listResult.ok) {
    fail(`Could not verify Dataverse installation: ${listOutput || "Unknown error"}`);
    return false;
  }
  if (!listOutput.toLowerCase().includes(DATAVERSE_PLUGIN)) {
    fail("Dataverse was not found in the installed plugin list");
    return false;
  }

  ok("Dataverse installation verified");
  return true;
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
  const scriptDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : process.cwd();
  // Script lives in scripts/, so the repo root is one level up
  const repoRoot = path.resolve(scriptDir, "..");
  const roots = [...new Set([repoRoot, process.cwd()])];
  const marketplacePaths = [
    "marketplace.json",
    path.join(".plugin", "marketplace.json"),
    path.join(".claude-plugin", "marketplace.json"),
  ];
  const errors = [];

  for (const root of roots) {
    for (const relativePath of marketplacePaths) {
      const filePath = path.join(root, relativePath);
      if (fs.existsSync(filePath)) {
        try {
          return parseMarketplaceManifest(fs.readFileSync(filePath, "utf8"));
        } catch (err) {
          errors.push(`${filePath}: ${err.message}`);
        }
      }
    }
  }

  info("Fetching marketplace manifest from GitHub...");
  for (const relativePath of ["marketplace.json", ".plugin/marketplace.json", ".claude-plugin/marketplace.json"]) {
    try {
      const raw = await httpsGet(`${GITHUB_RAW}/${relativePath}`);
      return parseMarketplaceManifest(raw);
    } catch (err) {
      errors.push(`${relativePath}: ${err.message}`);
    }
  }

  throw new Error(`Could not load marketplace manifest. Tried: ${errors.join("; ")}`);
}

// ── Claude Code installation ──────────────────────────────────
function installClaude(plugins) {
  header("Claude Code");

  // 1. Register marketplace via CLI (CLI clones the repo automatically)
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

  // 2. Update marketplace
  info("Updating marketplace...");
  const updateResult = run(`claude plugin marketplace update "${MARKETPLACE_NAME}"`);
  if (updateResult.ok) {
    ok("Marketplace updated");
  } else {
    warn(`Marketplace update: ${updateResult.output}`);
  }

  // 3. Enable auto-update (CLI does not set this)
  const knownPath = path.join(HOME, ".claude", "plugins", "known_marketplaces.json");
  enableAutoUpdate(knownPath, (data) => data);

  // 4. Install each plugin via CLI
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

  // 5. Verify installation
  info("Verifying installation...");
  const listResult = run("claude plugin list");
  if (listResult.ok) {
    const installed = plugins.filter((p) => listResult.output.includes(p));
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

  // 1. Register marketplace via CLI (CLI clones the repo automatically)
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

  // 2. Enable auto-update (CLI does not set this)
  const configPath = path.join(HOME, ".copilot", "config.json");
  enableAutoUpdate(configPath, (data) => data.marketplaces);

  // 3. Install each plugin via CLI
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

  // 4. Verify installation
  info("Verifying installation...");
  const listResult = run("copilot plugin list");
  if (listResult.ok) {
    const installed = plugins.filter((p) => listResult.output.includes(p));
    if (installed.length > 0) {
      ok(`Verified: ${installed.join(", ")}`);
    } else {
      warn("Plugins not found in plugin list output");
    }
  }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const options = parseInstallerOptions();

  console.log("");
  console.log(bold("Power Platform Skills — Installer"));
  console.log("──────────────────────────────────");

  // ── Prerequisites ──────────────────────────────────────────
  header("Checking prerequisites");
  ok(`Node.js ${process.version}`);

  // Detect tools — require CLI in PATH (CLI commands need the binary)
  const tools = [];

  if (hasCommand("claude")) {
    const ver = run("claude --version");
    tools.push("claude");
    ok(`Claude Code ${ver.ok ? ver.output : "(version unknown)"}`);
  }
  if (hasCommand("copilot")) {
    const ver = run("copilot --version");
    tools.push("copilot");
    ok(`GitHub Copilot CLI ${ver.ok ? ver.output : "(version unknown)"}`);
  }

  const dataverseTools = [...tools];
  if (options.includeDataverse && hasCommand("codex")) {
    const ver = run("codex --version");
    dataverseTools.push("codex");
    ok(`Codex CLI ${ver.ok ? ver.output : "(version unknown)"}`);
  }

  if (!hasInstallTarget(tools, dataverseTools, options)) {
    const requiredTools = options.includeDataverse
      ? "Claude Code, GitHub Copilot CLI, or Codex CLI"
      : "Claude Code or GitHub Copilot CLI";
    fail(`No supported CLI found in PATH (${requiredTools}).`);
    console.log("");
    console.log("  Install at least one and ensure it is on your PATH:");
    console.log("    Claude Code     https://docs.anthropic.com/en/docs/claude-code");
    console.log("    GitHub Copilot  https://docs.github.com/en/copilot");
    if (options.includeDataverse) {
      console.log("    Codex CLI       https://developers.openai.com/codex/cli");
    }
    process.exit(1);
  }
  if (tools.length === 0) {
    warn("No Claude Code or GitHub Copilot CLI found; Power Platform plugins will be skipped.");
    info("Continuing with the requested Dataverse companion installation for Codex CLI.");
  }

  // ── PAC CLI ──────────────────────────────────────────────────
  header("Power Platform CLI (pac)");

  if (hasCommand("pac")) {
    const ver = run("pac help");
    const versionMatch = ver.ok && ver.output.match(/Version:\s*(.+)/i);
    ok(`PAC CLI ${versionMatch ? versionMatch[1].trim() : "(installed)"}`);

    // Check NuGet for a newer version and update if available
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
        const updateResult = run(
          "dotnet tool update --global Microsoft.PowerApps.CLI.Tool"
        );
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
      const installResult = run(
        "dotnet tool install --global Microsoft.PowerApps.CLI.Tool"
      );
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

  // ── Azure CLI ───────────────────────────────────────────────
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

  let plugins = [];
  if (tools.length > 0) {
    // ── Marketplace ──────────────────────────────────────────
    header("Reading marketplace");

    const manifest = await loadMarketplace();
    plugins = manifest.plugins.map((p) => p.name);

    console.log(`  Marketplace : ${manifest.name}`);
    console.log("  Plugins     :");
    for (const p of plugins) console.log(`    - ${p}`);

    if (plugins.length === 0) {
      warn("No plugins found in the marketplace.");
      process.exit(0);
    }
  }

  // ── Install ────────────────────────────────────────────────
  if (tools.includes("claude")) installClaude(plugins);
  if (tools.includes("copilot")) installCopilot(plugins);

  let dataverseInstallFailed = false;
  if (options.includeDataverse) {
    for (const tool of dataverseTools) {
      if (!installCanonicalDataverse(tool)) {
        dataverseInstallFailed = true;
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────
  header(dataverseInstallFailed ? "Completed with errors" : "Done!");
  console.log("");
  if (tools.length > 0) {
    console.log("  Power Platform plugins will stay current via marketplace auto-update.");
  }
  if (options.includeDataverse && !dataverseInstallFailed) {
    console.log("  The official Dataverse companion is installed from its canonical marketplace.");
  }
  if (options.includeDataverse) {
    console.log("");
    console.log("  Dataverse on other native hosts:");
    for (const instruction of DATAVERSE_GUIDED_INSTALLS) {
      console.log(`    ${instruction}`);
    }
  }
  console.log("  Run this script again anytime to re-install or update.");
  console.log("");
  console.log("  Get started:");
  for (const tool of tools) {
    console.log(`    ${tool} session  ->  /power-pages:create-site`);
  }
  if (tools.length === 0 && dataverseTools.includes("codex")) {
    console.log("    codex session   ->  Connect to Dataverse");
  }
  console.log("");

  if (dataverseInstallFailed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    fail(`Installation failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  DATAVERSE_GUIDED_INSTALLS,
  DATAVERSE_INSTALLS,
  hasInstallTarget,
  installCanonicalDataverse,
  parseInstallerOptions,
};
