#!/usr/bin/env node

// Checks whether a Dataverse solution is installed in the current PAC environment.
// Usage:
//   node check-solution-installed.js --solutionName <uniqueName> [--envUrl <url>]
//
// If --envUrl is omitted, the environment URL is read from `pac env who`.
//
// Outputs JSON to stdout on success:
//   { "installed": true,  "solutionName": "...", "version": "1.0.0.5" }
//   { "installed": false, "solutionName": "..." }
//
// On infrastructure failure (no PAC env, no Azure CLI token, network error, 4xx/5xx),
// writes a human-readable message to stderr and exits 1 — the caller (skill) should
// treat this as "unknown" and fall back to asking the user manually.
//
// The query itself lives in lib/check-solution-installed.js so it can be unit-
// tested without spawning a subprocess or making real network calls.

const { getAuthToken, getEnvironmentUrl } = require('./lib/validation-helpers');
const { checkSolutionInstalled, sanitizeEnvUrl } = require('./lib/check-solution-installed');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--solutionName') args.solutionName = argv[++i];
    else if (a === '--envUrl') args.envUrl = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.solutionName) {
    process.stderr.write('Usage: node check-solution-installed.js --solutionName <uniqueName> [--envUrl <url>]\n');
    process.exit(1);
  }

  const rawEnvUrl = args.envUrl || getEnvironmentUrl();
  if (!rawEnvUrl) {
    process.stderr.write('No environment URL provided and `pac env who` did not return one. Run `pac auth create` and `pac env select` first.\n');
    process.exit(1);
  }

  // Sanitize before passing anywhere that interpolates the URL into a shell
  // command (getAuthToken builds `az account get-access-token --resource
  // "${envUrl}"`). sanitizeEnvUrl strips everything except scheme+host+port,
  // so a `--envUrl 'x"; rm -rf ~; echo "'` can't escape the quotes.
  let envUrl;
  try {
    envUrl = sanitizeEnvUrl(rawEnvUrl);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }

  const token = getAuthToken(envUrl);
  if (!token) {
    process.stderr.write('Failed to get Azure CLI token. Run `az login` first.\n');
    process.exit(1);
  }

  try {
    const result = await checkSolutionInstalled({
      envUrl,
      token,
      solutionName: args.solutionName,
    });
    console.log(JSON.stringify(result));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

main();
