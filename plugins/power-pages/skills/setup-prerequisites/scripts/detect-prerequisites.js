#!/usr/bin/env node

/**
 * detect-prerequisites.js — Reports which Power Pages plugin prerequisites are
 * present on this machine, at what version, and whether the PAC CLI and Azure
 * CLI are signed in.
 *
 * The `/setup-prerequisites` skill consumes the JSON on stdout to decide what to
 * offer the user. All probing is read-only — nothing here installs or signs in.
 *
 * Usage:
 *   node detect-prerequisites.js [--no-update-check]
 *
 * Exit codes:
 *   0  Everything the plugin needs is present and signed in
 *   1  At least one item needs action (missing tool, signed out, or an update)
 *
 * Pure parsers are exported so the tests can assert against captured CLI banners
 * without spawning the real tools.
 */

'use strict';

const { execFileSync } = require('child_process');
const https = require('https');

// NuGet's flat-container index for the PAC CLI dotnet tool. The `versions` array
// is ascending, so the last stable entry is the newest published version.
// See: https://learn.microsoft.com/nuget/api/package-base-address-resource
const PAC_NUGET_INDEX =
  'https://api.nuget.org/v3-flatcontainer/microsoft.powerapps.cli.tool/index.json';

// `pac help` cold-starts the .NET runtime, which can take several seconds on a
// first run (Windows Defender scan, NGen warm-up), so the probes get a generous
// timeout rather than reporting a slow tool as missing.
const PROBE_TIMEOUT_MS = 60000;

/**
 * Builds the invocation used to probe a tool.
 *
 * On Windows, some Microsoft CLIs ship only as a batch shim rather than an
 * `.exe` — the Azure CLI installs `az.cmd` (plus `az.ps1`) and no `az.exe` at
 * all. Node refuses to spawn a `.bat`/`.cmd` file without a shell (it throws
 * `EINVAL` since 18.20.2 / 20.12.2, and failed with CreateProcess error 193
 * before that), so probing `az` directly reports an installed Azure CLI as
 * missing. Routing every Windows probe through `cmd.exe /c` resolves the shim
 * the same way a terminal would, while still passing arguments as an array so
 * nothing is concatenated into a shell command string.
 *
 * See: https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2
 */
function buildProbeInvocation(command, args, platform = process.platform) {
  if (platform === 'win32') return { file: 'cmd.exe', args: ['/c', command, ...args] };
  return { file: command, args };
}

/**
 * Runs a command and returns its stdout, or null when the command is missing or
 * fails. Arguments are passed as an array, never as a shell command string.
 */
function probe(command, args, { timeout = PROBE_TIMEOUT_MS } = {}) {
  const invocation = buildProbeInvocation(command, args);
  try {
    return execFileSync(invocation.file, invocation.args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/**
 * Extracts the version from `pac help`, whose banner looks like:
 *
 *   Microsoft PowerPlatform CLI
 *   Version: 1.51.1+g8a2ec33
 *
 * The `+<git-sha>` build-metadata suffix is dropped so the value compares
 * cleanly against the plain semver NuGet publishes.
 */
function parsePacVersion(output) {
  if (!output) return null;
  const match = output.match(/Version:\s*([0-9]+(?:\.[0-9]+)*)/i);
  return match ? match[1] : null;
}

/**
 * Extracts the version from `az version -o tsv`, a tab-separated line:
 *
 *   2.77.0\t2.77.0\t...
 */
function parseAzVersion(output) {
  if (!output) return null;
  const match = output.match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Extracts the version from `git --version`, whose banner is:
 *
 *   git version 2.53.0
 *
 * The Apple-shipped build appends its own suffix:
 *
 *   git version 2.39.5 (Apple Git-154)
 */
function parseGitVersion(output) {
  if (!output) return null;
  const match = output.match(/git version\s+([0-9]+(?:\.[0-9]+)*)/i);
  return match ? match[1] : null;
}

/**
 * Extracts the version from `dotnet --version`, which prints a bare version such
 * as `10.0.102` (or `9.0.100-preview.1.24101.2` on a preview SDK).
 */
function parseDotnetVersion(output) {
  if (!output) return null;
  const match = output.match(/([0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.\-]*)/);
  return match ? match[1] : null;
}

/**
 * Parses the `pac auth who` banner, a label/value block. Captured from 2.9.3:
 *
 *   Connected as user@contoso.com
 *
 *   Type:                       User
 *   Cloud:                      Public
 *   Tenant Id:                  00000000-0000-0000-0000-000000000000
 *   User:                       user@contoso.com
 *   Environment Id:             11111111-1111-1111-1111-111111111111
 *   Organization Friendly Name: Contoso Dev
 *
 * PAC has shipped both "Tenant Id" and "Tenant ID" casing across versions, so
 * the match is case-insensitive. When no profile is selected, PAC prints an
 * error instead ("No profiles were found on this computer") and this returns the
 * signed-out shape. Values can contain their own ':' (URLs, timestamps), so each
 * pattern stops at the first colon after the label and takes the rest of the line.
 */
function parsePacAuthWho(output) {
  const signedOut = { signedIn: false, tenantId: null, user: null, cloud: null };
  if (!output) return signedOut;
  if (/no profiles were found/i.test(output)) return signedOut;

  // `label` is always a fixed, code-controlled string below, so interpolating it
  // into the pattern is safe. Escape it first if it ever comes from input.
  const field = (label) => {
    const match = output.match(new RegExp(`^\\s*${label}\\s*:\\s*(\\S.*?)\\s*$`, 'im'));
    return match ? match[1] : null;
  };

  const tenantId = field('Tenant Id');
  const user = field('User');

  if (!tenantId && !user) return signedOut;
  return { signedIn: true, tenantId, user, cloud: field('Cloud') };
}

/**
 * Parses `az account show -o json`:
 *
 *   { "tenantId": "...", "user": { "name": "user@contoso.com" }, "name": "Sub" }
 *
 * A signed-out Azure CLI exits non-zero and prints "Please run 'az login'", so
 * the caller passes null and this returns the signed-out shape. An account with
 * no subscription can still be signed in, so a missing subscription name is not
 * treated as a sign-out signal.
 */
function parseAzAccountShow(output) {
  const signedOut = { signedIn: false, tenantId: null, user: null, subscription: null };
  if (!output) return signedOut;
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return signedOut;
  }
  if (!parsed || typeof parsed !== 'object') return signedOut;
  if (!parsed.tenantId && !(parsed.user && parsed.user.name)) return signedOut;
  return {
    signedIn: true,
    tenantId: parsed.tenantId || null,
    user: parsed.user && parsed.user.name ? parsed.user.name : null,
    subscription: parsed.name || null,
  };
}

/**
 * Compares two dotted version strings. Returns 1 when `b` is newer, -1 when `a`
 * is newer, 0 when equal. Prerelease suffixes are ignored — a `-preview` build
 * compares as its numeric base, which is good enough for "is an update
 * available?" and avoids nagging preview users on every run.
 */
function compareVersions(a, b) {
  if (!a || !b) return 0;
  const parts = (v) => v.split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = parts(a);
  const pb = parts(b);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    if ((pb[i] || 0) > (pa[i] || 0)) return 1;
    if ((pb[i] || 0) < (pa[i] || 0)) return -1;
  }
  return 0;
}

/** Picks the newest stable version from NuGet's ascending `versions` array. */
function latestStableVersion(versions) {
  if (!Array.isArray(versions)) return null;
  const stable = versions.filter((v) => typeof v === 'string' && !v.includes('-'));
  return stable.length ? stable[stable.length - 1] : null;
}

/** Fetches the newest published PAC CLI version, or null on any network error. */
function fetchLatestPacVersion() {
  return new Promise((resolve) => {
    const request = https.get(PAC_NUGET_INDEX, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(latestStableVersion(JSON.parse(body).versions));
        } catch {
          resolve(null);
        }
      });
    });
    // An update check must never hold up or fail the skill, so every failure
    // path — DNS, proxy, offline, malformed body — resolves to null.
    request.on('error', () => resolve(null));
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
  });
}

/**
 * Turns a raw status map into the action list the skill works through. Each
 * action names the tool the workflow passes to `install-prerequisite.js`.
 */
function buildActions(status) {
  const actions = [];
  if (!status.node.available) actions.push({ tool: 'node', kind: 'install' });
  if (!status.git.available) actions.push({ tool: 'git', kind: 'install' });
  if (!status.dotnet.available) actions.push({ tool: 'dotnet', kind: 'install' });
  if (!status.pac.available) actions.push({ tool: 'pac', kind: 'install' });
  else if (status.pac.updateAvailable) actions.push({ tool: 'pac', kind: 'update' });
  if (!status.az.available) actions.push({ tool: 'az', kind: 'install' });
  // Sign-in is only actionable once the CLI itself exists; a missing CLI already
  // has an install action and would otherwise produce two entries for one gap.
  if (status.pac.available && !status.pacAuth.signedIn) actions.push({ tool: 'pac', kind: 'signin' });
  if (status.az.available && !status.azAuth.signedIn) actions.push({ tool: 'az', kind: 'signin' });
  return actions;
}

/**
 * Flags a PAC/Azure tenant mismatch. Both CLIs mint tokens the plugin's scripts
 * use against the same environment, so signing them into different tenants
 * surfaces as confusing 401/403s rather than an obvious error.
 */
function tenantMismatch(pacAuth, azAuth) {
  if (!pacAuth.signedIn || !azAuth.signedIn) return null;
  if (!pacAuth.tenantId || !azAuth.tenantId) return null;
  if (pacAuth.tenantId.toLowerCase() === azAuth.tenantId.toLowerCase()) return null;
  return { pacTenantId: pacAuth.tenantId, azTenantId: azAuth.tenantId };
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      `detect-prerequisites.js — Reports Power Pages plugin prerequisite status as JSON.

Usage:
  node detect-prerequisites.js [--no-update-check]

  --no-update-check   Skip the NuGet lookup for a newer PAC CLI version.

Exit codes:
  0  Ready — every tool present and both CLIs signed in
  1  Action needed — see the "actions" array in the JSON output
`
    );
    process.exit(0);
  }

  const checkUpdates = !process.argv.includes('--no-update-check');

  const nodeVersion = process.version.replace(/^v/, '');
  const gitVersion = parseGitVersion(probe('git', ['--version']));
  const dotnetVersion = parseDotnetVersion(probe('dotnet', ['--version']));
  const pacVersion = parsePacVersion(probe('pac', ['help']));
  const azVersion = parseAzVersion(probe('az', ['version', '-o', 'tsv']));

  const pacAuth = parsePacAuthWho(pacVersion ? probe('pac', ['auth', 'who']) : null);
  const azAuth = parseAzAccountShow(
    azVersion ? probe('az', ['account', 'show', '-o', 'json']) : null
  );

  const latestPac = checkUpdates && pacVersion ? await fetchLatestPacVersion() : null;

  const status = {
    platform: process.platform,
    // This script runs under Node, so Node is present by construction. It stays
    // in the report because the skill's summary lists every prerequisite.
    node: { available: true, version: nodeVersion },
    git: { available: Boolean(gitVersion), version: gitVersion },
    dotnet: { available: Boolean(dotnetVersion), version: dotnetVersion },
    pac: {
      available: Boolean(pacVersion),
      version: pacVersion,
      latestVersion: latestPac,
      updateAvailable: Boolean(latestPac && compareVersions(pacVersion, latestPac) === 1),
    },
    az: { available: Boolean(azVersion), version: azVersion },
    pacAuth,
    azAuth,
  };

  status.tenantMismatch = tenantMismatch(pacAuth, azAuth);
  status.actions = buildActions(status);
  status.ready = status.actions.length === 0;

  process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  process.exit(status.ready ? 0 : 1);
}

module.exports = {
  buildProbeInvocation,
  parsePacVersion,
  parseAzVersion,
  parseDotnetVersion,
  parseGitVersion,
  parsePacAuthWho,
  parseAzAccountShow,
  compareVersions,
  latestStableVersion,
  buildActions,
  tenantMismatch,
};

if (require.main === module) {
  main();
}
