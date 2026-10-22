#!/usr/bin/env node
/**
 * Power Platform Skills — Installation Script
 *
 * Clones the marketplace repository and uses CLI commands to register
 * the Open Plugins marketplace and install plugins for Claude Code and GitHub Copilot.
 *
 * Usage:
 *   node scripts/install.js [--include-dataverse]                        (from local clone)
 *   curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js | node
 *   curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js | node - --include-dataverse
 *
 * Options:
 *   --include-dataverse   Also install the dataverse plugin (maintained in microsoft/Dataverse-skills)
 *   -h, --help            Show this help
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// ── Config ────────────────────────────────────────────────────
const REPO = "microsoft/power-platform-skills";
const MARKETPLACE_NAME = "power-platform-skills";
const GITHUB_RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const HOME = os.homedir();

// Marketplace plugins that are installed only when their flag is passed. dataverse is
// maintained in microsoft/Dataverse-skills, and many users already install it from that
// repository's own marketplace; installing it here by default would load its skills twice.
const OPT_IN_PLUGINS = { dataverse: "--include-dataverse" };

const USAGE = `Usage: node install.js [--include-dataverse]

Options:
  --include-dataverse   Also install the dataverse plugin (maintained in microsoft/Dataverse-skills)
  -h, --help            Show this help`;

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

// ── Arguments ─────────────────────────────────────────────────
// `process.argv` differs by launch mode, and the script's own arguments start at index 2
// whenever any are present:
//   node scripts/install.js --include-dataverse  -> [node, /abs/install.js, "--include-dataverse"]
//   curl ... | node - --include-dataverse         -> [node, "-", "--include-dataverse"]
//   curl ... | node                               -> [node]
// Unknown arguments fail instead of being ignored, so a typo cannot silently drop a plugin.
function parseArgs(args) {
  const options = { help: false, includedOptIn: new Set() };
  const optInByFlag = new Map(Object.entries(OPT_IN_PLUGINS).map(([plugin, flag]) => [flag, plugin]));
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (optInByFlag.has(arg)) {
      options.includedOptIn.add(optInByFlag.get(arg));
    } else {
      throw new Error(`Unknown argument '${arg}'.\n\n${USAGE}`);
    }
  }
  return options;
}

function selectPlugins(pluginNames, includedOptIn) {
  const selected = [];
  const skipped = [];
  for (const name of pluginNames) {
    if (Object.prototype.hasOwnProperty.call(OPT_IN_PLUGINS, name) && !includedOptIn.has(name)) {
      skipped.push(name);
    } else {
      selected.push(name);
    }
  }
  return { selected, skipped };
}

// ── Helpers ───────────────────────────────────────────────────
function envValue(name) {
  if (process.platform !== "win32") return process.env[name];
  // Match Node's case-insensitive environment lookup, including duplicate PATH spellings.
  const key = Object.keys(process.env).filter((k) => k.toUpperCase() === name.toUpperCase()).sort()[0];
  return key === undefined ? undefined : process.env[key];
}

function isFullyQualifiedPath(file) {
  // Windows considers \tools absolute, but it still depends on the current drive.
  // A longer root identifies a drive-qualified or UNC path instead.
  return path.isAbsolute(file) && (process.platform !== "win32" || path.parse(file).root.length > 1);
}

function resolveCommand(cmd) {
  if (typeof cmd !== "string" || /^[a-z0-9-]+$/.exec(cmd)?.[0] !== cmd) {
    throw new Error("Invalid command name");
  }
  const win = process.platform === "win32";
  const paths = String(envValue("PATH") || "").split(win ? ";" : ":");
  const extensions = win
    ? String(envValue("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";")
      .map((ext) => ext.trim().toLowerCase()).filter((ext) => /^\.(?:com|exe|bat|cmd)$/.test(ext))
    : [""];
  for (const entry of paths) {
    // On POSIX, whitespace and quotes are literal directory-name characters.
    const dir = win ? entry.trim().replace(/^"(.*)"$/, "$1") : entry;
    // Skip implicit working-directory lookup and relative PATH entries.
    if (!isFullyQualifiedPath(dir)) continue;
    for (const ext of extensions) {
      const file = path.join(dir, cmd + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch (err) {
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(err.code)) throw err;
      }
    }
  }
  return null;
}

function hasCommand(cmd) {
  return resolveCommand(cmd) !== null;
}

function run(cmd, args = [], opts = {}) {
  try {
    let file = resolveCommand(cmd);
    if (!file) throw new Error(`${cmd} was not found on PATH`);
    let argv = args;
    const options = {
      stdio: "pipe",
      timeout: 120_000,
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
    };
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(file)) {
      // Node cannot execute Windows batch shims directly. cmd.exe parses the /c line
      // and the shim's %* again, so only inert argument tokens may cross this boundary.
      // The installer is also downloaded/piped alone: it cannot require a repo-local runner.
      // See: https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
      if (/["%!\u0000-\u001f\u007f]/.test(file)
        || !args.every((arg) => typeof arg === "string" && /^[A-Za-z0-9_./:@=-]+$/.exec(arg)?.[0] === arg)) {
        throw new Error(`Cannot safely pass the executable path or arguments to ${cmd}'s Windows batch launcher`);
      }
      const comspec = envValue("ComSpec");
      const systemRoot = envValue("SystemRoot") || "C:\\Windows";
      const shell = comspec && isFullyQualifiedPath(comspec) && path.basename(comspec).toLowerCase() === "cmd.exe"
        ? comspec : path.join(systemRoot, "System32", "cmd.exe");
      if (!isFullyQualifiedPath(shell)) throw new Error("Windows command interpreter path must be fully qualified");
      argv = ["/d", "/s", "/v:off", "/c", `""${file}" ${args.join(" ")}"`];
      file = shell;
      options.windowsVerbatimArguments = true;
      options.env = { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" };
    }
    const output = execFileSync(file, argv, options);
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

function isValidPluginName(name) {
  // Use the Open Plugins grammar shared with the repository validator. Compare the
  // whole match because JavaScript's $ anchor also accepts a trailing newline.
  const match = typeof name === "string" && /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.exec(name);
  return Boolean(match && match[0] === name && !name.includes("--") && !name.includes(".."));
}

function parseMarketplaceManifest(raw) {
  const manifest = JSON.parse(raw);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("marketplace manifest must be an object");
  }
  if (manifest.name !== MARKETPLACE_NAME) {
    throw new Error(
      `manifest name is '${manifest.name || "(missing)"}', expected '${MARKETPLACE_NAME}'`
    );
  }
  if (!Array.isArray(manifest.plugins)) {
    throw new Error("marketplace plugins must be an array");
  }
  for (const [index, plugin] of manifest.plugins.entries()) {
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin) || !isValidPluginName(plugin.name)) {
      throw new Error(`plugins[${index}].name does not follow Open Plugins name constraints`);
    }
  }
  return manifest;
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
  // `node -` (piped with arguments) sets argv[1] to "-", which is not a script path.
  const scriptPath = process.argv[1] && process.argv[1] !== "-" ? process.argv[1] : null;
  const scriptDir = scriptPath ? path.dirname(path.resolve(scriptPath)) : process.cwd();
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
          warn(`Ignoring invalid marketplace manifest: ${filePath}: ${err.message}`);
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
  const addResult = run("claude", ["plugin", "marketplace", "add", REPO]);
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
  const updateResult = run("claude", ["plugin", "marketplace", "update", MARKETPLACE_NAME]);
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
    const installResult = run("claude", ["plugin", "install", `${plugin}@${MARKETPLACE_NAME}`, "--scope", "user"]);
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
  const listResult = run("claude", ["plugin", "list"]);
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
  const addResult = run("copilot", ["plugin", "marketplace", "add", REPO]);
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
    const installResult = run("copilot", ["plugin", "install", `${plugin}@${MARKETPLACE_NAME}`]);
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
  const listResult = run("copilot", ["plugin", "list"]);
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
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  console.log("");
  console.log(bold("Power Platform Skills — Installer"));
  console.log("──────────────────────────────────");

  // ── Prerequisites ──────────────────────────────────────────
  header("Checking prerequisites");
  ok(`Node.js ${process.version}`);

  // Detect tools — require CLI in PATH (CLI commands need the binary)
  const tools = [];

  if (hasCommand("claude")) {
    const ver = run("claude", ["--version"]);
    tools.push("claude");
    ok(`Claude Code ${ver.ok ? ver.output : "(version unknown)"}`);
  }
  if (hasCommand("copilot")) {
    const ver = run("copilot", ["--version"]);
    tools.push("copilot");
    ok(`GitHub Copilot CLI ${ver.ok ? ver.output : "(version unknown)"}`);
  }

  if (tools.length === 0) {
    fail("Neither Claude Code nor GitHub Copilot CLI found in PATH.");
    console.log("");
    console.log("  Install at least one and ensure it is on your PATH:");
    console.log("    Claude Code     https://docs.anthropic.com/en/docs/claude-code");
    console.log("    GitHub Copilot  https://docs.github.com/en/copilot");
    process.exit(1);
  }

  // ── PAC CLI ──────────────────────────────────────────────────
  header("Power Platform CLI (pac)");

  if (hasCommand("pac")) {
    const ver = run("pac", ["help"]);
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
        const updateResult = run("dotnet", ["tool", "update", "--global", "Microsoft.PowerApps.CLI.Tool"]);
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
      const installResult = run("dotnet", ["tool", "install", "--global", "Microsoft.PowerApps.CLI.Tool"]);
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
    const ver = run("az", ["version", "-o", "tsv"]);
    const versionLine = ver.ok && ver.output.split("\n")[0];
    const azVersion = versionLine ? versionLine.split("\t")[0] : null;
    ok(`Azure CLI ${azVersion || "(installed)"}`);
  } else {
    warn("Azure CLI not found in PATH");

    let installed = false;
    if (process.platform === "win32" && hasCommand("winget")) {
      info("Installing Azure CLI via winget...");
      const installResult = run("winget", ["install", "-e", "--id", "Microsoft.AzureCLI",
        "--accept-source-agreements", "--accept-package-agreements"]);
      if (installResult.ok) {
        ok("Azure CLI installed");
        info("You may need to restart your terminal for the 'az' command to be available.");
        installed = true;
      } else {
        fail(`Failed to install via winget: ${installResult.output}`);
      }
    } else if (process.platform === "darwin" && hasCommand("brew")) {
      info("Installing Azure CLI via Homebrew...");
      const installResult = run("brew", ["install", "azure-cli"]);
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

  // ── Marketplace ────────────────────────────────────────────
  header("Reading marketplace");

  const manifest = await loadMarketplace();
  const { selected: plugins, skipped } = selectPlugins(
    manifest.plugins.map((p) => p.name),
    options.includedOptIn
  );

  console.log(`  Marketplace : ${manifest.name}`);
  console.log("  Plugins     :");
  for (const p of plugins) console.log(`    - ${p}`);
  for (const p of skipped) info(`Skipping ${p} (pass ${OPT_IN_PLUGINS[p]} to install it)`);
  for (const p of options.includedOptIn) {
    if (!plugins.includes(p)) warn(`${OPT_IN_PLUGINS[p]} was passed, but ${p} is not in the marketplace`);
  }

  if (plugins.length === 0) {
    warn("No plugins found in the marketplace.");
    process.exit(0);
  }

  // ── Install ────────────────────────────────────────────────
  if (tools.includes("claude")) installClaude(plugins);
  if (tools.includes("copilot")) installCopilot(plugins);

  // ── Summary ────────────────────────────────────────────────
  header("Done!");
  console.log("");
  console.log("  Plugins will stay current via the marketplace auto-update mechanism.");
  console.log("  Run this script again anytime to re-install or update.");
  console.log("");
  console.log("  Get started:");
  for (const tool of tools) {
    console.log(`    ${tool} session  ->  /power-pages:create-site`);
  }
  console.log("");
}

// Run when executed directly. Piped input (`curl ... | node`) leaves require.main undefined,
// so checking only `require.main === module` would make the one-line installer do nothing.
// Match the stdin module id instead of a missing require.main: `node -e "require(...)"` also
// leaves require.main undefined, and must import the helpers without starting an install.
if (require.main === module || module.id === "[stdin]") {
  main().catch((err) => {
    fail(`Installation failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, selectPlugins, OPT_IN_PLUGINS, isValidPluginName, parseMarketplaceManifest,
  loadMarketplace, resolveCommand, run, installClaude, installCopilot, main,
};
