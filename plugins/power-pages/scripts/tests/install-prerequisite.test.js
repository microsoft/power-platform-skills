const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveInstallPlan,
  parseArgs,
  TOOLS,
  MANUAL_INSTRUCTIONS,
} = require('../../skills/setup-prerequisites/scripts/install-prerequisite');

const everythingPresent = () => true;
const nothingPresent = () => false;

test('pac installs as a dotnet global tool on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const plan = resolveInstallPlan({ tool: 'pac', platform, commandExists: everythingPresent });
    assert.equal(plan.command, 'dotnet');
    assert.deepEqual(plan.args, [
      'tool',
      'install',
      '--global',
      'Microsoft.PowerApps.CLI.Tool',
    ]);
  }
});

test('pac --update switches install to update', () => {
  const plan = resolveInstallPlan({
    tool: 'pac',
    platform: 'darwin',
    update: true,
    commandExists: everythingPresent,
  });
  assert.deepEqual(plan.args, ['tool', 'update', '--global', 'Microsoft.PowerApps.CLI.Tool']);
});

test('pac without the .NET SDK has no automated path', () => {
  const plan = resolveInstallPlan({ tool: 'pac', platform: 'darwin', commandExists: nothingPresent });
  assert.equal(plan.command, null);
  assert.match(plan.reason, /\.NET SDK/);
  // The fresh-machine path installs the SDK and PAC in the same session, where
  // the new SDK is invisible to the already-running shell — the reason has to
  // name the restart so the agent does not report a platform limitation.
  assert.match(plan.reason, /restart your terminal/i);
  assert.ok(plan.manual.length > 0);
});

test('git uses winget on Windows and Homebrew on macOS', () => {
  const win = resolveInstallPlan({ tool: 'git', platform: 'win32', commandExists: everythingPresent });
  assert.equal(win.command, 'winget');
  assert.ok(win.args.includes('Git.Git'));

  const mac = resolveInstallPlan({ tool: 'git', platform: 'darwin', commandExists: everythingPresent });
  assert.equal(mac.command, 'brew');
  assert.deepEqual(mac.args, ['install', 'git']);
});

test('dotnet uses winget on Windows and Homebrew on macOS', () => {  const win = resolveInstallPlan({ tool: 'dotnet', platform: 'win32', commandExists: everythingPresent });
  assert.equal(win.command, 'winget');
  assert.ok(win.args.includes('Microsoft.DotNet.SDK.10'));
  assert.ok(win.args.includes('--accept-package-agreements'));

  const mac = resolveInstallPlan({ tool: 'dotnet', platform: 'darwin', commandExists: everythingPresent });
  assert.equal(mac.command, 'brew');
  assert.deepEqual(mac.args, ['install', '--cask', 'dotnet-sdk']);
});

test('az uses winget on Windows and Homebrew on macOS', () => {
  const win = resolveInstallPlan({ tool: 'az', platform: 'win32', commandExists: everythingPresent });
  assert.equal(win.command, 'winget');
  assert.ok(win.args.includes('Microsoft.AzureCLI'));

  const mac = resolveInstallPlan({ tool: 'az', platform: 'darwin', commandExists: everythingPresent });
  assert.equal(mac.command, 'brew');
  assert.deepEqual(mac.args, ['install', 'azure-cli']);
});

test('Linux falls back to manual instructions for git, dotnet, and az', () => {
  for (const tool of ['git', 'dotnet', 'az']) {
    const plan = resolveInstallPlan({ tool, platform: 'linux', commandExists: everythingPresent });
    assert.equal(plan.command, null);
    assert.match(plan.reason, /linux/);
    assert.deepEqual(plan.manual, MANUAL_INSTRUCTIONS[tool]);
  }
});

test('a missing package manager names the package manager in the reason', () => {
  const win = resolveInstallPlan({ tool: 'az', platform: 'win32', commandExists: nothingPresent });
  assert.match(win.reason, /winget/);

  const mac = resolveInstallPlan({ tool: 'az', platform: 'darwin', commandExists: nothingPresent });
  assert.match(mac.reason, /Homebrew/);
});

test('an unknown tool is rejected with the supported list', () => {
  const plan = resolveInstallPlan({ tool: 'node', platform: 'darwin', commandExists: everythingPresent });
  assert.equal(plan.command, null);
  for (const tool of TOOLS) assert.ok(plan.reason.includes(tool));
});

test('every plan carries manual instructions as a fallback', () => {
  for (const tool of TOOLS) {
    const plan = resolveInstallPlan({ tool, platform: 'linux', commandExists: everythingPresent });
    assert.ok(plan.manual.length > 0, `${tool} should carry manual instructions`);
  }
});

test('parseArgs reads the tool as a flag or a positional', () => {
  assert.deepEqual(parseArgs(['--tool', 'pac']), { tool: 'pac', update: false, dryRun: false, help: false });
  assert.deepEqual(parseArgs(['az']), { tool: 'az', update: false, dryRun: false, help: false });
});

test('parseArgs reads --update, --dry-run, and --help', () => {
  const args = parseArgs(['--tool', 'pac', '--update', '--dry-run', '--help']);
  assert.equal(args.update, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.help, true);
});

test('parseArgs defaults to no tool when none is given', () => {
  assert.equal(parseArgs([]).tool, null);
  assert.equal(parseArgs(['--dry-run']).tool, null);
});
