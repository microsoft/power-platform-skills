#!/usr/bin/env node
/**
 * Power Platform Skills — Installation Script
 *
 * Clones the marketplace repository and uses CLI commands to register
 * the marketplace and install plugins for Claude Code and GitHub Copilot.
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
const MARKETPLACE_NAME = "power-platform-skills";
const GITHUB_RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const HOME = os.homedir();

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
  const localFile = path.join(repoRoot, ".claude-plugin", "marketplace.json");

  if (fs.existsSync(localFile)) {
    return JSON.parse(fs.readFileSync(localFile, "utf8"));
  }

  // Also check cwd (handles running from repo root or piped download)
  const cwdFile = path.join(process.cwd(), ".claude-plugin", "marketplace.json");
  if (fs.existsSync(cwdFile)) {
    return JSON.parse(fs.readFileSync(cwdFile, "utf8"));
  }

  info("Fetching marketplace manifest from GitHub...");
  const raw = await httpsGet(`${GITHUB_RAW}/.claude-plugin/marketplace.json`);
  return JSON.parse(raw);
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

  if (tools.length === 0) {
    fail("Neither Claude Code nor GitHub Copilot CLI found in PATH.");
    console.log("");
    console.log("  Install at least one and ensure it is on your PATH:");
    console.log("    Claude Code     https://docs.anthropic.com/en/docs/claude-code");
    console.log("    GitHub Copilot  https://docs.github.com/en/copilot");
    process.exit(1);
  }

  // ── Marketplace ────────────────────────────────────────────
  header("Reading marketplace");

  const manifest = await loadMarketplace();
  const plugins = manifest.plugins.map((p) => p.name);

  console.log(`  Marketplace : ${manifest.name}`);
  console.log("  Plugins     :");
  for (const p of plugins) console.log(`    - ${p}`);

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

main().catch((err) => {
  fail(`Installation failed: ${err.message}`);
  process.exit(1);
});
