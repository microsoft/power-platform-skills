#!/usr/bin/env node

/**
 * install-prerequisite.js — Installs (or updates) one Power Pages plugin
 * prerequisite using the package manager that fits the current platform.
 *
 * The `/setup-prerequisites` skill calls this once per tool, after the user has
 * approved that specific install. Nothing here is chained or implicit: one
 * invocation installs exactly one tool.
 *
 * Usage:
 *   node install-prerequisite.js --tool <dotnet|pac|az> [--update] [--dry-run]
 *
 * Exit codes:
 *   0  Installed, or a dry run printed the plan
 *   1  No automated install path on this platform, or the install failed
 *
 * `resolveInstallPlan` is pure and exported so the tests can assert the plan for
 * every platform without a package manager present.
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');

const TOOLS = ['dotnet', 'pac', 'az'];

// Winget package identifiers, verified against the microsoft/winget-pkgs
// manifests at manifests/m/Microsoft/DotNet/SDK/10 and manifests/m/Microsoft/AzureCLI.
const WINGET_DOTNET_SDK_ID = 'Microsoft.DotNet.SDK.10';
const WINGET_AZURE_CLI_ID = 'Microsoft.AzureCLI';

// Non-interactive winget flags. Without the agreement flags winget stops on a
// prompt that never gets an answer when it runs from a skill.
const WINGET_FLAGS = [
  '-e',
  '--accept-source-agreements',
  '--accept-package-agreements',
  '--disable-interactivity',
];

// The PAC CLI ships as a .NET global tool. It is the only prerequisite whose
// install path is the same on every platform.
// See: https://learn.microsoft.com/power-platform/developer/cli/introduction
const PAC_NUGET_PACKAGE = 'Microsoft.PowerApps.CLI.Tool';

const MANUAL_INSTRUCTIONS = {
  dotnet: [
    'Windows (winget)   winget install -e --id Microsoft.DotNet.SDK.10',
    'macOS (Homebrew)   brew install --cask dotnet-sdk',
    'Any platform       https://aka.ms/dotnet/download',
  ],
  pac: [
    'Any platform       dotnet tool install --global Microsoft.PowerApps.CLI.Tool',
    'Docs               https://aka.ms/PowerPlatformCLI',
  ],
  az: [
    'Windows (winget)   winget install -e --id Microsoft.AzureCLI',
    'macOS (Homebrew)   brew install azure-cli',
    'Linux (curl)       curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash',
    'Docs               https://aka.ms/InstallAzureCLI',
  ],
};

/** Reports whether a command resolves on PATH, without running it. */
function hasCommand(command) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(locator, [command], { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the install command for one tool on one platform.
 *
 * Returns `{ command, args, description }` when an automated path exists, or
 * `{ command: null, reason, manual }` when the user has to install by hand —
 * which is the expected outcome on Linux, where the plugin does not guess
 * between apt, dnf, and the Azure install script.
 *
 * @param {object} options
 * @param {string} options.tool           One of TOOLS.
 * @param {string} options.platform       A `process.platform` value.
 * @param {boolean} [options.update]      Update an installed tool instead of installing it.
 * @param {(cmd: string) => boolean} [options.commandExists]  PATH probe, injected by the tests.
 */
function resolveInstallPlan({ tool, platform, update = false, commandExists = hasCommand }) {
  const manual = MANUAL_INSTRUCTIONS[tool] || [];

  if (tool === 'pac') {
    // PAC installs as a dotnet global tool on every platform, so the only thing
    // that can block it is a missing .NET SDK. A same-session SDK install also
    // lands here: the installer writes PATH for future processes, but this
    // process inherited its environment from a shell that started earlier, so
    // `dotnet` stays unresolvable until the terminal restarts.
    if (!commandExists('dotnet')) {
      return {
        command: null,
        reason:
          'The .NET SDK is required to install the Power Platform CLI, and dotnet was not found on PATH. ' +
          'If the SDK was just installed, restart your terminal and run this skill again — a new install is not visible to an already-running shell.',
        manual,
      };
    }
    return {
      command: 'dotnet',
      args: ['tool', update ? 'update' : 'install', '--global', PAC_NUGET_PACKAGE],
      description: `${update ? 'Updating' : 'Installing'} the Power Platform CLI as a .NET global tool`,
      manual,
    };
  }

  if (tool === 'dotnet') {
    if (platform === 'win32' && commandExists('winget')) {
      return {
        command: 'winget',
        args: ['install', ...WINGET_FLAGS, '--id', WINGET_DOTNET_SDK_ID],
        description: 'Installing the .NET SDK via winget',
        manual,
      };
    }
    if (platform === 'darwin' && commandExists('brew')) {
      return {
        command: 'brew',
        args: ['install', '--cask', 'dotnet-sdk'],
        description: 'Installing the .NET SDK via Homebrew',
        manual,
      };
    }
    return { command: null, reason: noPackageManagerReason(platform, '.NET SDK'), manual };
  }

  if (tool === 'az') {
    if (platform === 'win32' && commandExists('winget')) {
      return {
        command: 'winget',
        args: ['install', ...WINGET_FLAGS, '--id', WINGET_AZURE_CLI_ID],
        description: 'Installing the Azure CLI via winget',
        manual,
      };
    }
    if (platform === 'darwin' && commandExists('brew')) {
      return {
        command: 'brew',
        args: ['install', 'azure-cli'],
        description: 'Installing the Azure CLI via Homebrew',
        manual,
      };
    }
    return { command: null, reason: noPackageManagerReason(platform, 'Azure CLI'), manual };
  }

  return {
    command: null,
    reason: `Unknown tool "${tool}". Expected one of: ${TOOLS.join(', ')}.`,
    manual: [],
  };
}

function noPackageManagerReason(platform, label) {
  if (platform === 'win32') return `winget was not found, so the ${label} cannot be installed automatically.`;
  if (platform === 'darwin') return `Homebrew was not found, so the ${label} cannot be installed automatically.`;
  return `Automated install of the ${label} is not supported on ${platform}.`;
}

function parseArgs(argv) {
  const args = { tool: null, update: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tool') args.tool = argv[++i];
    else if (arg === '--update') args.update = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help') args.help = true;
    else if (!arg.startsWith('--') && !args.tool) args.tool = arg;
  }
  return args;
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.tool) {
    process.stdout.write(
      `install-prerequisite.js — Installs one Power Pages plugin prerequisite.

Usage:
  node install-prerequisite.js --tool <${TOOLS.join('|')}> [--update] [--dry-run]

  --update    Update an already-installed tool (supported for: pac).
  --dry-run   Print the resolved command without running it.

Exit codes:
  0  Installed, or the dry run printed a plan
  1  No automated install path on this platform, or the install failed
`
    );
    process.exit(args.tool ? 0 : 1);
  }

  const plan = resolveInstallPlan({
    tool: args.tool,
    platform: process.platform,
    update: args.update,
  });

  if (!plan.command) {
    emit({ tool: args.tool, status: 'unsupported', reason: plan.reason, manual: plan.manual });
    process.exit(1);
  }

  if (args.dryRun) {
    emit({
      tool: args.tool,
      status: 'planned',
      command: plan.command,
      args: plan.args,
      description: plan.description,
    });
    process.exit(0);
  }

  process.stderr.write(`${plan.description}...\n`);
  // Installs are long and chatty, so their output streams straight to the user's
  // terminal instead of being buffered and replayed after the fact.
  const result = spawnSync(plan.command, plan.args, { stdio: 'inherit', shell: false });

  if (result.status === 0) {
    emit({
      tool: args.tool,
      status: 'installed',
      command: plan.command,
      // A freshly installed global tool lands in a PATH entry the current shell
      // resolved at startup, so `pac`/`az` often stay unresolvable until the
      // terminal restarts. Say so rather than letting the next skill fail.
      note: 'You may need to restart your terminal before this command resolves on PATH.',
    });
    process.exit(0);
  }

  emit({
    tool: args.tool,
    status: 'failed',
    command: plan.command,
    exitCode: result.status,
    error: result.error ? result.error.message : null,
    manual: plan.manual,
  });
  process.exit(1);
}

module.exports = { resolveInstallPlan, parseArgs, hasCommand, TOOLS, MANUAL_INSTRUCTIONS };

if (require.main === module) {
  main();
}
