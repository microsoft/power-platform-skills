#!/usr/bin/env node

// Checks whether a Dataverse solution exists by unique name.
//
// Usage: node verify-solution-exists.js --envUrl <url> --uniqueName <name> [--token <token>]
//
// Options:
//   --envUrl <url>       Dataverse environment URL
//   --uniqueName <name>  Solution unique name (e.g., ContosoSite)
//   --token <token>      Bearer token (optional — acquired via Azure CLI if omitted)
//
// Output (JSON to stdout):
//   Found:     { "found": true, "solutionId": "...", "uniqueName": "...", "version": "...", "isManaged": false }
//   Not found: { "found": false, "uniqueName": "..." }
//
// Exit 0 on success (regardless of found/not-found), exit 1 on API error.

'use strict';

const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;

function parseArgs(argv) {
  const args = argv.slice(2);
  let envUrl = null;
  let uniqueName = null;
  let token = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) envUrl = args[++i];
    else if (args[i] === '--uniqueName' && args[i + 1]) uniqueName = args[++i];
    else if (args[i] === '--token' && args[i + 1]) token = args[++i];
  }

  return { envUrl, uniqueName, token };
}

async function verifySolutionExists({ envUrl, uniqueName, token }) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!uniqueName) throw new Error('--uniqueName is required');

  const resolvedToken = token || getAuthToken(envUrl);
  if (!resolvedToken) {
    throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');
  }

  const url = new URL(`${envUrl}/api/data/v9.2/solutions`);
  url.searchParams.set('$filter', `uniquename eq '${uniqueName}'`);
  url.searchParams.set('$select', 'solutionid,uniquename,version,ismanaged');

  const res = await helpers.makeRequest({
    url: url.toString(),
    headers: {
      Authorization: `Bearer ${resolvedToken}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    timeout: 15000,
  });

  if (res.error) throw new Error(`API request failed: ${res.error}`);
  if (res.statusCode === 401) throw new Error('Authentication failed. Run `az login` again.');
  if (res.statusCode !== 200) {
    throw new Error(`Unexpected response (${res.statusCode}): ${res.body}`);
  }

  const data = JSON.parse(res.body);
  if (!data.value || data.value.length === 0) {
    return { found: false, uniqueName };
  }

  const s = data.value[0];
  return {
    found: true,
    solutionId: s.solutionid,
    uniqueName: s.uniquename,
    version: s.version,
    isManaged: s.ismanaged,
  };
}

// CLI entry point
if (require.main === module) {
  const { envUrl, uniqueName, token } = parseArgs(process.argv);

  verifySolutionExists({ envUrl, uniqueName, token })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { verifySolutionExists };
