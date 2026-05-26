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

const { getAuthToken, makeRequest, getEnvironmentUrl } = require('./lib/validation-helpers');

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

  // Reject unique names with characters that can't appear in OData string literals.
  // Solution unique names are restricted to alphanumeric + underscore by Dataverse,
  // so this is also a sanity check.
  if (!/^[A-Za-z0-9_]+$/.test(args.solutionName)) {
    process.stderr.write(`Invalid solution unique name: "${args.solutionName}". Expected alphanumeric + underscore.\n`);
    process.exit(1);
  }

  const envUrl = args.envUrl || getEnvironmentUrl();
  if (!envUrl) {
    process.stderr.write('No environment URL provided and `pac env who` did not return one. Run `pac auth create` and `pac env select` first.\n');
    process.exit(1);
  }

  const token = getAuthToken(envUrl);
  if (!token) {
    process.stderr.write('Failed to get Azure CLI token. Run `az login` first.\n');
    process.exit(1);
  }

  const filter = `uniquename eq '${args.solutionName}'`;
  const url = `${envUrl}/api/data/v9.2/solutions?$filter=${encodeURIComponent(filter)}&$select=uniquename,version&$top=1`;

  const res = await makeRequest({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
  });

  if (res.error) {
    process.stderr.write(`Solution query failed: ${res.error}\n`);
    process.exit(1);
  }

  if (res.statusCode === 401 || res.statusCode === 403) {
    process.stderr.write(
      `Authentication / authorization failed (${res.statusCode}) querying solutions table. ` +
      `Either the token is expired (run \`az login\`) or the signed-in user lacks Read permission on the solutions table.\n`
    );
    process.exit(1);
  }

  if (res.statusCode !== 200) {
    process.stderr.write(`Unexpected response (${res.statusCode}): ${res.body}\n`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    process.stderr.write(`Failed to parse Dataverse response as JSON: ${res.body}\n`);
    process.exit(1);
  }

  const row = Array.isArray(data.value) && data.value.length > 0 ? data.value[0] : null;
  if (row) {
    console.log(JSON.stringify({
      installed: true,
      solutionName: args.solutionName,
      version: row.version || null,
    }));
  } else {
    console.log(JSON.stringify({
      installed: false,
      solutionName: args.solutionName,
    }));
  }
}

main();
